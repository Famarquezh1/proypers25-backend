'use strict';

const { resolveManagedSpotLimits } = require('./spotManagedAcquisitionPolicy');

function condition(component, code, expected, actual = null) {
  return { component, code, expected, actual };
}

function buildEntrySafetyFailures({ reconciliation = {}, exits = {}, adaptiveGate = {}, paperGate = {}, autonomy = {}, config = {}, openPositions = 0 } = {}) {
  const failures = [];
  const managedLimits = resolveManagedSpotLimits(config);

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

  if (adaptiveGate.allowed === false) {
    failures.push(condition('Adaptive Strategy', adaptiveGate.reasons?.[0] || 'ADAPTIVE_STRATEGY_DEGRADED', 'Adaptive strategy entry_allowed=true', {
      state: adaptiveGate.state,
      reasons: adaptiveGate.reasons || []
    }));
  }

  if (paperGate.allowed !== true) {
    const reasons = Array.isArray(paperGate.reasons) && paperGate.reasons.length ? paperGate.reasons : ['PAPER_REAL_ENTRY_GATE_BLOCKED'];
    for (const reason of reasons) failures.push(condition(reason.startsWith('TECHNICAL_') ? 'Technical Confirmation' : 'Paper-to-Real', reason, 'Current candidate satisfies the corresponding gate', paperGate.failed_conditions || null));
  }

  if (Number(openPositions || 0) >= managedLimits.max_managed_spot_assets) {
    failures.push(condition(
      'Managed Spot Assets',
      'MAX_MANAGED_SPOT_ASSETS_REACHED',
      `managed Spot acquisitions < ${managedLimits.max_managed_spot_assets}`,
      Number(openPositions || 0)
    ));
  }
  if (autonomy.should_halt === true) failures.push(condition('Autonomy', autonomy.halt_reason || 'AUTONOMY_HALTED', 'autonomy.should_halt=false', true));

  const checks = [
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
  for (const [field, expected, code] of checks) {
    if (config[field] !== expected) failures.push(condition('Configuration', code, `${field}=${expected}`, config[field]));
  }
  if (Number(config.max_position_usdt) !== managedLimits.max_per_acquisition_usdt) {
    failures.push(condition('Managed Spot Assets', 'POSITION_LIMIT_MUST_BE_10_USDT', `max_position_usdt=${managedLimits.max_per_acquisition_usdt}`, config.max_position_usdt));
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

module.exports = { buildEntrySafetyFailures, buildPromotionConfidence, firstFailureReason };
