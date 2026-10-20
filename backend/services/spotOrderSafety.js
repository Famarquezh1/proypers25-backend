'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

function uncertain(message) {
  return Object.assign(new Error(message), { code: 'ORDER_OUTCOME_UNCERTAIN' });
}
function journalStore(root = path.join(os.homedir(), '.proypers25', 'order-intents')) {
  fs.mkdirSync(root, { recursive: true });
  const file = (symbol) => {
    if (!/^[A-Z0-9]+$/.test(symbol)) throw new Error('INVALID_ORDER_SYMBOL');
    return path.join(root, `${symbol}.json`);
  };
  return {
    read(symbol) { try { return JSON.parse(fs.readFileSync(file(symbol), 'utf8')); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } },
    write(symbol, intent) { fs.writeFileSync(file(symbol), JSON.stringify(intent), { flag: 'wx', mode: 0o600 }); },
    clear(symbol) { fs.unlinkSync(file(symbol)); }
  };
}
// A persisted intent survives process death. Never retry a mutation on transport ambiguity.
// Reconcile order AND account before releasing the symbol, including on the next run.
async function reconcileIntent(send, base, symbol, intent, store) {
  let order;
  try {
    order = await send(base, 'GET', '/api/v3/order', { symbol, origClientOrderId: intent.clientId });
    const account = await send(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
    if (!Array.isArray(account?.balances) || !order?.orderId) throw new Error('invalid reconciliation data');
  } catch (error) {
    throw uncertain(`ORDER_RECONCILIATION_REQUIRED ${symbol} ${intent.clientId}: ${error.message}`);
  }
  const activeStop = intent.type !== 'MARKET' && ['NEW', 'PARTIALLY_FILLED'].includes(order.status);
  if (!activeStop && !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(order.status)) {
    throw uncertain(`ORDER_STILL_ACTIVE ${symbol} ${intent.clientId} ${order.status}`);
  }
  store.clear(symbol);
  return order;
}
async function submitOrder(send, base, params, store = journalStore()) {
  const previous = store.read(params.symbol);
  if (previous) {
    await reconcileIntent(send, base, params.symbol, previous, store);
    // Caller must rebuild quantities from fresh orders/balances, never submit stale parameters.
    throw uncertain(`ORDER_RECONCILED_REFRESH_REQUIRED ${params.symbol}`);
  }
  const intent = { clientId: params.newClientOrderId, type: params.type, createdAt: Date.now() };
  if (!intent.clientId) throw new Error('CLIENT_ORDER_ID_REQUIRED');
  store.write(params.symbol, intent);
  try {
    const order = await send(base, 'POST', '/api/v3/order', params);
    if (!order?.orderId || !['NEW', 'PARTIALLY_FILLED', 'FILLED'].includes(order.status)) throw uncertain('INVALID_ORDER_ACK');
    // Accepted stop orders are tracked by Binance, market orders must finish before release.
    if (params.type === 'MARKET' && order.status !== 'FILLED') throw uncertain('MARKET_ORDER_NOT_FILLED');
    store.clear(params.symbol);
    return order;
  } catch (error) {
    // Explicit exchange 4xx rejection is definitive; -1006/-1007 and 5xx are ambiguous.
    if (error.status >= 400 && error.status < 500 && Number.isInteger(error.body?.code) && ![-1006, -1007].includes(error.body.code)) {
      store.clear(params.symbol);
      throw error;
    }
    const order = await reconcileIntent(send, base, params.symbol, intent, store);
    if (order.status === 'FILLED' || (params.type !== 'MARKET' && ['NEW', 'PARTIALLY_FILLED'].includes(order.status))) return order;
    throw uncertain(`ORDER_TERMINAL_REFRESH_REQUIRED ${params.symbol} ${order.status}`);
  }
}

async function requestJson(url, options = {}, fetchImpl = global.fetch) {
  const method = options.method || 'GET';
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url, { ...options, signal: options.signal || AbortSignal.timeout(8000) });
      const text = await response.text();
      let body;
      try { body = JSON.parse(text); } catch { throw new Error('INVALID_JSON_RESPONSE'); }
      if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}: ${body?.msg || response.statusText}`), { status: response.status, body });
      const endpoint = new URL(url).pathname;
      if (/\/(openOrders|allOrders|myTrades|klines)$/.test(endpoint) && !Array.isArray(body)) throw new Error('INVALID_ARRAY_RESPONSE');
      if (endpoint.endsWith('/account') && !Array.isArray(body?.balances)) throw new Error('INVALID_ACCOUNT_RESPONSE');
      if (endpoint.endsWith('/exchangeInfo') && !Array.isArray(body?.symbols)) throw new Error('INVALID_EXCHANGE_RESPONSE');
      return body;
    } catch (error) {
      if (method !== 'GET' || attempt >= 1 || (error.status && error.status < 500)) throw error;
    }
  }
}
module.exports = { submitOrder, reconcileIntent, journalStore, requestJson };
