'use strict';

// Retry only idempotent reads. Never replay a BUY, SELL, cancel or protection mutation.
const TRANSIENT_STATUS = new Set([408, 500, 502, 503, 504]);
const TRANSIENT_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET']);

function retryableReadError(error) {
  const status = Number(error?.status || 0);
  if (status > 0) return TRANSIENT_STATUS.has(status);
  if (TRANSIENT_CODES.has(String(error?.code || error?.cause?.code || ''))) return true;
  if (error?.name === 'AbortError' || error?.name === 'TimeoutError') return true;
  return /fetch failed|network error|socket hang up|timed out|timeout/i.test(String(error?.message || error || ''));
}

async function retryRead(operation, { method = 'GET', attempts = 3, delayMs = 250, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)), label = 'read' } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  // Defensive backstop even if a caller accidentally wraps a mutation.
  if (String(method).toUpperCase() !== 'GET') return operation();
  const maxAttempts = Math.max(1, Math.min(3, Math.floor(Number(attempts) || 1)));
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (attempt === maxAttempts || !retryableReadError(error)) throw error;
      console.warn(`SPOT_READ_RETRY label=${label} attempt=${attempt} reason=${String(error?.message || error).slice(0, 180)}`);
      await sleep(delayMs * attempt);
    }
  }
}

module.exports = { retryRead, retryableReadError };
