'use strict';

const crypto = require('crypto');
const {
  DEFAULTS,
  reconstructInventory,
  historyCoversBalance,
  decideProfitProtection
} = require('../services/spotOrphanProtection');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const EXCLUDED_ASSETS = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'XEC']);
const ORPHAN_PREFIX = 'proypers-gh-orphan-';
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
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
  throw new Error('Binance private API unreachable from local runner');
}

function balanceRow(account, asset) {
  return (account.balances || []).find((row) => row.asset === asset) || {};
}

function totalBalance(account, asset) {
  const row = balanceRow(account, asset);
  return Number(row.free || 0) + Number(row.locked || 0);
}

async function recentHigh24h(base, symbol, currentPrice) {
  try {
    const rows = await request(base, `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`);
    if (!Array.isArray(rows) || !rows.length) return currentPrice;
    return Math.max(currentPrice, ...rows.map((row) => Number(row[2] || 0)));
  } catch (_) {
    return currentPrice;
  }
}

function note(counts, reason) {
  counts[reason] = (counts[reason] || 0) + 1;
}

async function main() {
  if (!API_KEY || !API_SECRET) throw new Error('Binance API secrets missing');
  const base = await chooseBase();
  const [account, prices] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    request(base, '/api/v3/ticker/price')
  ]);
  if (account.canTrade !== true) throw new Error('Binance account cannot trade');

  const priceMap = new Map((Array.isArray(prices) ? prices : []).map((row) => [row.symbol, Number(row.price || 0)]));
  const candidates = (account.balances || [])
    .map((row) => ({ asset: row.asset, free: Number(row.free || 0), locked: Number(row.locked || 0) }))
    .filter((row) => !EXCLUDED_ASSETS.has(row.asset) && row.free + row.locked > 0)
    .map((row) => ({ ...row, symbol: `${row.asset}USDT`, currentPrice: priceMap.get(`${row.asset}USDT`) || 0 }))
    .filter((row) => row.currentPrice > 0 && (row.free + row.locked) * row.currentPrice >= DEFAULTS.minNotionalUsdt);

  const counts = {};

  for (const candidate of candidates) {
    const { asset, symbol, currentPrice } = candidate;
    try {
      const [exchangeInfo, trades, openOrders] = await Promise.all([
        request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`),
        signed(base, 'GET', '/api/v3/myTrades', { symbol, limit: '1000' }),
        signed(base, 'GET', '/api/v3/openOrders', { symbol })
      ]);
      const info = exchangeInfo.symbols?.[0];
      if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) {
        note(counts, 'NOT_SPOT_TRADING');
        console.log(`ORPHAN_AUDIT symbol=${symbol} status=SKIP reason=NOT_SPOT_TRADING`);
        continue;
      }

      const owned = totalBalance(account, asset);
      const reconstructed = reconstructInventory(trades, asset, 'USDT');
      if (!(reconstructed.entryPrice > 0) || !historyCoversBalance(reconstructed.quantity, owned)) {
        note(counts, 'HISTORY_GAP');
        console.log(`ORPHAN_AUDIT symbol=${symbol} status=SKIP reason=HISTORY_GAP owned=${owned} reconstructed=${reconstructed.quantity}`);
        continue;
      }

      const orphanStop = (openOrders || [])
        .filter((order) => order.side === 'SELL' && ['NEW', 'PARTIALLY_FILLED'].includes(order.status))
        .filter((order) => String(order.clientOrderId || '').startsWith(ORPHAN_PREFIX))
        .sort((a, b) => Number(b.time || 0) - Number(a.time || 0))[0];
      const orphanLocked = orphanStop ? Math.max(0, Number(orphanStop.origQty || 0) - Number(orphanStop.executedQty || 0)) : 0;
      const refreshed = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      const free = Number(balanceRow(refreshed, asset).free || 0);
      const orphanQty = free + orphanLocked;
      if (!(orphanQty * currentPrice >= DEFAULTS.minNotionalUsdt)) {
        note(counts, 'NO_SIGNIFICANT_RESIDUE');
        console.log(`ORPHAN_AUDIT symbol=${symbol} status=SKIP reason=NO_SIGNIFICANT_RESIDUE free=${free} orphan_locked=${orphanLocked} total_locked=${Number(balanceRow(refreshed, asset).locked || 0)}`);
        continue;
      }

      const priceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');
      if (!priceFilter) {
        note(counts, 'PRICE_FILTER_MISSING');
        console.log(`ORPHAN_AUDIT symbol=${symbol} status=SKIP reason=PRICE_FILTER_MISSING`);
        continue;
      }

      const high = await recentHigh24h(base, symbol, currentPrice);
      const decision = decideProfitProtection({
        entryPrice: reconstructed.entryPrice,
        currentPrice,
        recentHigh: high,
        tickSize: Number(priceFilter.tickSize || 0)
      });
      const existingStop = Number(orphanStop?.stopPrice || 0);
      const tickSize = Number(priceFilter.tickSize || 0);
      const shouldUpgrade = Boolean(orphanStop && decision.stopPrice > existingStop + Math.max(tickSize * 0.5, Number.EPSILON));

      let status = decision.action;
      let reason = decision.protection || decision.reason || 'NONE';
      if (decision.action === 'PROTECT' && orphanStop && !shouldUpgrade) {
        status = 'ALREADY_PROTECTED';
        reason = 'ORPHAN_NATIVE_STOP_CURRENT';
      } else if (decision.action === 'PROTECT' && orphanStop && shouldUpgrade) {
        status = 'NEEDS_UPGRADE';
      } else if (decision.action === 'PROTECT' && !orphanStop) {
        status = 'NEEDS_ADOPTION';
      }

      note(counts, status);
      console.log(`ORPHAN_AUDIT symbol=${symbol} status=${status} reason=${reason} owned=${owned} orphan_qty=${orphanQty} entry=${reconstructed.entryPrice} current=${currentPrice} high24h=${high} stop=${decision.stopPrice || 0} existing_stop=${existingStop}`);
    } catch (error) {
      note(counts, 'ERROR');
      const message = String(error.message || error).replace(/\s+/g, '_').slice(0, 240);
      console.log(`ORPHAN_AUDIT symbol=${symbol} status=ERROR reason=${message}`);
    }
  }

  console.log(`ORPHAN_AUDIT_OK candidates=${candidates.length} decisions=${JSON.stringify(counts)} xec_excluded=true read_only=true`);
}

main().catch((error) => {
  console.error(`ORPHAN_AUDIT_FAILED ${error.message || error}`);
  process.exit(1);
});
