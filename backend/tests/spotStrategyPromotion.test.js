'use strict';

const assert = require('assert');
const {
  summarizeReal,
  summarizePaper,
  assessPromotion
} = require('../services/spotStrategyPromotionController');

const champion = {
  symbol: 'BTCUSDT',
  promotion_eligible: true,
  research_run_id: 'quant_1',
  champion: {
    walk: {
      validation: { trades: 8, expectancy: 0.01, profitFactor: 1.5, maxDrawdown: 0.04 },
      test: { trades: 8, expectancy: 0.009, profitFactor: 1.4, maxDrawdown: 0.05 }
    },
    calibration: { samples: 25, calibrated: true, brier: 0.2 }
  }
};

const paper = summarizePaper([
  { symbol: 'BTCUSDT', status: 'POSITIVE', sample_size: 8 },
  { symbol: 'BTCUSDT', status: 'PASSED', sample_size: 8 },
  { symbol: 'BTCUSDT', positive: true, sample_size: 8 }
], 'BTCUSDT');
assert.strictEqual(paper.validations, 3);
assert.strictEqual(paper.sample_size, 24);

const real = summarizeReal([
  { symbol: 'BTCUSDT', net_pnl_pct: 1.1, net_pnl_usdt: 0.11 },
  { symbol: 'BTCUSDT', net_pnl_pct: 0.8, net_pnl_usdt: 0.08 },
  { symbol: 'BTCUSDT', net_pnl_pct: -0.4, net_pnl_usdt: -0.04 },
  { symbol: 'BTCUSDT', net_pnl_pct: 0.9, net_pnl_usdt: 0.09 },
  { symbol: 'BTCUSDT', net_pnl_pct: 0.7, net_pnl_usdt: 0.07 }
], 'BTCUSDT');
assert.strictEqual(real.trades, 5);
assert.ok(real.expectancy > 0);
assert.ok(real.profit_factor > 1.05);

const promoted = assessPromotion({
  champion,
  adaptive: { state: 'ACTIVE', entry_allowed: true },
  paper,
  real
});
assert.strictEqual(promoted.entry_allowed, true);
assert.strictEqual(promoted.state, 'PROMOTED_LIMITED');
assert.strictEqual(promoted.limits.real_max_position_usdt, 10);
assert.strictEqual(promoted.limits.real_max_open_positions, 1);

const blocked = assessPromotion({
  champion,
  adaptive: { state: 'DEGRADED', entry_allowed: false },
  paper,
  real
});
assert.strictEqual(blocked.entry_allowed, false);
assert.ok(blocked.reasons.includes('ADAPTIVE_STRATEGY_DEGRADED'));

console.log('controlled Spot strategy promotion tests passed');