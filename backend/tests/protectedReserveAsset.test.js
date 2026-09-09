'use strict';

const assert = require('assert');
const {
  HARD_PROTECTED_RESERVE_ASSETS,
  isProtectedReserveSymbol
} = require('../services/approvedSpotRealExecutor');

assert.deepStrictEqual(HARD_PROTECTED_RESERVE_ASSETS, []);
assert.strictEqual(isProtectedReserveSymbol('XECUSDT'), false);
assert.strictEqual(isProtectedReserveSymbol('xecusdt'), false);
assert.strictEqual(isProtectedReserveSymbol('QTUMUSDT'), false);
assert.strictEqual(isProtectedReserveSymbol('QTUMUSDT', { protected_assets: ['QTUM'] }), true);
// Legacy protected_assets config must not freeze XEC out of the normal engine.
assert.strictEqual(isProtectedReserveSymbol('XECUSDT', { protected_assets: ['XEC'] }), false);
assert.strictEqual(isProtectedReserveSymbol('XECBTC'), false);

console.log('protected reserve asset tests passed');
