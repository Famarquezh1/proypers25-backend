'use strict';

const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];
const STABLE_USDT_EQUIVALENTS = new Set(['USDT']);
const XEC_EXCLUDED = true;

async function request(base, path) {
  const response = await fetch(`${base}${path}`, { method: 'GET' });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
  return body;
}

async function signedGet(base, path, params = {}) {
  const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  const response = await fetch(`${base}${path}?${query}&signature=${signature}`, {
    method: 'GET',
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
  return body;
}

async function chooseBase() {
  for (const base of BASES) {
    try {
      await request(base, '/api/v3/ping');
      await signedGet(base, '/api/v3/account', { omitZeroBalances: 'true' });
      return base;
    } catch (_) {}
  }
  throw new Error('Binance private API unreachable');
}

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function remainingQty(order) {
  return Math.max(0, n(order.origQty) - n(order.executedQty));
}

function classifyOrder(order) {
  const id = String(order.clientOrderId || '');
  let origin = 'MANUAL_OR_UNKNOWN';
  let family = 'UNKNOWN';
  let confidence = 'NONE';
  let autoExitManaged = false;

  if (id.startsWith('proypers-gh-protect-v61-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'V61_PROTECT';
    confidence = 'STRONG';
    autoExitManaged = true;
  } else if (id.startsWith('proypers-gh-protect-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'CORE_PROTECT';
    confidence = 'STRONG';
    autoExitManaged = true;
  } else if (id.startsWith('proypers-gh-orphan-exit-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'ORPHAN_EXIT';
    confidence = 'STRONG';
    autoExitManaged = true;
  } else if (id.startsWith('proypers-gh-orphan-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'ORPHAN_PROTECT';
    confidence = 'STRONG';
    autoExitManaged = true;
  } else if (id.startsWith('proypers-gh-exit-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'CORE_EXIT';
    confidence = 'STRONG';
    autoExitManaged = true;
  } else if (id.startsWith('proypers-gh-v10-')) {
    origin = 'PROYPERS_CURRENT';
    family = 'V10_ENTRY';
    confidence = 'STRONG';
  } else if (id.startsWith('proypers-gh-')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'LEGACY_GH';
    confidence = 'STRONG';
  } else if (id.startsWith('px25b_')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'CONTROLLED_BUY';
    confidence = 'STRONG';
  } else if (id.startsWith('px25x_')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'CONTROLLED_EXIT';
    confidence = 'STRONG';
  } else if (id.startsWith('px25lr_')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'LEGACY_RECOVERY';
    confidence = 'STRONG';
  } else if (id.startsWith('px25xec_')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'XEC_HOLDING';
    confidence = 'STRONG';
  } else if (id.startsWith('px25ghxec_')) {
    origin = 'PROYPERS_HERITAGE';
    family = 'XEC_LOCAL';
    confidence = 'STRONG';
  }

  const type = String(order.type || '').toUpperCase();
  const side = String(order.side || '').toUpperCase();
  const protectiveSell = side === 'SELL' && [
    'STOP_LOSS', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT', 'TAKE_PROFIT_LIMIT',
    'STOP', 'STOP_LIMIT', 'TRAILING_STOP_MARKET'
  ].includes(type);

  return {
    origin,
    family,
    confidence,
    auto_exit_managed: autoExitManaged,
    protective_sell: protectiveSell,
    manual_or_unknown: origin === 'MANUAL_OR_UNKNOWN'
  };
}

function inferLockedAsset(order, symbolInfo) {
  if (!symbolInfo) return null;
  const side = String(order.side || '').toUpperCase();
  if (side === 'SELL') return symbolInfo.baseAsset || null;
  if (side === 'BUY') return symbolInfo.quoteAsset || null;
  return null;
}

function estimateLockedAmount(order, symbolInfo) {
  if (!symbolInfo) return null;
  const remaining = remainingQty(order);
  const side = String(order.side || '').toUpperCase();
  if (side === 'SELL') return remaining;
  if (side === 'BUY') {
    const price = n(order.price) || n(order.stopPrice);
    return price > 0 ? remaining * price : null;
  }
  return null;
}

function approxUsdtPrice(asset, priceMap) {
  if (STABLE_USDT_EQUIVALENTS.has(asset)) return 1;
  return n(priceMap.get(`${asset}USDT`), 0) || null;
}

function iso(ms) {
  return ms > 0 ? new Date(ms).toISOString() : null;
}

async function main() {
  if (!API_KEY || !API_SECRET) throw new Error('Binance API secrets missing');

  const base = await chooseBase();
  const [account, restrictions, prices, exchangeInfo, allOpenOrders] = await Promise.all([
    signedGet(base, '/api/v3/account', { omitZeroBalances: 'true' }),
    signedGet(base, '/sapi/v1/account/apiRestrictions'),
    request(base, '/api/v3/ticker/price'),
    request(base, '/api/v3/exchangeInfo'),
    signedGet(base, '/api/v3/openOrders')
  ]);

  const priceMap = new Map((Array.isArray(prices) ? prices : []).map(row => [String(row.symbol), n(row.price)]));
  const symbolMap = new Map((exchangeInfo.symbols || []).map(row => [String(row.symbol), row]));
  const lockOrdersByAsset = new Map();

  for (const order of Array.isArray(allOpenOrders) ? allOpenOrders : []) {
    const info = symbolMap.get(String(order.symbol || ''));
    const lockedAsset = inferLockedAsset(order, info);
    if (!lockedAsset) continue;
    const list = lockOrdersByAsset.get(lockedAsset) || [];
    list.push({ order, info });
    lockOrdersByAsset.set(lockedAsset, list);
  }

  const now = Date.now();
  const rows = [];

  for (const balance of account.balances || []) {
    const asset = String(balance.asset || '');
    const free = n(balance.free);
    const locked = n(balance.locked);
    if (!(free > 0 || locked > 0)) continue;

    const priceUsdt = approxUsdtPrice(asset, priceMap);
    const valueUsdt = priceUsdt === null ? null : (free + locked) * priceUsdt;
    const lockOrders = lockOrdersByAsset.get(asset) || [];

    const orders = lockOrders.map(({ order, info }) => {
      const cls = classifyOrder(order);
      const time = n(order.time || order.transactTime || order.updateTime);
      return {
        symbol: String(order.symbol || ''),
        orderId: order.orderId ?? null,
        clientOrderId: String(order.clientOrderId || ''),
        type: String(order.type || ''),
        side: String(order.side || ''),
        status: String(order.status || ''),
        price: n(order.price),
        stopPrice: n(order.stopPrice),
        origQty: n(order.origQty),
        executedQty: n(order.executedQty),
        remainingQty: remainingQty(order),
        time,
        time_iso: iso(time),
        age_hours: time > 0 ? (now - time) / 3600000 : null,
        baseAsset: info?.baseAsset || null,
        quoteAsset: info?.quoteAsset || null,
        estimated_locked_asset: asset,
        estimated_locked_amount: estimateLockedAmount(order, info),
        ...cls
      };
    });

    const origins = [...new Set(orders.map(o => o.origin))];
    const families = [...new Set(orders.map(o => o.family))];
    const knownProypers = orders.filter(o => o.origin !== 'MANUAL_OR_UNKNOWN');
    const currentManaged = orders.filter(o => o.auto_exit_managed);
    const unknown = orders.filter(o => o.manual_or_unknown);
    const estimatedLocked = orders.reduce((sum, o) => sum + (Number.isFinite(o.estimated_locked_amount) ? o.estimated_locked_amount : 0), 0);

    let status = 'FREE_ONLY';
    if (locked > 0 && orders.length === 0) status = 'LOCKED_NO_MATCHING_OPEN_ORDER';
    else if (locked > 0 && unknown.length > 0 && knownProypers.length > 0) status = 'LOCKED_MIXED_PROYPERS_AND_UNKNOWN';
    else if (locked > 0 && unknown.length > 0) status = 'LOCKED_MANUAL_OR_UNKNOWN';
    else if (locked > 0 && currentManaged.length === orders.length && orders.length > 0) status = 'LOCKED_CURRENT_AUTO_EXIT_MANAGED';
    else if (locked > 0 && knownProypers.length === orders.length && orders.length > 0) status = 'LOCKED_PROYPERS_HERITAGE';
    else if (locked > 0) status = 'LOCKED_UNCLASSIFIED';
    else if (valueUsdt !== null && valueUsdt < 10) status = 'DUST_FREE';

    rows.push({
      asset,
      symbol_hint: `${asset}USDT`,
      free,
      locked,
      total: free + locked,
      price_usdt: priceUsdt,
      value_usdt: valueUsdt,
      status,
      excluded_from_orphan_adoption: asset === 'XEC' && XEC_EXCLUDED,
      order_origin_set: origins,
      order_family_set: families,
      open_order_count: orders.length,
      estimated_locked_from_orders: estimatedLocked,
      locked_reconciliation_delta: locked - estimatedLocked,
      open_orders: orders
    });
  }

  rows.sort((a, b) => {
    if ((b.locked > 0) !== (a.locked > 0)) return b.locked > 0 ? 1 : -1;
    return (b.value_usdt || 0) - (a.value_usdt || 0);
  });

  console.log('SPOT_BALANCE_AUDIT_BEGIN');
  console.log('SPOT_BALANCE_AUDIT_SAFETY ' + JSON.stringify({
    read_only: true,
    private_methods_used: ['GET'],
    canTrade: account.canTrade === true,
    withdrawals_enabled: restrictions.enableWithdrawals === true,
    xec_excluded_from_adoption: XEC_EXCLUDED,
    open_orders_total: Array.isArray(allOpenOrders) ? allOpenOrders.length : 0
  }));

  for (const row of rows) {
    console.log('SPOT_BALANCE ' + JSON.stringify(row));
  }

  console.log('SPOT_BALANCE_AUDIT_SUMMARY ' + JSON.stringify({
    balances: rows.length,
    locked_assets: rows.filter(row => row.locked > 0).length,
    locked_current_managed: rows.filter(row => row.status === 'LOCKED_CURRENT_AUTO_EXIT_MANAGED').length,
    locked_proypers_heritage: rows.filter(row => row.status === 'LOCKED_PROYPERS_HERITAGE').length,
    locked_manual_or_unknown: rows.filter(row => row.status === 'LOCKED_MANUAL_OR_UNKNOWN').length,
    locked_mixed: rows.filter(row => row.status === 'LOCKED_MIXED_PROYPERS_AND_UNKNOWN').length,
    locked_no_matching_order: rows.filter(row => row.status === 'LOCKED_NO_MATCHING_OPEN_ORDER').length,
    known_value_usdt: rows.reduce((sum, row) => sum + (Number.isFinite(row.value_usdt) ? row.value_usdt : 0), 0)
  }));
  console.log('SPOT_BALANCE_AUDIT_END');
}

main().catch(error => {
  console.error('SPOT_BALANCE_AUDIT_FAILED ' + (error.stack || error.message || String(error)));
  process.exit(1);
});
