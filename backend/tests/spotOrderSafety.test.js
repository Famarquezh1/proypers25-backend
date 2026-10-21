'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  journalStore,
  deterministicClientOrderId,
  submitOrder,
  cancelOrder,
  reconcileTransition,
  sellableQuantity,
  uncertain
} = require('../services/spotOrderSafety');

const temporaryDirectories = [];

function temporaryJournal() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'spot-order-journal-'));
  temporaryDirectories.push(directory);
  return directory;
}

function missingOrder() {
  return Object.assign(new Error('HTTP 400: Order does not exist'), { body: { code: -2013 } });
}

function transition(store, values = {}) {
  return store.begin('ABCUSDT', {
    id: `intent-${Math.random()}`,
    intent: 'REPLACE_PROTECTION',
    phase: 'INTENT',
    quantity: 3,
    preBalanceQuantity: null,
    baseAsset: 'ABC',
    oldProtections: [{ orderId: 'old-order', clientOrderId: 'old-stop' }],
    clientOrderIds: ['old-stop', 'new-stop'],
    newClientOrderId: 'new-stop',
    replacementStopPrice: 9,
    protectionClientPrefix: 'proypers-gh-protect-',
    ...values
  });
}

async function orderRecoveryTests() {
  const root = temporaryJournal();
  const sellRoot = temporaryJournal();
  const protectionRoot = temporaryJournal();
  const store = journalStore(root);
  const intent = transition(store);
  store.update('ABCUSDT', intent.id, { phase: 'CANCEL_CONFIRMED' });

  const afterRestart = journalStore(root);
  const pending = await reconcileTransition(afterRestart.read('ABCUSDT'), {
    getOpenOrders: async () => [],
    getOrder: async (_symbol, id) => {
      if (id === 'old-stop') return { orderId: 1, status: 'CANCELED' };
      throw missingOrder();
    },
    getAccount: async () => ({ balances: [{ asset: 'ABC', free: '3', locked: '0' }] })
  });
  assert.equal(pending.resolved, false);
  assert.equal(pending.recoverable, true, 'restart identifies a safely resumable replacement after confirming the old stop is canceled');

  let recoveryPosts = 0;
  let recoveryLookups = 0;
  const resumed = await submitOrder(async (_base, method, _endpoint, params) => {
    if (method === 'POST') {
      recoveryPosts += 1;
      assert.equal(params.newClientOrderId, 'new-stop');
      return { orderId: 2, clientOrderId: 'new-stop', status: 'NEW', origQty: '3' };
    }
    if (recoveryLookups++ === 0) throw missingOrder();
    return { orderId: 2, clientOrderId: 'new-stop', status: 'NEW', origQty: '3' };
  }, 'https://mock', {
    symbol: 'ABCUSDT',
    side: 'SELL',
    type: 'STOP_LOSS',
    quantity: '3',
    newClientOrderId: 'new-stop'
  }, afterRestart, afterRestart.read('ABCUSDT'));
  assert.equal(resumed.orderId, 2);
  assert.equal(recoveryPosts, 1, 'replacement is resumed with the same deterministic client ID');

  const manualStore = journalStore(temporaryJournal());
  const manualIntent = transition(manualStore, {
    oldProtections: [{ orderId: 'manual-stop', clientOrderId: '' }],
    orderIds: ['manual-stop'],
    clientOrderIds: ['new-stop']
  });
  const manualRecovery = await reconcileTransition(manualIntent, {
    getOpenOrders: async () => [],
    getOrder: async (_symbol, id, options) => {
      if (options.byOrderId) {
        assert.equal(id, 'manual-stop');
        return { orderId: 'manual-stop', status: 'CANCELED' };
      }
      throw missingOrder();
    },
    getAccount: async () => ({ balances: [{ asset: 'ABC', free: '3', locked: '0' }] })
  });
  assert.equal(manualRecovery.recoverable, true, 'restart can reconcile a manually placed stop by Binance order ID');

  const replacementActive = await reconcileTransition(afterRestart.read('ABCUSDT'), {
    getOpenOrders: async () => [{ orderId: 2, clientOrderId: 'new-stop', side: 'SELL', status: 'NEW', origQty: '3' }],
    getOrder: async (_symbol, id) => id === 'new-stop'
      ? { orderId: 2, clientOrderId: id, side: 'SELL', status: 'NEW', origQty: '3' }
      : { orderId: 1, clientOrderId: id, status: 'CANCELED' },
    getAccount: async () => ({ balances: [{ asset: 'ABC', free: '0', locked: '3' }] })
  });
  assert.equal(replacementActive.resolved, true, 'restart recognizes the replacement stop instead of duplicating it');

  const sellStore = journalStore(sellRoot);
  const sell = transition(sellStore, {
    intent: 'SELL',
    oldProtections: [],
    clientOrderIds: ['sell-id'],
    newClientOrderId: 'sell-id',
    preBalanceQuantity: 3,
    phase: 'ORDER_ACKNOWLEDGED'
  });
  const confirmedSell = await reconcileTransition(sell, {
    getOpenOrders: async () => [],
    getOrder: async () => ({ orderId: 8, status: 'FILLED', executedQty: '3' }),
    getAccount: async () => ({ balances: [] })
  });
  assert.equal(confirmedSell.resolved, true, 'a confirmed sell is reconciled after a restart');
  assert.equal(confirmedSell.outcome, 'SELL_CONFIRMED');

  const protectedStore = journalStore(protectionRoot);
  const protectedIntent = transition(protectedStore, { newClientOrderId: 'new-stop' });
  const existingProtection = await reconcileTransition(protectedIntent, {
    getOpenOrders: async () => [{ orderId: 1, clientOrderId: 'old-stop', side: 'SELL', status: 'NEW', origQty: '3' }],
    getOrder: async (_symbol, id) => {
      if (id === 'old-stop') return { orderId: 1, clientOrderId: id, status: 'NEW', origQty: '3' };
      throw missingOrder();
    },
    getAccount: async () => ({ balances: [{ asset: 'ABC', free: '0', locked: '3' }] })
  });
  assert.equal(existingProtection.resolved, true, 'an existing native stop is preserved and recognized');
  assert.equal(existingProtection.outcome, 'OLD_PROTECTION_PRESERVED');

  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(sellRoot, { recursive: true, force: true });
  fs.rmSync(protectionRoot, { recursive: true, force: true });
}

async function mutationTests() {
  const root = temporaryJournal();
  const store = journalStore(root);
  const intent = transition(store);
  let posts = 0;
  let lookups = 0;
  const send = async (_base, method, endpoint, params) => {
    if (method === 'POST') {
      posts += 1;
      assert.equal(store.read('ABCUSDT').phase, 'SUBMIT_INTENT', 'intent is durable before POST');
      throw new Error('timeout after acceptance');
    }
    assert.equal(endpoint, '/api/v3/order');
    assert.equal(params.origClientOrderId, 'new-stop');
    if (lookups++ === 0) throw missingOrder();
    return { orderId: 22, clientOrderId: 'new-stop', status: 'NEW' };
  };
  const accepted = await submitOrder(send, 'https://mock', {
    symbol: 'ABCUSDT',
    side: 'SELL',
    type: 'STOP_LOSS',
    quantity: '3',
    newClientOrderId: 'new-stop'
  }, store, intent);
  assert.equal(accepted.orderId, 22);
  assert.equal(posts, 1, 'accepted timeout is reconciled without resubmitting');
  assert.equal(store.read('ABCUSDT').phase, 'ORDER_RECONCILED');

  let duplicatePosts = 0;
  const duplicate = await submitOrder(async (_base, method) => {
    if (method === 'POST') duplicatePosts += 1;
    return { orderId: 22, clientOrderId: 'new-stop', status: 'NEW' };
  }, 'https://mock', {
    symbol: 'ABCUSDT',
    side: 'SELL',
    type: 'STOP_LOSS',
    quantity: '3',
    newClientOrderId: 'new-stop'
  }, store, intent);
  assert.equal(duplicate.orderId, 22);
  assert.equal(duplicatePosts, 0, 'deterministic client ID prevents duplicate replacement stops');

  const cancelStore = journalStore(temporaryJournal());
  const cancelIntent = transition(cancelStore);
  let deleteCount = 0;
  const canceled = await cancelOrder(async (_base, method, _endpoint, params) => {
    if (method === 'DELETE') {
      deleteCount += 1;
      assert.equal(cancelStore.read('ABCUSDT').phase, 'CANCEL_INTENT', 'intent is durable before DELETE');
      throw new Error('cancel acknowledgement lost');
    }
    assert.equal(params.origClientOrderId, 'old-stop');
    return { orderId: 55, status: 'CANCELED' };
  }, 'https://mock', 'ABCUSDT', { orderId: 55, clientOrderId: 'old-stop', origQty: '3' }, cancelStore, cancelIntent);
  assert.equal(canceled, true);
  assert.equal(deleteCount, 1, 'uncertain cancellation is queried, never blindly retried');

  const uncertainStore = journalStore(temporaryJournal());
  const uncertainIntent = transition(uncertainStore);
  await assert.rejects(submitOrder(async (_base, method) => {
    if (method === 'POST') throw new Error('network unavailable');
    throw missingOrder();
  }, 'https://mock', {
    symbol: 'ABCUSDT',
    side: 'SELL',
    type: 'MARKET',
    quantity: '3',
    newClientOrderId: 'sell-id'
  }, uncertainStore, uncertainIntent), (error) => error.code === 'ORDER_OUTCOME_UNCERTAIN');
  assert.equal(uncertainStore.read('ABCUSDT').phase, 'SUBMIT_INTENT', 'ambiguous submit remains persisted and blocks another mutation');
  assert.throws(() => uncertainStore.begin('ABCUSDT', { id: 'second', phase: 'INTENT' }),
    /SYMBOL_TRANSITION_PENDING/, 'another invocation cannot replace an ambiguous symbol journal');
}

function guardTests() {
  assert.equal(deterministicClientOrderId('proypers-gh-exit-', 'ABCUSDT', 'entry-1', 'STOP', 3),
    deterministicClientOrderId('proypers-gh-exit-', 'ABCUSDT', 'entry-1', 'STOP', 3));
  assert(deterministicClientOrderId('proypers-gh-exit-', 'ABCUSDT', 'entry-1', 'STOP', 3).length <= 36);

  const dust = sellableQuantity({
    managedQuantity: 0.4,
    totalQuantity: 0.4,
    lot: { minQty: '1', stepSize: '1' },
    price: 10,
    minimumNotional: 5
  });
  assert.equal(dust.sellable, false, 'sub-LOT_SIZE balance is not sellable');
  assert.equal(dust.reason, 'BELOW_MINIMUM_QUANTITY');

  const belowNotional = sellableQuantity({
    managedQuantity: 2,
    totalQuantity: 2,
    lot: { minQty: '0.1', stepSize: '0.1' },
    price: 1,
    minimumNotional: 5
  });
  assert.equal(belowNotional.sellable, false);
  assert.equal(belowNotional.reason, 'BELOW_MINIMUM_NOTIONAL');
  assert.equal(uncertain('mock').code, 'ORDER_OUTCOME_UNCERTAIN');
}

async function wrapperCompatibilityTest() {
  const root = temporaryJournal();
  const names = ['PROYPERS_SPOT_ORDER_JOURNAL_DIR', 'BINANCE_API_KEY', 'BINANCE_SECRET_KEY', 'BINANCE_SECRET'];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  const oldFetch = global.fetch;
  process.env.PROYPERS_SPOT_ORDER_JOURNAL_DIR = root;
  process.env.BINANCE_API_KEY = 'offline-test-key';
  process.env.BINANCE_SECRET_KEY = 'offline-test-secret';
  try {
    const engine = require('../scripts/github-spot-auto-exit-legacy-v10-aware');
    assert.equal(typeof engine.main, 'function');
    assert.equal(typeof engine.marketSell, 'function');
    const rules = { filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }] };
    const protection = engine.protectionParams(rules, 100, 100);
    assert(protection.stopPrice > 0 && protection.stopPrice < 100);

    let mutations = 0;
    global.fetch = async (_url, options = {}) => {
      if (options.method === 'POST' || options.method === 'DELETE') mutations += 1;
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => JSON.stringify({ balances: [{ asset: 'DUST', free: '0.4', locked: '0' }] })
      };
    };
    const result = await engine.marketSell('https://mock', {
      symbol: 'DUSTUSDT',
      baseAsset: 'DUST',
      filters: [
        { filterType: 'LOT_SIZE', minQty: '1', stepSize: '1' },
        { filterType: 'MIN_NOTIONAL', minNotional: '5' }
      ]
    }, 'DUSTUSDT', 0.4, 'TIMEOUT_STALE', 10, 10);
    assert.equal(result.skipped, true);
    assert.equal(mutations, 0, 'dust preflight leaves an existing protection untouched and submits no order');

    let protectionCanceled = false;
    let sellPosts = 0;
    let sellAccepted = false;
    const apiResponse = (status, body) => ({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 200 ? 'OK' : 'Bad Request',
      text: async () => JSON.stringify(body)
    });
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      const params = parsed.searchParams;
      if (parsed.pathname.endsWith('/account')) {
        return apiResponse(200, { balances: [{ asset: 'ABC', free: '1', locked: '0' }] });
      }
      if (parsed.pathname.endsWith('/openOrders')) {
        return apiResponse(200, protectionCanceled ? [] : [{
          orderId: 4,
          clientOrderId: 'proypers-gh-protect-existing',
          side: 'SELL',
          status: 'NEW',
          origQty: '1',
          executedQty: '0'
        }]);
      }
      if (parsed.pathname.endsWith('/order') && options.method === 'DELETE') {
        protectionCanceled = true;
        return apiResponse(200, { orderId: 4, status: 'CANCELED' });
      }
      if (parsed.pathname.endsWith('/order') && options.method === 'POST') {
        sellPosts += 1;
        sellAccepted = true;
        return apiResponse(200, { orderId: 5, status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '10' });
      }
      if (parsed.pathname.endsWith('/order') && params.get('origClientOrderId')) {
        if (sellAccepted) return apiResponse(200, { orderId: 5, status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '10' });
        return apiResponse(400, { code: -2013, msg: 'Order does not exist.' });
      }
      if (parsed.pathname.endsWith('/order') && params.get('orderId') === '4') {
        return apiResponse(200, { orderId: 4, status: 'CANCELED' });
      }
      throw new Error(`unexpected mock request ${parsed.pathname}`);
    };
    const sold = await engine.marketSell('https://mock', {
      symbol: 'ABCUSDT',
      baseAsset: 'ABC',
      filters: [
        { filterType: 'LOT_SIZE', minQty: '0.1', stepSize: '0.1' },
        { filterType: 'MIN_NOTIONAL', minNotional: '5' }
      ]
    }, 'ABCUSDT', 1, 'STOP_LOSS', 9, 10, 42, 'entry-42');
    assert.equal(sold.status, 'FILLED');
    assert.equal(protectionCanceled, true);
    assert.equal(sellPosts, 1, 'active native protection is cancelled only inside the persisted sell transition');

    let timeoutPosts = 0;
    let timeoutAccepted = false;
    global.fetch = async (url, options = {}) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith('/account')) return apiResponse(200, { balances: [{ asset: 'ABC', free: '1', locked: '0' }] });
      if (parsed.pathname.endsWith('/openOrders')) return apiResponse(200, []);
      if (parsed.pathname.endsWith('/order') && options.method === 'POST') {
        timeoutPosts += 1;
        timeoutAccepted = true;
        throw new Error('timeout after Binance accepted the order');
      }
      if (parsed.pathname.endsWith('/order') && parsed.searchParams.get('origClientOrderId')) {
        if (timeoutAccepted) return apiResponse(200, { orderId: 6, status: 'FILLED', executedQty: '1', cummulativeQuoteQty: '10' });
        return apiResponse(400, { code: -2013, msg: 'Order does not exist.' });
      }
      throw new Error(`unexpected timeout mock request ${parsed.pathname}`);
    };
    const reconciledSell = await engine.marketSell('https://mock', {
      symbol: 'ABCUSDT',
      baseAsset: 'ABC',
      filters: [
        { filterType: 'LOT_SIZE', minQty: '0.1', stepSize: '0.1' },
        { filterType: 'MIN_NOTIONAL', minNotional: '5' }
      ]
    }, 'ABCUSDT', 1, 'TIMEOUT_STALE', 9, 10, 42, 'entry-42');
    assert.equal(reconciledSell.orderId, 6);
    assert.equal(timeoutPosts, 1, 'accepted timeout is queried by client ID rather than retried');
  } finally {
    global.fetch = oldFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }

    fs.rmSync(root, { recursive: true, force: true });
  }
}

(async () => {
  guardTests();
  await orderRecoveryTests();
  await mutationTests();
  await wrapperCompatibilityTest();
  for (const directory of temporaryDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  console.log('spotOrderSafety tests passed (offline mocks; no live orders)');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
