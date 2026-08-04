'use strict';

const assert = require('assert');
const {
  HARD_PROTECTED_RESERVE_ASSETS,
  isProtectedReserveSymbol
} = require('../services/approvedSpotRealExecutor');

assert.deepStrictEqual(HARD_PROTECTED_RESERVE_ASSETS, ['XEC']);
assert.strictEqual(isProtectedReserveSymbol('XECUSDT'), true);
assert.strictEqual(isProtectedReserveSymbol('xecusdt'), true);
assert.strictEqual(isProtectedReserveSymbol('QTUMUSDT'), false);
assert.strictEqual(isProtectedReserveSymbol('QTUMUSDT', { protected_assets: ['QTUM'] }), true);
assert.strictEqual(isProtectedReserveSymbol('XECBTC'), false);

console.log('protected reserve asset tests passed');
