'use strict';

const { resolveManagedSpotLimits } = require('./spotManagedAcquisitionPolicy');
const { evaluateQuantEntryDecision } = require('./spotQuantEntryDecision');
const { evaluateLearnedEntry } = require('./spotRealLearningPolicy');

const RECOVERY_ENTRY_LANES = new Set(['EARLY_MOMENTUM', 'TACTICAL_MOMENTUM']);
const RECOVERY_BLOCKED_REGIMES = new Set(['BEAR_TREND', 'BEAR_HIGH_VOL']);
const RECOVERY_ALLOWED_ADAPTIVE_REASONS = new Set([
  'NON_POSITIVE_EXPECTANCY',
  'PROFIT_FACTOR_DEGRADED',
  'DRAWDOWN_TOO_HIGH'
]);
const RECOVERY_LEARNING_MIN_EARLY_MOMENTUM_SCORE = 85;
const RECOVERY_LEARNING_MIN_CONFIRMATIONS = 3;
const RECOVERY_LEARNING_MIN_RELATIVE_VOLUME = 1.5;
const SAFE_REAL_CONFIG_CHECKS = [
  ['enabled', true, 'REAL_SPOT_NOT_ENABLED'],
  ['kill_switch', false, 'KILL_SWITCH_ACTIVE'],
  ['new_entries_enabled', true, 'NEW_ENTRIES_DISABLED'],
  ['auto_order_execution', true, 'AUTO_ORDER_EXECUTION_DISABLED'],
  ['real_sells_enabled', true, 'REAL_SELLS_NOT_ENABLED'],
  ['spot_only', true, 'NOT_SPOT_ONLY'],
  ['futures_allowed', false, 'FUTURES_NOT_ALLOWED'],
  ['margin_allowed', false, 'MARGIN_NOT_ALLOWED'],
  ['leverage_allowed', false, 'LEVERAGE_NOT_ALLOWED'],
  ['withdrawals_allowed', false, 'WITHDRAWALS_MUST_BE_DISABLED']
];

function condition(component, code, expected, actual = null) {
  return { component, code, expected, actual };
}

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function evaluateHistoricalDrawdownRecoveryEntry({ reconciliation = {}, exits = {}, adaptiveGate = {}, paperGate = {}, autonomy = {}, config = {}, openPositions = 0 } = {}) {
  const managedLimits = resolveManagedSpotLimits(config);
  const adaptiveReasons = Array.isArray(adaptiveGate.reasons) ? adaptiveGate.reasons : [];
  const selectionLane = String(paperGate.selection_lane || paperGate.candidate?.selection_lane || '').toUpperCase();
  const regime = String(adaptiveGate.regime?.regime || adaptiveGate.market_regime || '').toUpperCase();
  const exitFailures = Array.isArray(exits.failures) ? exits.failures : [];
  const blockers = [];
  const quantDecision = evaluateQuantEntryDecision({ paperGate, adaptiveGate, config });
  const quantPass = quantDecision.allowed === true;

  const controlledHistoricalDegradation = adaptiveGate.allowed === false &&
    adaptiveGate.state === 'DEGRADED' &&
    adaptiveReasons.length > 0 &&
    adaptiveReasons.every((reason) => RECOVERY_ALLOWED_ADAPTIVE_REASONS.has(String(reason)));
  if (!controlledHistoricalDegradation) blockers.push('ADAPTIVE_NOT_DRAWDOWN_ONLY');
  if (!RECOVERY_ENTRY_LANES.has(selectionLane)) blockers.push('RECOVERY_LANE_NOT_ALLOWED');
  if (paperGate.allowed !== true && !quantPass) blockers.push('PAPER_TO_REAL_BLOCKED');
  if (paperGate.technical_confirmation?.allowed !== true && !quantPass) blockers.push('TECHNICAL_CONFIRMATION_BLOCKED');

  if (reconciliation.account_consistent !== true || reconciliation.entries_blocked === true || config.reconciliation_required === true || config.account_consistent === false) {
    blockers.push('RECONCILIATION_BLOCKED');
  }
  if (exits.blocked === true || exits.ok === false || exits.exit_engine_healthy === false || exitFailures.length > 0) {
    blockers.push('EXIT_ENGINE_NOT_HEALTHY');
  }
  if (autonomy.should_halt === true) blockers.push('AUTONOMY_HALTED');
  if (Number(openPositions || 0) >= managedLimits.max_managed_spot_assets) blockers.push('RECOVERY_MAX_MANAGED_SPOT_ASSETS_REACHED');
  if (!regime || regime === 'UNKNOWN') blockers.push('MARKET_REGIME_UNKNOWN');
  else if (RECOVERY_BLOCKED_REGIMES.has(regime)) blockers.push('RECOVERY_BLOCKED_BEAR_REGIME');

  for (const [field, expected, code] of SAFE_REAL_CONFIG_CHECKS) {
    if (config[field] !== expected) blockers.push(code);
  }
  if (managedLimits.max_per_acquisition_usdt !== 25) blockers.push('RECOVERY_POSITION_LIMIT_MUST_BE_25_USDT');
  if (managedLimits.max_managed_spot_assets > 2) blockers.push('RECOVERY_MAX_POSITIONS_MUST_BE_2');
  if (managedLimits.max_total_managed_capital_usdt > 50) blockers.push('RECOVERY_MANAGED_CAPITAL_ABOVE_50_USDT');

  return {
    allowed: blockers.length === 0,
    adaptive_recovery_entry: blockers.length === 0,
    policy: 'historical_drawdown_recovery_25_usdt',
    risk_signal: adaptiveReasons,
    selection_lane: selectionLane || null,
    regime: regime || null,
    max_position_usdt: managedLimits.max_per_acquisition_usdt,
    max_managed_spot_assets: managedLimits.max_managed_spot_assets,
    max_total_managed_capital_usdt: managedLimits.max_total_managed_capital_usdt,
    quant_decision: quantDecision,
    blockers: [...new Set(blockers)]
  };
}

function evaluateLearnedRecoveryOverride({ learnedDecision = {}, reconciliation = {}, exits = {}, adaptiveGate = {}, paperGate = {}, autonomy = {}, config = {}, openPositions = 0, adaptiveRecovery = null } = {}) {
  const candidate = paperGate.candidate || {};
  const metrics = candidate.earlyMomentum || candidate.early_momentum || {};
  const selectionLane = String(paperGate.selection_lane || candidate.selection_lane || '').toUpperCase();
  const stage = String(autonomy.current_stage || config.autonomy_stage || config.autonomy_snapshot?.current_stage || '').toUpperCase();
  const managedLimits = resolveManagedSpotLimits(config);
  const earlyMomentumScore = asNumber(candidate.earlyMomentumScore ?? candidate.early_momentum_score ?? metrics.score, 0);
  const confirmations = asNumber(metrics.confirmations, 0);
  const relativeVolume = asNumber(metrics.relative_volume_15m, 0);
  const minimumMomentumScore = Math.max(
    RECOVERY_LEARNING_MIN_EARLY_MOMENTUM_SCORE,
    asNumber(config.recovery_learning_min_early_momentum_score, RECOVERY_LEARNING_MIN_EARLY_MOMENTUM_SCORE)
  );
  const minimumRelativeVolume = Math.max(
    RECOVERY_LEARNING_MIN_RELATIVE_VOLUME,
    asNumber(config.early_momentum_min_relative_volume, RECOVERY_LEARNING_MIN_RELATIVE_VOLUME)
  );
  const recovery = adaptiveRecovery || evaluateHistoricalDrawdownRecoveryEntry({
    reconciliation,
    exits,
    adaptiveGate,
    paperGate,
    autonomy,
    config,
    openPositions
  });
  const regime = String(adaptiveGate.regime?.regime || adaptiveGate.market_regime || '').toUpperCase();
  const exitFailures = Array.isArray(exits.failures) ? exits.failures : [];
  const blockers = [];

  if (learnedDecision.allowed !== false || learnedDecision.reason !== 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY') {
    blockers.push('LEARNING_NEGATIVE_EXPECTANCY_NOT_PRESENT');
  }
  if (stage !== 'RECOVERY_25_USDT') blockers.push('LEARNING_OVERRIDE_REQUIRES_RECOVERY_25_USDT');
  if (managedLimits.max_per_acquisition_usdt !== 25) blockers.push('LEARNING_OVERRIDE_REQUIRES_25_USDT_LIMIT');
  if (managedLimits.max_managed_spot_assets !== 2) blockers.push('LEARNING_OVERRIDE_REQUIRES_2_POSITION_LIMIT');
  if (managedLimits.max_total_managed_capital_usdt > 50) blockers.push('LEARNING_OVERRIDE_REQUIRES_50_USDT_CAP');
  if (!RECOVERY_ENTRY_LANES.has(selectionLane)) blockers.push('LEARNING_OVERRIDE_LANE_NOT_ALLOWED');
  if (earlyMomentumScore < minimumMomentumScore) blockers.push('LEARNING_OVERRIDE_MOMENTUM_BELOW_85');
  if (confirmations < RECOVERY_LEARNING_MIN_CONFIRMATIONS) blockers.push('LEARNING_OVERRIDE_CONFIRMATIONS_BELOW_3');
  if (relativeVolume < minimumRelativeVolume) blockers.push('LEARNING_OVERRIDE_RELATIVE_VOLUME_TOO_LOW');
  if (paperGate.allowed !== true) blockers.push('LEARNING_OVERRIDE_PAPER_TO_REAL_NOT_PASS');
  if (paperGate.technical_confirmation?.allowed !== true) blockers.push('LEARNING_OVERRIDE_TECHNICAL_CONFIRMATION_NOT_PASS');
  if (recovery.allowed !== true) blockers.push('LEARNING_OVERRIDE_ADAPTIVE_RECOVERY_NOT_PASS');
  if (reconciliation.account_consistent !== true || reconciliation.entries_blocked === true || config.reconciliation_required === true || config.account_consistent === false) {
    blockers.push('LEARNING_OVERRIDE_RECONCILIATION_NOT_PASS');
  }
  if (exits.blocked === true || exits.ok === false || exits.exit_engine_healthy === false || exitFailures.length > 0) {
    blockers.push('LEARNING_OVERRIDE_EXIT_ENGINE_NOT_HEALTHY');
  }
  if (autonomy.should_halt === true) blockers.push('LEARNING_OVERRIDE_AUTONOMY_HALTED');
  if (!regime || regime === 'UNKNOWN' || RECOVERY_BLOCKED_REGIMES.has(regime)) blockers.push('LEARNING_OVERRIDE_MARKET_REGIME_BLOCKED');

  return {
    allowed: blockers.length === 0,
    policy: 'learned_negative_expectancy_recovery_override_v2_25_usdt',
    learning_remains_active: true,
    risk_signal: learnedDecision.reason || null,
    candidate_score: learnedDecision.candidate_score ?? asNumber(candidate.opportunityScore ?? candidate.score, 0),
    score_band: learnedDecision.score_band || null,
    selection_lane: selectionLane || null,
    recovery_stage: stage || null,
    max_position_usdt: managedLimits.max_per_acquisition_usdt,
    thresholds: {
      minimum_early_momentum_score: minimumMomentumScore,
      minimum_confirmations: RECOVERY_LEARNING_MIN_CONFIRMATIONS,
      minimum_relative_volume_15m: minimumRelativeVolume
    },
    metrics: {
      early_momentum_score: earlyMomentumScore,
      confirmations,
      relative_volume_15m: relativeVolume,
      accelerating: metrics.accelerating === true
    },
    adaptive_recovery: {
      allowed: recovery.allowed === true,
      blockers: recovery.blockers || [],
      regime: recovery.regime || regime || null
    },
    blockers: [...new Set(blockers)]
  };
}

function buildEntrySafetyFailures({ reconciliation = {}, exits = {}, adaptiveGate = {}, paperGate = {}, autonomy = {}, config = {}, openPositions = 0 } = {}) {
  const failures = [];
  const managedLimits = resolveManagedSpotLimits(config);
  const quantDecision = evaluateQuantEntryDecision({ paperGate, adaptiveGate, config });
  const learningProfile = autonomy.learning_profile || config.autonomy_snapshot?.learning_profile || {};
  const learnedDecision = evaluateLearnedEntry(paperGate.candidate || {}, learningProfile);
  const adaptiveRecovery = evaluateHistoricalDrawdownRecoveryEntry({ reconciliation, exits, adaptiveGate, paperGate, autonomy, config, openPositions });
  const learnedRecoveryOverride = evaluateLearnedRecoveryOverride({
    learnedDecision,
    reconciliation,
    exits,
    adaptiveGate,
    paperGate,
    autonomy,
    config,
    openPositions,
    adaptiveRecovery
  });
  const learnedEntryAllowed = learnedDecision.allowed === true || learnedRecoveryOverride.allowed === true;

  Object.assign(paperGate, {
    quant_entry_decision: quantDecision,
    quant_entry_allowed: quantDecision.allowed,
    quant_entry_score: quantDecision.score,
    quant_entry_expected_value_pct: quantDecision.expected_value_pct,
    learned_entry_decision: learnedDecision,
    learned_entry_raw_allowed: learnedDecision.allowed,
    learned_entry_allowed: learnedEntryAllowed,
    learned_entry_recovery_override: learnedRecoveryOverride,
    learned_entry_risk_signal: learnedDecision.allowed === false && learnedRecoveryOverride.allowed === true
      ? learnedDecision.reason
      : null
  });

  if (learnedEntryAllowed !== true) {
    failures.push(condition(
      'Real Performance Learning',
      learnedDecision.reason || 'LEARNED_ENTRY_BLOCKED',
      'Candidate score band must not have statistically supported negative real expectancy unless the strict RECOVERY_25_USDT momentum exception passes',
      {
        learned_decision: learnedDecision,
        recovery_override: learnedRecoveryOverride
      }
    ));
  }

  if (reconciliation.account_consistent !== true || reconciliation.entries_blocked === true || config.reconciliation_required === true || config.account_consistent === false) {
    failures.push(condition('Reconciliation', reconciliation.reason || config.entry_block_reason || 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED', 'Binance and Firestore consistent; entries_blocked=false', {
      account_consistent: reconciliation.account_consistent,
      entries_blocked: reconciliation.entries_blocked,
      reconciliation_required: config.reconciliation_required
    }));
  }

  const exitFailures = Array.isArray(exits.failures) ? exits.failures : [];
  if (exits.blocked === true || exits.ok === false || exits.exit_engine_healthy === false || exitFailures.length > 0) {
    failures.push(condition('Exit Engine', exits.blocked_reason || exitFailures[0]?.reason || exitFailures[0]?.error || 'EXIT_ENGINE_NOT_HEALTHY', 'Exit evaluation completes without failures', {
      blocked: exits.blocked,
      healthy: exits.exit_engine_healthy,
      failure_count: exitFailures.length
    }));
  }

  Object.assign(adaptiveGate, {
    adaptive_recovery_entry: adaptiveRecovery.allowed,
    adaptive_recovery_policy: adaptiveRecovery.policy,
    adaptive_recovery_max_position_usdt: adaptiveRecovery.max_position_usdt,
    adaptive_recovery_blockers: adaptiveRecovery.blockers,
    adaptive_recovery_quant_decision: adaptiveRecovery.quant_decision
  });

  if (adaptiveGate.allowed === false && adaptiveRecovery.allowed !== true && quantDecision.allowed !== true) {
    failures.push(condition('Adaptive Strategy', adaptiveGate.reasons?.[0] || 'ADAPTIVE_STRATEGY_DEGRADED', 'Adaptive strategy entry_allowed=true, controlled historical-performance recovery passes, or quantitative fast-lane expected value is positive', {
      state: adaptiveGate.state,
      reasons: adaptiveGate.reasons || [],
      recovery_policy: adaptiveRecovery.policy,
      recovery_blockers: adaptiveRecovery.blockers,
      quant_decision: quantDecision
    }));
  }

  if (paperGate.allowed !== true && quantDecision.allowed !== true) {
    const reasons = Array.isArray(paperGate.reasons) && paperGate.reasons.length ? paperGate.reasons : ['PAPER_REAL_ENTRY_GATE_BLOCKED'];
    for (const reason of reasons) failures.push(condition(reason.startsWith('TECHNICAL_') ? 'Technical Confirmation' : 'Paper-to-Real', reason, 'Current candidate satisfies the corresponding gate or quantitative fast-lane policy has positive expected value', paperGate.failed_conditions || null));
  }

  if (Number(openPositions || 0) >= managedLimits.max_managed_spot_assets) {
    failures.push(condition('Managed Spot Assets', 'MAX_MANAGED_SPOT_ASSETS_REACHED', `managed Spot acquisitions < ${managedLimits.max_managed_spot_assets}`, Number(openPositions || 0)));
  }
  if (autonomy.should_halt === true) failures.push(condition('Autonomy', autonomy.halt_reason || 'AUTONOMY_HALTED', 'autonomy.should_halt=false', true));

  for (const [field, expected, code] of SAFE_REAL_CONFIG_CHECKS) {
    if (config[field] !== expected) failures.push(condition('Configuration', code, `${field}=${expected}`, config[field]));
  }
  if (Number(config.max_position_usdt) !== managedLimits.max_per_acquisition_usdt) {
    failures.push(condition('Managed Spot Assets', 'POSITION_LIMIT_CONFIG_MISMATCH', `max_position_usdt=${managedLimits.max_per_acquisition_usdt}`, config.max_position_usdt));
  }

  return failures;
}

function buildPromotionConfidence(gate = {}) {
  return {
    indicator_only: true,
    blocks_entry: false,
    state: gate.state || 'UNKNOWN',
    high_confidence: gate.allowed === true,
    symbol: gate.symbol || null,
    reasons: gate.reasons || [],
    paper: gate.paper || null,
    real: gate.real || null,
    updated_at: gate.updated_at || gate.created_at || null
  };
}

function firstFailureReason(failures = []) {
  return failures[0]?.code || null;
}

module.exports = {
  buildEntrySafetyFailures,
  buildPromotionConfidence,
  firstFailureReason,
  evaluateHistoricalDrawdownRecoveryEntry,
  evaluateLearnedRecoveryOverride,
  RECOVERY_ALLOWED_ADAPTIVE_REASONS,
  RECOVERY_LEARNING_MIN_EARLY_MOMENTUM_SCORE,
  RECOVERY_LEARNING_MIN_CONFIRMATIONS,
  RECOVERY_LEARNING_MIN_RELATIVE_VOLUME
};
