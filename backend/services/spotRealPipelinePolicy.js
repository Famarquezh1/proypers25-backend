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
  if (!controlledHistoricalDegradation) blockers.push('ADAPTIVE_DEGRADATION_NOT_RECOVERABLE');
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
  if (Number(openPositions || 0) >= managedLimits.max_managed_spot_assets) blockers.push('RECOVERY_MANAGED_SLOTS_FULL');
  if (!regime || regime === 'UNKNOWN') blockers.push('MARKET_REGIME_UNKNOWN');
  else if (RECOVERY_BLOCKED_REGIMES.has(regime)) blockers.push('RECOVERY_BLOCKED_BEAR_REGIME');

  for (const [field, expected, code] of SAFE_REAL_CONFIG_CHECKS) {
    if (config[field] !== expected) blockers.push(code);
  }
  // Historical-performance recovery is deliberately capped at the 5 USDT tier.
  if (managedLimits.max_per_acquisition_usdt <= 0 || managedLimits.max_per_acquisition_usdt > 5) blockers.push('RECOVERY_POSITION_LIMIT_UNSAFE');

  return {
    allowed: blockers.length === 0,
    adaptive_recovery_entry: blockers.length === 0,
    policy: 'controlled_historical_performance_recovery',
    risk_signal: adaptiveReasons,
    selection_lane: selectionLane || null,
    regime: regime || null,
    max_position_usdt: managedLimits.max_per_acquisition_usdt,
    quant_decision: quantDecision,
    blockers: [...new Set(blockers)]
  };
}

function buildEntrySafetyFailures({ reconciliation = {}, exits = {}, adaptiveGate = {}, paperGate = {}, autonomy = {}, config = {}, openPositions = 0 } = {}) {
  const failures = [];
  const managedLimits = resolveManagedSpotLimits(config);
  const quantDecision = evaluateQuantEntryDecision({ paperGate, adaptiveGate, config });
  const learningProfile = autonomy.learning_profile || config.autonomy_snapshot?.learning_profile || {};
  const learnedDecision = evaluateLearnedEntry(paperGate.candidate || {}, learningProfile);
  Object.assign(paperGate, {
    quant_entry_decision: quantDecision,
    quant_entry_allowed: quantDecision.allowed,
    quant_entry_score: quantDecision.score,
    quant_entry_expected_value_pct: quantDecision.expected_value_pct,
    learned_entry_decision: learnedDecision,
    learned_entry_allowed: learnedDecision.allowed
  });

  if (learnedDecision.allowed !== true) {
    failures.push(condition(
      'Real Performance Learning',
      learnedDecision.reason || 'LEARNED_ENTRY_BLOCKED',
      'Candidate score band must not have statistically supported negative real expectancy',
      learnedDecision
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

  const adaptiveRecovery = evaluateHistoricalDrawdownRecoveryEntry({ reconciliation, exits, adaptiveGate, paperGate, autonomy, config, openPositions });
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
  RECOVERY_ALLOWED_ADAPTIVE_REASONS
};
