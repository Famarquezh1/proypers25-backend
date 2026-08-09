'use strict';

const VERSION = 'xec_historical_holding_policy_v1';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, n(value, min)));
}

function pctChange(current, reference) {
  const base = n(reference);
  return base > 0 ? ((n(current) / base) - 1) * 100 : null;
}

function normalizeXecPolicy(config = {}) {
  return {
    enabled: config.xec_managed_exit_enabled !== false,
    upside_arm_recovery_pct: Math.max(8, n(config.xec_upside_arm_recovery_pct, 12)),
    first_take_min_recovery_pct: Math.max(10, n(config.xec_first_take_min_recovery_pct, 15)),
    second_take_min_recovery_pct: Math.max(20, n(config.xec_second_take_min_recovery_pct, 30)),
    final_take_min_recovery_pct: Math.max(30, n(config.xec_final_take_min_recovery_pct, 50)),
    minimum_positive_cycles: Math.max(2, Math.floor(n(config.xec_minimum_positive_cycles, 2))),
    minimum_1h_change_pct: n(config.xec_minimum_1h_change_pct, 0.5),
    minimum_24h_change_pct: n(config.xec_minimum_24h_change_pct, 0),
    first_trailing_pullback_pct: Math.max(3, n(config.xec_first_trailing_pullback_pct, 5)),
    second_trailing_pullback_pct: Math.max(4, n(config.xec_second_trailing_pullback_pct, 6)),
    final_trailing_pullback_pct: Math.max(5, n(config.xec_final_trailing_pullback_pct, 8)),
    first_sell_fraction: clamp(config.xec_first_sell_fraction ?? 0.25, 0.1, 0.5),
    second_sell_fraction: clamp(config.xec_second_sell_fraction ?? 0.5, 0.2, 0.75),
    downside_trim_pct_from_baseline: Math.min(-8, n(config.xec_downside_trim_pct_from_baseline, -15)),
    downside_24h_confirmation_pct: Math.min(-1, n(config.xec_downside_24h_confirmation_pct, -3)),
    downside_trim_fraction: clamp(config.xec_downside_trim_fraction ?? 0.25, 0.1, 0.5),
    near_cost_basis_drawdown_pct: Math.min(0, n(config.xec_near_cost_basis_drawdown_pct, -5)),
    version: VERSION
  };
}

function evaluateXecHistoricalHolding({ state = {}, currentPrice, averageCost, oneHourChangePct, change24hPct, config = {} } = {}) {
  const policy = normalizeXecPolicy(config);
  const price = n(currentPrice);
  const baselinePrice = n(state.baseline_price, price);
  const lastPrice = n(state.last_price, baselinePrice);
  const stage = Math.max(0, Math.floor(n(state.xec_exit_stage, 0)));
  const downsideTrimDone = state.xec_downside_trim_done === true;
  const baselineDrawdownPct = Number.isFinite(Number(state.baseline_drawdown_pct)) ? Number(state.baseline_drawdown_pct) : null;
  const currentDrawdownPct = averageCost > 0 ? pctChange(price, averageCost) : null;
  const recoveryPct = pctChange(price, baselinePrice) || 0;
  const improvementPct = currentDrawdownPct !== null && baselineDrawdownPct !== null
    ? currentDrawdownPct - baselineDrawdownPct
    : recoveryPct;

  const positiveNow = price > lastPrice && n(oneHourChangePct) >= policy.minimum_1h_change_pct && n(change24hPct) >= policy.minimum_24h_change_pct;
  const positiveCycles = positiveNow ? Math.max(0, Math.floor(n(state.positive_cycles, 0))) + 1 : 0;
  const armedBefore = state.xec_runner_armed === true;
  const shouldArm = policy.enabled && !armedBefore && Math.max(recoveryPct, improvementPct) >= policy.upside_arm_recovery_pct && positiveCycles >= policy.minimum_positive_cycles;
  const armed = armedBefore || shouldArm;
  const previousHigh = n(state.highest_price_after_arm, price);
  const highestPrice = armed ? Math.max(previousHigh, price) : null;
  const highRecoveryPct = armed && highestPrice > 0 ? (pctChange(highestPrice, baselinePrice) || 0) : 0;
  const pullbackPct = armed && highestPrice > 0 ? ((highestPrice - price) / highestPrice) * 100 : 0;

  let sell = false;
  let sellFraction = 0;
  let finalExit = false;
  let reason = null;
  let nextStage = stage;
  let markDownsideTrimDone = downsideTrimDone;

  const downsideBreak = !downsideTrimDone && recoveryPct <= policy.downside_trim_pct_from_baseline && n(change24hPct) <= policy.downside_24h_confirmation_pct;
  if (policy.enabled && downsideBreak) {
    sell = true;
    sellFraction = policy.downside_trim_fraction;
    reason = 'XEC_STRUCTURAL_BREAKDOWN_TRIM';
    markDownsideTrimDone = true;
  } else if (policy.enabled && armed) {
    const nearCostBasis = currentDrawdownPct !== null && currentDrawdownPct >= policy.near_cost_basis_drawdown_pct;
    if (stage >= 2 && nearCostBasis && pullbackPct >= policy.second_trailing_pullback_pct) {
      sell = true;
      sellFraction = 1;
      finalExit = true;
      reason = 'XEC_NEAR_COST_BASIS_TRAILING_EXIT';
      nextStage = 3;
    } else if (stage >= 2 && highRecoveryPct >= policy.final_take_min_recovery_pct && pullbackPct >= policy.final_trailing_pullback_pct) {
      sell = true;
      sellFraction = 1;
      finalExit = true;
      reason = 'XEC_STRONG_RECOVERY_FINAL_TRAILING_EXIT';
      nextStage = 3;
    } else if (stage === 1 && highRecoveryPct >= policy.second_take_min_recovery_pct && pullbackPct >= policy.second_trailing_pullback_pct) {
      sell = true;
      sellFraction = policy.second_sell_fraction;
      reason = 'XEC_STRONG_RECOVERY_SECOND_PARTIAL';
      nextStage = 2;
    } else if (stage === 0 && highRecoveryPct >= policy.first_take_min_recovery_pct && pullbackPct >= policy.first_trailing_pullback_pct) {
      sell = true;
      sellFraction = policy.first_sell_fraction;
      reason = 'XEC_RECOVERY_TRAILING_FIRST_PARTIAL';
      nextStage = 1;
    }
  }

  return {
    sell,
    sell_fraction: sellFraction,
    final_exit: finalExit,
    reason,
    stage,
    next_stage: nextStage,
    mark_downside_trim_done: markDownsideTrimDone,
    arm_now: shouldArm,
    armed,
    positive_now: positiveNow,
    positive_cycles: positiveCycles,
    baseline_price: baselinePrice,
    current_price: price,
    average_cost_usdt: averageCost > 0 ? averageCost : null,
    baseline_drawdown_pct: baselineDrawdownPct,
    current_drawdown_pct: currentDrawdownPct,
    recovery_pct: recoveryPct,
    improvement_pct: improvementPct,
    highest_price_after_arm: highestPrice,
    high_recovery_pct: highRecoveryPct,
    pullback_from_recovery_high_pct: pullbackPct,
    one_hour_change_pct: n(oneHourChangePct),
    change_24h_pct: n(change24hPct),
    policy
  };
}

module.exports = {
  VERSION,
  normalizeXecPolicy,
  evaluateXecHistoricalHolding,
  pctChange
};
