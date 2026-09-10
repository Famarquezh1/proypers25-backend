'use strict';

const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const REPOSITORY = process.env.GITHUB_REPOSITORY || '';

const HARD_STOP_PCT = 0.05;
const BREAK_EVEN_TRIGGER_PCT = 0.05;
const BREAK_EVEN_LOCK_PCT = 0.002;
const TRAILING_TRIGGER_PCT = 0.08;
const TRAILING_DISTANCE_PCT = 0.03;
const STALE_TIMEOUT_HOURS = 18;
const STALE_TIMEOUT_MAX_GAIN_PCT = 0.005;
const MAX_MANAGED_AGE_DAYS = 7;
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

function fail(message) {
  console.error(`EXIT_ENGINE_BLOCKED: ${message}`);
  process.exit(2);
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function signed(base, method, path, params = {}) {
  const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  return request(base, `${path}?${query}&signature=${signature}`, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
}

async function chooseBase() {
  for (const base of BASES) {
    try {
      await request(base, '/api/v3/ping');
      await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      return base;
    } catch (_) {}
  }
  fail('Binance private API unreachable from local runner');
}

async function githubJson(path) {
  if (!GH_TOKEN || !REPOSITORY) return null;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28'
    }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.json();
}

async function managedSymbols() {
  const since = Date.now() - MAX_MANAGED_AGE_DAYS * 86400000;
  const issues = await githubJson('/issues?state=closed&per_page=100&sort=updated&direction=desc');
  if (!Array.isArray(issues)) return [];
  return [...new Set(issues
    .filter((issue) => issue.state_reason === 'completed')
    .filter((issue) => new Date(issue.created_at).getTime() >= since)
    .map((issue) => String(issue.title || '').match(/^\[SPOT SIGNAL\] ([A-Z0-9]+USDT)\b/))
    .filter(Boolean)
    .map((match) => match[1]))];
}

function decimalPlaces(step) {
  const text = String(step);
  if (!text.includes('.')) return 0;
  return (text.replace(/0+$/, '').split('.')[1] || '').length;
}

function floorToStep(qty, stepSize) {
  const step = Number(stepSize);
  if (!(step > 0)) return Number(qty);
  return Number((Math.floor((Number(qty) + Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}

function freeBalance(account, asset) {
  return Number((account.balances || []).find((x) => x.asset === asset)?.free || 0);
}

async function getRecentHigh(base, symbol, startTime, entryPrice, currentPrice) {
  const params = new URLSearchParams({ symbol, interval: '5m', startTime: String(startTime), limit: '1000' });
  try {
    const rows = await request(base, `/api/v3/klines?${params}`);
    return Math.max(entryPrice, currentPrice, ...rows.map((r) => Number(r[2] || 0)));
  } catch (_) {
    return Math.max(entryPrice, currentPrice);
  }
}

async function main() {
  if (!API_KEY || !API_SECRET) fail('Binance API secrets missing');
  const base = await chooseBase();
  const [account, restrictions, symbols] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),
    managedSymbols()
  ]);

  if (account.canTrade !== true) fail('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) fail('API withdrawals must remain disabled');

  if (!symbols.length) {
    console.log('EXIT_ENGINE_OK no managed symbols');
    return;
  }

  let openCount = 0;
  let soldCount = 0;

  for (const symbol of symbols) {
    const orders = await signed(base, 'GET', '/api/v3/allOrders', { symbol, limit: '100' });
    const managedBuys = orders
      .filter((o) => o.side === 'BUY' && o.status === 'FILLED' && String(o.clientOrderId || '').startsWith('proypers-gh-'))
      .sort((a, b) => Number(a.updateTime || a.time) - Number(b.updateTime || b.time));
    if (!managedBuys.length) continue;

    const buy = managedBuys[managedBuys.length - 1];
    const buyTime = Number(buy.updateTime || buy.time || 0);
    const laterExit = orders.some((o) => o.side === 'SELL' && o.status === 'FILLED' && String(o.clientOrderId || '').startsWith('proypers-gh-exit-') && Number(o.updateTime || o.time || 0) > buyTime);
    if (laterExit) continue;

    const executedQty = Number(buy.executedQty || 0);
    const quoteQty = Number(buy.cummulativeQuoteQty || 0);
    const entryPrice = executedQty > 0 ? quoteQty / executedQty : 0;
    if (!(entryPrice > 0 && executedQty > 0)) continue;

    const [ticker, exchangeInfo] = await Promise.all([
      request(base, `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),
      request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`)
    ]);
    const currentPrice = Number(ticker.price || 0);
    const info = exchangeInfo.symbols?.[0];
    if (!(currentPrice > 0) || !info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) continue;

    const baseAsset = info.baseAsset;
    const free = freeBalance(account, baseAsset);
    if (!(free > 0)) continue;

    openCount += 1;
    const ageHours = (Date.now() - buyTime) / 3600000;
    const gainPct = currentPrice / entryPrice - 1;
    const recentHigh = await getRecentHigh(base, symbol, buyTime, entryPrice, currentPrice);

    let effectiveStop = entryPrice * (1 - HARD_STOP_PCT);
    let protection = 'HARD_STOP';
    if (recentHigh / entryPrice - 1 >= BREAK_EVEN_TRIGGER_PCT) {
      effectiveStop = Math.max(effectiveStop, entryPrice * (1 + BREAK_EVEN_LOCK_PCT));
      protection = 'BREAK_EVEN';
    }
    if (recentHigh / entryPrice - 1 >= TRAILING_TRIGGER_PCT) {
      effectiveStop = Math.max(effectiveStop, recentHigh * (1 - TRAILING_DISTANCE_PCT));
      protection = 'TRAILING';
    }

    let reason = null;
    if (currentPrice <= effectiveStop) reason = protection === 'TRAILING' ? 'TRAILING_STOP' : protection === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';
    else if (ageHours >= STALE_TIMEOUT_HOURS && gainPct <= STALE_TIMEOUT_MAX_GAIN_PCT) reason = 'TIMEOUT_STALE';

    console.log(`MONITOR symbol=${symbol} entry=${entryPrice} current=${currentPrice} gain_pct=${(gainPct * 100).toFixed(3)} high=${recentHigh} stop=${effectiveStop} protection=${protection} age_h=${ageHours.toFixed(2)} action=${reason || 'HOLD'}`);
    if (!reason) continue;

    const lot = info.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE' && Number(f.stepSize) > 0) || info.filters?.find((f) => f.filterType === 'LOT_SIZE');
    if (!lot) throw new Error(`LOT_SIZE missing for ${symbol}`);
    const quantity = floorToStep(Math.min(executedQty, free), lot.stepSize);
    if (!(quantity >= Number(lot.minQty || 0))) {
      console.log(`EXIT_SKIPPED symbol=${symbol} reason=QUANTITY_BELOW_MINIMUM qty=${quantity}`);
      continue;
    }

    const notional = quantity * currentPrice;
    const notionalFilter = info.filters?.find((f) => f.filterType === 'NOTIONAL') || info.filters?.find((f) => f.filterType === 'MIN_NOTIONAL');
    const minNotional = Number(notionalFilter?.minNotional || 0);
    if (minNotional > 0 && notional < minNotional) {
      console.log(`EXIT_SKIPPED symbol=${symbol} reason=NOTIONAL_BELOW_MINIMUM notional=${notional}`);
      continue;
    }

    const order = await signed(base, 'POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: String(quantity),
      newOrderRespType: 'FULL',
      newClientOrderId: `proypers-gh-exit-${Date.now()}`
    });
    if (!order?.orderId) throw new Error(`SELL returned no orderId for ${symbol}`);
    soldCount += 1;
    console.log(`SELL_CREATED symbol=${symbol} reason=${reason} orderId=${order.orderId} status=${order.status} quantity=${quantity} entry=${entryPrice} exit=${currentPrice} pnl_pct=${(gainPct * 100).toFixed(3)}`);
  }

  console.log(`EXIT_ENGINE_OK managed_symbols=${symbols.length} open_positions=${openCount} sells=${soldCount}`);
}

main().catch((error) => fail(error.message || String(error)));
