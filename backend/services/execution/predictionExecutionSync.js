const { FieldValue } = require('firebase-admin/firestore');

function isTerminalIntentStatus(status) {
  const normalized = String(status || '').toLowerCase();
  return ['skipped', 'failed', 'dry_run', 'blocked', 'executed'].includes(normalized);
}

function shouldExpirePrediction(currentStatus, intentStatus) {
  const normalizedCurrent = String(currentStatus || '').toLowerCase();
  const normalizedIntent = String(intentStatus || '').toLowerCase();
  if (!['skipped', 'failed', 'dry_run', 'blocked'].includes(normalizedIntent)) return false;
  return !normalizedCurrent || normalizedCurrent === 'pendiente';
}

async function resolvePredictionDocRef(db, predictionId) {
  if (!db || !predictionId) return null;
  const directRef = db.collection('velas_predicciones').doc(predictionId);
  try {
    const directDoc = await directRef.get();
    if (directDoc.exists) return directRef;
  } catch (_) {
    // fall through
  }

  try {
    const snap = await db.collection('velas_predicciones').where('prediction_id', '==', predictionId).limit(1).get();
    if (!snap.empty) return snap.docs[0].ref;
  } catch (_) {
    return null;
  }

  return null;
}

async function resolveHighConvictionSignalRef(db, predictionId) {
  if (!db || !predictionId) return null;
  try {
    const snap = await db
      .collection('high_conviction_signals')
      .where('prediction_id', '==', predictionId)
      .limit(1)
      .get();
    if (!snap.empty) return snap.docs[0].ref;
  } catch (_) {
    return null;
  }
  return null;
}

function buildBinanceExecutionPayload({
  sourceProfile,
  status,
  reason,
  dryRun,
  executed,
  orderId,
  traceId,
  symbol,
  failureStage,
  errorMessage
}) {
  const normalizedStatus = String(status || '').toLowerCase();
  return {
    attempted: normalizedStatus !== 'dry_run' ? normalizedStatus !== 'unknown' : true,
    executed: Boolean(executed || normalizedStatus === 'executed'),
    dry_run: Boolean(dryRun || normalizedStatus === 'dry_run'),
    reason: reason || null,
    order_id: orderId || null,
    source_profile: sourceProfile || null,
    intent_status: normalizedStatus || null,
    failure_stage: failureStage || null,
    error_message: errorMessage || null,
    trace_id: traceId || null,
    symbol: symbol || null,
    updated_at: new Date().toISOString()
  };
}

function normalizeTradeOutcome(value) {
  const raw = String(value || '').toUpperCase();
  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS')) return 'LOSS';
  if (raw.includes('BREAKEVEN')) return 'BREAKEVEN';
  return null;
}

function mapTradeOutcomeToStatus(outcome) {
  if (outcome === 'WIN') return 'validado';
  if (outcome === 'LOSS') return 'fallido';
  if (outcome === 'BREAKEVEN') return 'validado-parcial';
  return null;
}

function buildClosedTradeExecutionPayload(options = {}) {
  const executedPayload = buildBinanceExecutionPayload({
    sourceProfile: options.sourceProfile,
    status: 'executed',
    reason: options.closeReason || null,
    executed: true,
    orderId: options.orderId || null,
    traceId: options.traceId || null,
    symbol: options.symbol || null
  });
  const tradeOutcome = normalizeTradeOutcome(options.winExchangeNet || options.winExchange);
  return {
    ...executedPayload,
    linked_position_id: options.positionId || null,
    closed_at: options.closedAt || null,
    close_reason: options.closeReason || null,
    close_pnl_pct: Number.isFinite(Number(options.closePnlPct)) ? Number(options.closePnlPct) : null,
    net_close_pnl_pct: Number.isFinite(Number(options.netClosePnlPct)) ? Number(options.netClosePnlPct) : null,
    win_exchange: options.winExchange || null,
    win_exchange_net: options.winExchangeNet || null,
    verification_outcome: tradeOutcome,
    updated_at: options.closedAt || new Date().toISOString()
  };
}

async function syncPredictionExecutionState(db, options = {}) {
  const predictionId = options.predictionId || null;
  if (!db || !predictionId || !isTerminalIntentStatus(options.status)) {
    return { prediction_synced: false, high_conviction_synced: false };
  }

  const nowIso = new Date().toISOString();
  const intentStatus = String(options.status || '').toLowerCase();
  const binanceExecution = buildBinanceExecutionPayload(options);
  let predictionSynced = false;
  let highConvictionSynced = false;

  const predictionRef = await resolvePredictionDocRef(db, predictionId);
  if (predictionRef) {
    try {
      const predictionSnap = await predictionRef.get();
      if (predictionSnap.exists) {
        const current = predictionSnap.data() || {};
        const payload = {
          binance_execution: binanceExecution,
          binance_terminal_status: intentStatus,
          binance_terminal_reason: options.reason || null,
          binance_terminal_at: nowIso,
          updated_at: nowIso
        };
        if (shouldExpirePrediction(current.status, intentStatus)) {
          payload.status = 'expirada';
          payload.completed_at = nowIso;
          payload.pending_state_resolution = options.pendingStateResolution || 'binance_terminal_sync';
          payload.pending_state_resolved_at = nowIso;
        }
        await predictionRef.set(payload, { merge: true });
        predictionSynced = true;
      }
    } catch (err) {
      console.warn('[PREDICTION_EXECUTION_SYNC] prediction sync failed', predictionId, err.message);
    }
  }

  if (String(options.sourceProfile || '').toLowerCase() === 'high_conviction') {
    const hcRef = await resolveHighConvictionSignalRef(db, predictionId);
    if (hcRef) {
      try {
        const hcSnap = await hcRef.get();
        if (hcSnap.exists) {
          const current = hcSnap.data() || {};
          const payload = {
            binance_execution: binanceExecution,
            updated_at: FieldValue.serverTimestamp()
          };
          if (shouldExpirePrediction(current.status, intentStatus)) {
            payload.status = 'expirada';
            payload.verification_outcome = 'EXPIRED';
            payload.completed_at = nowIso;
            payload.pending_state_resolution = options.pendingStateResolution || 'binance_terminal_sync';
          }
          await hcRef.set(payload, { merge: true });
          highConvictionSynced = true;
        }
      } catch (err) {
        console.warn('[PREDICTION_EXECUTION_SYNC] high conviction sync failed', predictionId, err.message);
      }
    }
  }

  return {
    prediction_synced: predictionSynced,
    high_conviction_synced: highConvictionSynced
  };
}

async function syncPredictionClosedTradeState(db, options = {}) {
  const predictionId = options.predictionId || null;
  if (!db || !predictionId) {
    return { prediction_synced: false, high_conviction_synced: false };
  }

  const tradeOutcome = normalizeTradeOutcome(options.winExchangeNet || options.winExchange);
  const mappedStatus = mapTradeOutcomeToStatus(tradeOutcome);
  const closedAtIso = options.closedAt || new Date().toISOString();
  const binanceExecution = buildClosedTradeExecutionPayload({
    ...options,
    closedAt: closedAtIso
  });
  const tradeClose = {
    position_id: options.positionId || null,
    source_profile: options.sourceProfile || null,
    symbol: options.symbol || null,
    closed_at: closedAtIso,
    close_reason: options.closeReason || null,
    close_pnl_pct: Number.isFinite(Number(options.closePnlPct)) ? Number(options.closePnlPct) : null,
    net_close_pnl_pct: Number.isFinite(Number(options.netClosePnlPct)) ? Number(options.netClosePnlPct) : null,
    win_exchange: options.winExchange || null,
    win_exchange_net: options.winExchangeNet || null
  };

  let predictionSynced = false;
  let highConvictionSynced = false;

  const predictionRef = await resolvePredictionDocRef(db, predictionId);
  if (predictionRef) {
    try {
      const payload = {
        binance_execution: binanceExecution,
        binance_terminal_status: 'executed',
        binance_terminal_reason: options.closeReason || null,
        binance_terminal_at: closedAtIso,
        verification_outcome: tradeOutcome,
        completed_at: closedAtIso,
        trade_close: tradeClose,
        updated_at: closedAtIso
      };
      if (mappedStatus) {
        payload.status = mappedStatus;
      }
      await predictionRef.set(payload, { merge: true });
      predictionSynced = true;
    } catch (err) {
      console.warn('[PREDICTION_EXECUTION_SYNC] prediction close sync failed', predictionId, err.message);
    }
  }

  if (String(options.sourceProfile || '').toLowerCase() === 'high_conviction') {
    const hcRef = await resolveHighConvictionSignalRef(db, predictionId);
    if (hcRef) {
      try {
        const payload = {
          binance_execution: binanceExecution,
          linked_position_id: options.positionId || null,
          verification_outcome: tradeOutcome,
          completed_at: closedAtIso,
          trade_close: tradeClose,
          updated_at: FieldValue.serverTimestamp()
        };
        if (mappedStatus) {
          payload.status = mappedStatus;
        }
        await hcRef.set(payload, { merge: true });
        highConvictionSynced = true;
      } catch (err) {
        console.warn('[PREDICTION_EXECUTION_SYNC] high conviction close sync failed', predictionId, err.message);
      }
    }
  }

  return {
    prediction_synced: predictionSynced,
    high_conviction_synced: highConvictionSynced
  };
}

module.exports = {
  resolvePredictionDocRef,
  syncPredictionExecutionState,
  syncPredictionClosedTradeState
};
