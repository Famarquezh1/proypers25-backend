const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');

const LATENCY_LOOKBACK_HOURS = Math.max(
  6,
  Math.min(24 * 30, Number(process.env.EXECUTION_LATENCY_LOOKBACK_HOURS || 72))
);
const LATENCY_LOG_LIMIT = Math.max(
  100,
  Math.min(5000, Number(process.env.EXECUTION_LATENCY_LOG_LIMIT || 1000))
);
const ENTRY_WINDOW_SECONDS = Math.max(5, Math.min(35, Number(process.env.ENTRY_WINDOW_SECONDS || 30)));

const TRACE_STAGE_KEYS = [
  'signal_to_emit_ms',
  'emit_to_intent_ms',
  'intent_to_process_ms',
  'process_to_attempt_ms',
  'attempt_to_order_ms'
];

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function toMsOrNull(value) {
  const date = parseDateLike(value);
  return date ? date.getTime() : null;
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean' || typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, entryValue]) => {
      const normalized = normalizeValue(entryValue);
      if (normalized !== undefined) acc[key] = normalized;
      return acc;
    }, {});
  }
  return value;
}

function sameJson(a, b) {
  return JSON.stringify(normalizeValue(a)) === JSON.stringify(normalizeValue(b));
}

function resolvePredictionId(signalData = {}) {
  return signalData?.prediction_id || signalData?.id || null;
}

function resolveSignalCreatedAtMs(signalData = {}) {
  return (
    toMsOrNull(signalData.signal_created_at) ||
    toMsOrNull(signalData.created_at) ||
    toMsOrNull(signalData.timestamp) ||
    toMsOrNull(signalData.ahora) ||
    toMsOrNull(signalData.entry_time)
  );
}

function resolveSignalEmittedAtMs(signalData = {}) {
  return (
    toMsOrNull(signalData.signal_emitted_at) ||
    toMsOrNull(signalData.emitted_at) ||
    resolveSignalCreatedAtMs(signalData)
  );
}

function buildInitialExecutionTrace(signalData = {}) {
  const signalCreatedAt = resolveSignalCreatedAtMs(signalData);
  const signalEmittedAt = resolveSignalEmittedAtMs(signalData);
  const now = Date.now();

  return {
    trace_id: signalData?.trace_id || crypto.randomUUID(),
    signal_created_at: signalCreatedAt,
    signal_emitted_at: signalEmittedAt,
    intent_created_at: now,
    intent_queued_at: now,
    intent_processed_at: null,
    execution_attempt_at: null,
    order_sent_at: null,
    order_ack_at: null
  };
}

function advanceExecutionTrace(trace = {}, patch = {}) {
  return {
    ...trace,
    ...patch
  };
}

function delta(from, to) {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  return Math.max(0, to - from);
}

function lastTraceTimestamp(trace = {}) {
  return [
    trace.order_ack_at,
    trace.order_sent_at,
    trace.execution_attempt_at,
    trace.intent_processed_at,
    trace.intent_queued_at,
    trace.intent_created_at,
    trace.signal_emitted_at,
    trace.signal_created_at
  ].find((value) => Number.isFinite(value)) || null;
}

function computeExecutionTraceMetrics(trace = {}) {
  const metrics = {
    signal_to_emit_ms: delta(trace.signal_created_at, trace.signal_emitted_at),
    emit_to_intent_ms: delta(trace.signal_emitted_at, trace.intent_created_at),
    intent_to_process_ms: delta(trace.intent_queued_at, trace.intent_processed_at),
    process_to_attempt_ms: delta(trace.intent_processed_at, trace.execution_attempt_at),
    attempt_to_order_ms: delta(trace.order_sent_at || trace.execution_attempt_at, trace.order_ack_at)
  };

  const totalEnd = lastTraceTimestamp(trace);
  metrics.total_latency_ms = delta(trace.signal_created_at || trace.signal_emitted_at, totalEnd);
  return metrics;
}

function dominantDelayStage(metrics = {}) {
  let winner = null;
  let maxValue = -1;
  for (const stage of TRACE_STAGE_KEYS) {
    const value = Number(metrics?.[stage]);
    if (Number.isFinite(value) && value > maxValue) {
      maxValue = value;
      winner = stage;
    }
  }
  return winner;
}

async function findSignalDocRef(db, signalData = {}) {
  if (!db) return null;
  const predictionId = resolvePredictionId(signalData);
  if (!predictionId) return null;

  const directRef = db.collection('velas_predicciones').doc(predictionId);
  try {
    const directDoc = await directRef.get();
    if (directDoc.exists) return directRef;
  } catch (_) {
    // fallback below
  }

  try {
    const snap = await db.collection('velas_predicciones').where('prediction_id', '==', predictionId).limit(1).get();
    if (!snap.empty) return snap.docs[0].ref;
  } catch (_) {
    return null;
  }
  return null;
}

async function persistExecutionTraceToSignal(db, signalData = {}, trace = {}) {
  const ref = await findSignalDocRef(db, signalData);
  if (!ref) return false;

  const traceMetrics = computeExecutionTraceMetrics(trace);
  const dominantStage = dominantDelayStage(traceMetrics);
  const payload = {
    trace_id: trace.trace_id || null,
    execution_trace: normalizeValue(trace),
    execution_trace_metrics: normalizeValue(traceMetrics),
    dominant_delay_stage: dominantStage,
    critical_delay: Number(traceMetrics.total_latency_ms || 0) > 60000
  };

  const doc = await ref.get();
  if (!doc.exists) return false;
  const current = {
    trace_id: doc.get('trace_id') || null,
    execution_trace: normalizeValue(doc.get('execution_trace') || {}),
    execution_trace_metrics: normalizeValue(doc.get('execution_trace_metrics') || {}),
    dominant_delay_stage: doc.get('dominant_delay_stage') || null,
    critical_delay: Boolean(doc.get('critical_delay'))
  };

  if (sameJson(current, payload)) return false;

  await ref.set(
    {
      ...payload,
      execution_trace_updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
  return true;
}

async function writeExecutionLatencyLog(db, payload = {}) {
  if (!db) return;
  await db.collection('execution_latency_logs').add({
    ...payload,
    created_at: FieldValue.serverTimestamp()
  });
}

async function persistExecutionLatencyObservation(db, signalData = {}, context = {}) {
  const trace = normalizeValue(context.trace || {});
  const metrics = normalizeValue(computeExecutionTraceMetrics(trace));
  const dominantStage = dominantDelayStage(metrics);
  const totalLatency = Number(metrics?.total_latency_ms || 0);
  const predictionId = resolvePredictionId(signalData);

  await persistExecutionTraceToSignal(db, signalData, trace);
  await writeExecutionLatencyLog(db, {
    trace_id: trace.trace_id || null,
    prediction_id: predictionId,
    symbol: context.symbol || signalData?.symbol || signalData?.simbolo || null,
    signal_type: context.signal_type || signalData?.source_profile || signalData?.source || 'unknown',
    state: context.state || 'observed',
    total_latency_ms: Number.isFinite(totalLatency) ? totalLatency : null,
    dominant_delay_stage: dominantStage,
    late_entry_blocked: Boolean(context.late_entry_blocked),
    critical_delay: totalLatency > 60000,
    exceeds_entry_window: totalLatency > ENTRY_WINDOW_SECONDS * 1000,
    execution_trace: trace,
    execution_trace_metrics: metrics
  });

  return {
    trace_id: trace.trace_id || null,
    execution_trace: trace,
    execution_trace_metrics: metrics,
    dominant_delay_stage: dominantStage,
    critical_delay: totalLatency > 60000
  };
}

function percentile(values = [], p = 0.5) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * p;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function getExecutionLatencySummary(db) {
  const from = new Date(Date.now() - LATENCY_LOOKBACK_HOURS * 60 * 60 * 1000);
  const snapshot = await db
    .collection('execution_latency_logs')
    .where('created_at', '>=', from)
    .orderBy('created_at', 'desc')
    .limit(LATENCY_LOG_LIMIT)
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      trace_id: data.trace_id || null,
      symbol: data.symbol || null,
      signal_type: data.signal_type || 'unknown',
      state: data.state || 'observed',
      total_latency_ms: toNum(data.total_latency_ms, null),
      dominant_delay_stage: data.dominant_delay_stage || null,
      critical_delay: Boolean(data.critical_delay),
      late_entry_blocked: Boolean(data.late_entry_blocked),
      execution_trace_metrics: normalizeValue(data.execution_trace_metrics || {})
    };
  });

  const totalLatencies = rows
    .map((row) => toNum(row.total_latency_ms, null))
    .filter((value) => Number.isFinite(value));
  const breakdown = TRACE_STAGE_KEYS.reduce((acc, stage) => {
    const values = rows
      .map((row) => toNum(row.execution_trace_metrics?.[stage], null))
      .filter((value) => Number.isFinite(value));
    acc[stage] = values.length
      ? values.reduce((sum, value) => sum + value, 0) / values.length
      : null;
    return acc;
  }, {});

  const bottleneckCounts = rows.reduce((acc, row) => {
    const stage = row.dominant_delay_stage || 'unknown';
    acc[stage] = (acc[stage] || 0) + 1;
    return acc;
  }, {});

  const topBottleneckStage = Object.entries(bottleneckCounts)
    .sort((a, b) => Number(b[1]) - Number(a[1]))[0]?.[0] || null;

  return {
    lookback_hours: LATENCY_LOOKBACK_HOURS,
    log_limit: LATENCY_LOG_LIMIT,
    entry_window_seconds: ENTRY_WINDOW_SECONDS,
    total_observations: rows.length,
    avg_total_latency: totalLatencies.length
      ? totalLatencies.reduce((sum, value) => sum + value, 0) / totalLatencies.length
      : null,
    p50_latency: percentile(totalLatencies, 0.5),
    p95_latency: percentile(totalLatencies, 0.95),
    max_latency: totalLatencies.length ? Math.max(...totalLatencies) : null,
    critical_delay_count: rows.filter((row) => row.critical_delay).length,
    late_entry_blocked_count: rows.filter((row) => row.late_entry_blocked).length,
    top_bottleneck_stage: topBottleneckStage,
    bottleneck_stage_counts: bottleneckCounts,
    breakdown,
    recent: rows.slice(0, 25)
  };
}

module.exports = {
  ENTRY_WINDOW_SECONDS,
  buildInitialExecutionTrace,
  advanceExecutionTrace,
  computeExecutionTraceMetrics,
  dominantDelayStage,
  persistExecutionLatencyObservation,
  getExecutionLatencySummary
};
