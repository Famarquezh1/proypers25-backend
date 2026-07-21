'use strict';

const assert = require('assert');
const {
  summarizeManagedQuantity,
  buildManagedDifference
} = require('../services/spotManagedQuantityRepair');
const { floorToStep } = require('../services/controlledSpotExitExecutor');

(function baseAssetCommissionIsRemoved() {
  const summary = summarizeManagedQuantity(
    { quantity: 1494768, order_id: 123 },
    [{ isBuyer: true, orderId: 123, qty: '1494768', commission: '1494.77', commissionAsset: 'XEC' }],
    'XEC'
  );
  assert.strictEqual(summary.gross_quantity, 1494768);
  assert.strictEqual(summary.base_asset_commission, 1494.77);
  assert.strictEqual(Number(summary.managed_quantity.toFixed(2)), 1493273.23);
  assert.strictEqual(floorToStep(summary.managed_quantity, '1.00'), 1493273);
})();

(function quoteAssetCommissionDoesNotReduceBaseQuantity() {
  const summary = summarizeManagedQuantity(
    { quantity: 100, order_id: 7 },
    [{ isBuyer: true, orderId: 7, qty: '100', commission: '0.01', commissionAsset: 'USDT' }],
    'XEC'
  );
  assert.strictEqual(summary.managed_quantity, 100);
})();

(function decimalStepRoundsDown() {
  assert.strictEqual(floorToStep(12.34567, '0.00100000'), 12.345);
})();

(function historicalHoldingsAreSeparated() {
  const difference = buildManagedDifference(
    { id: 'xec', symbol: 'XECUSDT' },
    32404488.97,
    { gross_quantity: 1494768, base_asset_commission: 1494.77, managed_quantity: 1493273.23 }
  );
  assert.strictEqual(difference.consistent, true);
  assert.strictEqual(Number(difference.historical_unmanaged_quantity.toFixed(2)), 30911215.74);
  assert.strictEqual(difference.managed_deficit, 0);
})();

(function managedDeficitBlocksReconciliation() {
  const difference = buildManagedDifference(
    { id: 'xec', symbol: 'XECUSDT' },
    1493000,
    { gross_quantity: 1494768, base_asset_commission: 1494.77, managed_quantity: 1493273.23 }
  );
  assert.strictEqual(difference.consistent, false);
  assert.strictEqual(Number(difference.managed_deficit.toFixed(2)), 273.23);
})();

console.log('spotManagedQuantityRepair tests passed');
