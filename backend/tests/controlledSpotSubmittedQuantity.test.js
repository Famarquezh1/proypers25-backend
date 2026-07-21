'use strict';

const assert = require('assert');
const {
  buildSellQuantityEvidence,
  getSellableQuantity,
  executeMarketSell
} = require('../services/controlledSpotExitExecutor');

(async () => {
  const direct = buildSellQuantityEvidence(1493273.23, 32404488.97, {
    filterType: 'LOT_SIZE',
    minQty: '1.00',
    maxQty: '90000000.00',
    stepSize: '1.00'
  });
  assert.strictEqual(direct.raw_managed_quantity, 1493273.23);
  assert.strictEqual(direct.step_size, '1.00');
  assert.strictEqual(direct.normalized_sell_quantity, 1493273);
  assert.strictEqual(direct.submitted_quantity, 1493273);

  const evidence = await getSellableQuantity('XECUSDT', 1493273.23, {
    privateRequest: async () => ({
      balances: [{ asset: 'XEC', free: '32404488.97', locked: '0' }]
    }),
    publicGet: async () => ({
      symbols: [{
        symbol: 'XECUSDT',
        status: 'TRADING',
        isSpotTradingAllowed: true,
        baseAsset: 'XEC',
        filters: [
          { filterType: 'MARKET_LOT_SIZE', minQty: '0.00', maxQty: '90000000.00', stepSize: '0.00000000' },
          { filterType: 'LOT_SIZE', minQty: '1.00', maxQty: '90000000.00', stepSize: '1.00' }
        ]
      }]
    })
  });
  assert.strictEqual(evidence.step_size, '1.00');
  assert.strictEqual(evidence.normalized_sell_quantity, 1493273);

  let submittedParams = null;
  const order = await executeMarketSell('XECUSDT', evidence.submitted_quantity, 'px25x_test', {
    findExistingSellOrder: async () => null,
    privateRequest: async (method, path, params) => {
      assert.strictEqual(method, 'POST');
      assert.strictEqual(path, '/api/v3/order');
      submittedParams = params;
      return {
        orderId: 123,
        status: 'FILLED',
        side: 'SELL',
        executedQty: '1493273',
        cummulativeQuoteQty: '10.50',
        fills: []
      };
    }
  });

  assert.strictEqual(order.orderId, 123);
  assert.ok(submittedParams);
  assert.strictEqual(submittedParams.quantity, 1493273);
  assert.notStrictEqual(submittedParams.quantity, 1494768);
  assert.notStrictEqual(submittedParams.quantity, 1493273.23);
  console.log('controlledSpotSubmittedQuantity.test.js PASS');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});