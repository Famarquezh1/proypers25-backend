'use strict';
const assert = require('node:assert/strict');
const { retryRead, transientReadFailure } = require('../services/spotSafeReadRetry');

async function main() {
  let count = 0;
  const delays = [];
  const value = await retryRead(async () => {
    count += 1;
    if (count < 3) throw new TypeError('fetch failed');
    return 'recovered';
  }, { sleep: async (ms) => { delays.push(ms); } });
  assert.equal(value, 'recovered');
  assert.equal(count, 3);
  assert.deepEqual(delays, [200, 400]);

  count = 0;
  await assert.rejects(retryRead(async () => {
    count += 1;
    throw new TypeError('fetch failed');
  }, { method: 'POST', sleep: async () => {} }), /fetch failed/);
  assert.equal(count, 1, 'POST must never be retried');

  count = 0;
  await assert.rejects(retryRead(async () => {
    count += 1;
    const error = new Error('unauthorized');
    error.status = 401;
    throw error;
  }, { sleep: async () => {} }), /unauthorized/);
  assert.equal(count, 1, 'non-transient HTTP errors must never be retried');

  count = 0;
  await assert.rejects(retryRead(async () => {
    count += 1;
    throw new TypeError('fetch failed');
  }, { sleep: async () => {} }), /fetch failed/);
  assert.equal(count, 3, 'bounded retries only');

  assert.equal(transientReadFailure({ status: 503 }), true);
  assert.equal(transientReadFailure({ status: 400 }), false);
  console.log('SPOT_SAFE_READ_RETRY_TEST_OK');
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
