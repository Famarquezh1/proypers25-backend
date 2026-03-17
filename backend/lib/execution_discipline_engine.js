const { FieldValue } = require('firebase-admin/firestore');
const { buildExecutionDisciplineMetrics } = require('./signal_adherence_monitor');

const EXECUTION_DISCIPLINE_ENABLED =
  String(process.env.EXECUTION_DISCIPLINE_ENABLED || 'true').toLowerCase() !== 'false';
const EXECUTION_DISCIPLINE_MODE = String(process.env.EXECUTION_DISCIPLINE_MODE || 'enforce').toLowerCase();
const ENTRY_WINDOW_SECONDS = Math.max(5, Number(process.env.ENTRY_WINDOW_SECONDS || 20));
const EARLY_EXIT_TP_RATIO = Math.max(0.1, Math.min(1, Number(process.env.EARLY_EXIT_TP_RATIO || 0.6)));
const PROFIT_CAPTURE_TARGET = Math.max(0.1, Math.min(1, Number(process.env.PROFIT_CAPTURE_TARGET || 0.4)));
const SLIPPAGE_THRESHOLD_PCT = Math.max(0.01, Number(process.env.EXECUTION_SLIPPAGE_THRESHOLD_PCT || 0.35));
const EXECUTION_SCORE_MIN = Math.max(0, Math.min(100, Number(process.env.EXECUTION_SCORE_MIN || 70)));
const SUMMARY_LOOKBACK_HOURS = Math.max(6, Math.min(24 * 30, Number(process.env.EXECUTION_DISCIPLINE_LOOKBACK_HOURS || 72)));
const LOG_LIMIT = Math.max(50, Math.min(2000, Number(process.env.EXECUTION_DISCIPLINE_LOG_LIMIT || 500)));

function nowIso() {
  return new Date().toISOString();
}

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

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function resolveSignalTime(signalData = {}) {
  return (
    parseDateLike(signalData.signal_at) ||
    parseDateLike(signalData.created_at) ||
    parseDateLike(signalData.timestamp) ||
    parseDateLike(signalData.ahora) ||
    parseDateLike(signalData.entry_time)
  );
}

function resolveExpectedTpPct(entity = {}) {
  const entry = toNum(
    entity.entry_price ?? entity.trade_plan?.entry_price ?? entity.intent?.entry_price,
    null
  );
  const takeProfit = toNum(
    entity.take_profit ?? entity.trade_plan?.take_profit ?? entity.intent?.take_profit,
    null
  );
  if (!Number.isFinite(entry) || !Number.isFinite(takeProfit) || entry <= 0) return null;
  return Math.abs(((takeProfit - entry) / entry) * 100);
}

function resolveStopLoss(entity = {}) {
  return toNum(entity.stop_loss ?? entity.trade_plan?.stop_loss ?? entity.intent?.stop_loss, null);
}

function resolveRealEntryPrice(orderResponse = {}, fallback = null) {
  const avgPrice = toNum(orderResponse?.avgPrice, null);
  if (Number.isFinite(avgPrice) && avgPrice > 0) return avgPrice;

  const executedQty = toNum(orderResponse?.executedQty, null);
  const cumQuote = toNum(orderResponse?.cumQuote, null);
  if (Number.isFinite(executedQty) && executedQty > 0 && Number.isFinite(cumQuote) && cumQuote > 0) {
    return cumQuote / executedQty;
  }

  return toNum(fallback, null);
}

function isEnforceMode() {
  return EXECUTION_DISCIPLINE_ENABLED && EXECUTION_DISCIPLINE_MODE !== 'observe';
}

async function writeExecutionDisciplineRecord(db, collectionName, payload = {}) {
  if (!db || !collectionName) return;
  await db.collection(collectionName).add({
    ...payload,
    created_at: FieldValue.serverTimestamp()
  });
}

async function logExecutionDiscipline(db, payload = {}) {
  if (!EXECUTION_DISCIPLINE_ENABLED || !db) return;
  const enriched = {
    enabled: EXECUTION_DISCIPLINE_ENABLED,
    mode: EXECUTION_DISCIPLINE_MODE,
    ...payload
  };
  await Promise.all([
    writeExecutionDisciplineRecord(db, 'execution_discipline_logs', enriched),
    writeExecutionDisciplineRecord(db, 'execution_events', enriched)
  ]);
}

async function readCurrentExecutionScore(db) {
  try {
    const doc = await db.collection('analytics_snapshots').doc('signal_intelligence_dashboard_v1').get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    return toNum(
      data?.execution?.report?.execution_discipline?.execution_discipline_score ??
        data?.intelligence?.report?.execution_discipline?.execution_discipline_score,
      null
    );
  } catch (_) {
    return null;
  }
}

async function evaluateEntryDiscipline({ db, signalData = {}, intent = {}, sourceProfile = 'event_emitted' }) {
  if (!EXECUTION_DISCIPLINE_ENABLED) {
    return { blocked: false, reason: null, details: { enabled: false } };
  }

  const signalTime = resolveSignalTime(signalData);
  const now = new Date();
  const lateBySeconds =
    signalTime && Number.isFinite(signalTime.getTime())
      ? (now.getTime() - signalTime.getTime()) / 1000
      : null;
  if (lateBySeconds != null && lateBySeconds > ENTRY_WINDOW_SECONDS) {
    const details = {
      signal_time: signalTime.toISOString(),
      checked_at: now.toISOString(),
      late_by_seconds: Math.round(lateBySeconds * 1000) / 1000,
      entry_window_seconds: ENTRY_WINDOW_SECONDS
    };
    await logExecutionDiscipline(db, {
      type: 'entry_control',
      event: 'late_entry_blocked',
      blocked: isEnforceMode(),
      source_profile: sourceProfile,
      symbol: intent.symbol || signalData.symbol || signalData.simbolo || null,
      prediction_id: signalData.prediction_id || signalData.id || null,
      details
    });
    return {
      blocked: isEnforceMode(),
      reason: 'late_entry_blocked',
      details
    };
  }

  const executionScore = await readCurrentExecutionScore(db);
  if (executionScore != null && executionScore < EXECUTION_SCORE_MIN) {
    const details = {
      execution_score: executionScore,
      minimum_required: EXECUTION_SCORE_MIN
    };
    await logExecutionDiscipline(db, {
      type: 'entry_control',
      event: 'execution_protection_mode',
      blocked: isEnforceMode(),
      source_profile: sourceProfile,
      symbol: intent.symbol || signalData.symbol || signalData.simbolo || null,
      prediction_id: signalData.prediction_id || signalData.id || null,
      details
    });
    return {
      blocked: isEnforceMode(),
      reason: 'execution_protection_mode',
      details
    };
  }

  return {
    blocked: false,
    reason: null,
    details: {
      execution_score: executionScore,
      entry_window_seconds: ENTRY_WINDOW_SECONDS
    }
  };
}

async function evaluateFilledOrderDiscipline({
  db,
  signalData = {},
  intent = {},
  orderResponse = {},
  sourceProfile = 'event_emitted'
}) {
  if (!EXECUTION_DISCIPLINE_ENABLED) {
    return { blocked: false, reason: null, details: { enabled: false } };
  }

  const modelEntry = toNum(intent.entry_price, null);
  const realEntry = resolveRealEntryPrice(orderResponse, modelEntry);
  const slippagePct =
    Number.isFinite(modelEntry) && modelEntry > 0 && Number.isFinite(realEntry)
      ? Math.abs(((realEntry - modelEntry) / modelEntry) * 100)
      : null;

  if (slippagePct != null && slippagePct > SLIPPAGE_THRESHOLD_PCT) {
    const details = {
      model_entry: modelEntry,
      real_entry: realEntry,
      slippage_pct: slippagePct,
      threshold_pct: SLIPPAGE_THRESHOLD_PCT
    };
    await logExecutionDiscipline(db, {
      type: 'slippage_control',
      event: 'slippage_blocked',
      blocked: isEnforceMode(),
      source_profile: sourceProfile,
      symbol: intent.symbol || signalData.symbol || signalData.simbolo || null,
      prediction_id: signalData.prediction_id || signalData.id || null,
      details
    });
    return {
      blocked: isEnforceMode(),
      reason: 'slippage_blocked',
      details
    };
  }

  return {
    blocked: false,
    reason: null,
    details: {
      model_entry: modelEntry,
      real_entry: realEntry,
      slippage_pct: slippagePct
    }
  };
}

function evaluatePositionDiscipline(position = {}, markPrice, context = {}) {
  if (!EXECUTION_DISCIPLINE_ENABLED) {
    return { forceClose: false, blockExit: false, armProfitCapture: false, details: { enabled: false } };
  }

  const side = String(position?.side || '').toUpperCase();
  const entry = toNum(position?.entry_price, null);
  const stopLoss = resolveStopLoss(position);
  const pnlPct = toNum(context.pnl_pct, null);
  const requestedReason = String(context.requested_reason || '');
  const expectedTpPct = resolveExpectedTpPct(position);
  const captureTriggerPct = Number.isFinite(expectedTpPct) ? expectedTpPct * PROFIT_CAPTURE_TARGET : null;
  const earlyExitBlockPct = Number.isFinite(expectedTpPct) ? expectedTpPct * EARLY_EXIT_TP_RATIO : null;
  const currentMaxSeen = Math.max(toNum(position?.profit_capture_max_seen_pct, 0) || 0, toNum(pnlPct, 0) || 0);
  const profitCaptureArmed = Boolean(position?.profit_capture_armed);
  const lockFloorPct = Number.isFinite(captureTriggerPct)
    ? Math.max(captureTriggerPct * 0.25, currentMaxSeen * 0.55)
    : null;

  if (
    Number.isFinite(stopLoss) &&
    Number.isFinite(markPrice) &&
    ((side === 'BUY' && markPrice <= stopLoss) || (side === 'SELL' && markPrice >= stopLoss))
  ) {
    return {
      forceClose: true,
      forceReason: 'sl_violation_forced',
      blockExit: false,
      armProfitCapture: false,
      details: {
        mark_price: markPrice,
        stop_loss: stopLoss,
        pnl_pct: pnlPct
      }
    };
  }

  if (
    requestedReason.startsWith('early_exit') &&
    Number.isFinite(pnlPct) &&
    pnlPct >= 0 &&
    Number.isFinite(earlyExitBlockPct) &&
    pnlPct < earlyExitBlockPct
  ) {
    return {
      forceClose: false,
      blockExit: true,
      blockReason: 'early_exit_blocked',
      armProfitCapture: false,
      details: {
        pnl_pct: pnlPct,
        expected_tp_pct: expectedTpPct,
        early_exit_threshold_pct: earlyExitBlockPct
      }
    };
  }

  if (!profitCaptureArmed && Number.isFinite(pnlPct) && Number.isFinite(captureTriggerPct) && pnlPct >= captureTriggerPct) {
    return {
      forceClose: false,
      blockExit: false,
      armProfitCapture: true,
      details: {
        pnl_pct: pnlPct,
        capture_trigger_pct: captureTriggerPct,
        lock_floor_pct: lockFloorPct
      }
    };
  }

  if (
    profitCaptureArmed &&
    Number.isFinite(pnlPct) &&
    Number.isFinite(lockFloorPct) &&
    pnlPct > 0 &&
    pnlPct <= lockFloorPct
  ) {
    return {
      forceClose: true,
      forceReason: 'profit_capture_enforced',
      blockExit: false,
      armProfitCapture: false,
      details: {
        pnl_pct: pnlPct,
        capture_trigger_pct: captureTriggerPct,
        lock_floor_pct: lockFloorPct,
        max_seen_pct: currentMaxSeen
      }
    };
  }

  return {
    forceClose: false,
    blockExit: false,
    armProfitCapture: false,
    details: {
      pnl_pct: pnlPct,
      expected_tp_pct: expectedTpPct,
      capture_trigger_pct: captureTriggerPct,
      max_seen_pct: currentMaxSeen
    }
  };
}

async function getExecutionDisciplineSummary(db) {
  const from = new Date(Date.now() - SUMMARY_LOOKBACK_HOURS * 60 * 60 * 1000);
  const snapshot = await db
    .collection('execution_discipline_logs')
    .where('created_at', '>=', from)
    .orderBy('created_at', 'desc')
    .limit(LOG_LIMIT)
    .get();

  const rows = snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      id: doc.id,
      type: String(data.type || 'unknown'),
      event: String(data.event || 'unknown'),
      blocked: Boolean(data.blocked),
      source_profile: String(data.source_profile || 'unknown'),
      details: data.details || {},
      created_at: parseDateLike(data.created_at)?.toISOString?.() || null
    };
  });

  const currentScore = await readCurrentExecutionScore(db);
  const blockedRows = rows.filter((row) => row.blocked);
  const byEvent = rows.reduce((acc, row) => {
    acc[row.event] = (acc[row.event] || 0) + 1;
    return acc;
  }, {});

  const disciplineRows = rows.map((row) => ({
    early_exit: row.event === 'early_exit_blocked',
    late_exit: row.event === 'late_entry_blocked',
    sl_violation: row.event === 'sl_violation_forced',
    profit_capture_ratio: row.event === 'profit_capture_enforced' ? 1 : null
  }));
  const metrics = buildExecutionDisciplineMetrics(
    disciplineRows,
    rows.length || 0,
    rows.length > 0 ? 1 - blockedRows.length / rows.length : null
  );

  return {
    enabled: EXECUTION_DISCIPLINE_ENABLED,
    mode: EXECUTION_DISCIPLINE_MODE,
    entry_window_seconds: ENTRY_WINDOW_SECONDS,
    profit_capture_target: PROFIT_CAPTURE_TARGET,
    early_exit_tp_ratio: EARLY_EXIT_TP_RATIO,
    slippage_threshold_pct: SLIPPAGE_THRESHOLD_PCT,
    execution_score_min: EXECUTION_SCORE_MIN,
    current_execution_score: currentScore,
    lookback_hours: SUMMARY_LOOKBACK_HOURS,
    total_events: rows.length,
    blocked_events: blockedRows.length,
    event_breakdown: byEvent,
    metrics
  };
}

module.exports = {
  EXECUTION_DISCIPLINE_ENABLED,
  EXECUTION_DISCIPLINE_MODE,
  ENTRY_WINDOW_SECONDS,
  EARLY_EXIT_TP_RATIO,
  PROFIT_CAPTURE_TARGET,
  SLIPPAGE_THRESHOLD_PCT,
  EXECUTION_SCORE_MIN,
  isEnforceMode,
  evaluateEntryDiscipline,
  evaluateFilledOrderDiscipline,
  evaluatePositionDiscipline,
  logExecutionDiscipline,
  getExecutionDisciplineSummary
};
