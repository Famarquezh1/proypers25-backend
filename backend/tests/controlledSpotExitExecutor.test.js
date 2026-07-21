'use strict';

const assert = require('assert');
const {
  determineExit,
  floorToStep,
  assertExitConfig,
  calculateAtrPct,
  resolveAdaptiveProtection,
  buildExitClientOrderId,
  recoverPendingExit
} = require('../services/controlledSpotExitExecutor');
const {
  assetFromSymbol,
  calculateReconciliation,
  buildReconciliationClose
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
assert.strictEqual(
  determineExit({ momentum_lost: true }, 100, now),
  'MOMENTUM_LOSS'
);
assert.strictEqual(
  determineExit({ current_score: 44, exit_score_floor: 45 }, 100, now),
  'SCORE_DETERIORATION'
);

const retryPosition = { id: 'position-1', symbol: 'XECUSDT', quantity: 100, capital_usdt: 20 };
assert.strictEqual(buildExitClientOrderId(retryPosition), buildExitClientOrderId({ ...retryPosition }));

const candles = Array.from({ length: 20 }, (_, index) => ({
  high: 101 + index,
  low: 99 + index,
  close: 100 + index
}));
const atrPct = calculateAtrPct(candles, 14);
assert.ok(atrPct > 0);

// With ATR at 1%, break-even starts at +1.2% and trailing starts at +1.8%.
// Use +1.5% so this test exercises only the break-even zone.
const breakEven = resolveAdaptiveProtection({
  entry_price: 100,
  sl_price: 96,
  tp1_price: 110,
  highest_price: 103,
  opened_at: '2026-07-15T10:00:00.000Z'
}, 101.5, 0.01, now);
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

const manualConversion = buildReconciliationClose(
  { id: 'xec-1', symbol: 'XECUSDT', quantity: 100, capital_usdt: 20 },
  calculateReconciliation({ quantity: 100, capital_usdt: 20 }, 0),
  { toAmount: 23, trades: 1, latestOrderId: 'convert-1' },
  null,
  '2026-07-15T12:00:00.000Z'
);
assert.strictEqual(manualConversion.reason, 'MANUAL_RECONCILIATION');
assert.strictEqual(manualConversion.source, 'BINANCE_CONVERT');
assert.strictEqual(manualConversion.eventId, 'binance_convert_convert-1');
assert.strictEqual(manualConversion.realizedPnl, 3);

const zombie = buildReconciliationClose(
  { id: 'xec-2', symbol: 'XECUSDT', quantity: 100, capital_usdt: 20, entry_price: 0.2 },
  calculateReconciliation({ quantity: 100, capital_usdt: 20 }, 0),
  null,
  null,
  '2026-07-15T12:00:00.000Z'
);
assert.strictEqual(zombie.reason, 'AUTO_RECONCILED');
assert.strictEqual(zombie.pnlVerified, false);
assert.strictEqual(zombie.realizedPnl, null);
assert.strictEqual(zombie.eventId, 'balance_absence_xec-2_0');

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

// Restart simulation: a durable EXIT_PENDING must use the existing Binance
// client order id. The recovery function has no execution dependency, so this
// test proves it never needs to submit a second sell after a process restart.
(async () => {
  const updates = [];
  const position = {
    id: 'position-restart-1', symbol: 'XECUSDT', exit_claim_id: 'claim-1',
    exit_client_order_id: 'px25x_restart', exit_reason_pending: 'TAKE_PROFIT',
    exit_price_observed: 0.0001
  };
  const recovered = await recoverPendingExit({}, {
    id: position.id,
    update: async (value) => updates.push(value)
  }, position, {
    findExistingSellOrder: async (symbol, clientOrderId) => {
      assert.strictEqual(symbol, 'XECUSDT');
      assert.strictEqual(clientOrderId, 'px25x_restart');
      return { orderId: 9001, executedQty: '10', cummulativeQuoteQty: '2', status: 'FILLED' };
    },
    finalizeExit: async (_db, _ref, claimed, order, reason) => {
      assert.strictEqual(claimed.claimId, 'claim-1');
      assert.strictEqual(claimed.clientOrderId, 'px25x_restart');
      assert.strictEqual(order.orderId, 9001);
      assert.strictEqual(reason, 'TAKE_PROFIT');
      return { fullyClosed: true, idempotent: false };
    }
  });
  assert.strictEqual(recovered.action, 'RECOVERED_SELL');
  assert.strictEqual(updates.length, 0);

  const retryReady = await recoverPendingExit({}, {
    id: position.id,
    update: async (value) => updates.push(value)
  }, position, {
    findExistingSellOrder: async () => null
  });
  assert.strictEqual(retryReady.action, 'EXIT_RETRY_READY');
  assert.deepStrictEqual(updates[0], {
    exit_status: 'EXIT_RETRY_READY',
    exit_recovery_note: 'BINANCE_ORDER_NOT_FOUND',
    exit_recovered_at: updates[0].exit_recovered_at
  });
  assert.ok(typeof updates[0].exit_recovered_at === 'string');
  console.log('pending exit restart recovery tests passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log('controlled Spot adaptive exit and reconciliation tests passed');
