'use strict';

const assert = require('assert');
const {
  minimumProtectedQuoteUsdt,
  resolveNativeProtectionStop
} = require('../services/spotNativeProtectionPolicy');

const stopLossInfo = {
  symbol: 'TESTUSDT',
  orderTypes: ['MARKET', 'STOP_LOSS'],
  filters: [
    { filterType: 'PRICE_FILTER', tickSize: '0.01' },
    { filterType: 'LOT_SIZE', stepSize: '0.001', minQty: '0.001' },
    { filterType: 'NOTIONAL', minNotional: '5', applyMinToMarket: true }
  ]
};

const floor = minimumProtectedQuoteUsdt(stopLossInfo, 0.03);
assert.strictEqual(floor.ok, true);
assert.strictEqual(floor.order_type, 'STOP_LOSS');
assert(floor.quote_floor_usdt >= 5.20 && floor.quote_floor_usdt <= 5.21);

const regular = resolveNativeProtectionStop({
  info: stopLossInfo,
  quantity: 0.05,
  desiredStopPrice: 110,
  currentPrice: 120
});
assert.strictEqual(regular.action, 'PLACE');
assert.strictEqual(regular.stop_price, 110);

const tightened = resolveNativeProtectionStop({
  info: stopLossInfo,
  quantity: 0.04,
  desiredStopPrice: 119,
  currentPrice: 127.3
});
assert.strictEqual(tightened.action, 'PLACE_TIGHTENED');
assert(tightened.stop_price > 125);
assert(tightened.stop_price < 127.3);
assert(tightened.effective_notional_usdt >= 5);

const impossible = resolveNativeProtectionStop({
  info: stopLossInfo,
  quantity: 0.04,
  desiredStopPrice: 119,
  currentPrice: 125.1
});
assert.strictEqual(impossible.action, 'UNPROTECTABLE');

const stopLimitInfo = {
  ...stopLossInfo,
  orderTypes: ['MARKET', 'STOP_LOSS_LIMIT']
};
const limitFloor = minimumProtectedQuoteUsdt(stopLimitInfo, 0.03, { stopLimitGapPct: 0.006 });
assert(limitFloor.quote_floor_usdt > floor.quote_floor_usdt);

console.log('spotNativeProtectionPolicy tests passed');
