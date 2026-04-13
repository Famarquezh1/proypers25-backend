const { FieldValue } = require('firebase-admin/firestore');

const COLLECTION_NAME = 'velas_symbol_runtime_state';
const COOLDOWN_ENABLED = process.env.PREDICTION_SYMBOL_COOLDOWN_ENABLED !== 'false';
const PRIORITIZATION_ENABLED = process.env.PREDICTION_SYMBOL_PRIORITIZATION_ENABLED !== 'false';
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.PREDICTION_SYMBOL_FAILURE_THRESHOLD || 2));
const COOLDOWN_MINUTES = Math.max(5, Number(process.env.PREDICTION_SYMBOL_COOLDOWN_MINUTES || 60));
const MAX_COOLDOWN_MINUTES = Math.max(COOLDOWN_MINUTES, Number(process.env.PREDICTION_SYMBOL_MAX_COOLDOWN_MINUTES || 240));
const TECHNICAL_COOLDOWN_MAX_MINUTES = Math.max(
  1,
  Math.min(5, Number(process.env.PREDICTION_SYMBOL_TECHNICAL_COOLDOWN_MINUTES || 5))
);
const TECHNICAL_RESET_FAILURE_THRESHOLD = Math.max(
  4,
  Number(process.env.PREDICTION_SYMBOL_TECHNICAL_RESET_FAILURE_THRESHOLD || 4)
);
const TECHNICAL_TRACKED_FAILURE_CAP = Math.max(1, FAILURE_THRESHOLD - 1);
const FETCH_BUFFER = Math.max(0, Number(process.env.PREDICTION_SYMBOL_FETCH_BUFFER || 20));
const COOLDOWN_AUDIT_ENABLED = String(process.env.COOLDOWN_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const RECORD_SYMBOL_OUTCOME_BREAKDOWN_ENABLED =
  String(process.env.RECORD_SYMBOL_OUTCOME_BREAKDOWN_ENABLED || process.env.PROFILING_FETCH_ENABLED || 'false')
    .toLowerCase() === 'true';

function timestampToMs(value) {
  if (!value) return 0;
  if (typeof value?.toDate === 'function') return value.toDate().getTime();
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function cooldownMinutesForFailures(consecutiveFailures) {
  if (consecutiveFailures < FAILURE_THRESHOLD) return 0;
  const stepsOverThreshold = Math.max(0, consecutiveFailures - FAILURE_THRESHOLD);
  const candidate = COOLDOWN_MINUTES * Math.pow(2, stepsOverThreshold);
  return Math.min(MAX_COOLDOWN_MINUTES, candidate);
}

function technicalCooldownMinutesForFailures(consecutiveFailures) {
  const normalized = Math.max(1, Number(consecutiveFailures || 0));
  return Math.min(TECHNICAL_COOLDOWN_MAX_MINUTES, normalized);
}

function normalizeFailureType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized === 'technical' || normalized === 'market' ? normalized : null;
}

function isTechnicalFailureReason(reason, errorCode) {
  const haystack = `${String(reason || '')} ${String(errorCode || '')}`.toLowerCase();
  if (!haystack.trim()) {
    return false;
  }

  return [
    'timeout',
    'fetch',
    'network',
    'socket',
    'econn',
    'etimedout',
    'enotfound',
    'prediction',
    'prediccion',
    'spot price',
    'candles',
    'binance',
    'external'
  ].some((pattern) => haystack.includes(pattern));
}

function resolveFailureType(outcome = {}, state = {}) {
  const explicit = normalizeFailureType(outcome.failureType);
  if (explicit) {
    return explicit;
  }

  if (isTechnicalFailureReason(outcome.error, outcome.errorCode)) {
    return 'technical';
  }

  const persisted = normalizeFailureType(state.last_failure_type);
  if (persisted) {
    return persisted;
  }

  return 'technical';
}

function buildCooldownUntilIso(baseMs, cooldownMinutes) {
  if (!Number.isFinite(baseMs) || baseMs <= 0 || !Number.isFinite(cooldownMinutes) || cooldownMinutes <= 0) {
    return null;
  }

  return new Date(baseMs + cooldownMinutes * 60 * 1000).toISOString();
}

function buildCooldownClassificationLog(payload = {}) {
  console.log('[COOLDOWN_CLASSIFIED]', JSON.stringify(payload));
}

function classifyRecordOutcomeBucket(durationMs) {
  const normalized = Number(durationMs);
  if (!Number.isFinite(normalized) || normalized < 0) return null;
  if (normalized < 500) return 'normal';
  if (normalized < 2000) return 'lento';
  if (normalized < 5000) return 'muy_lento';
  return 'critico';
}

function buildRecordOutcomeBreakdownLog(payload = {}) {
  if (!RECORD_SYMBOL_OUTCOME_BREAKDOWN_ENABLED) return;
  console.log('[RECORD_SYMBOL_OUTCOME_BREAKDOWN]', JSON.stringify(payload));
}

function buildRecordOutcomeWriteOnlyLog(payload = {}) {
  console.log('[RECORD_SYMBOL_OUTCOME_WRITE_ONLY]', JSON.stringify(payload));
}

function assessCooldownState(state = {}, nowMs = Date.now()) {
  const storedConsecutiveFailures = Number(state.consecutive_failures || 0);
  const storedTechnicalFailures = Number(state.consecutive_technical_failures || 0);
  const storedMarketFailures = Number(state.consecutive_market_failures || 0);
  const storedCooldownUntilMs = timestampToMs(state.cooldown_until);
  const lastFailureAtMs = timestampToMs(state.last_failure_at);
  const persistedFailureType = normalizeFailureType(state.last_failure_type);
  const inferredLegacyTechnical =
    !persistedFailureType &&
    storedTechnicalFailures === 0 &&
    storedMarketFailures === 0 &&
    storedConsecutiveFailures >= TECHNICAL_RESET_FAILURE_THRESHOLD &&
    isTechnicalFailureReason(state.last_failure_reason, state.last_error_code);

  const failureType = inferredLegacyTechnical ? 'technical' : persistedFailureType;
  let effectiveConsecutiveFailures = storedConsecutiveFailures;
  let effectiveTechnicalFailures = storedTechnicalFailures;
  let effectiveMarketFailures = storedMarketFailures;
  let effectiveCooldownUntilMs = storedCooldownUntilMs;
  let cooldownProfile = state.cooldown_profile || null;
  let adjusted = false;
  let adjustmentReason = null;

  if (failureType === 'technical' && storedConsecutiveFailures > 0) {
    const technicalFailures = Math.max(
      storedTechnicalFailures,
      inferredLegacyTechnical ? storedConsecutiveFailures : storedTechnicalFailures || storedConsecutiveFailures
    );
    const technicalCooldownMs = technicalCooldownMinutesForFailures(technicalFailures) * 60 * 1000;
    const desiredCooldownUntilMs = lastFailureAtMs > 0 ? lastFailureAtMs + technicalCooldownMs : 0;
    const cappedConsecutiveFailures = Math.min(technicalFailures, TECHNICAL_TRACKED_FAILURE_CAP);

    effectiveTechnicalFailures = technicalFailures;
    effectiveMarketFailures = 0;
    effectiveConsecutiveFailures = cappedConsecutiveFailures;
    cooldownProfile = 'technical_short';

    if (desiredCooldownUntilMs > 0) {
      effectiveCooldownUntilMs =
        storedCooldownUntilMs > 0
          ? Math.min(storedCooldownUntilMs, desiredCooldownUntilMs)
          : desiredCooldownUntilMs;
    }

    adjusted =
      inferredLegacyTechnical ||
      storedConsecutiveFailures !== cappedConsecutiveFailures ||
      (desiredCooldownUntilMs > 0 &&
        (storedCooldownUntilMs === 0 || storedCooldownUntilMs > desiredCooldownUntilMs));

    if (adjusted) {
      adjustmentReason = inferredLegacyTechnical
        ? 'legacy_technical_partial_reset'
        : 'technical_short_cooldown';
    }
  }

  return {
    failureType,
    cooldownProfile,
    adjusted,
    adjustmentReason,
    effectiveConsecutiveFailures,
    effectiveTechnicalFailures,
    effectiveMarketFailures,
    effectiveCooldownUntilMs,
    cooldownActive: COOLDOWN_ENABLED && effectiveCooldownUntilMs > nowMs
  };
}

async function loadSymbolStates(db, symbols) {
  const cleanSymbols = Array.from(
    new Set((Array.isArray(symbols) ? symbols : []).filter((symbol) => typeof symbol === 'string' && symbol.trim()))
  );
  if (!cleanSymbols.length) return new Map();

  const refs = cleanSymbols.map((symbol) => db.collection(COLLECTION_NAME).doc(symbol));
  const snapshots = await db.getAll(...refs);
  const states = new Map();

  snapshots.forEach((snapshot, index) => {
    const symbol = cleanSymbols[index];
    states.set(symbol, snapshot.exists ? snapshot.data() || {} : {});
  });

  return states;
}

async function selectPredictionConfigs(db, predictionConfig, options = {}) {
  const configs = Array.isArray(predictionConfig) ? predictionConfig : [];
  const requestedMaxSymbols = Number(options.maxSymbols || 0) || configs.length;
  const states = await loadSymbolStates(
    db,
    configs.map((item) => item?.symbol).filter(Boolean)
  );
  const nowMs = Date.now();
  const cooldownAdjustments = [];

  const enriched = configs.map((config, index) => {
    const state = states.get(config.symbol) || {};
    const cooldownAssessment = assessCooldownState(state, nowMs);

    if (cooldownAssessment.adjusted && cooldownAssessment.failureType === 'technical') {
      const nextCooldownUntil =
        cooldownAssessment.effectiveCooldownUntilMs > nowMs
          ? new Date(cooldownAssessment.effectiveCooldownUntilMs).toISOString()
          : null;
      cooldownAdjustments.push({
        symbol: config.symbol,
        state,
        assessment: cooldownAssessment,
        patch: {
          symbol: config.symbol,
          consecutive_failures: cooldownAssessment.effectiveConsecutiveFailures,
          consecutive_technical_failures: cooldownAssessment.effectiveTechnicalFailures,
          consecutive_market_failures: cooldownAssessment.effectiveMarketFailures,
          cooldown_until: nextCooldownUntil,
          cooldown_start_at: nextCooldownUntil ? state.last_failure_at || new Date(nowMs).toISOString() : null,
          cooldown_profile: cooldownAssessment.cooldownProfile,
          last_failure_type: cooldownAssessment.failureType,
          cooldown_adjusted_at: new Date(nowMs).toISOString(),
          cooldown_adjustment_reason: cooldownAssessment.adjustmentReason,
          updated_at: new Date(nowMs).toISOString()
        }
      });
    }

    return {
      config,
      state,
      index,
      failureType: cooldownAssessment.failureType,
      cooldownProfile: cooldownAssessment.cooldownProfile,
      adjusted: cooldownAssessment.adjusted,
      consecutiveFailures: cooldownAssessment.effectiveConsecutiveFailures,
      consecutiveTechnicalFailures: cooldownAssessment.effectiveTechnicalFailures,
      consecutiveMarketFailures: cooldownAssessment.effectiveMarketFailures,
      totalFailures: Number(state.total_failures || 0),
      totalSuccess: Number(state.total_success || 0),
      cooldownUntilMs: cooldownAssessment.effectiveCooldownUntilMs,
      cooldownActive: cooldownAssessment.cooldownActive
    };
  });

  if (cooldownAdjustments.length) {
    await Promise.allSettled(
      cooldownAdjustments.map((item) =>
        db.collection(COLLECTION_NAME).doc(item.symbol).set(item.patch, { merge: true })
      )
    );
    cooldownAdjustments.forEach((item) => {
      buildCooldownClassificationLog({
        symbol: item.symbol,
        failure_type: item.assessment.failureType,
        cooldown_applied_ms:
          item.assessment.effectiveCooldownUntilMs > nowMs
            ? item.assessment.effectiveCooldownUntilMs - nowMs
            : 0,
        consecutive_failures: item.assessment.effectiveConsecutiveFailures,
        adjusted: true,
        adjustment_reason: item.assessment.adjustmentReason
      });
    });
  }

  const excluded = enriched.filter((item) => item.cooldownActive);
  let eligible = enriched.filter((item) => !item.cooldownActive);

  if (COOLDOWN_AUDIT_ENABLED) {
    const cooldownAudits = enriched.map((item) => {
      const cooldownMinutes =
        item.failureType === 'technical'
          ? technicalCooldownMinutesForFailures(item.consecutiveTechnicalFailures || item.consecutiveFailures)
          : cooldownMinutesForFailures(item.consecutiveFailures);
      const remainingMs = item.cooldownActive ? Math.max(0, item.cooldownUntilMs - nowMs) : 0;
      const lastSignalAt = item.state.last_success_at || item.state.last_failure_at || null;
      return {
        symbol: item.config.symbol,
        in_cooldown: item.cooldownActive,
        cooldown_reason: item.cooldownActive ? 'consecutive_failures' : null,
        failure_type: item.failureType,
        cooldown_profile: item.cooldownProfile,
        adjusted: item.adjusted,
        cooldown_start: item.state.cooldown_start_at || null,
        cooldown_remaining_ms: item.cooldownActive ? remainingMs : 0,
        last_signal_timestamp: lastSignalAt,
        last_execution_timestamp: item.state.last_execution_at || item.state.last_success_at || null,
        cooldown_rule_applied: {
          failure_threshold: FAILURE_THRESHOLD,
          consecutive_failures: item.consecutiveFailures,
          consecutive_technical_failures: item.consecutiveTechnicalFailures,
          consecutive_market_failures: item.consecutiveMarketFailures,
          cooldown_minutes: cooldownMinutes,
          technical_cooldown_max_minutes: TECHNICAL_COOLDOWN_MAX_MINUTES,
          max_cooldown_minutes: MAX_COOLDOWN_MINUTES
        }
      };
    });
    cooldownAudits.forEach((row) => {
      console.log('[COOLDOWN_AUDIT]', JSON.stringify(row));
    });
  }

  if (PRIORITIZATION_ENABLED) {
    eligible = eligible.sort((a, b) => {
      if (a.consecutiveFailures !== b.consecutiveFailures) {
        return a.consecutiveFailures - b.consecutiveFailures;
      }
      if (a.totalFailures !== b.totalFailures) {
        return a.totalFailures - b.totalFailures;
      }
      if (a.totalSuccess !== b.totalSuccess) {
        return b.totalSuccess - a.totalSuccess;
      }
      return a.index - b.index;
    });
  }

  const selected = eligible.slice(0, requestedMaxSymbols);

  if (COOLDOWN_AUDIT_ENABLED) {
    const topBlocked = excluded
      .slice(0, 10)
      .map((item) => ({
        symbol: item.config.symbol,
        cooldown_until:
          item.cooldownUntilMs > nowMs ? new Date(item.cooldownUntilMs).toISOString() : item.state.cooldown_until || null,
        consecutive_failures: item.consecutiveFailures,
        failure_type: item.failureType,
        adjusted: item.adjusted
      }));
    console.log('[COOLDOWN_SUMMARY]', JSON.stringify({
      total_symbols: configs.length,
      in_cooldown_count: excluded.length,
      out_of_cooldown_count: eligible.length,
      top_blocked_symbols: topBlocked
    }));
  }

  return {
    configs: selected.map((item) => item.config),
    summary: {
      cooldown_enabled: COOLDOWN_ENABLED,
      prioritization_enabled: PRIORITIZATION_ENABLED,
      requested_symbols: requestedMaxSymbols,
      fetched_symbols: configs.length,
      eligible_symbols: eligible.length,
      cooldown_excluded: excluded.length,
      cooldown_excluded_symbols: excluded.slice(0, 10).map((item) => ({
        symbol: item.config.symbol,
        cooldown_until:
          item.cooldownUntilMs > nowMs ? new Date(item.cooldownUntilMs).toISOString() : item.state.cooldown_until || null,
        consecutive_failures: item.consecutiveFailures,
        failure_type: item.failureType,
        adjusted: item.adjusted
      }))
    }
  };
}

async function recordSymbolOutcome(db, symbol, outcome = {}) {
  if (!symbol || typeof symbol !== 'string') return;
  const totalStartedAtMs = Date.now();
  const ref = db.collection(COLLECTION_NAME).doc(symbol);
  const nowMs = Date.now();
  const nowIso = new Date(nowMs).toISOString();
  const requiresReadBeforeWrite = !outcome?.ok;
  let writeMode = requiresReadBeforeWrite ? 'fallback_get_set' : 'merge_set';
  let getStartedAtMs = null;
  let setStartedAtMs = null;
  let getMs = null;
  let setMs = null;

  try {
    if (outcome.ok) {
      setStartedAtMs = Date.now();
      await ref.set(
        {
          symbol,
          consecutive_failures: 0,
          consecutive_technical_failures: 0,
          consecutive_market_failures: 0,
          total_failures: FieldValue.increment(0),
          total_success: FieldValue.increment(1),
          total_technical_failures: FieldValue.increment(0),
          total_market_failures: FieldValue.increment(0),
          cooldown_until: null,
          cooldown_start_at: null,
          cooldown_profile: FieldValue.delete(),
          cooldown_adjusted_at: FieldValue.delete(),
          cooldown_adjustment_reason: FieldValue.delete(),
          last_failure_type: FieldValue.delete(),
          last_success_at: nowIso,
          last_cycle_type: outcome.cycleType || null,
          updated_at: nowIso
        },
        { merge: true }
      );
      setMs = Math.max(0, Date.now() - setStartedAtMs);
      const totalMs = Math.max(0, Date.now() - totalStartedAtMs);
      buildRecordOutcomeWriteOnlyLog({
        symbol,
        mode: writeMode,
        success: true
      });
      buildRecordOutcomeBreakdownLog({
        symbol,
        total_ms: totalMs,
        get_ms: 0,
        set_ms: setMs,
        network_estimate_ms: Math.max(0, totalMs - Number(setMs || 0)),
        bucket: classifyRecordOutcomeBucket(totalMs),
        mode: writeMode,
        success: true
      });
      return;
    }

    getStartedAtMs = Date.now();
    const snapshot = await ref.get();
    getMs = Math.max(0, Date.now() - getStartedAtMs);
    const current = snapshot.exists ? snapshot.data() || {} : {};

    const totalFailures = Number(current.total_failures || 0);
    const totalSuccess = Number(current.total_success || 0);
    const totalTechnicalFailures = Number(current.total_technical_failures || 0);
    const totalMarketFailures = Number(current.total_market_failures || 0);
    const failureType = resolveFailureType(outcome, current);
    const previousTechnicalFailures =
      normalizeFailureType(current.last_failure_type) === 'technical'
        ? Math.max(
            Number(current.consecutive_technical_failures || 0),
            Number(current.consecutive_failures || 0)
          )
        : Number(current.consecutive_technical_failures || 0);
    const previousMarketFailures =
      normalizeFailureType(current.last_failure_type) === 'market'
        ? Math.max(
            Number(current.consecutive_market_failures || 0),
            Number(current.consecutive_failures || 0)
          )
        : Number(current.consecutive_market_failures || 0);

    const nextTechnicalFailures =
      failureType === 'technical' ? previousTechnicalFailures + 1 : 0;
    const nextMarketFailures =
      failureType === 'market' ? previousMarketFailures + 1 : 0;
    const nextConsecutiveFailures =
      failureType === 'technical'
        ? Math.min(nextTechnicalFailures, TECHNICAL_TRACKED_FAILURE_CAP)
        : nextMarketFailures;
    const cooldownMinutes =
      failureType === 'technical'
        ? technicalCooldownMinutesForFailures(nextTechnicalFailures)
        : cooldownMinutesForFailures(nextMarketFailures);
    const cooldownAppliedMs = cooldownMinutes > 0 ? cooldownMinutes * 60 * 1000 : 0;
    const cooldownUntil = buildCooldownUntilIso(nowMs, cooldownMinutes);
    const cooldownProfile = failureType === 'technical' ? 'technical_short' : 'market_default';

    setStartedAtMs = Date.now();
    await ref.set(
      {
        symbol,
        consecutive_failures: nextConsecutiveFailures,
        consecutive_technical_failures: nextTechnicalFailures,
        consecutive_market_failures: nextMarketFailures,
        total_failures: totalFailures + 1,
        total_success: totalSuccess,
        total_technical_failures:
          failureType === 'technical' ? totalTechnicalFailures + 1 : totalTechnicalFailures,
        total_market_failures:
          failureType === 'market' ? totalMarketFailures + 1 : totalMarketFailures,
        cooldown_until: cooldownUntil,
        cooldown_start_at: cooldownUntil ? nowIso : null,
        cooldown_profile: cooldownProfile,
        cooldown_count: Number(current.cooldown_count || 0) + (cooldownUntil ? 1 : 0),
        last_failure_at: nowIso,
        last_failure_type: failureType,
        last_failure_reason: String(outcome.error || 'unknown'),
        last_cycle_type: outcome.cycleType || null,
        updated_at: nowIso,
        last_error_code: outcome.errorCode || null
      },
      { merge: true }
    );
    setMs = Math.max(0, Date.now() - setStartedAtMs);

    buildCooldownClassificationLog({
      symbol,
      failure_type: failureType,
      cooldown_applied_ms: cooldownAppliedMs,
      consecutive_failures: nextConsecutiveFailures,
      adjusted: false
    });

    const totalMs = Math.max(0, Date.now() - totalStartedAtMs);
    buildRecordOutcomeWriteOnlyLog({
      symbol,
      mode: writeMode,
      success: true
    });
    buildRecordOutcomeBreakdownLog({
      symbol,
      total_ms: totalMs,
      get_ms: getMs,
      set_ms: setMs,
      network_estimate_ms: Math.max(0, totalMs - (Number(getMs || 0) + Number(setMs || 0))),
      bucket: classifyRecordOutcomeBucket(totalMs),
      mode: writeMode,
      success: true
    });
  } catch (err) {
    if (getMs == null && Number.isFinite(getStartedAtMs)) {
      getMs = Math.max(0, Date.now() - getStartedAtMs);
    }
    if (setStartedAtMs != null && setMs == null) {
      setMs = Math.max(0, Date.now() - setStartedAtMs);
    }
    const totalMs = Math.max(0, Date.now() - totalStartedAtMs);
    buildRecordOutcomeWriteOnlyLog({
      symbol,
      mode: writeMode,
      success: false
    });
    buildRecordOutcomeBreakdownLog({
      symbol,
      total_ms: totalMs,
      get_ms: getMs,
      set_ms: setMs,
      network_estimate_ms: Math.max(0, totalMs - (Number(getMs || 0) + Number(setMs || 0))),
      bucket: classifyRecordOutcomeBucket(totalMs),
      mode: writeMode,
      success: false,
      error: err?.message || String(err)
    });
    throw err;
  }
}

module.exports = {
  COOLDOWN_ENABLED,
  FETCH_BUFFER,
  PRIORITIZATION_ENABLED,
  selectPredictionConfigs,
  recordSymbolOutcome
};
