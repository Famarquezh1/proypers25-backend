function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

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

function countTimeouts(rows = []) {
  let total = 0;
  for (const row of rows) {
    const reasons = Array.isArray(row.failure_reasons_top) ? row.failure_reasons_top : [];
    for (const item of reasons) {
      const reason = String(item?.reason || '').toLowerCase();
      if (reason.includes('timeout')) total += 1;
    }
  }
  return total;
}

function countFallbackUsed(predictions = []) {
  let total = 0;
  for (const row of predictions) {
    const sourceUsed = String(
      row?.profiling?.fetch_candles?.source_used ||
      row?.profiling?.spot_fetch?.source_used ||
      row.fetch_source ||
      ''
    ).toLowerCase();
    if (sourceUsed && sourceUsed !== 'binance' && sourceUsed !== 'primary') {
      total += 1;
    }
  }
  return total;
}

function deriveDiagnosis(metrics = {}) {
  if (Number(metrics.cycles_executed || 0) === 0 || Number(metrics.symbols_attempted || 0) === 0) {
    return 'pipeline_not_entered';
  }
  if (Number(metrics.fetch_attempts || 0) === 0) {
    return 'no_fetch';
  }
  if (Number(metrics.timeouts || 0) > 0) {
    return 'timeouts';
  }
  if (Number(metrics.fetch_fail || 0) > 0 && Number(metrics.fetch_success || 0) === 0) {
    return 'fetch_failing';
  }
  if (Number(metrics.predictions_generated || 0) > 0 && Number(metrics.predictions_saved || 0) === 0) {
    return 'predictions_not_saved';
  }
  if (Number(metrics.predictions_generated || 0) === 0 && Number(metrics.fetch_success || 0) === 0) {
    return 'fetch_failing';
  }
  return 'predictions_not_saved';
}

async function getPredictionFlowDiagnostic(db, options = {}) {
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

  const predictionsInWindow = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const cyclesExecuted = predictionCycles.length;
  const symbolsAttempted = predictionCycles.reduce(
    (sum, row) => sum + Number(row.symbols_requested || row.symbols_total || row.prediction_runtime_selector?.requested_symbols || 0),
    0
  );
  const fetchAttempts = symbolsAttempted;
  const fetchSuccess = predictionCycles.reduce(
    (sum, row) => sum + Number(row.processed_ok || 0),
    0
  );
  const fetchFail = predictionCycles.reduce(
    (sum, row) => sum + Number(row.failed || 0),
    0
  );
  const timeouts = countTimeouts(predictionCycles);
  const fallbackUsed = countFallbackUsed(predictionsInWindow);
  const predictionsGenerated = fetchSuccess;
  const predictionsSaved = predictionsInWindow.length;

  const report = {
    cycles_executed: cyclesExecuted,
    symbols_attempted: symbolsAttempted,
    fetch_attempts: fetchAttempts,
    fetch_success: fetchSuccess,
    fetch_fail: fetchFail,
    timeouts,
    fallback_used: fallbackUsed,
    predictions_generated: predictionsGenerated,
    predictions_saved: predictionsSaved,
    diagnosis: deriveDiagnosis({
      cycles_executed: cyclesExecuted,
      symbols_attempted: symbolsAttempted,
      fetch_attempts: fetchAttempts,
      fetch_success: fetchSuccess,
      fetch_fail: fetchFail,
      timeouts,
      fallback_used: fallbackUsed,
      predictions_generated: predictionsGenerated,
      predictions_saved: predictionsSaved
    })
  };

  console.log('[PREDICTION_FLOW_DIAGNOSTIC]', JSON.stringify({
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2)
    },
    ...report
  }));

  return report;
}

module.exports = {
  getPredictionFlowDiagnostic
};
