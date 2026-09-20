'use strict';

const assert = require('assert');
const { resolveTrailingDistance } = require('../services/spotProgressiveTrailing');

assert.strictEqual(resolveTrailingDistance(0.08, 0.04), 0.04);
assert.strictEqual(resolveTrailingDistance(0.249, 0.04), 0.04);
assert.strictEqual(resolveTrailingDistance(0.25, 0.04), 0.035);
assert.strictEqual(resolveTrailingDistance(0.50, 0.04), 0.03);
assert.strictEqual(resolveTrailingDistance(1.00, 0.04), 0.025);
assert.strictEqual(resolveTrailingDistance(1.80, 0.04), 0.025);

console.log('spotProgressiveTrailing tests passed');
