'use strict';
const assert = require('assert');
const { momentumContinuationFactor } = require('../services/spotMomentumContinuation');

const continuing = momentumContinuationFactor({
  r15: 0.018, r60: 0.035, r24: 0.055,
  vol15: 1.8, vol30: 1.2, breakout60: 0.012, rs60: 0.018
});
assert(continuing.score > 0);
assert.strictEqual(continuing.pass, true);

const exhausted = momentumContinuationFactor({
  r15: 0.002, r60: 0.07, r24: 0.14,
  vol15: 0.8, vol30: 1.5, breakout60: -0.01, rs60: -0.005
});
assert(exhausted.score < 0);
assert.strictEqual(exhausted.pass, false);

const flat = momentumContinuationFactor({
  r15: 0, r60: 0, r24: 0, vol15: 1, vol30: 1, breakout60: 0, rs60: 0
});
assert.strictEqual(flat.score, 0);
assert.strictEqual(flat.pass, false);

console.log('spotMomentumContinuation tests passed');
