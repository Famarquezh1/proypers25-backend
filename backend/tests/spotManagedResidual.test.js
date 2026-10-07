'use strict';

const assert = require('assert');
const {
  remainingOrderQty,
  latestOpenProtection,
  latestFilledExit,
  resolveManagedResidual,
  managedTradesOnly
} = require('../services/spotManagedResidual');

const buy = {
  side: 'BUY',
  status: 'FILLED',
  time: 1000,
  updateTime: 1000,
  executedQty: '1000',
  cummulativeQuoteQty: '20'
};

const filledProtect = {
  side: 'SELL',
  status: 'FILLED',
  time: 2000,
  updateTime: 2000,
  executedQty: '200',
  origQty: '200',
  cummulativeQuoteQty: '4.4',
  clientOrderId: 'proypers-gh-protect-old'
};

const openProtect = {
  side: 'SELL',
  status: 'NEW',
  time: 3000,
  updateTime: 3000,
  origQty: '795.8',
  executedQty: '0',
  stopPrice: '0.02',
  clientOrderId: 'proypers-gh-protect-v61-live'
};

assert.strictEqual(remainingOrderQty(openProtect), 795.8);
assert.strictEqual(latestOpenProtection([filledProtect, openProtect], 1000), openProtect);
assert.strictEqual(latestFilledExit([filledProtect, openProtect], 1000), filledProtect);

const trades = [
  { id: 1, time: 1000, isBuyer: true, qty: '1000', quoteQty: '20', price: '0.02', commission: '0', commissionAsset: 'BNB' },
  { id: 2, time: 2000, isBuyer: false, qty: '204.2', quoteQty: '4.4924', price: '0.022', commission: '0', commissionAsset: 'BNB' }
];

const residual = resolveManagedResidual({
  buy,
  orders: [filledProtect, openProtect],
  trades,
  ownedTotal: 795.8,
  baseAsset: 'SAGA'
});

assert.strictEqual(residual.active, true);
assert.strictEqual(residual.residualMode, true);
assert.strictEqual(residual.managedQty, 795.8);
assert(residual.entryPrice > 0);
assert.strictEqual(residual.reason, 'RESIDUAL_RECONSTRUCTED');

const fullyClosed = resolveManagedResidual({
  buy,
  orders: [filledProtect],
  trades,
  ownedTotal: 0,
  baseAsset: 'SAGA'
});
assert.strictEqual(fullyClosed.active, false);

const pyramidBase = {
  side: 'BUY', status: 'FILLED', orderId: 10, time: 5000, updateTime: 5000,
  executedQty: '10', cummulativeQuoteQty: '100',
  clientOrderId: 'proypers-gh-base'
};
const pyramidAdd = {
  side: 'BUY', status: 'FILLED', orderId: 11, time: 6000, updateTime: 6000,
  executedQty: '1', cummulativeQuoteQty: '11',
  clientOrderId: 'proypers-gh-add-live'
};
const pyramidProtect = {
  side: 'SELL', status: 'NEW', orderId: 12, time: 7000, updateTime: 7000,
  origQty: '11', executedQty: '0', stopPrice: '10.4',
  clientOrderId: 'proypers-gh-protect-live'
};
const manualBuy = {
  side: 'BUY', status: 'FILLED', orderId: 99, time: 5500, updateTime: 5500,
  executedQty: '5', cummulativeQuoteQty: '50',
  clientOrderId: 'manual-buy'
};
const pyramidTrades = [
  { orderId: 10, id: 10, time: 5000, isBuyer: true, qty: '10', quoteQty: '100', price: '10', commission: '0', commissionAsset: 'BNB' },
  { orderId: 99, id: 99, time: 5500, isBuyer: true, qty: '5', quoteQty: '50', price: '10', commission: '0', commissionAsset: 'BNB' },
  { orderId: 11, id: 11, time: 6000, isBuyer: true, qty: '1', quoteQty: '11', price: '11', commission: '0', commissionAsset: 'BNB' }
];

assert.strictEqual(managedTradesOnly(pyramidTrades, [pyramidBase, pyramidAdd, pyramidProtect, manualBuy]).length, 2);
const pyramidManaged = resolveManagedResidual({
  buy: pyramidAdd,
  orders: [pyramidBase, pyramidAdd, pyramidProtect, manualBuy],
  trades: pyramidTrades,
  ownedTotal: 11,
  baseAsset: 'ABC',
  forceReconstruct: true
});
assert.strictEqual(pyramidManaged.active, true);
assert.strictEqual(pyramidManaged.managedQty, 11);
assert(Math.abs(pyramidManaged.entryPrice - (111 / 11)) < 1e-9);


const firstRklbbBuy = {
  side: 'BUY', status: 'FILLED', orderId: 26157111, time: 10000, updateTime: 10000,
  executedQty: '0.22954', cummulativeQuoteQty: '14.60',
  clientOrderId: 'proypers-gh-rklbb-first'
};
const secondRklbbBuy = {
  side: 'BUY', status: 'FILLED', orderId: 26164413, time: 11000, updateTime: 11000,
  executedQty: '0.23300', cummulativeQuoteQty: '14.98',
  clientOrderId: 'proypers-gh-rklbb-second'
};
const secondRklbbExit = {
  side: 'SELL', status: 'FILLED', orderId: 26298787, time: 12000, updateTime: 12000,
  executedQty: '0.23300', origQty: '0.23300', cummulativeQuoteQty: '14.67201',
  clientOrderId: 'proypers-gh-protect-rklbb'
};
const rklbbTrades = [
  { orderId: 26157111, id: 1, time: 10000, isBuyer: true, qty: '0.22954', quoteQty: '14.60', price: '63.605', commission: '0', commissionAsset: 'BNB' },
  { orderId: 26164413, id: 2, time: 11000, isBuyer: true, qty: '0.23300', quoteQty: '14.98', price: '64.292', commission: '0', commissionAsset: 'BNB' },
  { orderId: 26298787, id: 3, time: 12000, isBuyer: false, qty: '0.23300', quoteQty: '14.67201', price: '62.97', commission: '0', commissionAsset: 'BNB' }
];
const rklbbResidual = resolveManagedResidual({
  buy: secondRklbbBuy,
  orders: [firstRklbbBuy, secondRklbbBuy, secondRklbbExit],
  trades: rklbbTrades,
  ownedTotal: 0.22954,
  baseAsset: 'RKLBB',
  forceReconstruct: true
});
assert.strictEqual(rklbbResidual.active, true);
assert.strictEqual(rklbbResidual.residualMode, true);
assert(Math.abs(rklbbResidual.managedQty - 0.22954) < 1e-8);
assert(rklbbResidual.entryPrice > 63 && rklbbResidual.entryPrice < 64);
assert.strictEqual(rklbbResidual.reason, 'RESIDUAL_RECONSTRUCTED');

console.log('spotManagedResidual tests passed');
