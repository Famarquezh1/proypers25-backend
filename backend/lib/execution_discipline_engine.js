const { FieldValue } = require('firebase-admin/firestore');
const { buildExecutionDisciplineMetrics } = require('./signal_adherence_monitor');

const EXECUTION_DISCIPLINE_ENABLED =
  String(process.env.EXECUTION_DISCIPLINE_ENABLED || 'true').toLowerCase() !== 'false';
const EXECUTION_DISCIPLINE_MODE = String(process.env.EXECUTION_DISCIPLINE_MODE || 'enforce').toLowerCase();
const ENTRY_WINDOW_SECONDS = Math.max(5, Math.min(35, Number(process.env.ENTRY_WINDOW_SECONDS || 30)));
const SOFT_LATE_ENTRY_GRACE_MS = Math.max(1000, Number(process.env.SOFT_LATE_ENTRY_GRACE_MS || 5000));
const ENABLE_SOFT_LATE_ENTRY =
  String(process.env.ENABLE_SOFT_LATE_ENTRY || process.env.ALLOW_SOFT_LATE_ENTRY || 'true').toLowerCase() === 'true';
const EARLY_EXIT_TP_RATIO = Math.max(0.1, Math.min(1, Number(process.env.EARLY_EXIT_TP_RATIO || 0.6)));
const PROFIT_CAPTURE_TARGET = Math.max(0.1, Math.min(1, Number(process.env.PROFIT_CAPTURE_TARGET || 0.4)));
const SLIPPAGE_THRESHOLD_PCT = Math.max(0.01, Number(process.env.EXECUTION_SLIPPAGE_THRESHOLD_PCT || 0.35));
const EXECUTION_SCORE_MIN = Math.max(0, Math.min(100, Number(process.env.EXECUTION_SCORE_MIN || 65)));
const SUMMARY_LOOKBACK_HOURS = Math.max(6, Math.min(24 * 30, Number(process.env.EXECUTION_DISCIPLINE_LOOKBACK_HOURS || 72)));
const LOG_LIMIT = Math.max(50, Math.min(2000, Number(process.env.EXECUTION_DISCIPLINE_LOG_LIMIT || 500)));
const SIGNAL_SCAN_LIMIT = Math.max(250, Math.min(30000, Number(process.env.EXECUTION_DISCIPLINE_SIGNAL_SCAN_LIMIT || 5000)));

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

function normalizeConfidenceToPct(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return n <= 1 ? n * 100 : n;
}

function normalizeValue(value) {
  if (value === undefined) return null;
  if (value === null) return null;
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => normalizeValue(item));
  }
  if (typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, entryValue]) => {
      const normalized = normalizeValue(entryValue);
      if (normalized !== undefined) {
        acc[key] = normalized;
      }
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

function resolveSignalTime(signalData = {}) {
  return (
    parseDateLike(signalData.signal_at) ||
    parseDateLike(signalData.created_at) ||
    parseDateLike(signalData.timestamp) ||
    parseDateLike(signalData.ahora) ||
    parseDateLike(signalData.entry_time)
  );
}

function combineUtcDateAndHms(baseDate, hms) {
  if (!baseDate || !hms || typeof hms !== 'string') return null;
  const match = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const out = new Date(baseDate);
  out.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
  return Number.isFinite(out.getTime()) ? out : null;
}

function resolveWindowEnd(signalData = {}, signalTime = null) {
  return (
    parseDateLike(signalData.entry_window_end_at) ||
    parseDateLike(signalData.window_end_at) ||
    parseDateLike(signalData.entry_window_ends_at) ||
    parseDateLike(signalData?.estimated_window?.end) ||
    parseDateLike(signalData?.entry_window?.end) ||
    combineUtcDateAndHms(signalTime, signalData?.estimated_window?.end) ||
    combineUtcDateAndHms(signalTime, signalData?.entry_window?.end) ||
    combineUtcDateAndHms(signalTime, signalData?.entry_window_utc?.end)
  );
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
    // fall through to query lookup
  }

  try {
    const snap = await db.collection('velas_predicciones').where('prediction_id', '==', predictionId).limit(1).get();
    if (!snap.empty) {
      return snap.docs[0].ref;
    }
  } catch (_) {
    return null;
  }

  return null;
}

async function mergeSignalExecutionMeta(db, signalData = {}, partialMeta = {}) {
  const ref = await findSignalDocRef(db, signalData);
  if (!ref) return false;

  const doc = await ref.get();
  if (!doc.exists) return false;
  const current = normalizeValue(doc.data()?.execution_meta || {});
  const next = normalizeValue({
    ...current,
    ...partialMeta
  });

  if (sameJson(current, next)) {
    return false;
  }

  await ref.set(
    {
      execution_meta: {
        ...next,
        updated_at: FieldValue.serverTimestamp()
      }
    },
    { merge: true }
  );

  return true;
}

function classifyLateEntryType(delayMs) {
  if (!Number.isFinite(delayMs) || delayMs <= 0) return 'none';
  return delayMs <= SOFT_LATE_ENTRY_GRACE_MS ? 'soft' : 'hard';
}

function resolveTimingPct(signalData = {}, intent = {}) {
  return normalizeConfidenceToPct(signalData?.timing_score ?? signalData?.timing ?? intent?.timing);
}

function resolveOutcomeLabel(signal = {}) {
  const raw = String(
    signal?.verification_outcome ||
      signal?.verification?.verification_outcome ||
      signal?.verification?.outcome_label ||
      signal?.status ||
      ''
  ).toUpperCase();

  if (raw.includes('WIN') || raw === 'VALIDADO') return 'WIN';
  if (raw.includes('LOSS') || raw === 'FALLIDO') return 'LOSS';
  if (raw.includes('PARTIAL') || raw.includes('PARCIAL')) return 'PARTIAL';
  return raw || 'PENDIENTE';
}

function classifyBinanceExecution(signal = {}) {
  const exec = signal?.binance_execution || {};
  const reason = String(exec?.reason || '').toLowerCase();

  if (!exec || Object.keys(exec).length === 0) return 'no_attempt';
  if (exec.executed) return 'executed';
  if (exec.dry_run) return 'dry_run';
  if (reason.startsWith('error:')) return 'failed_execution';
  if (reason === 'not_attempted' || reason === 'signal_not_emitted' || reason === 'neutral_direction' || reason === 'already_processed') {
    return 'no_attempt';
  }
  return 'omitted';
}

function resolveMissedOpportunityType(signal = {}) {
  const reason = String(signal?.binance_execution?.reason || '').toLowerCase();
  if (reason === 'late_entry_blocked') return 'late_entry';
  if (reason === 'execution_protection_mode') return 'execution_protection';
  return null;
}

async function summarizeSignalExecutionMeta(db) {
  const snapshot = await db
    .collection('velas_predicciones')
    .orderBy('timestamp', 'desc')
    .limit(SIGNAL_SCAN_LIMIT)
    .get();

  let batch = db.batch();
  let batchOps = 0;
  let updates = 0;
  let analyzedSignals = 0;
  let executedSignals = 0;
  let omittedSignals = 0;
  let lateEntryBlocked = 0;
  let softLate = 0;
  let hardLate = 0;
  let softLateExecuted = 0;
  let softLateBlocked = 0;
  let missedWins = 0;
  let missedLosses = 0;
  const delaySamples = [];

  const flushBatch = async () => {
    if (batchOps === 0) return;
    await batch.commit();
    batch = db.batch();
    batchOps = 0;
  };

  for (const doc of snapshot.docs) {
    const signal = { id: doc.id, ...doc.data() };
    const executionState = classifyBinanceExecution(signal);
    const currentMeta = normalizeValue(signal.execution_meta || {});
    const reason = String(signal?.binance_execution?.reason || '').toLowerCase();
    const rawDelayMs = toNum(
      currentMeta?.execution_delay_ms ??
        signal?.binance_execution?.execution_meta?.execution_delay_ms ??
        signal?.binance_execution?.execution_discipline?.execution_delay_ms ??
        signal?.binance_execution?.execution_discipline?.late_by_ms,
      null
    );
    const lateType = currentMeta?.late_entry_type && currentMeta?.late_entry_type !== 'none'
      ? currentMeta.late_entry_type
      : reason === 'late_entry_blocked'
        ? classifyLateEntryType(rawDelayMs)
        : 'none';
    const outcome = resolveOutcomeLabel(signal);
    const omitted = executionState === 'omitted';
    const missedType = omitted ? resolveMissedOpportunityType(signal) : null;
    const nextMeta = normalizeValue({
      late_entry_type: lateType,
      execution_delay_ms: rawDelayMs,
      missed_opportunity: omitted && outcome === 'WIN',
      missed_opportunity_type: missedType,
      would_have_been_win: omitted && outcome === 'WIN',
      would_have_been_loss: omitted && outcome === 'LOSS',
      override_applied:
        Boolean(
          currentMeta?.override_applied ??
            signal?.binance_execution?.execution_meta?.override_applied ??
            signal?.binance_execution?.execution_discipline?.override_applied
        ),
      override_reason:
        currentMeta?.override_reason ??
        signal?.binance_execution?.execution_meta?.override_reason ??
        signal?.binance_execution?.execution_discipline?.override_reason ??
        null
    });

    if (!sameJson(currentMeta, nextMeta)) {
      batch.set(
        doc.ref,
        {
          execution_meta: {
            ...nextMeta,
            updated_at: FieldValue.serverTimestamp()
          }
        },
        { merge: true }
      );
      batchOps += 1;
      updates += 1;

      if (omitted && (outcome === 'WIN' || outcome === 'LOSS')) {
        const eventPayload = {
          enabled: EXECUTION_DISCIPLINE_ENABLED,
          mode: EXECUTION_DISCIPLINE_MODE,
          type: 'missed_opportunity',
          event: outcome === 'WIN' ? 'missed_opportunity_win' : 'missed_opportunity_loss',
          blocked: false,
          prediction_id: signal.id,
          symbol: signal.simbolo || signal.symbol || null,
          execution_delay_ms: rawDelayMs,
          details: {
            missed_opportunity: outcome === 'WIN',
            missed_opportunity_type: missedType,
            late_entry_type: lateType,
            verification_outcome: outcome
          },
          created_at: FieldValue.serverTimestamp()
        };
        batch.set(db.collection('execution_events').doc(), eventPayload);
        batch.set(db.collection('execution_discipline_logs').doc(), eventPayload);
        batchOps += 2;
      }

      if (batchOps >= 400) {
        await flushBatch();
      }
    }

    if (signal?.binance_execution) {
      analyzedSignals += 1;
    }
    if (executionState === 'executed') {
      executedSignals += 1;
    }
    if (omitted) {
      omittedSignals += 1;
      if (outcome === 'WIN') missedWins += 1;
      if (outcome === 'LOSS') missedLosses += 1;
    }
    if (reason === 'late_entry_blocked') {
      lateEntryBlocked += 1;
      if (lateType === 'soft') softLate += 1;
      if (lateType === 'hard') hardLate += 1;
      if (lateType === 'soft') softLateBlocked += 1;
    }
    if (executionState === 'executed' && lateType === 'soft' && nextMeta.override_applied) {
      softLateExecuted += 1;
    }
    if (Number.isFinite(rawDelayMs)) {
      delaySamples.push(rawDelayMs);
    }
  }

  await flushBatch();

  const executionDelayAvgMs = delaySamples.length
    ? delaySamples.reduce((sum, value) => sum + value, 0) / delaySamples.length
    : null;

  return {
    signal_scan_limit: SIGNAL_SCAN_LIMIT,
    analyzed_signals: analyzedSignals,
    executed_signals: executedSignals,
    execution_rate: analyzedSignals > 0 ? executedSignals / analyzedSignals : null,
    omitted_signals: omittedSignals,
    missed_wins: missedWins,
    missed_losses: missedLosses,
    missed_win_rate: omittedSignals > 0 ? missedWins / omittedSignals : null,
    missed_loss_rate: omittedSignals > 0 ? missedLosses / omittedSignals : null,
    late_entry_blocked: lateEntryBlocked,
    late_entry_block_rate: analyzedSignals > 0 ? lateEntryBlocked / analyzedSignals : null,
    soft_late_ratio: lateEntryBlocked > 0 ? softLate / lateEntryBlocked : null,
    hard_late_ratio: lateEntryBlocked > 0 ? hardLate / lateEntryBlocked : null,
    late_entry_soft_executed: softLateExecuted,
    late_entry_soft_blocked: softLateBlocked,
    execution_delay_avg_ms: executionDelayAvgMs,
    avg_execution_delay: executionDelayAvgMs,
    updated_signals: updates
  };
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
  const windowEnd = resolveWindowEnd(signalData, signalTime);
  const now = new Date();
  const signalAgeMs =
    signalTime && Number.isFinite(signalTime.getTime())
      ? now.getTime() - signalTime.getTime()
      : null;
  const entryWindowMs = ENTRY_WINDOW_SECONDS * 1000;
  let lateBeyondWindowMs = 0;
  if (windowEnd && Number.isFinite(windowEnd.getTime())) {
    lateBeyondWindowMs = Math.max(0, now.getTime() - windowEnd.getTime());
  } else if (Number.isFinite(signalAgeMs) && signalAgeMs > entryWindowMs) {
    lateBeyondWindowMs = signalAgeMs - entryWindowMs;
  }
  const lateEntryType = classifyLateEntryType(lateBeyondWindowMs);
  const confidencePct = normalizeConfidenceToPct(signalData?.confianza ?? signalData?.confidence ?? intent?.confidence);
  const timingPct = resolveTimingPct(signalData, intent);
  const allowSoftLateEntry =
    lateEntryType === 'soft' &&
    ENABLE_SOFT_LATE_ENTRY &&
    Number.isFinite(confidencePct) &&
    confidencePct >= 97 &&
    Number.isFinite(timingPct) &&
    timingPct >= 85;
  const overrideApplied = allowSoftLateEntry;
  const overrideReason = overrideApplied ? 'soft_late_high_confidence' : 'normal_execution';

  if (lateEntryType !== 'none') {
    const details = {
      signal_time: signalTime?.toISOString?.() || null,
      window_end_time: windowEnd?.toISOString?.() || null,
      checked_at: now.toISOString(),
      signal_age_ms: signalAgeMs,
      execution_delay_ms: lateBeyondWindowMs,
      late_by_seconds: Math.round((lateBeyondWindowMs / 1000) * 1000) / 1000,
      entry_window_seconds: ENTRY_WINDOW_SECONDS,
      late_entry_type: lateEntryType,
      confidence_pct: confidencePct,
      timing_pct: timingPct,
      grace_allowed: allowSoftLateEntry,
      override_applied: overrideApplied,
      override_reason: overrideReason
    };
    await mergeSignalExecutionMeta(db, signalData, {
      late_entry_type: lateEntryType,
      execution_delay_ms: lateBeyondWindowMs,
      missed_opportunity: false,
      missed_opportunity_type: allowSoftLateEntry ? null : 'late_entry',
      would_have_been_win: false,
      would_have_been_loss: false,
      override_applied: overrideApplied,
      override_reason: overrideReason
    });
    await logExecutionDiscipline(db, {
      type: 'entry_control',
      event: allowSoftLateEntry ? 'late_entry_soft_allowed' : 'late_entry_blocked',
      blocked: isEnforceMode() && !allowSoftLateEntry,
      source_profile: sourceProfile,
      symbol: intent.symbol || signalData.symbol || signalData.simbolo || null,
      prediction_id: resolvePredictionId(signalData),
      execution_delay_ms: lateBeyondWindowMs,
      details
    });
    return {
      blocked: isEnforceMode() && !allowSoftLateEntry,
      reason: allowSoftLateEntry ? null : 'late_entry_blocked',
      details
    };
  }

  await mergeSignalExecutionMeta(db, signalData, {
    late_entry_type: 'none',
    execution_delay_ms: Number.isFinite(signalAgeMs) ? signalAgeMs : null,
    override_applied: false,
    override_reason: 'normal_execution'
  });

  const executionScore = await readCurrentExecutionScore(db);
  if (executionScore != null && executionScore < EXECUTION_SCORE_MIN) {
    const details = {
      execution_score: executionScore,
      minimum_required: EXECUTION_SCORE_MIN
    };
    await mergeSignalExecutionMeta(db, signalData, {
      late_entry_type: 'none',
      execution_delay_ms: Number.isFinite(signalAgeMs) ? signalAgeMs : null,
      missed_opportunity: false,
      missed_opportunity_type: 'execution_protection',
      would_have_been_win: false,
      would_have_been_loss: false,
      override_applied: false,
      override_reason: 'normal_execution'
    });
    await logExecutionDiscipline(db, {
      type: 'entry_control',
      event: 'execution_protection_mode',
      blocked: isEnforceMode(),
      source_profile: sourceProfile,
      symbol: intent.symbol || signalData.symbol || signalData.simbolo || null,
      prediction_id: resolvePredictionId(signalData),
      execution_delay_ms: Number.isFinite(signalAgeMs) ? signalAgeMs : null,
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
      entry_window_seconds: ENTRY_WINDOW_SECONDS,
      execution_delay_ms: Number.isFinite(signalAgeMs) ? signalAgeMs : null,
      late_entry_type: 'none',
      allow_soft_late_entry: ENABLE_SOFT_LATE_ENTRY,
      override_applied: false,
      override_reason: 'normal_execution'
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
      prediction_id: resolvePredictionId(signalData),
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
  const signalMetrics = await summarizeSignalExecutionMeta(db);
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
    allow_soft_late_entry: ENABLE_SOFT_LATE_ENTRY,
    soft_late_entry_grace_ms: SOFT_LATE_ENTRY_GRACE_MS,
    profit_capture_target: PROFIT_CAPTURE_TARGET,
    early_exit_tp_ratio: EARLY_EXIT_TP_RATIO,
    slippage_threshold_pct: SLIPPAGE_THRESHOLD_PCT,
    execution_score_min: EXECUTION_SCORE_MIN,
    current_execution_score: currentScore,
    lookback_hours: SUMMARY_LOOKBACK_HOURS,
    total_events: rows.length,
    blocked_events: blockedRows.length,
    event_breakdown: byEvent,
    metrics,
    signal_metrics: signalMetrics
  };
}

module.exports = {
  EXECUTION_DISCIPLINE_ENABLED,
  EXECUTION_DISCIPLINE_MODE,
  ENTRY_WINDOW_SECONDS,
  ENABLE_SOFT_LATE_ENTRY,
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
