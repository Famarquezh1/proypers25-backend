'use strict';

const assert = require('assert');
const {
  summarizeManagedQuantity,
  isPartialExitPosition,
  summarizeRemainingManagedQuantity,
  buildManagedDifference,
  classifyAndCloseDustIfNeeded
} = require('../services/spotManagedQuantityRepair');
const {
  floorToStep,
  evaluateAndExecuteRealSpotExits
} = require('../services/controlledSpotExitExecutor');

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

(function sushiBaseAssetCommissionProducesRealSellableBalance() {
  const summary = summarizeManagedQuantity(
    { quantity: 25, order_id: 9001 },
    [{ isBuyer: true, orderId: 9001, qty: '25', commission: '0.025', commissionAsset: 'SUSHI' }],
    'SUSHI'
  );
  assert.strictEqual(summary.gross_quantity, 25);
  assert.strictEqual(summary.base_asset_commission, 0.025);
  assert.strictEqual(summary.managed_quantity, 24.975);
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

(function partialExitKeepsOnlyRemainingManagedQuantity() {
  const position = {
    id: 'tut',
    symbol: 'TUTUSDT',
    quantity: 0.516,
    managed_quantity: 483.516,
    gross_quantity: 484,
    base_asset_commission: 0.484,
    exit_status: 'PARTIAL_EXIT_FILLED',
    last_partial_exit_event_id: 'binance_order_123'
  };
  assert.strictEqual(isPartialExitPosition(position), true);
  const summary = summarizeRemainingManagedQuantity(position, 0.516);
  assert.strictEqual(summary.managed_quantity, 0.516);
  assert.strictEqual(summary.net_quantity, 0.516);
  assert.strictEqual(summary.source, 'stored_partial_exit_residual');
})();

(function partialExitNeverResurrectsSoldQuantity() {
  const summary = summarizeRemainingManagedQuantity({
    quantity: 0.516,
    managed_quantity: 483.516,
    exit_status: 'PARTIAL_EXIT_FILLED'
  }, 0.516);
  assert.notStrictEqual(summary.managed_quantity, 483.516);
  assert.strictEqual(summary.managed_quantity, 0.516);
})();

(async function sushiSubMinNotionalIsClosedBeforeExitEngineAndDoesNotFreezeEntries() {
  const position = {
    id: 'sushi-real-1',
    symbol: 'SUSHIUSDT',
    status: 'REAL_OPEN',
    quantity: 24.975,
    managed_quantity: 24.975,
    net_quantity: 24.975,
    capital_usdt: 5,
    exit_status: 'EXIT_FAILED',
    exit_error: 'Filter failure: NOTIONAL',
    exit_reason_pending: 'BREAK_EVEN_STOP'
  };
  const stores = {
    position: { ...position },
    dust: null,
    balance: { in_positions_usdt: 5, dust_residual_cost_usdt: 0, dust_residual_value_usdt: 0 }
  };
  const positionRef = { kind: 'position', id: position.id };
  const dustRef = { kind: 'dust', id: `dust_${position.id}` };
  const balanceRef = { kind: 'balance', id: 'balance' };
  const snapshotFor = (ref) => {
    if (ref.kind === 'position') return { exists: true, id: position.id, data: () => ({ ...stores.position }) };
    if (ref.kind === 'dust') return { exists: Boolean(stores.dust), id: dustRef.id, data: () => stores.dust };
    if (ref.kind === 'balance') return { exists: true, id: 'balance', data: () => ({ ...stores.balance }) };
    throw new Error('unexpected ref');
  };
  const db = {
    doc: (path) => {
      assert.strictEqual(path, 'real_spot_config/balance');
      return balanceRef;
    },
    collection: (name) => {
      if (name === 'real_spot_dust_residuals') return { doc: () => dustRef };
      if (name === 'real_spot_positions') {
        return {
          where: () => ({
            get: async () => ({
              size: stores.position.status === 'REAL_OPEN' ? 1 : 0,
              docs: stores.position.status === 'REAL_OPEN' ? [{ id: position.id, data: () => ({ ...stores.position }) }] : []
            })
          })
        };
      }
      throw new Error(`unexpected collection ${name}`);
    },
    runTransaction: async (callback) => callback({
      get: async (ref) => snapshotFor(ref),
      update: (ref, patch) => {
        if (ref.kind !== 'position') throw new Error('unexpected update');
        stores.position = { ...stores.position, ...patch };
      },
      set: (ref, patch, options) => {
        if (ref.kind === 'dust') stores.dust = { ...(stores.dust || {}), ...patch };
        else if (ref.kind === 'balance') stores.balance = options?.merge ? { ...stores.balance, ...patch } : { ...patch };
        else throw new Error('unexpected set');
      }
    })
  };

  const summary = {
    gross_quantity: 25,
    base_asset_commission: 0.025,
    managed_quantity: 24.975,
    net_quantity: 24.975,
    source: 'confirmed_buy_fills'
  };
  const dust = await classifyAndCloseDustIfNeeded(db, { id: position.id, ref: positionRef }, position, summary, {
    publicRequest: async (path) => {
      if (path === '/api/v3/exchangeInfo') return {
        symbols: [{
          symbol: 'SUSHIUSDT', baseAsset: 'SUSHI', status: 'TRADING', isSpotTradingAllowed: true,
          filters: [
            { filterType: 'LOT_SIZE', minQty: '0.1', maxQty: '9000000', stepSize: '0.1' },
            { filterType: 'NOTIONAL', minNotional: '5' }
          ]
        }]
      };
      if (path === '/api/v3/ticker/price') return { price: String(4.80 / 24.975) };
      throw new Error(`unexpected path ${path}`);
    }
  });
  assert.strictEqual(dust.closed, true);
  assert.strictEqual(dust.classification.residual_classification, 'SUB_MIN_NOTIONAL_RESIDUAL');
  assert.strictEqual(stores.position.status, 'REAL_CLOSED');
  assert.strictEqual(stores.position.logical_closing_reason, 'SUB_MIN_NOTIONAL_RESIDUAL');
  assert.strictEqual(stores.position.capital_usdt, 0);
  assert.strictEqual(stores.dust.residual_classification, 'SUB_MIN_NOTIONAL_RESIDUAL');

  const exitResult = await evaluateAndExecuteRealSpotExits(db, {
    enabled: true,
    real_sells_enabled: true,
    auto_order_execution: true,
    spot_only: true,
    futures_allowed: false,
    margin_allowed: false,
    leverage_allowed: false,
    withdrawals_allowed: false
  });
  assert.strictEqual(exitResult.ok, true);
  assert.strictEqual(exitResult.exit_engine_healthy, true);
  assert.strictEqual(exitResult.evaluated, 0);
  assert.strictEqual(exitResult.failures.length, 0);
})();

console.log('spotManagedQuantityRepair tests passed');
