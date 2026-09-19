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
  throw new Error('Binance private API unreachable');
}

function classifyOrder(order) {
  const id = String(order.clientOrderId || '');
  if (id.startsWith('proypers-gh-protect-v61-')) return 'V61_PROTECT';
  if (id.startsWith('proypers-gh-protect-')) return 'MANAGED_PROTECT';
  if (id.startsWith('proypers-gh-orphan-')) return 'ORPHAN_PROTECT';
  if (id.startsWith('proypers-gh-exit-')) return 'MANAGED_EXIT';
  if (id.startsWith('proypers-gh-v10-')) return 'V10';
  return 'OTHER';
}

async function main() {
  if (!API_KEY || !API_SECRET) throw new Error('Binance API secrets missing');
  const base = await chooseBase();
  const [account, prices, allOpenOrders] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    request(base, '/api/v3/ticker/price'),
    signed(base, 'GET', '/api/v3/openOrders')
  ]);

  const priceMap = new Map((Array.isArray(prices) ? prices : []).map(x => [String(x.symbol), Number(x.price || 0)]));
  const openBySymbol = new Map();
  for (const order of Array.isArray(allOpenOrders) ? allOpenOrders : []) {
    const list = openBySymbol.get(order.symbol) || [];
    list.push(order);
    openBySymbol.set(order.symbol, list);
  }

  const rows = [];
  for (const b of account.balances || []) {
    const free = Number(b.free || 0);
    const locked = Number(b.locked || 0);
    if (!(free > 0 || locked > 0)) continue;
    const symbol = `${b.asset}USDT`;
    const price = priceMap.get(symbol) || (b.asset === 'USDT' ? 1 : 0);
    const value = price > 0 ? (free + locked) * price : null;
    const orders = openBySymbol.get(symbol) || [];
    const classes = [...new Set(orders.map(classifyOrder))];
    let status = 'FREE_ONLY';
    if (locked > 0 && orders.length === 0) status = 'LOCKED_NO_USDT_OPEN_ORDER';
    else if (locked > 0 && classes.some(x => ['V61_PROTECT','MANAGED_PROTECT'].includes(x))) status = 'MANAGED_LOCKED';
    else if (locked > 0 && classes.includes('ORPHAN_PROTECT')) status = 'ORPHAN_LOCKED';
    else if (locked > 0 && orders.length) status = 'OTHER_LOCKED';
    else if (free > 0 && value !== null && value < 10) status = 'DUST_FREE';

    rows.push({
      asset: b.asset,
      symbol,
      free,
      locked,
      total: free + locked,
      price_usdt: price || null,
      value_usdt: value,
      status,
      open_orders: orders.map(o => ({
        orderId: o.orderId,
        side: o.side,
        type: o.type,
        status: o.status,
        price: Number(o.price || 0),
        stopPrice: Number(o.stopPrice || 0),
        origQty: Number(o.origQty || 0),
        executedQty: Number(o.executedQty || 0),
        clientOrderId: String(o.clientOrderId || ''),
        class: classifyOrder(o)
      }))
    });
  }

  rows.sort((a,b) => (b.value_usdt || 0) - (a.value_usdt || 0));
  console.log('SPOT_BALANCE_AUDIT_BEGIN');
  for (const row of rows) {
    console.log('SPOT_BALANCE ' + JSON.stringify(row));
  }
  console.log('SPOT_BALANCE_AUDIT_SUMMARY ' + JSON.stringify({
    balances: rows.length,
    total_known_usdt: rows.reduce((s,x)=>s+(Number.isFinite(x.value_usdt)?x.value_usdt:0),0),
    managed_locked: rows.filter(x=>x.status==='MANAGED_LOCKED').length,
    orphan_locked: rows.filter(x=>x.status==='ORPHAN_LOCKED').length,
    other_locked: rows.filter(x=>x.status==='OTHER_LOCKED'||x.status==='LOCKED_NO_USDT_OPEN_ORDER').length,
    free_only: rows.filter(x=>x.status==='FREE_ONLY'||x.status==='DUST_FREE').length
  }));
  console.log('SPOT_BALANCE_AUDIT_END');
}

main().catch(err => {
  console.error('SPOT_BALANCE_AUDIT_FAILED ' + (err.stack || err.message || String(err)));
  process.exit(1);
});
