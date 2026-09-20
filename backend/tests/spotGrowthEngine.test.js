'use strict';

const assert = require('assert');
const {
  estimateAccountEquityUsdt,
  estimateManagedExposureUsdt,
  tierCapUsdt,
  resolveGrowthPosition
} = require('../services/spotGrowthEngine');

const prices = [
  { symbol: 'BTCUSDT', price: '60000' },
  { symbol: 'AAAUSDT', price: '2' },
  { symbol: 'BBABTC', price: '0.0001' }
];
const account = { balances: [
  { asset: 'USDT', free: '300', locked: '0' },
  { asset: 'AAA', free: '50', locked: '0' },
  { asset: 'BBA', free: '1', locked: '0' }
]};
assert.strictEqual(estimateAccountEquityUsdt(account, prices), 406);

const orders = [
  { side:'SELL', status:'NEW', symbol:'AAAUSDT', origQty:'20', executedQty:'0', clientOrderId:'proypers-gh-protect-1' },
  { side:'SELL', status:'NEW', symbol:'AAAUSDT', origQty:'3', executedQty:'1', clientOrderId:'manual-1' }
];
assert.strictEqual(estimateManagedExposureUsdt(orders, prices), 40);

assert.strictEqual(tierCapUsdt('HIGH', 550), 30.25);
assert.strictEqual(tierCapUsdt('EXCEPTIONAL', 550), 55);
assert.strictEqual(tierCapUsdt('EXCEPTIONAL', 900), 70);

const high = resolveGrowthPosition({
  lane:'CORE', tier:'HIGH', equityUsdt:550, usdtFree:300, managedExposureUsdt:100, baseQuoteOrderQty:30
});
assert.strictEqual(high.quote_order_qty, 30.25);
assert.strictEqual(high.reason, 'COMPOUNDING_CORE');

const exceptional = resolveGrowthPosition({
  lane:'CORE', tier:'EXCEPTIONAL', equityUsdt:600, usdtFree:300, managedExposureUsdt:100, baseQuoteOrderQty:50
});
assert.strictEqual(exceptional.quote_order_qty, 60);

const capped = resolveGrowthPosition({
  lane:'CORE', tier:'EXCEPTIONAL', equityUsdt:600, usdtFree:300, managedExposureUsdt:385, baseQuoteOrderQty:50
});
assert.strictEqual(capped.quote_order_qty, 5);

const v10 = resolveGrowthPosition({
  lane:'V10_HUNTER', tier:'EXCEPTIONAL', equityUsdt:600, usdtFree:300, managedExposureUsdt:0, baseQuoteOrderQty:40
});
assert.strictEqual(v10.quote_order_qty, 40);
assert.strictEqual(v10.enabled, false);

console.log('spotGrowthEngine tests passed');
