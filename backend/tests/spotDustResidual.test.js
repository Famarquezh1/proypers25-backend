'use strict';

const assert = require('assert');
const {
  floorToStep,
  extractMarketRules,
  classifyDustResidual
} = require('../services/spotDustResidual');

const tutInfo = {
  symbol: 'TUTUSDT',
  baseAsset: 'TUT',
  status: 'TRADING',
  isSpotTradingAllowed: true,
  filters: [
    { filterType: 'LOT_SIZE', minQty: '1.00000000', maxQty: '9000000.00000000', stepSize: '1.00000000' },
    { filterType: 'MIN_NOTIONAL', minNotional: '5.00000000' }
  ]
};

(function tutResidualIsDust() {
  const result = classifyDustResidual({
    residualQuantity: 0.516,
    currentPrice: 0.0207,
    symbolInfo: tutInfo
  });
  assert.strictEqual(result.dust, true);
  assert.strictEqual(result.normalized_sellable_quantity, 0);
  assert(result.reasons.includes('RESIDUAL_BELOW_STEP_SIZE'));
  assert(result.reasons.includes('RESIDUAL_BELOW_MINIMUM_QUANTITY'));
})();

(function sellableBalanceIsNotDust() {
  const result = classifyDustResidual({
    residualQuantity: 483,
    currentPrice: 0.0207,
    symbolInfo: tutInfo
  });
  assert.strictEqual(result.dust, false);
  assert.strictEqual(result.normalized_sellable_quantity, 483);
  assert(result.normalized_sellable_value_usdt > 5);
})();

(function minimumNotionalAlsoClassifiesDust() {
  const rules = extractMarketRules({
    symbol: 'ABCUSDT',
    baseAsset: 'ABC',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [
      { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '100000', stepSize: '0.1' },
      { filterType: 'NOTIONAL', minNotional: '5' }
    ]
  });
  const result = classifyDustResidual({ residualQuantity: 2, currentPrice: 1, marketRules: rules });
  assert.strictEqual(result.dust, true);
  assert.strictEqual(result.below_minimum_notional, true);
  assert.strictEqual(result.residual_classification, 'SUB_MIN_NOTIONAL_RESIDUAL');
  assert(result.reasons.includes('RESIDUAL_BELOW_MINIMUM_NOTIONAL'));
})();

(function sushiProductionEquivalentIsResidualNotFailure() {
  const sushiInfo = {
    symbol: 'SUSHIUSDT',
    baseAsset: 'SUSHI',
    status: 'TRADING',
    isSpotTradingAllowed: true,
    filters: [
      { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '9000000', stepSize: '0.1' },
      { filterType: 'NOTIONAL', minNotional: '5' }
    ]
  };
  const result = classifyDustResidual({
    residualQuantity: 24.975,
    currentPrice: 4.80 / 24.975,
    symbolInfo: sushiInfo
  });
  assert.strictEqual(result.dust, true);
  assert.strictEqual(result.below_minimum_notional, true);
  assert.strictEqual(result.residual_classification, 'SUB_MIN_NOTIONAL_RESIDUAL');
  assert(result.normalized_sellable_value_usdt < 5);
})();

(function decimalFloorIsStable() {
  assert.strictEqual(floorToStep(12.34567, '0.00100000'), 12.345);
})();

console.log('spotDustResidual tests passed');
