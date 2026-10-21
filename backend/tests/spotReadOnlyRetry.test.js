'use strict';
const assert = require('node:assert/strict');
const { retryReadOnly, isTransientReadError } = require('../services/spotReadOnlyRetry');

(async () => {
  let calls = 0;
  const result = await retryReadOnly(async () => {
    calls += 1;
    if (calls < 3) throw new TypeError('fetch failed');
    return 'ok';
  }, { sleep: async () => {} });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(retryReadOnly(async () => { calls++; throw new TypeError('fetch failed'); }, { method: 'POST', sleep: async () => {} }), /fetch failed/);
  assert.equal(calls, 1, 'writes must never be retried');

  calls = 0;
  await assert.rejects(retryReadOnly(async () => { calls++; const error = new Error('Forbidden'); error.status = 403; throw error; }, { sleep: async () => {} }), /Forbidden/);
  assert.equal(calls, 1, 'permission errors must not be retried');

  calls = 0;
  await assert.rejects(retryReadOnly(async () => { calls++; throw new Error('invalid signature'); }, { sleep: async () => {} }), /invalid signature/);
  assert.equal(calls, 1);
  assert.equal(isTransientReadError({ status: 429 }), true);
  assert.equal(isTransientReadError({ status: 401 }), false);
  console.log('spotReadOnlyRetry tests passed');
})().catch((error) => { console.error(error); process.exitCode = 1; });
