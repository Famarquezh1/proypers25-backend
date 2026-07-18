'use strict';

const assert = require('assert');
const {
  determineExit,
  floorToStep,
  assertExitConfig,
  calculateAtrPct,
  resolveAdaptiveProtection
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
assert.strictEqual(
  determineExit({ effective_sl_price: 101, protection_mode: 'BREAK_EVEN' }, 100.9, now),
  'BREAK_EVEN_STOP'
);
assert.strictEqual(
  determineExit({ effective_sl_price: 108, protection_mode: 'TRAILING' }, 107.9, now),
  'TRAILING_STOP'
);

const candles = Array.from({ length: 20 }, (_, index) => ({
  high: 101 + index,
  low: 99 + index,
  close: 100 + index
}));
const atrPct = calculateAtrPct(candles, 14);
assert.ok(atrPct > 0);

const breakEven = resolveAdaptiveProtection({
  entry_price: 100,
  sl_price: 96,
  tp1_price: 110,
  highest_price: 103,
  opened_at: '2026-07-15T10:00:00.000Z'
}, 102, 0.01, now);
assert.strictEqual(breakEven.protection_mode, 'BREAK_EVEN');
assert.ok(breakEven.effective_sl_price > 100);

const trailing = resolveAdaptiveProtection({
  entry_price: 100,
  sl_price: 96,
  tp1_price: 115,
  highest_price: 110,
  opened_at: '2026-07-15T10:00:00.000Z'
}, 109, 0.01, now);
assert.strictEqual(trailing.protection_mode, 'TRAILING');
assert.ok(trailing.effective_sl_price > 107);
assert.ok(trailing.effective_sl_price < trailing.highest_price);

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

console.log('controlled Spot adaptive exit and reconciliation tests passed');
