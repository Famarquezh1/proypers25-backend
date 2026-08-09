'use strict';

const assert = require('assert');
const { evaluateXecHistoricalHolding, normalizeXecPolicy } = require('../services/xecHistoricalHoldingPolicy');
const { normalizeConfig: normalizeManagerConfig, sellableQuantity, buildClientOrderId } = require('../services/xecHistoricalHoldingManager');

const policy = normalizeXecPolicy({});
assert.strictEqual(policy.upside_arm_recovery_pct, 12);
assert.strictEqual(policy.first_take_min_recovery_pct, 15);
assert.strictEqual(policy.second_take_min_recovery_pct, 30);
assert.strictEqual(policy.final_take_min_recovery_pct, 50);
assert.strictEqual(policy.first_sell_fraction, 0.25);
assert.strictEqual(policy.second_sell_fraction, 0.5);
assert.strictEqual(policy.downside_trim_pct_from_baseline, -15);

const managerConfig = normalizeManagerConfig({ new_xec_entries_allowed: true });
assert.strictEqual(managerConfig.enabled, true);
assert.strictEqual(managerConfig.xec_managed_exit_enabled, true);
assert.strictEqual(managerConfig.new_xec_entries_allowed, false);
assert.strictEqual(managerConfig.sell_to_usdt, true);

const quiet = evaluateXecHistoricalHolding({
  state: { baseline_price: 100, last_price: 100, positive_cycles: 0, xec_exit_stage: 0 },
  currentPrice: 100,
  averageCost: 150,
  oneHourChangePct: 0,
  change24hPct: 0,
  config: {}
});
assert.strictEqual(quiet.sell, false);
assert.strictEqual(quiet.armed, false);

const arm = evaluateXecHistoricalHolding({
  state: { baseline_price: 100, last_price: 110, positive_cycles: 1, xec_exit_stage: 0 },
  currentPrice: 116,
  averageCost: 150,
  oneHourChangePct: 1,
  change24hPct: 4,
  config: {}
});
assert.strictEqual(arm.arm_now, true);
assert.strictEqual(arm.armed, true);
assert.strictEqual(arm.sell, false);

const firstPartial = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 118,
    positive_cycles: 2,
    xec_exit_stage: 0,
    xec_runner_armed: true,
    highest_price_after_arm: 120
  },
  currentPrice: 113.5,
  averageCost: 150,
  oneHourChangePct: -1,
  change24hPct: 3,
  config: {}
});
assert.strictEqual(firstPartial.sell, true);
assert.strictEqual(firstPartial.sell_fraction, 0.25);
assert.strictEqual(firstPartial.final_exit, false);
assert.strictEqual(firstPartial.reason, 'XEC_RECOVERY_TRAILING_FIRST_PARTIAL');
assert.strictEqual(firstPartial.next_stage, 1);

const secondPartial = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 132,
    positive_cycles: 2,
    xec_exit_stage: 1,
    xec_runner_armed: true,
    highest_price_after_arm: 135
  },
  currentPrice: 126,
  averageCost: 150,
  oneHourChangePct: -1,
  change24hPct: 8,
  config: {}
});
assert.strictEqual(secondPartial.sell, true);
assert.strictEqual(secondPartial.sell_fraction, 0.5);
assert.strictEqual(secondPartial.final_exit, false);
assert.strictEqual(secondPartial.reason, 'XEC_STRONG_RECOVERY_SECOND_PARTIAL');
assert.strictEqual(secondPartial.next_stage, 2);

const finalRunnerExit = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 155,
    positive_cycles: 2,
    xec_exit_stage: 2,
    xec_runner_armed: true,
    highest_price_after_arm: 160
  },
  currentPrice: 147,
  averageCost: 180,
  oneHourChangePct: -1,
  change24hPct: 10,
  config: {}
});
assert.strictEqual(finalRunnerExit.sell, true);
assert.strictEqual(finalRunnerExit.sell_fraction, 1);
assert.strictEqual(finalRunnerExit.final_exit, true);
assert.strictEqual(finalRunnerExit.reason, 'XEC_STRONG_RECOVERY_FINAL_TRAILING_EXIT');
assert.strictEqual(finalRunnerExit.next_stage, 3);

const nearCostBasisExit = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 151,
    positive_cycles: 2,
    xec_exit_stage: 2,
    xec_runner_armed: true,
    highest_price_after_arm: 160
  },
  currentPrice: 150,
  averageCost: 157,
  oneHourChangePct: -0.5,
  change24hPct: 5,
  config: {}
});
assert.strictEqual(nearCostBasisExit.sell, true);
assert.strictEqual(nearCostBasisExit.final_exit, true);
assert.strictEqual(nearCostBasisExit.reason, 'XEC_NEAR_COST_BASIS_TRAILING_EXIT');

const downsideTrim = evaluateXecHistoricalHolding({
  state: { baseline_price: 100, last_price: 90, positive_cycles: 0, xec_exit_stage: 0, xec_downside_trim_done: false },
  currentPrice: 84,
  averageCost: 150,
  oneHourChangePct: -2,
  change24hPct: -4,
  config: {}
});
assert.strictEqual(downsideTrim.sell, true);
assert.strictEqual(downsideTrim.sell_fraction, 0.25);
assert.strictEqual(downsideTrim.final_exit, false);
assert.strictEqual(downsideTrim.reason, 'XEC_STRUCTURAL_BREAKDOWN_TRIM');
assert.strictEqual(downsideTrim.mark_downside_trim_done, true);

const noSecondDownsideTrim = evaluateXecHistoricalHolding({
  state: { baseline_price: 100, last_price: 84, xec_exit_stage: 0, xec_downside_trim_done: true },
  currentPrice: 80,
  averageCost: 150,
  oneHourChangePct: -2,
  change24hPct: -5,
  config: {}
});
assert.strictEqual(noSecondDownsideTrim.sell, false);

const exchangeInfo = {
  status: 'TRADING',
  isSpotTradingAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '1', stepSize: '1' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5' }
  ]
};
const partialSizing = sellableQuantity({ free_quantity: 48000000, current_price: 0.0000068, exchange_info: exchangeInfo }, firstPartial);
assert.strictEqual(partialSizing.ok, true);
assert.strictEqual(partialSizing.quantity, 12000000);
assert.strictEqual(partialSizing.fraction, 0.25);

const id1 = buildClientOrderId({ baseline_at: '2026-08-09T20:00:00.000Z', xec_exit_stage: 0 }, firstPartial);
const id2 = buildClientOrderId({ baseline_at: '2026-08-09T20:00:00.000Z', xec_exit_stage: 1 }, secondPartial);
assert.notStrictEqual(id1, id2);
assert(id1.startsWith('px25xec_'));

console.log('xecHistoricalHoldingPolicy tests passed');
