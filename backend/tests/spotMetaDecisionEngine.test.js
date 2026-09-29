'use strict';

const assert = require('assert');
const { evaluateSpotMetaDecision } = require('../services/spotMetaDecisionEngine');

const buy = evaluateSpotMetaDecision({
  lane: 'CORE',
  localGuard: { allow: true, metrics: {
    continuationPass: true,
    continuationScore: 0.32,
    manipulationRisk: 0.20,
    endReturnPct: 0.006,
    peakToEndPct: -0.001,
    lastSpreadPct: 0.0005
  }},
  v61Score: 0.8,
  v42PassCount: 3,
  v42Norm: 0.95,
  signalPct: 2.0,
  currentPct: 2.6,
  exposureUsdt: 80,
  equityUsdt: 540
});
assert.strictEqual(buy.decision, 'BUY');
assert.strictEqual(buy.mode, 'SHADOW_ONLY');

const reject = evaluateSpotMetaDecision({
  lane: 'V10_HUNTER',
  localGuard: { allow: true, metrics: {
    continuationPass: false,
    continuationScore: -0.15,
    manipulationRisk: 0.25,
    endReturnPct: 0.004,
    peakToEndPct: 0,
    lastSpreadPct: 0.0005
  }},
  v61Score: 0.1,
  v42PassCount: 0,
  v42Norm: 0.1,
  signalPct: 1.7,
  currentPct: 3.1,
  exposureUsdt: 60,
  equityUsdt: 540
});
assert.strictEqual(reject.decision, 'REJECT');
assert(reject.reasons.includes('NO_CONTINUATION'));

const wait = evaluateSpotMetaDecision({
  lane: 'CORE',
  localGuard: { allow: true, metrics: {
    continuationPass: true,
    continuationScore: 0.05,
    manipulationRisk: 0.35,
    endReturnPct: -0.0005,
    peakToEndPct: -0.002,
    lastSpreadPct: 0.0008
  }},
  v61Score: 0.5,
  v42PassCount: 2,
  v42Norm: 0.7,
  signalPct: 3.0,
  currentPct: 3.8,
  exposureUsdt: 150,
  equityUsdt: 540
});
assert.strictEqual(wait.decision, 'WAIT');

console.log('spotMetaDecisionEngine tests OK');
