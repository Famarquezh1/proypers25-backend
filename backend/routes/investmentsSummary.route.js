'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../firebase-admin-config');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const router = express.Router();
const POSITIONS = 'real_spot_positions';
const RESULTS = 'real_spot_execution_results';

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateSummarySecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'SUMMARY_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

function signParams(params, secret) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function signedBinanceGet(path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = signParams({ ...params, recvWindow: 10000, timestamp: Date.now() }, apiSecret);
  const response = await axios.get(`https://api.binance.com${path}?${query}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 15000
  });
  return response.data;
}

async function getAllPrices() {
  const response = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 10000 });
  return new Map((response.data || []).map((item) => [item.symbol, Number(item.price || 0)]));
}

async function getAllTrades(symbol) {
  const all = [];
  let fromId;
  for (let page = 0; page < 10; page += 1) {
    const params = { symbol, limit: 1000 };
    if (fromId !== undefined) params.fromId = fromId;
    const batch = await signedBinanceGet('/api/v3/myTrades', params);
    if (!Array.isArray(batch) || batch.length === 0) break;
    all.push(...batch);
    if (batch.length < 1000) break;
    fromId = Number(batch[batch.length - 1].id) + 1;
  }
  return all;
}

async function getConvertHistory() {
  const all = [];
  const windowMs = 29 * 24 * 60 * 60 * 1000;
  const accountStart = Date.UTC(2017, 0, 1);
  for (let end = Date.now(); end > accountStart && all.length < 5000; end -= windowMs) {
    const start = Math.max(accountStart, end - windowMs);
    try {
      const response = await signedBinanceGet('/sapi/v1/convert/tradeFlow', {
        startTime: start,
        endTime: end,
        limit: 1000
      });
      const batch = Array.isArray(response?.list) ? response.list : [];
      all.push(...batch.filter((item) => String(item.orderStatus || '').toUpperCase() === 'SUCCESS'));
      if (batch.length === 0 && end < Date.now() - (365 * 24 * 60 * 60 * 1000)) break;
    } catch (error) {
      console.warn('[INVESTMENTS_SUMMARY] convert history unavailable:', error.response?.data?.msg || error.message);
      break;
    }
  }
  const unique = new Map();
  all.forEach((item) => unique.set(String(item.orderId || `${item.createTime}-${item.fromAsset}-${item.toAsset}`), item));
  return [...unique.values()].sort((a, b) => Number(a.createTime || 0) - Number(b.createTime || 0));
}

function valueAssetInUsdt(asset, quantity, prices) {
  if (asset === 'USDT') return quantity;
  const direct = prices.get(`${asset}USDT`);
  if (direct > 0) return quantity * direct;
  const btcPrice = prices.get('BTCUSDT');
  const viaBtc = prices.get(`${asset}BTC`);
  return btcPrice > 0 && viaBtc > 0 ? quantity * viaBtc * btcPrice : 0;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function buildEngineDiagnosis(config, openPositions, assets) {
  const blockers = [];
  if (config.enabled !== true) blockers.push('Motor desactivado');
  if (config.kill_switch === true) blockers.push('Kill switch activado');
  if (config.new_entries_enabled !== true) blockers.push('Nuevas entradas desactivadas');
  if (config.real_sells_enabled !== true) blockers.push('Ventas reales desactivadas');
  if (config.auto_order_execution !== true) blockers.push('Ejecución automática desactivada');
  if (config.spot_only !== true) blockers.push('Modo exclusivo Spot no confirmado');
  if (config.futures_allowed === true) blockers.push('Futuros permitidos');
  if (config.margin_allowed === true) blockers.push('Margen permitido');
  if (config.leverage_allowed === true) blockers.push('Apalancamiento permitido');
  if (config.withdrawals_allowed === true) blockers.push('Retiros permitidos');
  if (Number(config.max_position_usdt || 0) > 10) blockers.push('Tamaño por posición supera US$10');
  if (Number(config.max_open_positions || 0) > 1) blockers.push('Máximo de posiciones supera 1');
  if (Number(config.max_total_capital_usdt || 0) > 10) blockers.push('Capital total supera US$10');
  const balanceByAsset = new Map(assets.map((asset) => [asset.asset, asset.quantity]));
  for (const position of openPositions) {
    const symbol = String(position.symbol || '').toUpperCase();
    const asset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : null;
    const recorded = Number(position.quantity || 0);
    const actual = Number(balanceByAsset.get(asset) || 0);
    if (!asset || actual + Math.max(1e-8, recorded * 0.0001) < recorded) {
      blockers.push(`Posición inconsistente: ${symbol || position.id}`);
    }
  }
  return { ready: blockers.length === 0, blockers: [...new Set(blockers)] };
}

function summarizeAsset(asset, trades, conversions, accountQuantity, currentPrice) {
  const events = [];
  trades.forEach((trade) => events.push({
    type: trade.isBuyer === true ? 'BUY' : 'SELL',
    timeMs: Number(trade.time || 0),
    time: new Date(Number(trade.time || 0)).toISOString(),
    quantity: Number(trade.qty || 0),
    quoteUsdt: Number(trade.quoteQty || (Number(trade.qty || 0) * Number(trade.price || 0))),
    priceUsdt: Number(trade.price || 0),
    orderId: trade.orderId,
    commission: Number(trade.commission || 0),
    commissionAsset: trade.commissionAsset || null,
    source: 'SPOT_ORDER'
  }));
  conversions
    .filter((item) => String(item.fromAsset || '').toUpperCase() === asset && String(item.toAsset || '').toUpperCase() === 'USDT')
    .forEach((item) => {
      const quantity = Number(item.fromAmount || 0);
      const quoteUsdt = Number(item.toAmount || 0);
      events.push({
        type: 'CONVERT_TO_USDT',
        timeMs: Number(item.createTime || 0),
        time: new Date(Number(item.createTime || 0)).toISOString(),
        quantity,
        quoteUsdt,
        priceUsdt: quantity > 0 ? quoteUsdt / quantity : 0,
        orderId: item.orderId || null,
        commission: 0,
        commissionAsset: null,
        source: 'BINANCE_CONVERT'
      });
    });
  events.sort((a, b) => a.timeMs - b.timeMs);

  let trackedQty = 0;
  let averageCost = 0;
  let bought = 0;
  let sold = 0;
  let converted = 0;
  let realizedOrders = 0;
  let realizedConversions = 0;
  const timeline = events.map((event) => {
    let eventPnl = null;
    if (event.type === 'BUY') {
      const previousCost = trackedQty * averageCost;
      trackedQty += event.quantity;
      bought += event.quoteUsdt;
      averageCost = trackedQty > 0 ? (previousCost + event.quoteUsdt) / trackedQty : 0;
    } else {
      const quantityFromTracked = Math.min(event.quantity, trackedQty);
      eventPnl = event.quoteUsdt - (quantityFromTracked * averageCost);
      trackedQty = Math.max(0, trackedQty - event.quantity);
      if (event.type === 'SELL') {
        sold += event.quoteUsdt;
        realizedOrders += eventPnl;
      } else {
        converted += event.quoteUsdt;
        realizedConversions += eventPnl;
      }
      if (trackedQty === 0) averageCost = 0;
    }
    return { ...event, pnlUsdt: eventPnl };
  });

  const remainingCost = trackedQty * averageCost;
  const currentValue = accountQuantity * currentPrice;
  const unrealized = currentValue - remainingCost;
  const realized = realizedOrders + realizedConversions;
  return {
    asset,
    symbol: `${asset}USDT`,
    account_quantity: Number(accountQuantity.toFixed(12)),
    tracked_quantity: Number(trackedQty.toFixed(12)),
    untracked_quantity: Number((accountQuantity - trackedQty).toFixed(12)),
    average_cost_usdt: Number(averageCost.toFixed(12)),
    current_price_usdt: Number(currentPrice.toFixed(12)),
    total_bought_usdt: Number(bought.toFixed(8)),
    total_sold_usdt: Number(sold.toFixed(8)),
    total_converted_usdt: Number(converted.toFixed(8)),
    remaining_cost_usdt: Number(remainingCost.toFixed(8)),
    realized_order_pnl_usdt: Number(realizedOrders.toFixed(8)),
    realized_conversion_pnl_usdt: Number(realizedConversions.toFixed(8)),
    realized_pnl_usdt: Number(realized.toFixed(8)),
    unrealized_pnl_usdt: Number(unrealized.toFixed(8)),
    total_pnl_usdt: Number((realized + unrealized).toFixed(8)),
    return_pct: remainingCost > 0 ? Number(((unrealized / remainingCost) * 100).toFixed(4)) : null,
    coverage_complete: Math.abs(accountQuantity - trackedQty) <= Math.max(1e-8, accountQuantity * 0.0001),
    timeline: timeline.slice(-150).reverse()
  };
}

async function buildSummary() {
  const [account, prices, openSnapshot, resultSnapshot, controlSnapshot, conversions] = await Promise.all([
    signedBinanceGet('/api/v3/account'),
    getAllPrices(),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    db.collection(RESULTS).get(),
    db.collection('real_spot_config').doc('control').get(),
    getConvertHistory()
  ]);
  const openPositions = openSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const results = resultSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const config = controlSnapshot.exists ? controlSnapshot.data() : {};
  const assets = (account.balances || []).map((balance) => {
    const free = Number(balance.free || 0);
    const locked = Number(balance.locked || 0);
    const quantity = free + locked;
    const value = valueAssetInUsdt(balance.asset, quantity, prices);
    const position = openPositions.find((item) => String(item.symbol || '').toUpperCase() === `${balance.asset}USDT`);
    const entry = Number(position?.entry_price || 0);
    const current = Number(prices.get(`${balance.asset}USDT`) || 0);
    return {
      asset: balance.asset,
      free,
      locked,
      quantity,
      value_usdt: value,
      price_usdt: balance.asset === 'USDT' ? 1 : current,
      managed_by_api: Boolean(position),
      unrealized_pnl_usdt: position && entry > 0 ? quantity * ((current || entry) - entry) : null
    };
  }).filter((asset) => asset.quantity > 0 && (asset.value_usdt >= 0.01 || asset.asset === 'USDT'))
    .sort((a, b) => b.value_usdt - a.value_usdt);

  const historyAssets = new Set(assets.filter((asset) => asset.asset !== 'USDT').map((asset) => asset.asset));
  conversions.filter((item) => String(item.toAsset || '').toUpperCase() === 'USDT').forEach((item) => historyAssets.add(String(item.fromAsset || '').toUpperCase()));
  const portfolioHistory = await Promise.all([...historyAssets].filter(Boolean).map(async (assetName) => {
    const asset = assets.find((item) => item.asset === assetName);
    const quantity = Number(asset?.quantity || 0);
    const currentPrice = Number(prices.get(`${assetName}USDT`) || 0);
    try {
      return summarizeAsset(assetName, await getAllTrades(`${assetName}USDT`), conversions, quantity, currentPrice);
    } catch (error) {
      return { asset: assetName, symbol: `${assetName}USDT`, error: error.response?.data?.msg || error.message, timeline: [] };
    }
  }));

  const totalEquity = assets.reduce((sum, asset) => sum + asset.value_usdt, 0);
  const usdt = assets.find((asset) => asset.asset === 'USDT');
  const totalBought = portfolioHistory.reduce((sum, item) => sum + Number(item.total_bought_usdt || 0), 0);
  const totalSold = portfolioHistory.reduce((sum, item) => sum + Number(item.total_sold_usdt || 0), 0);
  const totalConverted = portfolioHistory.reduce((sum, item) => sum + Number(item.total_converted_usdt || 0), 0);
  const remainingCost = portfolioHistory.reduce((sum, item) => sum + Number(item.remaining_cost_usdt || 0), 0);
  const realizedOrders = portfolioHistory.reduce((sum, item) => sum + Number(item.realized_order_pnl_usdt || 0), 0);
  const realizedConversions = portfolioHistory.reduce((sum, item) => sum + Number(item.realized_conversion_pnl_usdt || 0), 0);
  const unrealized = portfolioHistory.reduce((sum, item) => sum + Number(item.unrealized_pnl_usdt || 0), 0);
  const apiExposure = openPositions.reduce((sum, position) => sum + Number(position.capital_usdt || 0), 0);
  const manualConversions = conversions
    .filter((item) => String(item.toAsset || '').toUpperCase() === 'USDT')
    .map((item) => ({
      order_id: item.orderId || null,
      from_asset: String(item.fromAsset || '').toUpperCase(),
      to_asset: 'USDT',
      from_amount: Number(item.fromAmount || 0),
      to_amount: Number(item.toAmount || 0),
      ratio: Number(item.ratio || 0),
      created_at: new Date(Number(item.createTime || 0)).toISOString()
    })).sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  const recentTrades = results.map((item) => ({
    id: item.id,
    symbol: item.symbol || null,
    closing_reason: item.closing_reason || item.close_reason || null,
    net_pnl_usdt: Number(item.net_pnl_usdt || 0),
    net_pnl_pct: item.net_pnl_pct === null || item.net_pnl_pct === undefined ? null : Number(item.net_pnl_pct),
    closed_at: item.closed_at || null,
    external_conversion: item.external_conversion === true
  })).sort((a, b) => (toDate(b.closed_at)?.getTime() || 0) - (toDate(a.closed_at)?.getTime() || 0)).slice(0, 30);

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    account: {
      total_equity_usdt: Number(totalEquity.toFixed(6)),
      available_usdt: Number((usdt?.free || 0).toFixed(6)),
      locked_usdt: Number((usdt?.locked || 0).toFixed(6))
    },
    portfolio: {
      historical_buys_usdt: Number(totalBought.toFixed(6)),
      historical_sells_usdt: Number(totalSold.toFixed(6)),
      manual_conversions_received_usdt: Number(totalConverted.toFixed(6)),
      remaining_tracked_cost_usdt: Number(remainingCost.toFixed(6)),
      realized_order_pnl_usdt: Number(realizedOrders.toFixed(6)),
      realized_conversion_pnl_usdt: Number(realizedConversions.toFixed(6)),
      realized_pnl_usdt: Number((realizedOrders + realizedConversions).toFixed(6)),
      unrealized_pnl_usdt: Number(unrealized.toFixed(6))
    },
    allocation: {
      api_exposure_usdt: Number(apiExposure.toFixed(6)),
      configured_max_total_usdt: Number(config.max_total_capital_usdt || 0),
      configured_position_size_usdt: Number(config.max_position_usdt || 0),
      configured_max_open_positions: Number(config.max_open_positions || 0)
    },
    engine: { ...config, open_positions: openPositions.length, diagnosis: buildEngineDiagnosis(config, openPositions, assets) },
    assets: assets.map((asset) => ({ ...asset, value_usdt: Number(asset.value_usdt.toFixed(6)) })),
    portfolio_history: portfolioHistory,
    manual_conversions: manualConversions,
    recent_trades: recentTrades
  };
}

router.get('/internal/investments/summary', validateSummarySecret, async (req, res) => {
  try {
    return res.json(await buildSummary());
  } catch (error) {
    console.error('[INVESTMENTS_SUMMARY] Failed:', error.message);
    return res.status(500).json({ ok: false, error: 'SUMMARY_FAILED', details: error.response?.data?.msg || error.message });
  }
});

router.get('/investments-dashboard', (req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 · Inversiones</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#edf5ff}.wrap{max-width:1180px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap}.top input{flex:1;min-width:220px}.top input,.top button{padding:14px;border-radius:12px;border:1px solid #29415f;background:#0d1b2d;color:white}.top button{background:#e8edf4;color:#07111f;font-weight:800;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:18px;padding:18px}.label,.muted,.note{color:#91a8c2}.label{font-size:13px}.value{font-size:25px;font-weight:850;margin-top:7px}.good{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}h1{font-size:42px;margin:0 0 4px}h2{font-size:30px;margin:34px 0 16px}.row{display:grid;grid-template-columns:1.1fr 1fr 1fr 1fr 1fr;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid #203853}.row:last-child{border:0}.status{padding:5px 9px;border-radius:999px;background:#1b3048;font-size:12px;display:inline-block}.asset-detail{margin:12px 0}.asset-detail summary{cursor:pointer;font-weight:800;font-size:18px}.mini{font-size:12px}.error{margin-top:14px;color:#ff718a}.conversion{border-left:4px solid #ffd166}.event{display:grid;grid-template-columns:1fr 1fr 1fr 1fr;gap:10px;padding:10px 0;border-bottom:1px solid #203853}.event:last-child{border:0}@media(max-width:680px){.wrap{padding:16px}h1{font-size:36px}h2{font-size:27px}.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}.row .wide{grid-column:1/-1}.event{grid-template-columns:1fr 1fr}.value{font-size:28px}}
</style></head><body><main class="wrap"><h1>Proypers25</h1><div class="muted">Panel privado Spot · Binance real</div><div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button></div><div id="error" class="error"></div><div id="content" hidden><section id="cards" class="grid"></section><h2>Diagnóstico del motor</h2><div id="engine" class="card"></div><h2>Activos actuales</h2><div id="assets" class="card"></div><h2>Conversiones manuales a USDT</h2><div class="card conversion"><div class="note">Se muestran como cierres manuales de oportunidad. No se confunden con ventas automáticas de la API.</div><div id="conversions"></div></div><h2>Ruta histórica por activo</h2><div id="history"></div><h2>Cierres registrados por el sistema</h2><div id="trades" class="card"></div></div><script>
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n||0));const num=(n,d=8)=>Number(n||0).toLocaleString('es-CL',{maximumFractionDigits:d});const pct=n=>n===null||n===undefined?'—':Number(n).toFixed(2)+'%';const cls=n=>Number(n||0)>=0?'good':'bad';const date=v=>v?new Intl.DateTimeFormat('es-CL',{dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'—';
async function load(){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);error.textContent='Actualizando datos reales de Binance...';try{const r=await fetch('/internal/investments/summary',{headers:{'x-investments-secret':s}});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
function render(d){content.hidden=false;const p=d.portfolio||{};const cards=[['Capital actual',money(d.account.total_equity_usdt),''],['USDT disponible',money(d.account.available_usdt),''],['Compras históricas',money(p.historical_buys_usdt),''],['Ventas Spot',money(p.historical_sells_usdt),''],['Conversiones a USDT',money(p.manual_conversions_received_usdt),'warn'],['Costo pendiente',money(p.remaining_tracked_cost_usdt),''],['PnL no realizado',money(p.unrealized_pnl_usdt),cls(p.unrealized_pnl_usdt)],['PnL realizado total',money(p.realized_pnl_usdt),cls(p.realized_pnl_usdt)],['PnL por conversiones',money(p.realized_conversion_pnl_usdt),cls(p.realized_conversion_pnl_usdt)],['Exposición API',money(d.allocation.api_exposure_usdt),'']];document.getElementById('cards').innerHTML=cards.map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');const diag=d.engine.diagnosis;engine.innerHTML='<div class="value '+(diag.ready?'good':'warn')+'">'+(diag.ready?'LISTO SEGÚN CONFIGURACIÓN':'BLOQUEADO POR SEGURIDAD')+'</div><div>'+(diag.blockers.length?diag.blockers.map(x=>'• '+x).join('<br>'):'Spot real habilitado, ventas automáticas habilitadas y sin inconsistencias detectadas.')+'</div><div class="note">Límites actuales: '+money(d.allocation.configured_position_size_usdt)+' por posición, '+d.allocation.configured_max_open_positions+' posición y '+money(d.allocation.configured_max_total_usdt)+' de exposición total.</div>';assets.innerHTML=d.assets.map(a=>'<div class="row"><div class="wide"><b>'+a.asset+'</b><div class="mini muted">'+(a.managed_by_api?'Administrado por API':'Saldo de cuenta')+'</div></div><div><span class="label">Valor</span><br><b>'+money(a.value_usdt)+'</b></div><div><span class="label">Cantidad</span><br><b>'+num(a.quantity)+'</b></div><div><span class="label">PnL API</span><br><b class="'+cls(a.unrealized_pnl_usdt)+'">'+(a.unrealized_pnl_usdt===null?'—':money(a.unrealized_pnl_usdt))+'</b></div></div>').join('');conversions.innerHTML=(d.manual_conversions||[]).map(c=>'<div class="event"><div><span class="label">Fecha</span><br><b>'+date(c.created_at)+'</b></div><div><span class="label">Conversión</span><br><b>'+c.from_asset+' → USDT</b></div><div><span class="label">Entregado</span><br><b>'+num(c.from_amount)+' '+c.from_asset+'</b></div><div><span class="label">Recibido</span><br><b class="warn">'+money(c.to_amount)+'</b></div></div>').join('')||'<div class="muted" style="padding-top:14px">Binance no devolvió conversiones manuales en el historial consultable.</div>';history.innerHTML=(d.portfolio_history||[]).map(h=>{if(h.error)return '<div class="card bad">'+h.asset+' · '+h.error+'</div>';return '<details class="card asset-detail"><summary>'+h.asset+' · <span class="'+cls(h.total_pnl_usdt)+'">'+money(h.total_pnl_usdt)+'</span></summary><div class="grid"><div><div class="label">Comprado</div><b>'+money(h.total_bought_usdt)+'</b></div><div><div class="label">Vendido Spot</div><b>'+money(h.total_sold_usdt)+'</b></div><div><div class="label">Convertido a USDT</div><b class="warn">'+money(h.total_converted_usdt)+'</b></div><div><div class="label">PnL conversiones</div><b class="'+cls(h.realized_conversion_pnl_usdt)+'">'+money(h.realized_conversion_pnl_usdt)+'</b></div><div><div class="label">PnL pendiente</div><b class="'+cls(h.unrealized_pnl_usdt)+'">'+money(h.unrealized_pnl_usdt)+'</b></div><div><div class="label">Cobertura</div><b class="'+(h.coverage_complete?'good':'warn')+'">'+(h.coverage_complete?'Saldo reconciliado':'Revisión requerida')+'</b></div></div><div>'+h.timeline.map(t=>'<div class="event"><div>'+date(t.time)+'</div><div><b>'+(t.type==='CONVERT_TO_USDT'?'CONVERSIÓN MANUAL':t.type)+'</b></div><div>'+num(t.quantity)+' '+h.asset+'</div><div class="'+(t.type==='BUY'?'good':'warn')+'">'+money(t.quoteUsdt)+'</div></div>').join('')+'</div></details>';}).join('');trades.innerHTML=(d.recent_trades||[]).map(t=>'<div class="event"><div><b>'+String(t.symbol||'—')+'</b></div><div class="'+cls(t.net_pnl_usdt)+'">'+money(t.net_pnl_usdt)+'</div><div>'+(t.external_conversion?'Conversión manual':String(t.closing_reason||'—'))+'</div><div>'+date(t.closed_at)+'</div></div>').join('')||'<div class="muted">Aún no hay cierres registrados.</div>';}
secret.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
