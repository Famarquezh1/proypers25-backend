'use strict';

const assert = require('assert');
const { evaluateSevenDay } = require('../services/spotDiscoveryLongHorizon');
const { classifyReaction, buildDiscoveryCandidate } = require('../services/spotDiscoveryIntelligence');

const evaluation = evaluateSevenDay(1, [
  { high: 1.05, low: 0.97, close: 1.02 },
  { high: 1.55, low: 0.95, close: 1.4 }
]);

assert.strictEqual(evaluation.label, '7d');
assert.strictEqual(evaluation.hours, 168);
assert.strictEqual(evaluation.hit_plus_50_pct, true);
assert.strictEqual(evaluation.hit_plus_100_pct, false);
assert.strictEqual(evaluation.drop_below_minus_10_pct, false);
assert.strictEqual(classifyReaction(evaluation), 'EXTRAORDINARY_50_PLUS');
assert.strictEqual(classifyReaction({ max_favorable_move_pct: 105 }), 'EXPLOSIVE_100_PLUS');

const candidate = buildDiscoveryCandidate({
  symbol: 'TESTUSDT',
  opportunityScore: 80,
  riskScore: 25,
  liquidityScore: 80,
  volumeChangeScore: 75,
  breakoutScore: 70,
  accumulationScore: 65,
  impulseScore: 75,
  reasons: ['volume_24h_above_recent_average', 'recent_high_breakout']
}, {
  horizons: { h168: evaluation }
});

assert.strictEqual(candidate.shadow_only, true);
assert.strictEqual(candidate.extraordinary_reaction, true);
assert.strictEqual(candidate.reaction_class, 'EXTRAORDINARY_50_PLUS');
assert.strictEqual(candidate.validation.horizon, '7d');

console.log('spot discovery long horizon tests passed');