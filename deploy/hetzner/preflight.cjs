'use strict';

// Read-only health probe. This program cannot place, cancel, or amend orders.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const BASE = 'https://api.binance.com';
const ALLOWED = new Set(['/api/v3/ping', '/api/v3/time', '/api/v3/exchangeInfo',
  '/api/v3/account', '/api/v3/openOrders', '/sapi/v1/account/apiRestrictions']);

function credential(name) {
  const dir = process.env.CREDENTIALS_DIRECTORY;
  return dir ? fs.readFileSync(path.join(dir, name), 'utf8').trim() : '';
}

async function get(endpoint, params = {}, credentials) {
  if (!ALLOWED.has(endpoint)) throw new Error('ENDPOINT_NOT_ALLOWED');
  const query = new URLSearchParams(params);
  const headers = {};
  if (credentials) {
    query.set('recvWindow', '5000');
    query.set('timestamp', String(Date.now()));
    query.set('signature', crypto.createHmac('sha256', credentials.secret)
      .update(query.toString()).digest('hex'));
    headers['X-MBX-APIKEY'] = credentials.key;
  }
  const response = await fetch(`${BASE}${endpoint}?${query}`, {
    method: 'GET', headers, signal: AbortSignal.timeout(15000)
  });
  // Never print URLs, signatures, response bodies, balances, or credentials.
  if (!response.ok) throw new Error(`BINANCE_HTTP_${response.status}`);
  return response.json();
}

async function main() {
  await get('/api/v3/ping');
  const time = await get('/api/v3/time');
  const skewMs = Math.abs(Date.now() - Number(time.serverTime));
  if (!Number.isFinite(skewMs) || skewMs > 3000) throw new Error('CLOCK_SKEW');
  const info = await get('/api/v3/exchangeInfo', {symbol: 'BTCUSDT'});
  if (info.symbols?.[0]?.isSpotTradingAllowed !== true) throw new Error('SPOT_UNAVAILABLE');
  const key = credential('binance-key');
  const secret = credential('binance-secret');
  if (!key || !secret) {
    console.log(JSON.stringify({mode: 'READ_ONLY', publicConnectivity: true,
      privateConnectivity: 'CREDENTIALS_PENDING', tradingActivated: false}));
    return;
  }
  const credentials = {key, secret};
  const [account, permissions, orders] = await Promise.all([
    get('/api/v3/account', {omitZeroBalances: 'true'}, credentials),
    get('/sapi/v1/account/apiRestrictions', {}, credentials),
    get('/api/v3/openOrders', {}, credentials)
  ]);
  if (permissions.enableWithdrawals !== false) throw new Error('WITHDRAWALS_NOT_DISABLED');
  if (permissions.ipRestrict !== true) throw new Error('API_IP_RESTRICTION_REQUIRED');
  if (!Array.isArray(orders) || !Array.isArray(account.balances)) throw new Error('INVALID_ACCOUNT_RESPONSE');
  const nativeStops = orders.filter(order => order.side === 'SELL' &&
    ['STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT'].includes(order.type));
  console.log(JSON.stringify({mode: 'READ_ONLY', publicConnectivity: true,
    privateConnectivity: true, withdrawalsDisabled: true, ipRestricted: true,
    canTrade: account.canTrade === true, openOrderCount: orders.length,
    nativeConditionalSellCount: nativeStops.length, tradingActivated: false,
    positionProtection: 'RECONCILIATION_REQUIRED'}));
}

if (require.main === module) main().catch(error => {
  const reason = /^[A-Z_]+(?:_\d+)?$/.test(error.message) ? error.message : 'PROBE_FAILED';
  console.error(JSON.stringify({mode: 'READ_ONLY', tradingActivated: false, reason}));
  process.exitCode = 1;
});
module.exports = {get, main};
