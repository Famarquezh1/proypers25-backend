'use strict';

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function isTransientReadError(error) {
  if (Number.isInteger(error?.status)) return RETRYABLE_STATUS.has(error.status);
  const code = String(error?.cause?.code || error?.code || '');
  if (/^(ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|UND_ERR_CONNECT_TIMEOUT|UND_ERR_SOCKET)$/.test(code)) return true;
  return /^(fetch failed|network error)$/i.test(String(error?.message || ''));
}

async function retryReadOnly(operation, { method = 'GET', attempts = 3, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
  if (typeof operation !== 'function') throw new TypeError('operation must be a function');
  if (method !== 'GET') return operation();
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try { return await operation(); }
    catch (error) {
      if (attempt >= attempts || !isTransientReadError(error)) throw error;
      await sleep(150 * attempt);
    }
  }
}

module.exports = { isTransientReadError, retryReadOnly };
