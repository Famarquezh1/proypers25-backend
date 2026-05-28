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

function round(value, decimals = 4) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(decimals));
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 1));
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

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.signal_emitted_at) ||
    parseDateLike(row.created_at) ||
    parseDateLike(row.timestamp) ||
    parseDateLike(row.ahora)
  );
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function normalizeReason(row = {}) {
  return String(
    row.reason ||
    row.final_evaluation?.reason ||
    row.validation?.reason ||
    row.execution_discipline?.reason ||
    row.error_message ||
    ''
  ).trim() || 'unknown';
}

function deriveDiagnosis(report = {}) {
  const qualityRate = Number(report.quality_pass_rate || 0);
  const executionRate = Number(report.execution_pass_rate || 0);
  if (qualityRate < 0.5 && executionRate < 0.5) return 'combined_too_strict';
  if (qualityRate < 0.5) return 'quality_too_strict';
  return 'execution_too_strict';
}

async function getPipelinePassRateDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);

  const [predictions, intents] = await Promise.all([
    loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs),
    loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs)
  ]);

  const emittedSignals = predictions.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until && row.signal_emitted === true;
  });

  const scopedIntents = intents.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const passedQuality = scopedIntents.filter((row) => normalizeReason(row) !== 'event_quality_gate');
  const passedExecutionScore = passedQuality.filter((row) => normalizeReason(row) !== 'execution_protection_mode');
  const executed = scopedIntents.filter((row) => String(row.status || '').toLowerCase() === 'executed');

  const signalsEmitted = emittedSignals.length;
  const report = {
    signals_emitted: signalsEmitted,
    passed_quality: passedQuality.length,
    passed_execution_score: passedExecutionScore.length,
    executed: executed.length,
    quality_pass_rate: signalsEmitted > 0 ? round(passedQuality.length / signalsEmitted) : 0,
    execution_pass_rate: passedQuality.length > 0 ? round(passedExecutionScore.length / passedQuality.length) : 0,
    final_pass_rate: signalsEmitted > 0 ? round(executed.length / signalsEmitted) : 0
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getPipelinePassRateDiagnostic
};
