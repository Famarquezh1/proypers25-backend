'use strict';
// Bounded account inspection. Uses the existing GET-only VPS transport.
const fs = require('node:fs');
const crypto = require('node:crypto');
const path = require('node:path');
const root = '/var/lib/proypers25';
const transport = require('/opt/proypers25/runtime/readonly.cjs').makeFetch();
const key = fs.readFileSync('/etc/proypers25/binance-key', 'utf8').trim();
const secret = fs.readFileSync('/etc/proypers25/binance-secret', 'utf8').trim();
const allowed = new Set(['/api/v3/account', '/api/v3/openOrders', '/api/v3/allOrders', '/api/v3/myTrades', '/api/v3/ticker/price', '/api/v3/exchangeInfo']);
let requests = 0;
async function get(endpoint, params = {}, signed = true) {
  if (!allowed.has(endpoint) || ++requests > 240) throw Error('ACCOUNT_READ_BUDGET');
  const query = new URLSearchParams(params);
  if (signed) {
    query.set('recvWindow', '5000');
    query.set('timestamp', String(Date.now()));
    query.set('signature', crypto.createHmac('sha256', secret).update(query.toString()).digest('hex'));
  }
  const response = await transport('https://api.binance.com' + endpoint + '?' + query, {
    method: 'GET', headers: signed ? {'X-MBX-APIKEY': key} : {}
  });
  if (!response.ok) throw Error('ACCOUNT_HTTP_' + response.status);
  return response.json();
}
async function history(endpoint, symbol, cursorName, idName) {
  let cursor = '0';
  const rows = [];
  for (let page = 0; page < 3; page++) {
    const batch = await get(endpoint, {symbol, [cursorName]: cursor, limit: '1000'});
    if (!Array.isArray(batch)) throw Error('ACCOUNT_HISTORY_SCHEMA');
    rows.push(...batch);
    if (batch.length < 1000) return {complete: true, rows};
    const next = (BigInt(batch[batch.length - 1][idName]) + 1n).toString();
    if (BigInt(next) <= BigInt(cursor)) throw Error('ACCOUNT_HISTORY_CURSOR');
    cursor = next;
  }
  return {complete: false, rows};
}
function balances(account) {
  return account.balances.filter(b => Number(b.free) + Number(b.locked) > 0)
    .map(b => ({asset: b.asset, free: b.free, locked: b.locked})).sort((a, b) => a.asset.localeCompare(b.asset));
}
async function main() {
  const symbols = new Set();
  const stateCounts = {};
  for (const group of ['execution-state', 'exit-state', 'transition-state']) {
    const dir = path.join(root, group);
    stateCounts[group] = {};
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).filter(n => /^[a-f0-9]{32}\.json$/.test(n))) {
      const row = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      stateCounts[group][row.state] = (stateCounts[group][row.state] || 0) + 1;
      if (group === 'execution-state' && Number(row.buy?.executedQty) > 0 &&
          /^[A-Z0-9]{2,24}USDT$/.test(row.symbol || '')) symbols.add(row.symbol);
    }
  }
  const before = await get('/api/v3/account', {omitZeroBalances: 'true'});
  const openOrders = await get('/api/v3/openOrders');
  if (!Array.isArray(openOrders)) throw Error('ACCOUNT_OPEN_ORDER_SCHEMA');
  for (const order of openOrders) if (/^[A-Z0-9]{2,24}USDT$/.test(order.symbol)) symbols.add(order.symbol);
  const held = balances(before);
  for (const balance of held) if (balance.asset !== 'USDT') symbols.add(balance.asset + 'USDT');
  console.log('ACCOUNT_SCOPE', JSON.stringify({symbols: [...symbols].sort(), stateCounts, balances: held,
    openOrderCount: openOrders.length}));
  if (symbols.size > 100) throw Error('ACCOUNT_SYMBOL_SCOPE');
  const tickerRows = await get('/api/v3/ticker/price', {}, false);
  if (!Array.isArray(tickerRows)) throw Error('ACCOUNT_TICKER_SCHEMA');
  const prices = new Map(tickerRows.map(row => [row.symbol, row.price]));
  const results = [];
  for (const symbol of [...symbols].sort()) {
    const orders = await history('/api/v3/allOrders', symbol, 'orderId', 'orderId');
    const trades = await history('/api/v3/myTrades', symbol, 'fromId', 'id');
    results.push({symbol, price: prices.get(symbol) || null, ordersComplete: orders.complete,
      tradesComplete: trades.complete,
      orders: orders.rows.map(o => ({orderId: o.orderId, clientOrderId: o.clientOrderId, side: o.side,
        type: o.type, status: o.status, executedQty: o.executedQty, cummulativeQuoteQty: o.cummulativeQuoteQty,
        origQty: o.origQty, price: o.price, stopPrice: o.stopPrice, time: o.time, updateTime: o.updateTime})),
      trades: trades.rows.map(t => ({id: t.id, orderId: t.orderId, time: t.time, isBuyer: t.isBuyer,
        qty: t.qty, quoteQty: t.quoteQty, price: t.price, commission: t.commission, commissionAsset: t.commissionAsset}))});
  }
  const after = await get('/api/v3/account', {omitZeroBalances: 'true'});
  const authorization = JSON.parse(fs.readFileSync('/etc/proypers25/LIVE_AUTHORIZATION.json', 'utf8'));
  console.log('ACCOUNT_REVIEW', JSON.stringify({at: new Date().toISOString(), authorizedAt: authorization.authorizedAt,
    scope: 'VPS executed-buy, currently held and open USDT symbols; up to 3000 orders and fills per symbol; retained API history',
    transfersReviewed: false, vpsCostsIncluded: false, stateCounts, balancesBefore: held, balancesAfter: balances(after),
    balanceSnapshotStable: JSON.stringify(held) === JSON.stringify(balances(after)),
    openOrders: openOrders.map(o => ({symbol: o.symbol, orderId: o.orderId, clientOrderId: o.clientOrderId,
      side: o.side, type: o.type, status: o.status, origQty: o.origQty, executedQty: o.executedQty,
      price: o.price, stopPrice: o.stopPrice, time: o.time})), results, requests, realOrdersSent: 0}));
}
main().catch(error => {
  console.error(/^[A-Z_0-9]+$/.test(error.message) ? error.message : 'ACCOUNT_READ_FAILED');
  process.exitCode = 1;
});
