'use strict';

const assert = require('assert');
const {
  resolveManagedSpotLimits,
  managedAcquisitionCapacity,
  MAX_MANAGED_SPOT_ASSETS,
  MAX_MANAGED_CAPITAL_USDT,
  MAX_PER_ACQUISITION_USDT
} = require('../services/spotManagedAcquisitionPolicy');
const { buildEntrySafetyFailures } = require('../services/spotRealPipelinePolicy');

const limits = resolveManagedSpotLimits({ max_position_usdt: 10, max_open_positions: 4, max_total_capital_usdt: 40 });
assert.strictEqual(MAX_MANAGED_SPOT_ASSETS, 4);
assert.strictEqual(MAX_MANAGED_CAPITAL_USDT, 80);
assert.strictEqual(MAX_PER_ACQUISITION_USDT, 20);
assert.strictEqual(limits.max_managed_spot_assets, 4);
assert.strictEqual(limits.max_total_managed_capital_usdt, 40);
assert.strictEqual(limits.max_per_acquisition_usdt, 10);
assert.strictEqual(limits.legacy_max_open_positions, 4);

const recoveryLimits = resolveManagedSpotLimits({ max_position_usdt: 5, max_open_positions: 4, max_total_capital_usdt: 20 });
assert.strictEqual(recoveryLimits.max_per_acquisition_usdt, 5);
assert.strictEqual(recoveryLimits.max_total_managed_capital_usdt, 20);

const growthLimits = resolveManagedSpotLimits({ max_position_usdt: 20, max_open_positions: 4, max_total_capital_usdt: 80 });
assert.strictEqual(growthLimits.max_per_acquisition_usdt, 20);
assert.strictEqual(growthLimits.max_total_managed_capital_usdt, 80);

const threeManaged = managedAcquisitionCapacity({
  currentManagedAssets: 3,
  currentManagedCapitalUsdt: 30,
  config: { max_position_usdt: 10, max_total_capital_usdt: 40, max_open_positions: 4 }
});
assert.strictEqual(threeManaged.can_acquire, true);
assert.strictEqual(threeManaged.slots_remaining, 1);
assert.strictEqual(threeManaged.managed_capital_remaining_usdt, 10);

const fourManaged = managedAcquisitionCapacity({
  currentManagedAssets: 4,
  currentManagedCapitalUsdt: 40,
  config: { max_position_usdt: 10, max_total_capital_usdt: 40 }
});
assert.strictEqual(fourManaged.can_acquire, false);
assert.strictEqual(fourManaged.slots_remaining, 0);
assert.strictEqual(fourManaged.managed_capital_remaining_usdt, 0);

function safeGateInput(openPositions) {
  return {
    reconciliation: { account_consistent: true, entries_blocked: false },
    exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
    adaptiveGate: { allowed: true },
    paperGate: { allowed: true, reasons: [] },
    autonomy: { should_halt: false },
    openPositions,
    config: {
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
      max_position_usdt: 10,
      max_total_capital_usdt: 40,
      max_open_positions: 4
    }
  };
}

const threeFailures = buildEntrySafetyFailures(safeGateInput(3));
assert.ok(!threeFailures.some((failure) => failure.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));
assert.ok(!threeFailures.some((failure) => failure.code === 'MAX_OPEN_POSITIONS_MUST_BE_1'));

const fourFailures = buildEntrySafetyFailures(safeGateInput(4));
assert.ok(fourFailures.some((failure) => failure.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));

console.log('managedSpotAcquisitionPolicy.test.js: PASS');
