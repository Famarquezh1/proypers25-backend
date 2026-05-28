function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(1, Number(options.hours || 1));
  const windowMs = sinceExplicit
    ? Math.max(1, until.getTime() - sinceExplicit.getTime())
    : options.days
      ? days * 24 * 60 * 60 * 1000
      : hours * 60 * 60 * 1000;

  return {
    since: sinceExplicit || new Date(until.getTime() - windowMs),
    until
  };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolveSnapshotTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.timestamp);
}

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.created_at) ||
    parseDateLike(row.timestamp) ||
    parseDateLike(row.signal_created_at) ||
    parseDateLike(row.ahora)
  );
}

function classifyErrorType(message = '') {
  const text = String(message || '').toLowerCase();
  if (!text) return 'silent_fail';
  if (text.includes('requires an index') || text.includes('failed_precondition') || text.includes('index')) {
    return 'firestore_index_missing';
  }
  if (text.includes('permission_denied') || text.includes('permission denied') || text.includes('insufficient permissions')) {
    return 'permission_denied';
  }
  if (text.includes('timeout')) {
    return 'write_timeout';
  }
  if (
    text.includes('invalid') ||
    text.includes('validation') ||
    text.includes('spot_price_invalid') ||
    text.includes('expected_move_percent_invalid')
  ) {
    return 'validation_error';
  }
  if (text.includes('undefined') || text.includes('ignoreundefinedproperties') || text.includes('cannot use "undefined"')) {
    return 'undefined_data';
  }
  return 'silent_fail';
}

function increment(bucket, key, amount = 1) {
  const normalized = String(key || 'unknown');
  bucket[normalized] = (bucket[normalized] || 0) + amount;
}

function deriveDiagnosis(report = {}) {
  const lastErrorType = String(report.last_error_type || '');
  if (Number(report.save_attempts || 0) === 0) {
    return 'save_not_called';
  }
  if (lastErrorType === 'permission_denied') {
    return 'permission_issue';
  }
  if (lastErrorType === 'validation_error' || lastErrorType === 'undefined_data') {
    return 'data_invalid';
  }
  return 'write_failing';
}

async function getPredictionSaveDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);

  const [snapshotRows, predictionRows] = await Promise.all([
    loadRecentRows(db, 'velas_monitoring_snapshots', 'created_at', Math.min(maxDocs, 1500)),
    loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs)
  ]);

  const predictionCycles = snapshotRows
    .filter((row) => String(row.source || '').toLowerCase() === 'prediction_cycle')
    .map((row) => ({
      ...row,
      created_at_date: resolveSnapshotTimestamp(row)
    }))
    .filter((row) => row.created_at_date && row.created_at_date >= since && row.created_at_date <= until);

  const predictionsSaved = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const saveAttempts = predictionCycles.reduce(
    (sum, row) => sum + Number(row.processed_ok || 0),
    0
  );
  const saveSuccess = predictionsSaved.length;
  const saveFail = Math.max(0, saveAttempts - saveSuccess);

  const failureEntries = predictionCycles.flatMap((row) => Array.isArray(row.failure_reasons_top) ? row.failure_reasons_top : []);
  const relevantErrors = failureEntries.map((entry) => String(entry?.reason || '')).filter(Boolean);
  const lastError = relevantErrors[0] || null;
  const errorTypesCount = {};
  for (const reason of relevantErrors) {
    increment(errorTypesCount, classifyErrorType(reason));
  }

  if (!Object.keys(errorTypesCount).length && saveAttempts > 0 && saveSuccess === 0) {
    errorTypesCount.silent_fail = saveFail || saveAttempts;
  }

  const lastErrorType = classifyErrorType(lastError);
  const report = {
    save_attempts: saveAttempts,
    save_success: saveSuccess,
    save_fail: saveFail,
    last_error: lastError,
    error_types_count: errorTypesCount,
    last_error_type: lastError ? lastErrorType : (saveAttempts > 0 && saveSuccess === 0 ? 'silent_fail' : null)
  };

  return {
    save_attempts: report.save_attempts,
    save_success: report.save_success,
    save_fail: report.save_fail,
    last_error: report.last_error,
    error_types_count: report.error_types_count,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getPredictionSaveDiagnostic
};
