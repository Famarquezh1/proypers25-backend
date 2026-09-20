'use strict';

const assert = require('assert');
const { DAY_MS, highHistoryCadence } = require('../services/spotHighHistoryPolicy');

const end = 1_800_000_000_000;
assert.strictEqual(highHistoryCadence(end - 2 * DAY_MS, end).interval, '5m');
assert.strictEqual(highHistoryCadence(end - 10 * DAY_MS, end).interval, '5m');
assert.strictEqual(highHistoryCadence(end - 11 * DAY_MS, end).interval, '1h');
assert.strictEqual(highHistoryCadence(end - 27 * DAY_MS, end).interval, '1h');
assert.strictEqual(highHistoryCadence(end - 181 * DAY_MS, end).interval, '1d');

console.log('spotHighHistoryPolicy tests passed');
