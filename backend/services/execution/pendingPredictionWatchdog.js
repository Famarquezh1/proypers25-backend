const { FieldValue } = require('firebase-admin/firestore');

const STALE_PENDING_PREDICTION_TIMEOUT_MS = Math.max(
  60000,
  Number(process.env.PREDICTION_PENDING_TIMEOUT_MS || 120000)
);
const STALE_PENDING_PREDICTION_SCAN_LIMIT = Math.max(
  10,
  Number(process.env.PREDICTION_PENDING_SCAN_LIMIT || 100)
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

async function syncHighConvictionExpiredStatus(db, predictionId, executedAtIso) {
  if (!db || !predictionId) return;
  try {
    const snap = await db.collection('high_conviction_signals')
      .where('prediction_id', '==', predictionId)
      .limit(1)
      .get();
    if (snap.empty) return;
    await snap.docs[0].ref.set({
      status: 'expirada',
      verification_outcome: 'EXPIRED',
      completed_at: executedAtIso,
      pending_state_resolution: 'expired_watchdog',
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
  } catch (err) {
    console.warn('[PENDING_STATE_RESOLVED] high conviction sync failed', predictionId, err.message);
  }
}

function resolvePendingOutcome(data, now, staleAfterMs) {
  const createdAt = parseDateLike(data.created_at || data.timestamp || data.signal_created_at || data.ahora);
  const ageMs = createdAt ? (now - createdAt.getTime()) : null;
  const binanceExecution = data.binance_execution || {};
  const hasExecutionFailure = Boolean(
    binanceExecution.attempted &&
    binanceExecution.executed === false &&
    binanceExecution.reason
  );

  if (hasExecutionFailure) {
    return {
      shouldResolve: true,
      resolution: 'entry_discipline_failed_watchdog',
      remarks: `Pending state resolved after failed execution attempt: ${binanceExecution.reason}.`,
      ageMs
    };
  }

  if (!createdAt || ageMs === null || ageMs < staleAfterMs || data.completed_at) {
    return { shouldResolve: false, ageMs };
  }

  return {
    shouldResolve: true,
    resolution: 'expired_watchdog',
    remarks: 'Pending state resolved by watchdog after timeout.',
    ageMs
  };
}

async function reapStalePendingPredictions(db, options = {}) {
  if (!db) return { scanned: 0, resolved: 0, stale_ids: [] };
  const staleAfterMs = Math.max(
    60000,
    Number(options.staleAfterMs || STALE_PENDING_PREDICTION_TIMEOUT_MS)
  );
  const limit = Math.max(10, Number(options.limit || STALE_PENDING_PREDICTION_SCAN_LIMIT));
  const now = Date.now();
  const snap = await db.collection('velas_predicciones')
    .where('status', '==', 'pendiente')
    .limit(limit)
    .get();

  let resolved = 0;
  const staleIds = [];

  for (const doc of snap.docs) {
    const data = doc.data() || {};
    const outcome = resolvePendingOutcome(data, now, staleAfterMs);
    if (!outcome.shouldResolve) continue;

    const executedAtIso = new Date().toISOString();
    await doc.ref.set({
      status: 'expirada',
      expired: true,
      completed_at: executedAtIso,
      pending_state_resolution: outcome.resolution,
      pending_state_resolved_at: executedAtIso,
      verification: {
        executed_at: executedAtIso,
        verification_outcome: 'EXPIRED',
        outcome_label: 'EXPIRED',
        remarks: outcome.remarks,
        method: 'pending_watchdog_v1'
      },
      updated_at: FieldValue.serverTimestamp()
    }, { merge: true });

    await syncHighConvictionExpiredStatus(db, doc.id, executedAtIso);

    console.info('[PENDING_STATE_RESOLVED]', {
      prediction_id: doc.id,
      symbol: data.simbolo || data.symbol || 'UNKNOWN',
      age_ms: outcome.ageMs,
      resolution: outcome.resolution
    });

    resolved += 1;
    staleIds.push(doc.id);
  }

  return {
    scanned: snap.size,
    resolved,
    stale_ids: staleIds
  };
}

module.exports = {
  STALE_PENDING_PREDICTION_TIMEOUT_MS,
  reapStalePendingPredictions
};
