'use strict';

const assert = require('assert');
const {
  buildPolicy,
  suggestedAllocation,
  buildDecision,
  evaluatePosition,
  calculateTradePnl
} = require('../services/spotShadowDecisionEngine');

const policy = buildPolicy({
  initialCapital: 119,
  reserveCapital: 70,
  minPosition: 3,
  maxPosition: 8,
  maxPositions: 5,
  feeRate: 0.001,
  stopLossPct: 6,
  takeProfit1Pct: 8,
  takeProfit2Pct: 18,
  maxHoldingHours: 72,
  minimumConviction: 60,
  maximumRisk: 70
});

assert.strictEqual(policy.max_operating_capital_usdt, 49);
assert.strictEqual(policy.stop_loss_pct, -6);

const strong = {
  symbol: 'TESTUSDT',
  status: 'HIGH_CONVICTION',
  conviction_score: 82,
  asymmetry_score: 74,
  risk_score: 38,
  detection_price: 1.25,
  reasons: ['volume_acceleration', 'breakout']
};

const allocation = suggestedAllocation(strong, policy);
assert(allocation >= 3 && allocation <= 8);

const decision = buildDecision(strong, {
  policy,
  openPositions: [],
  availableOperatingCapital: 49
});
assert.strictEqual(decision.action, 'SHADOW_ENTRY');
assert.strictEqual(decision.real_order, false);
assert(decision.allocation_usdt >= 3);

const rejectedRisk = buildDecision({ ...strong, risk_score: 90 }, {
  policy,
  openPositions: [],
  availableOperatingCapital: 49
});
assert.strictEqual(rejectedRisk.action, 'SKIP');
assert.strictEqual(rejectedRisk.rejection_reason, 'RISK_ABOVE_MAXIMUM');

const duplicate = buildDecision(strong, {
  policy,
  openPositions: [{ symbol: 'TESTUSDT' }],
  availableOperatingCapital: 49
});
assert.strictEqual(duplicate.rejection_reason, 'SYMBOL_ALREADY_OPEN');

const partial = evaluatePosition(
  { partial_taken: false },
  { max_favorable_move_pct: 10, max_adverse_move_pct: -2, variation_pct: 6, hours: 24 },
  policy
);
assert.strictEqual(partial.action, 'PARTIAL');
assert.strictEqual(partial.reason, 'TAKE_PROFIT_1');

const stop = evaluatePosition(
  { partial_taken: false },
  { max_favorable_move_pct: 3, max_adverse_move_pct: -7, variation_pct: -5, hours: 12 },
  policy
);
assert.strictEqual(stop.action, 'CLOSE');
assert.strictEqual(stop.reason, 'STOP_LOSS');

const timeout = evaluatePosition(
  { partial_taken: true },
  { max_favorable_move_pct: 5, max_adverse_move_pct: -2, variation_pct: 2, hours: 72 },
  policy
);
assert.strictEqual(timeout.action, 'CLOSE');
assert.strictEqual(timeout.reason, 'TIMEOUT');

const pnl = calculateTradePnl(10, 10, 0.001, 1);
assert.strictEqual(pnl.gross_pnl_usdt, 1);
assert.strictEqual(pnl.fees_usdt, 0.02);
assert.strictEqual(pnl.net_pnl_usdt, 0.98);

console.log('spotShadowDecisionEngine.test.js PASS');