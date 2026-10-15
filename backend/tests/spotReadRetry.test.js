'use strict';
const assert = require('node:assert/strict');
const { retryRead, retryableReadError } = require('../services/spotReadRetry');

(async () => {
  let reads = 0;
  const result = await retryRead(async () => {
    reads += 1;
    if (reads < 3) throw new TypeError('fetch failed');
    return { ok: true };
  }, { sleep: async () => {}, label: 'test-read' });
  assert.deepEqual(result, { ok: true });
  assert.equal(reads, 3);

  let mutations = 0;
  await assert.rejects(() => retryRead(async () => {
    mutations += 1;
    throw new TypeError('fetch failed');
  }, { method: 'POST', sleep: async () => {} }), /fetch failed/);
  assert.equal(mutations, 1, 'mutations must never be replayed');

  let permanent = 0;
  await assert.rejects(() => retryRead(async () => {
    permanent += 1;
    const error = new Error('invalid request');
    error.status = 400;
    throw error;
  }, { sleep: async () => {} }), /invalid request/);
  assert.equal(permanent, 1, 'HTTP 400 must not be retried');

  assert.equal(retryableReadError({ status: 503 }), true);
  assert.equal(retryableReadError({ status: 429 }), false);
  assert.equal(retryableReadError({ status: 400, body: { code: -1021 } }), false);
  console.log('spotReadRetry tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
