'use strict';

const assert = require('assert');
const {
  remainingOrderQty,
  latestOpenProtection,
  latestFilledExit,
  resolveManagedResidual
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

console.log('spotManagedResidual tests passed');
