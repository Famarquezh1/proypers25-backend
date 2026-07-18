'use strict';

const assert = require('assert');
const {
  computePerformanceMetrics,
  classifyRegime,
  decideStrategyState
} = require('../services/adaptiveSpotStrategyController');

const positive = Array.from({ length: 12 }, (_, index) => ({
  net_pnl_pct: index % 4 === 0 ? -0.3 : 0.8
}));
const positiveMetrics = computePerformanceMetrics(positive);
assert.strictEqual(positiveMetrics.trades, 12);
assert.ok(positiveMetrics.expectancy > 0);
assert.ok(positiveMetrics.profit_factor > 1);
assert.strictEqual(decideStrategyState(positiveMetrics, { regime: 'BULL_TREND' }).entry_allowed, true);

const negative = Array.from({ length: 12 }, () => ({ net_pnl_pct: -0.7 }));
const negativeMetrics = computePerformanceMetrics(negative);
const degraded = decideStrategyState(negativeMetrics, { regime: 'BEAR_TREND' });
assert.strictEqual(degraded.state, 'DEGRADED');
assert.strictEqual(degraded.entry_allowed, false);

const insufficient = decideStrategyState(computePerformanceMetrics([{ net_pnl_pct: -1 }]), { regime: 'BEAR_TREND' });
assert.strictEqual(insufficient.state, 'OBSERVE');
assert.strictEqual(insufficient.entry_allowed, true);

const bullCandles = Array.from({ length: 60 }, (_, index) => ({ close: 100 + index }));
assert.ok(classifyRegime(bullCandles).regime.startsWith('BULL'));

const bearCandles = Array.from({ length: 60 }, (_, index) => ({ close: 200 - index * 1.5 }));
assert.ok(classifyRegime(bearCandles).regime.startsWith('BEAR'));

console.log('adaptive Spot strategy controller tests passed');
