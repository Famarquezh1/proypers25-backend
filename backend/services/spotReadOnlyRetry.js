'use strict';

// Only retry idempotent reads. Never repeat exchange orders, cancellations or GitHub writes.
const RETRYABLE = /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|AbortError/i;
function isTransientReadError(error) {
  const status = Number(error?.status || String(error?.message || '').match(/HTTP\s+(\d{3})/i)?.[1]);
  if ([429, 502, 503, 504].includes(status)) return true;
  if (status >= 400) return false;
  return RETRYABLE.test(String(error?.message || error || '')) ||
    RETRYABLE.test(String(error?.cause?.code || error?.code || ''));
}
async function retryReadOnly(fn, { method = 'GET', maxAttempts = 3, delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof fn !== 'function') throw new TypeError('retryReadOnly requires function');
  if (String(method).toUpperCase() !== 'GET') return fn();
  const attempts = Math.max(1, Math.min(3, Math.floor(Number(maxAttempts) || 1)));
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try { return await fn(); }
    catch (error) {
      if (attempt === attempts || !isTransientReadError(error)) throw error;
      await delay(200 * attempt);
    }
  }
}
module.exports = { isTransientReadError, retryReadOnly };
