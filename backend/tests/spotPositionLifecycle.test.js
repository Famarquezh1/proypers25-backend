'use strict';

const assert = require('assert');
const {
  closeMetrics,
  entryPositionId,
  recordConfirmedSpotEntry,
  recordConfirmedSpotClose
} = require('../services/spotPositionLifecycle');

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function memoryFirestore(initial = {}) {
  const state = new Map(Object.entries(initial).map(([path, value]) => [path, clone(value)]));
  const ref = (path) => ({
    path,
    id: path.split('/').pop(),
    get: async () => snapshot(path)
  });
  const snapshot = (path) => ({
    exists: state.has(path),
    id: path.split('/').pop(),
    data: () => clone(state.get(path))
  });
  const write = (path, value, options = {}) => {
    state.set(path, options.merge ? { ...(state.get(path) || {}), ...clone(value) } : clone(value));
  };
  const db = {
    doc: ref,
    collection: (name) => ({ doc: (id) => ref(`${name}/${id}`) }),
    runTransaction: async (callback) => callback({
      get: async (documentRef) => snapshot(documentRef.path),
      set: (documentRef, value, options) => write(documentRef.path, value, options),
      update: (documentRef, value) => {
        if (!state.has(documentRef.path)) throw new Error(`missing ${documentRef.path}`);
        write(documentRef.path, value, { merge: true });
      },
      create: (documentRef, value) => {
        if (state.has(documentRef.path)) throw new Error(`exists ${documentRef.path}`);
        write(documentRef.path, value);
      }
    }),
    read: (path) => clone(state.get(path))
  };
  return db;
}

const metrics = closeMetrics({
  entry_price: 100,
  highest_price: 112,
  lowest_price: 94,
  entry_score: 91.5,
  model_version: 'quant_v6',
  market_regime: 'TRENDING_UP',
  opened_at: '2026-07-20T10:00:00.000Z'
}, {
  exitPrice: 108,
  allocatedCapital: 10,
  netPnl: 0.78,
  finalScore: 72,
  closedAt: '2026-07-20T12:30:00.000Z'
});

assert.strictEqual(metrics.entry_score, 91.5);
assert.strictEqual(metrics.final_score, 72);
assert.strictEqual(metrics.duration_ms, 9000000);
assert.strictEqual(metrics.mfe_pct, 12);
assert.strictEqual(metrics.mae_pct, -6);
assert.strictEqual(metrics.net_pnl_usdt, 0.78);

const unverified = closeMetrics({ entry_price: 10 }, {
  exitPrice: 10,
  allocatedCapital: 1,
  netPnl: null,
  closedAt: '2026-07-20T12:30:00.000Z'
});
assert.strictEqual(unverified.net_pnl_usdt, null);

// Exchange-confirmed BUY -> partial SELL -> full SELL -> retry. This uses an
// in-memory Firestore adapter only; it never reaches Binance or creates a
// production position.
(async () => {
  const db = memoryFirestore({
    'real_spot_config/balance': { available_usdt: 100, in_positions_usdt: 0, realized_pnl_usdt: 0 }
  });
  const intentId = 'real_spot_intent_scan-1_XECUSDT';
  const candidate = { symbol: 'XECUSDT', scan_id: 'scan-1', opportunityScore: 90, category: 'MOMENTUM' };
  const config = { take_profit_1_pct: 5, take_profit_2_pct: 10, stop_loss_pct: -5, timeout_hours: 24 };
  const order = {
    orderId: 1001,
    clientOrderId: 'px25b_test',
    executedQty: '2',
    cummulativeQuoteQty: '10',
    fills: [{ price: '5', qty: '2', commission: '0', commissionAsset: 'USDT' }]
  };
  const entry = await recordConfirmedSpotEntry(db, { intentId, candidate, config, order, openedAt: '2026-07-20T10:00:00.000Z' });
  assert.strictEqual(entry.idempotent, false);
  assert.strictEqual(entry.positionId, entryPositionId(intentId));
  assert.deepStrictEqual(db.read('real_spot_config/balance'), {
    available_usdt: 90,
    in_positions_usdt: 10,
    realized_pnl_usdt: 0,
    updated_at: '2026-07-20T10:00:00.000Z',
    source: 'SPOT_LIFECYCLE_CONFIRMED'
  });
  const retryEntry = await recordConfirmedSpotEntry(db, { intentId, candidate, config, order, openedAt: '2026-07-20T10:00:01.000Z' });
  assert.strictEqual(retryEntry.idempotent, true);
  assert.strictEqual(db.read('real_spot_config/balance').available_usdt, 90);

  const positionRef = db.collection('real_spot_positions').doc(entry.positionId);
  const partial = await recordConfirmedSpotClose(db, {
    positionRef,
    position: { id: entry.positionId },
    eventId: 'binance_order_2001',
    reason: 'TAKE_PROFIT',
    source: 'BINANCE_ORDER',
    executedQuantity: 1,
    quoteReceivedUsdt: 6,
    exitPrice: 6,
    closedAt: '2026-07-20T11:00:00.000Z'
  });
  assert.strictEqual(partial.fullyClosed, false);
  assert.strictEqual(db.read(`real_spot_positions/${entry.positionId}`).quantity, 1);
  assert.strictEqual(db.read(`real_spot_positions/${entry.positionId}`).capital_usdt, 5);
  assert.strictEqual(db.read('real_spot_config/balance').available_usdt, 96);
  assert.strictEqual(db.read('real_spot_config/balance').in_positions_usdt, 5);
  assert.strictEqual(db.read('real_spot_config/balance').realized_pnl_usdt, 1);

  const partialRetry = await recordConfirmedSpotClose(db, {
    positionRef,
    position: { id: entry.positionId },
    eventId: 'binance_order_2001', reason: 'TAKE_PROFIT', source: 'BINANCE_ORDER',
    executedQuantity: 1, quoteReceivedUsdt: 6, exitPrice: 6
  });
  assert.strictEqual(partialRetry.idempotent, true);
  assert.strictEqual(db.read('real_spot_config/balance').available_usdt, 96);

  const close = await recordConfirmedSpotClose(db, {
    positionRef,
    position: { id: entry.positionId },
    eventId: 'binance_order_2002', reason: 'STOP_LOSS', source: 'BINANCE_ORDER',
    executedQuantity: 1, quoteReceivedUsdt: 4, exitPrice: 4,
    closedAt: '2026-07-20T12:00:00.000Z'
  });
  assert.strictEqual(close.fullyClosed, true);
  assert.strictEqual(db.read(`real_spot_positions/${entry.positionId}`).status, 'REAL_CLOSED');
  assert.strictEqual(db.read('real_spot_config/balance').available_usdt, 100);
  assert.strictEqual(db.read('real_spot_config/balance').in_positions_usdt, 0);
  assert.strictEqual(db.read('real_spot_config/balance').realized_pnl_usdt, 0);
  console.log('spot entry/partial-close/full-close/idempotency lifecycle test passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

console.log('spot position lifecycle metrics tests passed');
