'use strict';

const assert = require('assert');
const {
  buildAutonomyControlPatch,
  RECOVERY_PRODUCTIVITY_MAX_OPEN_POSITIONS,
  RECOVERY_PRODUCTIVITY_MAX_TOTAL_CAPITAL_USDT
} = require('../services/spotAutonomyController');
const {
  evaluateHistoricalDrawdownRecoveryEntry,
  buildEntrySafetyFailures
} = require('../services/spotRealPipelinePolicy');

assert.strictEqual(RECOVERY_PRODUCTIVITY_MAX_OPEN_POSITIONS, 3);
assert.strictEqual(RECOVERY_PRODUCTIVITY_MAX_TOTAL_CAPITAL_USDT, 75);

const snapshot = {
  should_halt: false,
  performance_recovery_mode: true,
  performance_recovery_reason: 'RECENT_REAL_PERFORMANCE_DEGRADED',
  current_stage: 'RECOVERY_25_USDT'
};

const migrationPatch = buildAutonomyControlPatch({ enabled: true }, snapshot, '2026-09-06T20:00:00.000Z');
assert.strictEqual(migrationPatch.max_position_usdt, 25);
assert.strictEqual(migrationPatch.max_open_positions, 2);
assert.strictEqual(migrationPatch.max_total_capital_usdt, 50);
assert.strictEqual(migrationPatch.recovery_productivity_capacity_enabled, true);
assert.strictEqual(migrationPatch.recovery_productivity_capacity_active, false);

const productivePatch = buildAutonomyControlPatch({
  enabled: true,
  recovery_productivity_capacity_enabled: true
}, snapshot, '2026-09-06T20:05:00.000Z');
assert.strictEqual(productivePatch.max_position_usdt, 25);
assert.strictEqual(productivePatch.max_open_positions, 3);
assert.strictEqual(productivePatch.max_total_capital_usdt, 75);
assert.strictEqual(productivePatch.recovery_productivity_capacity_active, true);

const config = {
  enabled: true,
  kill_switch: false,
  new_entries_enabled: true,
  auto_order_execution: true,
  real_sells_enabled: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false,
  max_position_usdt: 25,
  max_open_positions: 3,
  max_total_capital_usdt: 75,
  recovery_productivity_capacity_enabled: true,
  reconciliation_required: false,
  account_consistent: true,
  autonomy_stage: 'RECOVERY_25_USDT'
};
const reconciliation = { account_consistent: true, entries_blocked: false };
const exits = { ok: true, blocked: false, exit_engine_healthy: true, failures: [] };
const adaptiveGate = {
  allowed: false,
  state: 'DEGRADED',
  reasons: ['PROFIT_FACTOR_DEGRADED'],
  regime: { regime: 'BULL_TREND' }
};
const paperGate = {
  allowed: true,
  selection_lane: 'EARLY_MOMENTUM',
  candidate: { symbol: 'TESTUSDT', selection_lane: 'EARLY_MOMENTUM' },
  technical_confirmation: { allowed: true }
};
const autonomy = { should_halt: false, current_stage: 'RECOVERY_25_USDT' };

const recoveryAtTwo = evaluateHistoricalDrawdownRecoveryEntry({
  reconciliation, exits, adaptiveGate, paperGate, autonomy, config, openPositions: 2
});
assert.strictEqual(recoveryAtTwo.allowed, true);
assert.strictEqual(recoveryAtTwo.max_managed_spot_assets, 3);
assert.strictEqual(recoveryAtTwo.max_total_managed_capital_usdt, 75);
assert.strictEqual(recoveryAtTwo.recovery_productivity_capacity, true);

const twoPositionFailures = buildEntrySafetyFailures({
  reconciliation,
  exits,
  adaptiveGate: { ...adaptiveGate },
  paperGate: { ...paperGate, candidate: { ...paperGate.candidate } },
  autonomy,
  config,
  openPositions: 2
});
assert.ok(!twoPositionFailures.some((item) => item.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));

const threePositionFailures = buildEntrySafetyFailures({
  reconciliation,
  exits,
  adaptiveGate: { ...adaptiveGate },
  paperGate: { ...paperGate, candidate: { ...paperGate.candidate } },
  autonomy,
  config,
  openPositions: 3
});
assert.ok(threePositionFailures.some((item) => item.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));

const weakTechnicalFailures = buildEntrySafetyFailures({
  reconciliation,
  exits,
  adaptiveGate: { ...adaptiveGate },
  paperGate: {
    ...paperGate,
    allowed: false,
    reasons: ['TECHNICAL_VOLUME_NOT_CONFIRMED'],
    technical_confirmation: { allowed: false },
    candidate: { ...paperGate.candidate }
  },
  autonomy,
  config,
  openPositions: 2
});
assert.ok(weakTechnicalFailures.some((item) => item.code === 'TECHNICAL_VOLUME_NOT_CONFIRMED'));

console.log('spotRecoveryProductivityCapacity.test.js: PASS');
