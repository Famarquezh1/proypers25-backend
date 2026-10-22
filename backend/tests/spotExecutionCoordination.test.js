'use strict';

const assert = require('assert');
const {
  createSpotExecutionCoordinator,
  leaseDocumentId,
  withLocalSpotMutation
} = require('../services/spotExecutionCoordination');

function fakeFirestore() {
  const documents = new Map();
  let pending = Promise.resolve();
  return {
    collection(name) {
      return {
        doc(id) {
          const key = `${name}/${id}`;
          return {
            key,
            async get() {
              const value = documents.get(key);
              return { exists: Boolean(value), data: () => value && { ...value } };
            }
          };
        }
      };
    },
    runTransaction(callback) {
      const run = pending.then(() => callback({
        get: async (ref) => {
          const value = documents.get(ref.key);
          return { exists: Boolean(value), data: () => value && { ...value } };
        },
        set: (ref, value, options = {}) => {
          documents.set(ref.key, options.merge ? { ...(documents.get(ref.key) || {}), ...value } : value);
        }
      }));
      pending = run.catch(() => {});
      return run;
    },
    documents
  };
}

(async () => {
  const db = fakeFirestore();
  let clock = 1000;
  const first = createSpotExecutionCoordinator(db, { ownerId: 'runner-a', now: () => clock, leaseMs: 100 });
  const second = createSpotExecutionCoordinator(db, { ownerId: 'firestore-exit', now: () => clock, leaseMs: 100 });
  const accountId = 'mock-spot-account';
  await assert.rejects(first.acquire('', 'BTCUSDT', 'missing-account'), /SPOT_COORDINATION_ACCOUNT_REQUIRED/);
  let mutationCalls = 0;
  await assert.rejects(
    withLocalSpotMutation('', 'BTCUSDT', 'entry-1', async () => { mutationCalls += 1; }),
    /SPOT_COORDINATION_ACCOUNT_REQUIRED/
  );
  assert.strictEqual(mutationCalls, 0, 'missing shared account identity fails closed before order mutation');
  assert.strictEqual(leaseDocumentId(accountId, 'BTCUSDT'), leaseDocumentId(accountId, 'btcusdt'));
  assert.notStrictEqual(leaseDocumentId(accountId, 'BTCUSDT'), leaseDocumentId('another-account', 'BTCUSDT'));
  const recoveredExisting = await withLocalSpotMutation(accountId, 'BTCUSDT', 'entry-1', async () => {
    mutationCalls += 1;
    return { orderId: 'unexpected' };
  }, {
    db,
    metadata: { side: 'BUY' },
    findExisting: async () => ({
      orderId: 'existing-order', clientOrderId: 'entry-1', side: 'BUY', status: 'FILLED'
    })
  });
  assert.strictEqual(recoveredExisting.orderId, 'existing-order');
  assert.strictEqual(mutationCalls, 0, 'an existing client ID is recovered without another Binance request');

  const [winner, loser] = await Promise.all([
    first.acquire(accountId, 'BTCUSDT', 'exit-1', { side: 'SELL' }),
    second.acquire(accountId, 'BTCUSDT', 'exit-2', { side: 'SELL' })
  ]);
  assert.strictEqual([winner, loser].filter((lease) => lease.acquired).length, 1);
  assert.strictEqual([winner, loser].find((lease) => !lease.acquired).reason, 'SPOT_SYMBOL_BUSY');
  const lease = winner.acquired ? winner : loser;
  const winnerCoordinator = winner.acquired ? first : second;
  await winnerCoordinator.beginMutation(lease);
  clock = 1200;
  const afterExpiredMutation = await second.acquire(accountId, 'BTCUSDT', 'another-exit');
  assert.strictEqual(afterExpiredMutation.acquired, false);
  assert.strictEqual(afterExpiredMutation.reason, 'SPOT_SYMBOL_AMBIGUOUS');
  const storedLease = Array.from(db.documents.values())[0];
  assert.strictEqual(storedLease.state, 'AMBIGUOUS');

  const wrongEvidence = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', { orderFound: false });
  assert.strictEqual(wrongEvidence, false);
  const unresolved = await second.acquire(accountId, 'BTCUSDT', 'retry');
  assert.strictEqual(unresolved.acquired, false);

  const unrelatedOrder = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', {
    orderFound: true, status: 'FILLED', orderId: 'other-order', symbol: 'BTCUSDT', clientOrderId: 'another-intent'
  });
  assert.strictEqual(unrelatedOrder, false, 'unrelated client order must not unlock the lease');
  const wrongSymbol = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', {
    orderFound: true, status: 'FILLED', orderId: 'mock-order-1', symbol: 'ETHUSDT', clientOrderId: 'exit-1'
  });
  assert.strictEqual(wrongSymbol, false, 'different Binance symbol must not unlock the lease');
  const missingOrderId = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', {
    orderFound: true, status: 'FILLED', symbol: 'BTCUSDT', clientOrderId: 'exit-1'
  });
  assert.strictEqual(missingOrderId, false, 'an order without Binance orderId cannot unlock an ambiguous intent');
  const wrongSide = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', {
    orderFound: true, status: 'FILLED', orderId: 'mock-buy', symbol: 'BTCUSDT',
    clientOrderId: 'exit-1', side: 'BUY'
  });
  assert.strictEqual(wrongSide, false, 'an order with mismatched side must not unlock a SELL intent');
  const resolved = await second.resolveAmbiguous(accountId, 'BTCUSDT', 'exit-1', {
    orderFound: true, status: 'FILLED', orderId: 'mock-order-1',
    symbol: 'BTCUSDT', clientOrderId: 'exit-1', side: 'SELL'
  });
  assert.strictEqual(resolved, true);
  const nextLease = await second.acquire(accountId, 'BTCUSDT', 'retry-after-reconcile');
  assert.strictEqual(nextLease.acquired, true);
  assert.ok(nextLease.fencingToken > lease.fencingToken);
  await second.release(nextLease);

  const fencingDb = fakeFirestore();
  let fencingClock = 5000;
  const staleCoordinator = createSpotExecutionCoordinator(fencingDb, {
    ownerId: 'stale-runner', now: () => fencingClock, leaseMs: 50
  });
  const newCoordinator = createSpotExecutionCoordinator(fencingDb, {
    ownerId: 'new-runner', now: () => fencingClock, leaseMs: 50
  });
  const staleLease = await staleCoordinator.acquire(accountId, 'SOLUSDT', 'stale-order');
  fencingClock += 51;
  const currentLease = await newCoordinator.acquire(accountId, 'SOLUSDT', 'current-order');
  assert.strictEqual(currentLease.acquired, true);
  assert.ok(currentLease.fencingToken > staleLease.fencingToken);
  await assert.rejects(staleCoordinator.beginMutation(staleLease), /SPOT_LEASE_FENCE_REJECTED/);
  await newCoordinator.release(currentLease);

  const timeoutDb = fakeFirestore();
  const timeoutCoordinator = createSpotExecutionCoordinator(timeoutDb, { ownerId: 'runner-timeout', now: () => clock });
  await assert.rejects(
    timeoutCoordinator.withMutation(accountId, 'ETHUSDT', 'sell-timeout', async () => {
      const timeout = new Error('request timed out after write');
      timeout.code = 'ETIMEDOUT';
      throw timeout;
    }, { side: 'SELL', type: 'MARKET', clientOrderId: 'sell-timeout' }),
    /request timed out/
  );
  const timeoutLease = await timeoutCoordinator.acquire(accountId, 'ETHUSDT', 'duplicate-sell');
  assert.strictEqual(timeoutLease.acquired, false);
  assert.strictEqual(timeoutLease.reason, 'SPOT_SYMBOL_AMBIGUOUS');
  const activeMarketOrder = await timeoutCoordinator.resolveAmbiguous(accountId, 'ETHUSDT', 'sell-timeout', {
    orderFound: true, status: 'NEW', side: 'SELL', type: 'MARKET', orderId: 'mock-active-sell',
    symbol: 'ETHUSDT', clientOrderId: 'sell-timeout'
  });
  assert.strictEqual(activeMarketOrder, false, 'an in-flight sell remains fail-closed');
  const activeStop = await timeoutCoordinator.resolveAmbiguous(accountId, 'ETHUSDT', 'sell-timeout', {
    orderFound: true, status: 'NEW', side: 'SELL', type: 'STOP_LOSS_LIMIT', orderId: 'mock-active-stop',
    symbol: 'ETHUSDT', clientOrderId: 'sell-timeout'
  });
  assert.strictEqual(activeStop, false, 'an unrelated stop cannot resolve a MARKET sell timeout');
  const terminalSell = await timeoutCoordinator.resolveAmbiguous(accountId, 'ETHUSDT', 'sell-timeout', {
    orderFound: true, status: 'FILLED', side: 'SELL', type: 'MARKET', orderId: 'mock-active-sell',
    symbol: 'ETHUSDT', clientOrderId: 'sell-timeout'
  });
  assert.strictEqual(terminalSell, true, 'matching terminal sell reconciles the ambiguous intent');

  console.log('spotExecutionCoordination.test.js passed');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
