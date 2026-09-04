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
const { evaluateSpotEntryMarketSafety } = require('../services/spotEntryMarketSafety');

const limits = resolveManagedSpotLimits({ max_position_usdt: 10, max_open_positions: 4, max_total_capital_usdt: 40 });
assert.strictEqual(MAX_MANAGED_SPOT_ASSETS, 4);
assert.strictEqual(MAX_MANAGED_CAPITAL_USDT, 80);
assert.strictEqual(MAX_PER_ACQUISITION_USDT, 25);
assert.strictEqual(limits.max_managed_spot_assets, 4);
assert.strictEqual(limits.max_total_managed_capital_usdt, 40);
assert.strictEqual(limits.max_per_acquisition_usdt, 10);
assert.strictEqual(limits.legacy_max_open_positions, 4);

const recoveryLimits = resolveManagedSpotLimits({ max_position_usdt: 25, max_open_positions: 2, max_total_capital_usdt: 50 });
assert.strictEqual(recoveryLimits.max_per_acquisition_usdt, 25);
assert.strictEqual(recoveryLimits.max_managed_spot_assets, 2);
assert.strictEqual(recoveryLimits.max_total_managed_capital_usdt, 50);

const growthLimits = resolveManagedSpotLimits({ max_position_usdt: 20, max_open_positions: 4, max_total_capital_usdt: 80 });
assert.strictEqual(growthLimits.max_per_acquisition_usdt, 20);
assert.strictEqual(growthLimits.max_managed_spot_assets, 4);
assert.strictEqual(growthLimits.max_total_managed_capital_usdt, 80);

const oneRecoveryManaged = managedAcquisitionCapacity({
  currentManagedAssets: 1,
  currentManagedCapitalUsdt: 25,
  config: { max_position_usdt: 25, max_total_capital_usdt: 50, max_open_positions: 2 }
});
assert.strictEqual(oneRecoveryManaged.can_acquire, true);
assert.strictEqual(oneRecoveryManaged.slots_remaining, 1);
assert.strictEqual(oneRecoveryManaged.managed_capital_remaining_usdt, 25);

const twoRecoveryManaged = managedAcquisitionCapacity({
  currentManagedAssets: 2,
  currentManagedCapitalUsdt: 50,
  config: { max_position_usdt: 25, max_total_capital_usdt: 50, max_open_positions: 2 }
});
assert.strictEqual(twoRecoveryManaged.can_acquire, false);
assert.strictEqual(twoRecoveryManaged.slots_remaining, 0);
assert.strictEqual(twoRecoveryManaged.managed_capital_remaining_usdt, 0);

const capitalExhausted = managedAcquisitionCapacity({
  currentManagedAssets: 1,
  currentManagedCapitalUsdt: 30,
  config: { max_position_usdt: 25, max_total_capital_usdt: 50, max_open_positions: 2 }
});
assert.strictEqual(capitalExhausted.can_acquire, false);
assert.strictEqual(capitalExhausted.managed_capital_remaining_usdt, 20);

const sushiInfo = {
  symbol: 'SUSHIUSDT',
  baseAsset: 'SUSHI',
  quoteAsset: 'USDT',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '0.10000000', maxQty: '9000000.00000000', stepSize: '0.10000000' },
    { filterType: 'NOTIONAL', minNotional: '5.00000000' }
  ]
};

const unsafeFiveDollarEntry = evaluateSpotEntryMarketSafety({
  symbol: 'SUSHIUSDT',
  quoteOrderQty: 5,
  currentPrice: 0.1998,
  symbolInfo: sushiInfo
});
assert.strictEqual(unsafeFiveDollarEntry.allowed, false);
assert([
  'ENTRY_POST_FEE_NOTIONAL_BELOW_MINIMUM',
  'ENTRY_MIN_NOTIONAL_HEADROOM_INSUFFICIENT'
].includes(unsafeFiveDollarEntry.reason));
assert(unsafeFiveDollarEntry.estimated_sellable_quantity_after_fee < 25);
assert(unsafeFiveDollarEntry.estimated_sellable_notional_now_usdt < unsafeFiveDollarEntry.rules.minimum_notional_usdt ||
  unsafeFiveDollarEntry.stress_sellable_notional_usdt < unsafeFiveDollarEntry.required_headroom_notional_usdt);

const safeRecoveryEntry = evaluateSpotEntryMarketSafety({
  symbol: 'SUSHIUSDT',
  quoteOrderQty: 25,
  currentPrice: 0.1998,
  symbolInfo: sushiInfo
});
assert.strictEqual(safeRecoveryEntry.allowed, true);
assert(safeRecoveryEntry.stress_sellable_notional_usdt > safeRecoveryEntry.required_headroom_notional_usdt);

const coarseStepInfo = {
  ...sushiInfo,
  symbol: 'COARSEUSDT',
  baseAsset: 'COARSE',
  filters: [
    { filterType: 'LOT_SIZE', minQty: '10', maxQty: '100000', stepSize: '10' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5' }
  ]
};
const postFeeUnsafe = evaluateSpotEntryMarketSafety({
  symbol: 'COARSEUSDT',
  quoteOrderQty: 6,
  currentPrice: 0.61,
  symbolInfo: coarseStepInfo
});
assert.strictEqual(postFeeUnsafe.allowed, false);
assert(['ENTRY_POST_FEE_QUANTITY_BELOW_MINIMUM', 'ENTRY_POST_FEE_NOTIONAL_BELOW_MINIMUM', 'ENTRY_MIN_NOTIONAL_HEADROOM_INSUFFICIENT'].includes(postFeeUnsafe.reason));

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

const fourFailures = buildEntrySafetyFailures(safeGateInput(4));
assert.ok(fourFailures.some((failure) => failure.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));

console.log('managedSpotAcquisitionPolicy.test.js: PASS');
