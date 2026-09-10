'use strict';

const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const SYMBOL = String(process.env.SIGNAL_SYMBOL || '').toUpperCase();
const SIGNAL_PRICE = Number(process.env.SIGNAL_PRICE || 0);
const SIGNAL_PCT = Number(process.env.SIGNAL_PCT || 0);
const SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';

const MIN_USDT = 10;
const MAX_USDT = 100;
const POSITION_FRACTION = 0.15;
const MAX_SIGNAL_AGE_MS = 15 * 60 * 1000;
const MAX_PRICE_ADVANCE_FROM_SIGNAL = 0.03;
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

function fail(message) {
  console.error(`BLOCKED: ${message}`);
  process.exit(2);
}

function validateInputs() {
  if (!API_KEY || !API_SECRET) fail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');
  if (!/^[A-Z0-9]{3,20}USDT$/.test(SYMBOL)) fail('Invalid or missing signal symbol');
  if (!(SIGNAL_PRICE > 0)) fail('Invalid signal price');
  if (!(SIGNAL_PCT >= 1 && SIGNAL_PCT < 18)) fail('Signal is outside Early Momentum band');
  const created = Date.parse(SIGNAL_CREATED_AT);
  if (!Number.isFinite(created)) fail('Signal timestamp missing or invalid');
  if (Date.now() - created > MAX_SIGNAL_AGE_MS) fail('Signal is stale (>15 minutes)');
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
    error.status = response.status;
    error.body = body;
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
  const failures = [];
  for (const base of BASES) {
    try {
      await request(base, '/api/v3/ping');
      await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      return base;
    } catch (error) {
      failures.push(`${base}=${error.status || error.message}`);
    }
  }
  fail(`Binance private API unreachable from this GitHub runner (${failures.join(', ')})`);
}

function freeBalance(account, asset) {
  const row = (account.balances || []).find((x) => x.asset === asset);
  return Number(row?.free || 0);
}

async function main() {
  validateInputs();
  const base = await chooseBase();

  const [ticker, account, restrictions] = await Promise.all([
    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    signed(base, 'GET', '/sapi/v1/account/apiRestrictions')
  ]);

  if (account.canTrade !== true) fail('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) fail('API withdrawals are not locked; execution refused');

  const currentPct = Number(ticker.priceChangePercent || 0);
  const currentPrice = Number(ticker.lastPrice || 0);
  const quoteVolume = Number(ticker.quoteVolume || 0);
  if (!(currentPct >= 1 && currentPct < 18)) fail(`Opportunity no longer in Early Momentum band (${currentPct}%)`);
  if (!(quoteVolume >= 200000)) fail(`Liquidity dropped below minimum (${quoteVolume} USDT)`);
  if (!(currentPrice > 0)) fail('Current price unavailable');

  const advance = (currentPrice - SIGNAL_PRICE) / SIGNAL_PRICE;
  if (advance > MAX_PRICE_ADVANCE_FROM_SIGNAL) fail(`Price advanced ${(advance * 100).toFixed(2)}% after alert; anti-chase blocked`);

  const usdtFree = freeBalance(account, 'USDT');
  const quoteOrderQty = Math.min(MAX_USDT, Math.floor(usdtFree * POSITION_FRACTION * 100) / 100);
  if (quoteOrderQty < MIN_USDT) fail(`Insufficient free USDT for minimum acquisition (${usdtFree} USDT free)`);

  const baseAsset = SYMBOL.slice(0, -4);
  const existingAssetQty = freeBalance(account, baseAsset);
  if (existingAssetQty > 0 && existingAssetQty * currentPrice >= MIN_USDT) {
    fail(`${baseAsset} already has >= ${MIN_USDT} USDT equivalent balance; duplicate acquisition blocked`);
  }

  console.log(`APPROVED symbol=${SYMBOL} signal_pct=${SIGNAL_PCT} current_pct=${currentPct} signal_price=${SIGNAL_PRICE} current_price=${currentPrice} usdt_free=${usdtFree} quote_order_qty=${quoteOrderQty}`);

  const order = await signed(base, 'POST', '/api/v3/order', {
    symbol: SYMBOL,
    side: 'BUY',
    type: 'MARKET',
    quoteOrderQty: quoteOrderQty.toFixed(2),
    newOrderRespType: 'FULL',
    newClientOrderId: `proypers-gh-${Date.now()}`
  });

  if (!order?.orderId) fail('Binance returned no orderId');
  console.log(`ORDER_CREATED symbol=${SYMBOL} orderId=${order.orderId} status=${order.status} quoteOrderQty=${quoteOrderQty}`);
}

main().catch((error) => fail(error.message || String(error)));
