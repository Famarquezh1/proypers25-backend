'use strict';

const assert = require('assert');
const { DEFAULTS, evaluateMicrostructure } = require('../services/localPretradeGuard');

assert.strictEqual(DEFAULTS.samples, 5);
assert.strictEqual(DEFAULTS.maxLastSpreadPct, 0.006);
assert.strictEqual(DEFAULTS.minEndReturnPct, -0.006);

const healthy = evaluateMicrostructure([
  { bid: 100.00, ask: 100.10, mid: 100.05, spreadPct: 0.0010 },
  { bid: 100.15, ask: 100.25, mid: 100.20, spreadPct: 0.0010 },
  { bid: 100.20, ask: 100.30, mid: 100.25, spreadPct: 0.0010 },
  { bid: 100.30, ask: 100.40, mid: 100.35, spreadPct: 0.0010 },
  { bid: 100.35, ask: 100.45, mid: 100.40, spreadPct: 0.0010 }
], { latencyMs: 120, clockSkewMs: 80 });
assert.strictEqual(healthy.allow, true);
assert.strictEqual(healthy.code, 'LOCAL_MICRO_OK');

const reversal = evaluateMicrostructure([
  { bid: 100.0, ask: 100.1, mid: 100.05, spreadPct: 0.0010 },
  { bid: 100.2, ask: 100.3, mid: 100.25, spreadPct: 0.0010 },
  { bid: 99.8, ask: 99.9, mid: 99.85, spreadPct: 0.0010 },
  { bid: 99.2, ask: 99.3, mid: 99.25, spreadPct: 0.0010 },
  { bid: 99.1, ask: 99.2, mid: 99.15, spreadPct: 0.0010 }
], { latencyMs: 120, clockSkewMs: 80 });
assert.strictEqual(reversal.allow, false);
assert(reversal.reason.includes('MICRO_REVERSAL'));

const peakReject = evaluateMicrostructure([
  { bid: 100.0, ask: 100.1, mid: 100.05, spreadPct: 0.0010 },
  { bid: 102.0, ask: 102.1, mid: 102.05, spreadPct: 0.0010 },
  { bid: 101.0, ask: 101.1, mid: 101.05, spreadPct: 0.0010 },
  { bid: 100.7, ask: 100.8, mid: 100.75, spreadPct: 0.0010 },
  { bid: 100.6, ask: 100.7, mid: 100.65, spreadPct: 0.0010 }
], { latencyMs: 120, clockSkewMs: 80 });
assert.strictEqual(peakReject.allow, false);
assert(peakReject.reason.includes('MICRO_PEAK_REJECTION'));

const wideSpread = evaluateMicrostructure([
  { bid: 99.5, ask: 100.5, mid: 100.0, spreadPct: 0.0100 },
  { bid: 99.5, ask: 100.5, mid: 100.0, spreadPct: 0.0100 },
  { bid: 99.5, ask: 100.5, mid: 100.0, spreadPct: 0.0100 },
  { bid: 99.5, ask: 100.5, mid: 100.0, spreadPct: 0.0100 },
  { bid: 99.5, ask: 100.5, mid: 100.0, spreadPct: 0.0100 }
], { latencyMs: 120, clockSkewMs: 80 });
assert.strictEqual(wideSpread.allow, false);
assert(wideSpread.reason.includes('WIDE_SPREAD'));
assert(wideSpread.reason.includes('PERSISTENT_WIDE_SPREAD'));

const unhealthyConnection = evaluateMicrostructure([
  { bid: 100, ask: 100.1, mid: 100.05, spreadPct: 0.001 },
  { bid: 100, ask: 100.1, mid: 100.05, spreadPct: 0.001 },
  { bid: 100, ask: 100.1, mid: 100.05, spreadPct: 0.001 }
], { latencyMs: 1900, clockSkewMs: 4500 });
assert.strictEqual(unhealthyConnection.allow, false);
assert(unhealthyConnection.reason.includes('LOCAL_BINANCE_LATENCY'));
assert(unhealthyConnection.reason.includes('LOCAL_CLOCK_SKEW'));

console.log('localPretradeGuard tests OK');
