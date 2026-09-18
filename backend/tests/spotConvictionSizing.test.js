'use strict';

const assert = require('assert');
const {
  classifyConviction,
  resolveConvictionPosition
} = require('../services/spotConvictionSizing');

assert.strictEqual(classifyConviction({
  lane: 'CORE', v61Score: 0.78, v42PassCount: 3, v42Norm: 0.93
}).tier, 'NORMAL');

assert.strictEqual(classifyConviction({
  lane: 'CORE', v61Score: 0.90, v42PassCount: 3, v42Norm: 0.96
}).tier, 'HIGH');

assert.strictEqual(classifyConviction({
  lane: 'CORE', v61Score: 1.10, v42PassCount: 3, v42Norm: 0.99
}).tier, 'EXCEPTIONAL');

assert.strictEqual(classifyConviction({
  lane: 'V10_HUNTER',
  microflowScore: 0.0024,
  microflowCut: 0.0018,
  microflowMargin: 0.0010,
  microflowMarginCut: 0.0007,
  calibrationWinRate: 0.59
}).tier, 'HIGH');

assert.strictEqual(classifyConviction({
  lane: 'V10_HUNTER',
  microflowScore: 0.0030,
  microflowCut: 0.0018,
  microflowMargin: 0.0015,
  microflowMarginCut: 0.0007,
  calibrationWinRate: 0.62
}).tier, 'EXCEPTIONAL');

assert.strictEqual(resolveConvictionPosition({
  lane: 'CORE', v61Score: 0.90, v42PassCount: 3, v42Norm: 0.96,
  usdtFree: 200, baseFraction: 0.20
}).quote_order_qty, 30);

assert.strictEqual(resolveConvictionPosition({
  lane: 'CORE', v61Score: 1.10, v42PassCount: 3, v42Norm: 0.99,
  usdtFree: 200, baseFraction: 0.20
}).quote_order_qty, 40);

assert.strictEqual(resolveConvictionPosition({
  lane: 'CORE', v61Score: 1.10, v42PassCount: 3, v42Norm: 0.99,
  usdtFree: 200, baseFraction: 0.20, isLeveraged: true
}).quote_order_qty, 5);

assert.strictEqual(resolveConvictionPosition({
  lane: 'CORE', v61Score: 1.10, v42PassCount: 3, v42Norm: 0.99,
  usdtFree: 45, baseFraction: 0.20
}).quote_order_qty, 5);

console.log('spotConvictionSizing tests passed');
