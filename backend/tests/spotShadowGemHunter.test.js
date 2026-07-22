'use strict';

const assert = require('assert');
const {
  buildGemPolicy,
  isGemPattern,
  buildGemDecision,
  evaluateGemPosition,
  tradePnl
} = require('../services/spotShadowGemHunter');

const policy = buildGemPolicy({ initialCapital: 20, reserveCapital: 8, minPosition: 2, maxPosition: 4 });
assert.strictEqual(policy.initial_capital_usdt, 20);
assert.strictEqual(policy.reserve_capital_usdt, 8);
assert.strictEqual(policy.max_positions, 3);

const candidate = {
  symbol: 'TESTUSDT',
  detection_price: 1,
  conviction_score: 67,
  asymmetry_score: 72,
  risk_score: 76,
  status: 'WATCH_CLOSELY',
  reasons: ['volume_24h_above_recent_average', 'recent_high_breakout']
};
assert.strictEqual(isGemPattern(candidate), true);
const decision = buildGemDecision(candidate, { policy, openPositions: [], availableCapital: 12 });
assert.strictEqual(decision.action, 'GEM_SHADOW_ENTRY');
assert.strictEqual(decision.real_order, false);
assert.ok(decision.allocation_usdt >= 2 && decision.allocation_usdt <= 4);

const rejected = buildGemDecision({ ...candidate, asymmetry_score: 30 }, { policy, openPositions: [], availableCapital: 12 });
assert.strictEqual(rejected.action, 'SKIP');
assert.strictEqual(rejected.rejection_reason, 'ASYMMETRY_BELOW_GEM_MINIMUM');

const partial = evaluateGemPosition(
  { first_partial_taken: false, second_partial_taken: false, peak_move_pct: 0 },
  { max_favorable_move_pct: 31, max_adverse_move_pct: -4, variation_pct: 28, hours: 24 },
  policy
);
assert.strictEqual(partial.action, 'PARTIAL');
assert.strictEqual(partial.reason, 'FIRST_PARTIAL');

const trailing = evaluateGemPosition(
  { first_partial_taken: true, second_partial_taken: false, peak_move_pct: 50 },
  { max_favorable_move_pct: 50, max_adverse_move_pct: -3, variation_pct: 30, hours: 48 },
  policy
);
assert.strictEqual(trailing.action, 'CLOSE');
assert.strictEqual(trailing.reason, 'TRAILING_EXIT');

const stopped = evaluateGemPosition(
  { first_partial_taken: false, second_partial_taken: false, peak_move_pct: 0 },
  { max_favorable_move_pct: 4, max_adverse_move_pct: -22, variation_pct: -15, hours: 10 },
  policy
);
assert.strictEqual(stopped.reason, 'HARD_STOP');

const pnl = tradePnl(4, 25, 0.001, 0.35);
assert.ok(pnl.net_pnl_usdt > 0);
assert.ok(pnl.fees_usdt > 0);

console.log('spotShadowGemHunter.test.js passed');
