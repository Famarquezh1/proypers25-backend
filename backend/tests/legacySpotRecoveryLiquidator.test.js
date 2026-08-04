'use strict';

const assert = require('assert');
const {
  DEFAULT_TARGET_ASSETS,
  HARD_PROTECTED_ASSETS,
  normalizeConfig,
  isProtectedAsset,
  floorToStep,
  buildCurrentCostBasis,
  evaluateRecoveryDecision,
  buildClientOrderId
} = require('../services/legacySpotRecoveryLiquidator');

assert.deepStrictEqual(DEFAULT_TARGET_ASSETS, ['QTUM', 'ANKR', 'BAR', 'LAYER', 'CATI']);
assert.deepStrictEqual(HARD_PROTECTED_ASSETS, ['XEC']);
assert.strictEqual(isProtectedAsset('XEC'), true);
assert.strictEqual(isProtectedAsset('xec'), true);
assert.strictEqual(isProtectedAsset('QTUM'), false);

const config = normalizeConfig({
  target_assets: ['XEC', 'QTUM', 'ANKR', 'BAR', 'LAYER', 'CATI', 'QTUM'],
  protected_assets: []
});
assert.deepStrictEqual(config.target_assets, ['QTUM', 'ANKR', 'BAR', 'LAYER', 'CATI']);
assert.ok(config.protected_assets.includes('XEC'));
assert.strictEqual(config.xec_never_sell, true);

assert.strictEqual(floorToStep(73.6263, '0.10000000'), 73.6);
assert.strictEqual(floorToStep(10027.2627, '0.10000000'), 10027.2);

const cost = buildCurrentCostBasis([
  { time: 1, isBuyer: true, qty: '100', quoteQty: '50', commission: '0.05', commissionAsset: 'USDT' },
  { time: 2, isBuyer: false, qty: '20', quoteQty: '12', commission: '0.012', commissionAsset: 'USDT' }
]);
assert.strictEqual(cost.tracked_quantity, 80);
assert.ok(cost.average_cost_usdt > 0.5 && cost.average_cost_usdt < 0.51);

const watching = evaluateRecoveryDecision({
  state: {
    baseline_price: 0.60,
    baseline_drawdown_pct: -25,
    last_price: 0.61,
    positive_cycles: 0,
    status: 'WATCHING'
  },
  currentPrice: 0.62,
  averageCost: 0.80,
  oneHourChangePct: 1.1,
  change24hPct: 2,
  config: { minimum_recovery_pct: 5, minimum_positive_cycles: 2 }
});
assert.strictEqual(watching.sell, false);
assert.strictEqual(watching.armed, false);
assert.strictEqual(watching.positive_cycles, 1);

const armed = evaluateRecoveryDecision({
  state: {
    baseline_price: 0.60,
    baseline_drawdown_pct: -25,
    last_price: 0.62,
    positive_cycles: 1,
    status: 'WATCHING'
  },
  currentPrice: 0.64,
  averageCost: 0.80,
  oneHourChangePct: 1.2,
  change24hPct: 3,
  config: { minimum_recovery_pct: 5, minimum_positive_cycles: 2 }
});
assert.strictEqual(armed.arm_now, true);
assert.strictEqual(armed.armed, true);
assert.strictEqual(armed.sell, false);

const trailingSale = evaluateRecoveryDecision({
  state: {
    baseline_price: 0.60,
    baseline_drawdown_pct: -25,
    last_price: 0.67,
    positive_cycles: 2,
    status: 'ARMED',
    armed: true,
    highest_price_after_arm: 0.68
  },
  currentPrice: 0.66,
  averageCost: 0.80,
  oneHourChangePct: -0.5,
  change24hPct: 1,
  config: { trailing_pullback_pct: 2.5, minimum_improvement_at_sale_pct: 3 }
});
assert.strictEqual(trailingSale.sell, true);
assert.strictEqual(trailingSale.reason, 'RECOVERY_TRAILING_EXIT');
assert.ok(trailingSale.improvement_pct >= 3);

const targetSale = evaluateRecoveryDecision({
  state: {
    baseline_price: 0.60,
    baseline_drawdown_pct: -25,
    last_price: 0.70,
    positive_cycles: 2,
    status: 'ARMED',
    armed: true,
    highest_price_after_arm: 0.71
  },
  currentPrice: 0.72,
  averageCost: 0.80,
  oneHourChangePct: 1,
  change24hPct: 4,
  config: { target_max_loss_pct: -10 }
});
assert.strictEqual(targetSale.sell, true);
assert.strictEqual(targetSale.reason, 'LOSS_REDUCED_TO_TARGET');

assert.strictEqual(buildClientOrderId('QTUM', { baseline_at: '2026-08-04T12:00:00Z' }), buildClientOrderId('QTUM', { baseline_at: '2026-08-04T12:00:00Z' }));
assert.ok(buildClientOrderId('QTUM', { baseline_at: '2026-08-04T12:00:00Z' }).length <= 36);

console.log('legacy Spot recovery liquidation tests passed');
