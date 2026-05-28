const { SIGNAL_RANKING_ENABLED } = require('./signal_ranking_engine');
const { getPreAlertRuntimeMetrics } = require('../tasks/velasScheduler');

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

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function increment(bucket, key, amount = 1) {
  const normalized = String(key || 'unknown');
  bucket[normalized] = (bucket[normalized] || 0) + amount;
}

function topEntries(map = {}, limit = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
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

function toMs(value) {
  const date = parseDateLike(value);
  return date ? date.getTime() : 0;
}

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.created_at) ||
    parseDateLike(row.timestamp) ||
    parseDateLike(row.signal_created_at) ||
    parseDateLike(row.ahora)
  );
}

function resolveSnapshotTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.timestamp);
}

function resolveSignalTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.timestamp) || parseDateLike(row.updated_at);
}

function buildSchedulerSection(snapshotRows = [], prealertRuntime = null, since, until) {
  const schedulerSources = new Set(['prealert_cycle', 'prediction_cycle']);
  const schedulerRows = snapshotRows
    .filter((row) => schedulerSources.has(String(row.source || '').toLowerCase()))
    .map((row) => ({
      ...row,
      created_at_date: resolveSnapshotTimestamp(row)
    }))
    .filter((row) => row.created_at_date);

  const inWindow = schedulerRows.filter((row) => row.created_at_date >= since && row.created_at_date <= until);
  const sortedDesc = [...schedulerRows].sort((a, b) => b.created_at_date - a.created_at_date);
  const sortedWindowAsc = [...inWindow].sort((a, b) => a.created_at_date - b.created_at_date);
  const intervalsMinutes = [];
  for (let i = 1; i < sortedWindowAsc.length; i += 1) {
    const deltaMinutes = (sortedWindowAsc[i].created_at_date.getTime() - sortedWindowAsc[i - 1].created_at_date.getTime()) / 60000;
    if (Number.isFinite(deltaMinutes) && deltaMinutes >= 0) {
      intervalsMinutes.push(deltaMinutes);
    }
  }

  const expectedIntervalMinutes = 2;
  const lastExecution = sortedDesc[0] || null;
  const gapFromNowMinutes = lastExecution
    ? round((until.getTime() - lastExecution.created_at_date.getTime()) / 60000, 2)
    : null;
  const latestWindowExecution = sortedWindowAsc.length ? sortedWindowAsc[sortedWindowAsc.length - 1] : null;
  const intervalRatio = gapFromNowMinutes == null ? null : round(gapFromNowMinutes / expectedIntervalMinutes, 2);

  return {
    executions_in_window: inWindow.length,
    executions_by_source: topEntries(
      inWindow.reduce((acc, row) => {
        increment(acc, row.source || 'unknown');
        return acc;
      }, {}),
      5
    ),
    last_execution_at: lastExecution?.created_at_date?.toISOString() || prealertRuntime?.last_finished_at || null,
    last_execution_source: lastExecution?.source || null,
    expected_interval_minutes: expectedIntervalMinutes,
    expected_interval_source: 'backend/scripts/setupScheduler.sh -> velas-prealerts "*/2 * * * *"',
    observed_interval_minutes: {
      avg: round(average(intervalsMinutes), 2),
      min: intervalsMinutes.length ? round(Math.min(...intervalsMinutes), 2) : null,
      max: intervalsMinutes.length ? round(Math.max(...intervalsMinutes), 2) : null
    },
    gap_vs_expected: {
      minutes_since_last_execution: gapFromNowMinutes,
      ratio_vs_expected: intervalRatio
    },
    runtime_state: {
      running: Boolean(prealertRuntime?.running),
      last_started_at: prealertRuntime?.last_started_at || null,
      last_finished_at: prealertRuntime?.last_finished_at || null,
      last_duration_ms: toNumber(prealertRuntime?.last_duration_ms, null),
      last_error: prealertRuntime?.last_error || null
    },
    scheduler_logs_present: schedulerRows.length > 0,
    latest_window_snapshot: latestWindowExecution
      ? {
          source: latestWindowExecution.source || null,
          symbols_total: toNumber(latestWindowExecution.symbols_total, 0),
          processed_ok: toNumber(latestWindowExecution.processed_ok, 0),
          failed: toNumber(latestWindowExecution.failed, 0),
          signals_emitted: toNumber(latestWindowExecution.signals_emitted, 0),
          signals_suppressed: toNumber(latestWindowExecution.signals_suppressed, 0)
        }
      : null
  };
}

function buildPredictionsSection(predictions = []) {
  const symbols = new Set();
  const timeframes = new Set();
  const logsPresence = {
    analysis_start_at: 0,
    decision_post_learning: 0,
    event_context_filter: 0,
    manual_prealert_decision: 0,
    high_conviction_decision: 0,
    profiling: 0
  };

  for (const row of predictions) {
    if (row.simbolo || row.symbol) symbols.add(String(row.simbolo || row.symbol).toUpperCase());
    if (row.timeframe) timeframes.add(String(row.timeframe));
    if (row.analysis_start_at) logsPresence.analysis_start_at += 1;
    if (row.decision_post_learning) logsPresence.decision_post_learning += 1;
    if (row.event_context_filter) logsPresence.event_context_filter += 1;
    if (row.manual_prealert_decision) logsPresence.manual_prealert_decision += 1;
    if (row.high_conviction_decision) logsPresence.high_conviction_decision += 1;
    if (row.profiling) logsPresence.profiling += 1;
  }

  return {
    total_predicciones_generadas: predictions.length,
    simbolos_evaluados: symbols.size,
    simbolos_muestra: Array.from(symbols).slice(0, 20),
    timeframes_usados: Array.from(timeframes).sort(),
    logs_de_prediccion: {
      present: Object.values(logsPresence).some((value) => value > 0),
      coverage: logsPresence
    }
  };
}

function buildPrealertsSection(predictions = [], signalRows = []) {
  const filteredReasons = {};
  let generated = 0;
  let filtered = 0;

  for (const row of predictions) {
    const decision = row.manual_prealert_decision || null;
    if (!decision) continue;
    if (decision.ok === true) generated += 1;
    else {
      filtered += 1;
      increment(filteredReasons, decision.reason || 'unknown');
    }
  }

  const notificationRows = signalRows.filter((row) => String(row.type || '').toLowerCase() === 'manual_prealert');

  return {
    prealerts_generados: generated,
    prealerts_filtrados: filtered,
    razones_de_filtrado_top: topEntries(filteredReasons, 10),
    notification_logs_detected: notificationRows.length > 0,
    notifications_in_window: notificationRows.length
  };
}

function buildFinalSignalsSection(predictions = []) {
  const suppressionReasons = {};
  let emitted = 0;
  let suppressed = 0;

  for (const row of predictions) {
    if (row.signal_emitted === true) emitted += 1;
    if (row.signal_emitted === false) {
      suppressed += 1;
      increment(suppressionReasons, row.suppression_reason || row.decision_post_learning?.suppression_reason || 'unknown');
    }
  }

  return {
    senales_emitidas: emitted,
    senales_suprimidas: suppressed,
    razones_de_supresion_top: topEntries(suppressionReasons, 10)
  };
}

function buildFlagsSection() {
  const eventContextEnabled = String(process.env.EVENT_CONTEXT_FILTER_ENABLED || 'false').toLowerCase() === 'true';
  const qualityGateAuditEnabled = String(process.env.QUALITY_GATE_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
  return {
    EVENT_CONTEXT_FILTER_ENABLED: {
      active: eventContextEnabled,
      mode: process.env.EVENT_CONTEXT_FILTER_MODE || 'observe'
    },
    SIGNAL_RANKING_ENABLED: {
      active: SIGNAL_RANKING_ENABLED
    },
    QUALITY_GATE_ENABLED: {
      active: true,
      mode: 'codepath_active'
    },
    QUALITY_GATE_AUDIT_ENABLED: {
      active: qualityGateAuditEnabled
    },
    MANUAL_PREALERTS_ENABLED: {
      active: String(process.env.MANUAL_PREALERTS_ENABLED || 'true').toLowerCase() !== 'false'
    },
    FEATURE_VELAS_MODEL_ENABLED: {
      active: String(process.env.FEATURE_VELAS_MODEL_ENABLED || 'false').toLowerCase() === 'true'
    },
    SCHEDULER_AUDIT_ENABLED: {
      active: String(process.env.SCHEDULER_AUDIT_ENABLED || 'false').toLowerCase() === 'true'
    },
    DIAGNOSTIC_MODE: {
      active: String(process.env.DIAGNOSTIC_MODE || 'false').toLowerCase() === 'true'
    }
  };
}

function buildAutomaticDiagnostic(context = {}) {
  const scheduler = context.scheduler || {};
  const predictions = context.predictions || {};
  const prealerts = context.prealerts || {};
  const finalSignals = context.finalSignals || {};

  const staleScheduler =
    scheduler.executions_in_window === 0 ||
    (toNumber(scheduler.gap_vs_expected?.ratio_vs_expected, null) != null &&
      Number(scheduler.gap_vs_expected.ratio_vs_expected) > 2.5) ||
    Boolean(scheduler.runtime_state?.last_error);
  const pipelineGeneratedPredictions = Number(predictions.total_predicciones_generadas || 0) > 0;
  const pipelineGeneratedAnyFinalSignal =
    Number(finalSignals.senales_emitidas || 0) + Number(finalSignals.senales_suprimidas || 0) > 0;
  if (staleScheduler) {
    return 'scheduler_down';
  }
  if (!pipelineGeneratedPredictions) {
    return 'no_predictions';
  }
  if (pipelineGeneratedPredictions && !pipelineGeneratedAnyFinalSignal) {
    return 'filtered_before_signal';
  }
  return 'no_market_conditions';
}

async function getSignalGenerationDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);

  const [predictionRows, snapshotRows, signalRows] = await Promise.all([
    loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs),
    loadRecentRows(db, 'velas_monitoring_snapshots', 'created_at', Math.min(maxDocs, 1500)),
    loadRecentRows(db, 'telegram_notifications', 'created_at', Math.min(maxDocs, 1000)).catch(() => [])
  ]);

  const predictions = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const inWindowSignals = signalRows.filter((row) => {
    const ts = resolveSignalTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const prealertRuntime = getPreAlertRuntimeMetrics();
  const scheduler = buildSchedulerSection(snapshotRows, prealertRuntime, since, until);
  const predictionsSection = buildPredictionsSection(predictions);
  const prealertsSection = buildPrealertsSection(predictions, inWindowSignals);
  const finalSignalsSection = buildFinalSignalsSection(predictions);
  const flags = buildFlagsSection();
  const diagnosis = buildAutomaticDiagnostic({
    scheduler,
    predictions: predictionsSection,
    prealerts: prealertsSection,
    finalSignals: finalSignalsSection
  });

  return {
    scheduler_runs: Number(scheduler.executions_in_window || 0),
    last_run_ts: scheduler.last_execution_at || null,
    predictions_count: Number(predictionsSection.total_predicciones_generadas || 0),
    prealerts_count: Number(prealertsSection.prealerts_generados || 0),
    signals_emitted: Number(finalSignalsSection.senales_emitidas || 0),
    signals_suppressed: Number(finalSignalsSection.senales_suprimidas || 0),
    top_suppression_reason: finalSignalsSection.razones_de_supresion_top?.[0]?.key || null,
    flags: {
      EVENT_CONTEXT_FILTER_ENABLED: Boolean(flags.EVENT_CONTEXT_FILTER_ENABLED?.active),
      SIGNAL_RANKING_ENABLED: Boolean(flags.SIGNAL_RANKING_ENABLED?.active),
      QUALITY_GATE_ENABLED: Boolean(flags.QUALITY_GATE_ENABLED?.active)
    },
    diagnosis
  };
}

module.exports = {
  getSignalGenerationDiagnostic
};
