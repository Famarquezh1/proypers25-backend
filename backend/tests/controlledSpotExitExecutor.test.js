'use strict';

const assert = require('assert');
const {
  determineExit,
  floorToStep,
  assertExitConfig
} = require('../services/controlledSpotExitExecutor');
const {
  assetFromSymbol,
  calculateReconciliation
} = require('../services/spotAccountReconciliation');

const now = new Date('2026-07-15T12:00:00.000Z');

assert.strictEqual(determineExit({ tp1_price: 105, sl_price: 95 }, 106, now), 'TAKE_PROFIT');
assert.strictEqual(determineExit({ tp1_price: 105, sl_price: 95 }, 94, now), 'STOP_LOSS');
assert.strictEqual(
  determineExit({ tp1_price: 105, sl_price: 95, timeout_at: '2026-07-15T11:59:00.000Z' }, 100, now),
  'TIMEOUT'
);
assert.strictEqual(
  determineExit({ tp1_price: 105, sl_price: 95, timeout_at: '2026-07-15T13:00:00.000Z' }, 100, now),
  null
);

assert.strictEqual(floorToStep(12.34567, '0.00100000'), 12.345);
assert.strictEqual(floorToStep(40001215.74, '1.00000000'), 40001215);
assert.strictEqual(floorToStep(0.009, '0.01000000'), 0);

assert.strictEqual(assetFromSymbol('XECUSDT'), 'XEC');
assert.strictEqual(assetFromSymbol('BTCUSDT'), 'BTC');
assert.strictEqual(assetFromSymbol('BTCUSDC'), null);

const partial = calculateReconciliation({ quantity: 40000000, capital_usdt: 200 }, 25000000);
assert.strictEqual(partial.deficit, 15000000);
assert.strictEqual(partial.actualQuantity, 25000000);
assert.strictEqual(partial.remainingCapital, 125);
assert.strictEqual(partial.fullyExternalClosed, false);

const full = calculateReconciliation({ quantity: 40000000, capital_usdt: 200 }, 0);
assert.strictEqual(full.deficit, 40000000);
assert.strictEqual(full.remainingCapital, 0);
assert.strictEqual(full.fullyExternalClosed, true);

assert.doesNotThrow(() => assertExitConfig({
  enabled: true,
  kill_switch: false,
  real_sells_enabled: true,
  auto_order_execution: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false
}));

assert.throws(() => assertExitConfig({
  enabled: true,
  kill_switch: false,
  real_sells_enabled: false,
  auto_order_execution: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false
}), /REAL_SELLS_NOT_ENABLED/);

console.log('controlled Spot exit and reconciliation tests passed');
