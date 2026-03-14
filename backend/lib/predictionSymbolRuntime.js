const { FieldValue } = require('firebase-admin/firestore');

const COLLECTION_NAME = 'velas_symbol_runtime_state';
const COOLDOWN_ENABLED = process.env.PREDICTION_SYMBOL_COOLDOWN_ENABLED !== 'false';
const PRIORITIZATION_ENABLED = process.env.PREDICTION_SYMBOL_PRIORITIZATION_ENABLED !== 'false';
const FAILURE_THRESHOLD = Math.max(1, Number(process.env.PREDICTION_SYMBOL_FAILURE_THRESHOLD || 2));
const COOLDOWN_MINUTES = Math.max(5, Number(process.env.PREDICTION_SYMBOL_COOLDOWN_MINUTES || 60));
const MAX_COOLDOWN_MINUTES = Math.max(COOLDOWN_MINUTES, Number(process.env.PREDICTION_SYMBOL_MAX_COOLDOWN_MINUTES || 240));
const FETCH_BUFFER = Math.max(0, Number(process.env.PREDICTION_SYMBOL_FETCH_BUFFER || 20));

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

  const enriched = configs.map((config, index) => {
    const state = states.get(config.symbol) || {};
    const cooldownUntilMs = timestampToMs(state.cooldown_until);
    return {
      config,
      state,
      index,
      consecutiveFailures: Number(state.consecutive_failures || 0),
      totalFailures: Number(state.total_failures || 0),
      totalSuccess: Number(state.total_success || 0),
      cooldownUntilMs,
      cooldownActive: COOLDOWN_ENABLED && cooldownUntilMs > nowMs
    };
  });

  const excluded = enriched.filter((item) => item.cooldownActive);
  let eligible = enriched.filter((item) => !item.cooldownActive);

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
        cooldown_until: item.state.cooldown_until || null,
        consecutive_failures: item.consecutiveFailures
      }))
    }
  };
}

async function recordSymbolOutcome(db, symbol, outcome = {}) {
  if (!symbol || typeof symbol !== 'string') return;
  const ref = db.collection(COLLECTION_NAME).doc(symbol);
  const snapshot = await ref.get();
  const current = snapshot.exists ? snapshot.data() || {} : {};

  const consecutiveFailures = Number(current.consecutive_failures || 0);
  const totalFailures = Number(current.total_failures || 0);
  const totalSuccess = Number(current.total_success || 0);

  if (outcome.ok) {
    await ref.set(
      {
        symbol,
        consecutive_failures: 0,
        total_failures: totalFailures,
        total_success: totalSuccess + 1,
        cooldown_until: null,
        last_success_at: new Date().toISOString(),
        last_cycle_type: outcome.cycleType || null,
        updated_at: new Date().toISOString()
      },
      { merge: true }
    );
    return;
  }

  const nextConsecutiveFailures = consecutiveFailures + 1;
  const cooldownMinutes = cooldownMinutesForFailures(nextConsecutiveFailures);
  const cooldownUntil =
    cooldownMinutes > 0
      ? new Date(Date.now() + cooldownMinutes * 60 * 1000).toISOString()
      : null;

  await ref.set(
    {
      symbol,
      consecutive_failures: nextConsecutiveFailures,
      total_failures: totalFailures + 1,
      total_success: totalSuccess,
      cooldown_until: cooldownUntil,
      cooldown_count: Number(current.cooldown_count || 0) + (cooldownUntil ? 1 : 0),
      last_failure_at: new Date().toISOString(),
      last_failure_reason: String(outcome.error || 'unknown'),
      last_cycle_type: outcome.cycleType || null,
      updated_at: new Date().toISOString(),
      last_error_code: outcome.errorCode || null
    },
    { merge: true }
  );
}

module.exports = {
  COOLDOWN_ENABLED,
  FETCH_BUFFER,
  PRIORITIZATION_ENABLED,
  selectPredictionConfigs,
  recordSymbolOutcome
};
