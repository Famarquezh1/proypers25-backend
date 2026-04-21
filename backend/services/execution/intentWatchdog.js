const { FieldValue } = require('firebase-admin/firestore');
const { syncPredictionExecutionState } = require('./predictionExecutionSync');

const INTENT_STAGE_TIMEOUT_MS = Math.max(
  15000,
  Number(process.env.BINANCE_INTENT_STAGE_TIMEOUT_MS || 30000)
);
const STALE_PROCESSING_TIMEOUT_MS = Math.max(
  INTENT_STAGE_TIMEOUT_MS * 3,
  Number(process.env.BINANCE_INTENT_STALE_TIMEOUT_MS || 120000)
);
const STALE_PROCESSING_SCAN_LIMIT = Math.max(
  10,
  Number(process.env.BINANCE_INTENT_STALE_SCAN_LIMIT || 100)
);

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function buildTimeoutError(label, timeoutMs) {
  const err = new Error(`timeout after ${timeoutMs}ms (${label})`);
  err.name = 'IntentTimeoutError';
  err.timeoutMs = timeoutMs;
  err.failureStage = label;
  return err;
}

function resolveProcessingHeartbeatDate(data = {}) {
  return (
    parseDateLike(data.processing_stage_updated_at) ||
    parseDateLike(data.updated_at) ||
    parseDateLike(data.processing_started_at) ||
    parseDateLike(data.created_at)
  );
}

async function withTimeout(promise, timeoutMs = INTENT_STAGE_TIMEOUT_MS, label = 'intent_stage') {
  let timer = null;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(buildTimeoutError(label, timeoutMs)), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

async function updateIntentProcessingStage(ref, stage, payload = {}) {
  if (!ref || !stage) return;
  await ref.set(
    {
      processing_stage: stage,
      processing_stage_updated_at: new Date().toISOString(),
      ...payload,
      updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function markIntentFailed(ref, payload = {}) {
  if (!ref) return;
  await ref.set(
    {
      status: 'failed',
      reason: payload.reason || 'failed_timeout',
      failure_stage: payload.failure_stage || payload.processing_stage || 'unknown',
      error_message: payload.error_message || payload.reason || 'intent_failed',
      processing_stage: payload.processing_stage || payload.failure_stage || 'failed',
      failed_at: new Date().toISOString(),
      updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function reapStaleProcessingIntents(db, options = {}) {
  if (!db) return { scanned: 0, reaped: 0, stale_ids: [] };
  const staleAfterMs = Math.max(
    10000,
    Number(options.staleAfterMs || STALE_PROCESSING_TIMEOUT_MS)
  );
  const limit = Math.max(10, Number(options.limit || STALE_PROCESSING_SCAN_LIMIT));
  const now = Date.now();
  const snap = await db.collection('binance_execution_intents')
    .where('status', '==', 'processing')
    .limit(limit)
    .get();

  let reaped = 0;
  const staleIds = [];
  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const heartbeatAt = resolveProcessingHeartbeatDate(data);
    if (!heartbeatAt) continue;
    if (now - heartbeatAt.getTime() < staleAfterMs) continue;
    console.warn('[EXECUTION_TIMEOUT_PATH]', {
      prediction_id: data.prediction_id || null,
      symbol: data.symbol || null,
      stage: data.processing_stage || 'processing',
      timeout_ms: staleAfterMs,
      reason: 'processing_timeout_watchdog'
    });
    await doc.ref.set(
      {
        status: 'failed',
        reason: 'failed_timeout',
        failure_stage: 'processing_timeout_watchdog',
        processing_stage: data.processing_stage || 'processing',
        error_message: 'processing intent exceeded timeout watchdog threshold',
        watchdog_reaped: true,
        watchdog_reaped_at: new Date().toISOString(),
        updated_at: FieldValue.serverTimestamp()
      },
      { merge: true }
    );
    if (data.prediction_id) {
      await syncPredictionExecutionState(db, {
        predictionId: data.prediction_id,
        sourceProfile: data.source_profile || data.source || null,
        status: 'failed',
        reason: 'failed_timeout',
        dryRun: false,
        executed: false,
        traceId: data.trace_id || null,
        symbol: data.symbol || null,
        failureStage: 'processing_timeout_watchdog',
        errorMessage: 'processing intent exceeded timeout watchdog threshold',
        pendingStateResolution: 'processing_timeout_watchdog'
      });
    }
    reaped += 1;
    staleIds.push(doc.id);
  }

  return {
    scanned: snap.size,
    reaped,
    stale_ids: staleIds
  };
}

module.exports = {
  INTENT_STAGE_TIMEOUT_MS,
  STALE_PROCESSING_TIMEOUT_MS,
  withTimeout,
  updateIntentProcessingStage,
  markIntentFailed,
  reapStaleProcessingIntents
};
