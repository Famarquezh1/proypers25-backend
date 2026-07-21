'use strict';

const assert = require('assert');
const { closeMetrics } = require('../services/spotPositionLifecycle');

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

console.log('spot position lifecycle metrics tests passed');
