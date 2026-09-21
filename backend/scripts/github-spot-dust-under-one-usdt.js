'use strict';

const crypto = require('crypto');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const MAX_VALUE_USDT = 1;
const HARD_EXCLUDED = new Set(['USDT','XEC']);
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isProypersId(value='') {
  const id = String(value || '');
  return id.startsWith('proypers-gh-') ||
    id.startsWith('px25b_') ||
    id.startsWith('px25x_') ||
    id.startsWith('px25lr_') ||
    id.startsWith('px25xec_') ||
    id.startsWith('px25ghxec_') ||
    id.startsWith('px25dust_');
}

async function request(base, method, path, params = {}, signed = false) {
  let url = `${base}${path}`;
  const headers = {};
  if (signed) {
    const query = new URLSearchParams({ ...params, recvWindow:'5000', timestamp:String(Date.now()) }).toString();
    const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
    url += `?${query}&signature=${signature}`;
    headers['X-MBX-APIKEY'] = API_KEY;
  } else if (Object.keys(params).length) {
    url += `?${new URLSearchParams(params)}`;
  }
  const response = await fetch(url, { method, headers });
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw:text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
  return body;
}

async function chooseBase() {
  for (const base of BASES) {
    try {
      await request(base,'GET','/api/v3/ping');
      await request(base,'GET','/api/v3/account',{omitZeroBalances:'true'},true);
      return base;
    } catch (_) {}
  }
  throw new Error('Binance private API unreachable');
}

function assetValueUsdt(asset, qty, priceMap) {
  if (asset === 'USDT') return qty;
  const direct = n(priceMap.get(`${asset}USDT`));
  if (direct > 0) return qty * direct;
  const btc = n(priceMap.get(`${asset}BTC`));
  const btcUsdt = n(priceMap.get('BTCUSDT'));
  return btc > 0 && btcUsdt > 0 ? qty * btc * btcUsdt : null;
}

async function main() {
  if (!API_KEY || !API_SECRET) throw new Error('Binance API secrets missing');
  const base = await chooseBase();

  const [account, restrictions, prices, exchangeInfo, openOrders, convertible] = await Promise.all([
    request(base,'GET','/api/v3/account',{omitZeroBalances:'true'},true),
    request(base,'GET','/sapi/v1/account/apiRestrictions',{},true),
    request(base,'GET','/api/v3/ticker/price'),
    request(base,'GET','/api/v3/exchangeInfo'),
    request(base,'GET','/api/v3/openOrders',{},true),
    request(base,'POST','/sapi/v1/asset/dust-convert/query-convertible-assets',{targetAsset:'USDT'},true)
  ]);

  if (account.canTrade !== true) throw new Error('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) throw new Error('API withdrawals must remain disabled');

  const pricesMap = new Map((prices || []).map(row=>[String(row.symbol||''),n(row.price)]));
  const symbols = new Set((exchangeInfo.symbols || []).map(row=>String(row.symbol||'')));
  const openAssets = new Set();
  for (const order of openOrders || []) {
    const symbol = String(order.symbol || '');
    const info = (exchangeInfo.symbols || []).find(row=>row.symbol===symbol);
    if (!info) continue;
    if (String(order.side||'').toUpperCase()==='SELL') openAssets.add(String(info.baseAsset||''));
    else if (String(order.side||'').toUpperCase()==='BUY') openAssets.add(String(info.quoteAsset||''));
  }

  const convertibleAssets = new Set((convertible.details || []).map(row=>String(row.asset||'').toUpperCase()));
  const outcomes = [];

  for (const row of account.balances || []) {
    const asset = String(row.asset || '').toUpperCase();
    const free = n(row.free);
    const locked = n(row.locked);
    if (HARD_EXCLUDED.has(asset) || !(free > 0) || locked > 0) continue;

    const value = assetValueUsdt(asset, free, pricesMap);
    if (!(value !== null && value > 0 && value < MAX_VALUE_USDT)) continue;
    if (openAssets.has(asset)) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'OPEN_ORDER_PRESENT'});
      continue;
    }
    if (!convertibleAssets.has(asset)) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'NOT_CONVERTIBLE_TO_USDT'});
      continue;
    }

    const directSymbol = `${asset}USDT`;
    if (!symbols.has(directSymbol)) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'OWNERSHIP_UNPROVABLE_NO_DIRECT_HISTORY'});
      continue;
    }

    let orders = [];
    try {
      orders = await request(base,'GET','/api/v3/allOrders',{symbol:directSymbol,limit:'1000'},true);
    } catch (error) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'ORDER_HISTORY_UNAVAILABLE'});
      continue;
    }

    const filled = (orders || []).filter(o=>String(o.status||'').toUpperCase()==='FILLED');
    const proypersFilled = filled.filter(o=>isProypersId(o.clientOrderId));
    const unknownFilled = filled.filter(o=>!isProypersId(o.clientOrderId));
    if (!proypersFilled.length) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'NO_PROYPERS_OWNERSHIP_EVIDENCE'});
      continue;
    }
    if (unknownFilled.length) {
      outcomes.push({asset,value_usdt:value,action:'SKIP',reason:'MANUAL_OR_UNKNOWN_HISTORY_PRESENT'});
      continue;
    }

    const clientId = `px25dust_${crypto.createHash('sha256').update(`${asset}|${free}`).digest('hex').slice(0,20)}`;
    try {
      const response = await request(base,'POST','/sapi/v1/asset/dust-convert/convert',{
        asset,
        targetAsset:'USDT',
        clientId
      },true);
      const rows = (response.transferResult || []).filter(r=>String(r.fromAsset||'').toUpperCase()===asset);
      const received = rows.reduce((sum,r)=>sum+n(r.transferedAmount),0);
      const converted = rows.reduce((sum,r)=>sum+n(r.amount),0);
      if (!(converted > 0)) throw new Error('conversion_not_confirmed');
      outcomes.push({asset,value_usdt:value,action:'CONVERTED_TO_USDT',converted_quantity:converted,received_usdt:received});
      console.log(`DUST_CONVERTED asset=${asset} estimated_usdt=${value.toFixed(6)} received_usdt=${received}`);
    } catch (error) {
      outcomes.push({asset,value_usdt:value,action:'CONVERT_FAILED',reason:String(error.message||error)});
    }
  }

  console.log('DUST_UNDER_ONE_SUMMARY '+JSON.stringify({
    max_value_usdt:MAX_VALUE_USDT,
    converted:outcomes.filter(x=>x.action==='CONVERTED_TO_USDT').length,
    skipped:outcomes.filter(x=>x.action==='SKIP').length,
    failed:outcomes.filter(x=>x.action==='CONVERT_FAILED').length,
    received_usdt:outcomes.reduce((sum,x)=>sum+n(x.received_usdt),0),
    outcomes
  }));
}

main().catch(error=>{
  console.error('DUST_UNDER_ONE_FAILED '+(error.stack||error.message||String(error)));
  process.exit(1);
});
