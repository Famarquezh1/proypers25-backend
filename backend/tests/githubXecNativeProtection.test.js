'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { normalizeXecPolicy, evaluateXecHistoricalHolding } = require('../services/xecHistoricalHoldingPolicy');
const {
  buildCurrentCostBasis,
  buildInitialState,
  buildClientOrderId,
  sellableQuantity,
  finalizeStateAfterSale
} = require('../scripts/github-xec-historical-protection');

const policy = normalizeXecPolicy({});
assert.strictEqual(policy.upside_arm_recovery_pct, 12);
assert.strictEqual(policy.fast_arm_recovery_pct, 15);
assert.strictEqual(policy.first_take_min_recovery_pct, 15);
assert.strictEqual(policy.downside_trim_pct_from_baseline, -15);

const fastArm = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 114,
    positive_cycles: 0,
    xec_exit_stage: 0,
    xec_runner_armed: false
  },
  currentPrice: 116,
  averageCost: 150,
  oneHourChangePct: -0.5,
  change24hPct: -1,
  config: {}
});
assert.strictEqual(fastArm.arm_now, true);
assert.strictEqual(fastArm.arm_mode, 'FAST_RECOVERY');
assert.strictEqual(fastArm.armed, true);
assert.strictEqual(fastArm.sell, false, 'fast arm must protect the recovery without selling immediately');

const confirmedArm = evaluateXecHistoricalHolding({
  state: {
    baseline_price: 100,
    last_price: 111,
    positive_cycles: 1,
    xec_exit_stage: 0,
    xec_runner_armed: false
  },
  currentPrice: 113,
  averageCost: 150,
  oneHourChangePct: 1,
  change24hPct: 4,
  config: {}
});
assert.strictEqual(confirmedArm.arm_now, true);
assert.strictEqual(confirmedArm.arm_mode, 'CONFIRMED_RECOVERY');
assert.strictEqual(confirmedArm.sell, false);

const costBasis = buildCurrentCostBasis([
  { time: 1, isBuyer: true, qty: '100', quoteQty: '0.0006', price: '0.000006', commission: '1', commissionAsset: 'XEC' },
  { time: 2, isBuyer: false, qty: '20', quoteQty: '0.00014', price: '0.000007', commission: '0.0000001', commissionAsset: 'USDT' }
]);
assert.strictEqual(costBasis.tracked_quantity, 79);
assert(costBasis.average_cost_usdt > 0);
assert(costBasis.remaining_cost_usdt > 0);

const snapshot = {
  current_price: 0.0000068,
  change_24h_pct: -2,
  one_hour_change_pct: 0,
  free_quantity: 48000000,
  locked_quantity: 0,
  total_quantity: 48000000,
  average_cost_usdt: 0.00001,
  remaining_cost_usdt: 480,
  exchange_info: {
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [
      { filterType: 'LOT_SIZE', minQty: '1', stepSize: '1' },
      { filterType: 'MIN_NOTIONAL', minNotional: '5' }
    ]
  }
};
const state = buildInitialState(snapshot, '2026-09-15T15:00:00.000Z');
assert.strictEqual(state.status, 'WATCHING');
assert.strictEqual(state.baseline_price, snapshot.current_price);
assert.strictEqual(state.xec_exit_stage, 0);
assert.strictEqual(state.xec_runner_armed, false);

const firstPartial = evaluateXecHistoricalHolding({
  state: {
    ...state,
    baseline_price: 100,
    last_price: 118,
    xec_runner_armed: true,
    highest_price_after_arm: 120,
    positive_cycles: 2
  },
  currentPrice: 113.5,
  averageCost: 150,
  oneHourChangePct: -1,
  change24hPct: 3,
  config: {}
});
assert.strictEqual(firstPartial.sell, true);
assert.strictEqual(firstPartial.sell_fraction, 0.25);
assert.strictEqual(firstPartial.reason, 'XEC_RECOVERY_TRAILING_FIRST_PARTIAL');

const sizing = sellableQuantity(snapshot, firstPartial);
assert.strictEqual(sizing.ok, true);
assert.strictEqual(sizing.quantity, 12000000);
assert.strictEqual(sizing.fraction, 0.25);

const clientOrderId = buildClientOrderId(state, firstPartial);
assert(clientOrderId.startsWith('px25ghxec_'));
assert(clientOrderId.length <= 36);
assert.strictEqual(clientOrderId, buildClientOrderId(state, firstPartial), 'client order id must be deterministic for idempotency');

const finalized = finalizeStateAfterSale(
  { ...state, pending_client_order_id: clientOrderId },
  { ...firstPartial, armed: true, next_stage: 1, mark_downside_trim_done: false },
  { orderId: 123, clientOrderId, status: 'FILLED', executedQty: '12000000', cummulativeQuoteQty: '81.6' },
  '2026-09-15T16:00:00.000Z'
);
assert.strictEqual(finalized.status, 'ARMED');
assert.strictEqual(finalized.xec_exit_stage, 1);
assert.strictEqual(finalized.last_sale.reason, 'XEC_RECOVERY_TRAILING_FIRST_PARTIAL');
assert.strictEqual(finalized.pending_client_order_id, null);

const root = path.join(__dirname, '..');
const autoExit = fs.readFileSync(path.join(root, 'scripts', 'github-spot-auto-exit.js'), 'utf8');
const executor = fs.readFileSync(path.join(root, 'scripts', 'github-spot-manual-execution-v10-aware.js'), 'utf8');
const protector = fs.readFileSync(path.join(root, 'scripts', 'github-xec-historical-protection.js'), 'utf8');
assert(autoExit.includes("run('github-xec-historical-protection.js', 'XEC_HISTORICAL_PROTECT')"));
assert(executor.includes("SYMBOL === 'XECUSDT'"));
assert(executor.includes('XEC historical holding is exit-only; new XEC entries are disabled'));
assert(protector.includes('enableWithdrawals !== false'));
assert(protector.includes("strategy: 'RECOVERY_RUNNER_PROGRESSIVE_EXIT'"));

console.log('githubXecNativeProtection tests passed');
