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
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function getBinanceAccount() {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = signParams({ recvWindow: 5000, timestamp: Date.now() }, apiSecret);
  const response = await axios.get(`https://api.binance.com/api/v3/account?${query}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000
  });
  return response.data;
}

async function getAllPrices() {
  const response = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 10000 });
  return new Map((response.data || []).map((item) => [item.symbol, Number(item.price || 0)]));
}

function valueAssetInUsdt(asset, quantity, prices) {
  if (asset === 'USDT') return quantity;
  const direct = prices.get(`${asset}USDT`);
  if (direct > 0) return quantity * direct;
  const btcPrice = prices.get('BTCUSDT');
  const viaBtc = prices.get(`${asset}BTC`);
  if (btcPrice > 0 && viaBtc > 0) return quantity * viaBtc * btcPrice;
  return 0;
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function periodMetrics(results, since) {
  const selected = results.filter((item) => {
    const closed = toDate(item.closed_at || item.created_at);
    return closed && closed >= since;
  });
  const pnl = selected.reduce((sum, item) => sum + Number(item.net_pnl_usdt || 0), 0);
  return { trades: selected.length, pnl_usdt: Number(pnl.toFixed(6)) };
}

function buildTradeStats(results) {
  const wins = results.filter((item) => Number(item.net_pnl_usdt || 0) > 0);
  const losses = results.filter((item) => Number(item.net_pnl_usdt || 0) < 0);
  const grossProfit = wins.reduce((sum, item) => sum + Number(item.net_pnl_usdt || 0), 0);
  const grossLoss = Math.abs(losses.reduce((sum, item) => sum + Number(item.net_pnl_usdt || 0), 0));
  const totalPnl = results.reduce((sum, item) => sum + Number(item.net_pnl_usdt || 0), 0);
  return {
    total_trades: results.length,
    wins: wins.length,
    losses: losses.length,
    win_rate_pct: results.length ? Number(((wins.length / results.length) * 100).toFixed(2)) : 0,
    profit_factor: grossLoss > 0 ? Number((grossProfit / grossLoss).toFixed(3)) : (grossProfit > 0 ? null : 0),
    realized_pnl_usdt: Number(totalPnl.toFixed(6))
  };
}

async function buildSummary() {
  const [account, prices, openSnapshot, resultSnapshot, controlSnapshot] = await Promise.all([
    getBinanceAccount(),
    getAllPrices(),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    db.collection(RESULTS).get(),
    db.collection('real_spot_config').doc('control').get()
  ]);

  const openPositions = openSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const results = resultSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const config = controlSnapshot.exists ? controlSnapshot.data() : {};

  const assets = (account.balances || [])
    .map((balance) => {
      const free = Number(balance.free || 0);
      const locked = Number(balance.locked || 0);
      const quantity = free + locked;
      const value = valueAssetInUsdt(balance.asset, quantity, prices);
      const apiPosition = openPositions.find((position) => String(position.symbol || '').toUpperCase() === `${balance.asset}USDT`);
      const entryPrice = Number(apiPosition?.entry_price || 0);
      const unrealized = apiPosition && entryPrice > 0
        ? quantity * ((prices.get(`${balance.asset}USDT`) || entryPrice) - entryPrice)
        : null;
      return {
        asset: balance.asset,
        free,
        locked,
        quantity,
        price_usdt: balance.asset === 'USDT' ? 1 : Number(prices.get(`${balance.asset}USDT`) || 0),
        value_usdt: value,
        managed_by_api: Boolean(apiPosition),
        api_position_id: apiPosition?.id || null,
        entry_price: apiPosition?.entry_price || null,
        tp1_price: apiPosition?.tp1_price || null,
        sl_price: apiPosition?.sl_price || null,
        timeout_at: apiPosition?.timeout_at || null,
        unrealized_pnl_usdt: unrealized
      };
    })
    .filter((asset) => asset.quantity > 0 && (asset.value_usdt >= 0.01 || asset.asset === 'USDT'))
    .sort((a, b) => b.value_usdt - a.value_usdt);

  const totalEquity = assets.reduce((sum, asset) => sum + asset.value_usdt, 0);
  const usdt = assets.find((asset) => asset.asset === 'USDT');
  const apiExposure = openPositions.reduce((sum, position) => sum + Number(position.capital_usdt || 0), 0);
  const now = new Date();
  const startDay = new Date(now); startDay.setUTCHours(0, 0, 0, 0);
  const startWeek = new Date(now.getTime() - (7 * 24 * 60 * 60 * 1000));
  const startMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const stats = buildTradeStats(results);

  const recentTrades = results
    .map((item) => ({
      id: item.id,
      symbol: item.symbol || null,
      closing_reason: item.closing_reason || item.close_reason || null,
      net_pnl_usdt: Number(item.net_pnl_usdt || 0),
      net_pnl_pct: Number(item.net_pnl_pct || 0),
      closed_at: item.closed_at || null,
      order_id: item.order_id || null
    }))
    .sort((a, b) => (toDate(b.closed_at)?.getTime() || 0) - (toDate(a.closed_at)?.getTime() || 0))
    .slice(0, 30);

  return {
    ok: true,
    generated_at: now.toISOString(),
    source: { account: 'binance_spot', positions: 'firestore', prices: 'binance_public' },
    account: {
      can_trade: account.canTrade === true,
      can_withdraw_account_level: account.canWithdraw === true,
      account_type: account.accountType || null,
      total_equity_usdt: Number(totalEquity.toFixed(6)),
      available_usdt: Number((usdt?.free || 0).toFixed(6)),
      locked_usdt: Number((usdt?.locked || 0).toFixed(6)),
      non_zero_assets: assets.length
    },
    allocation: {
      api_exposure_usdt: Number(apiExposure.toFixed(6)),
      configured_max_total_usdt: Number(config.max_total_capital_usdt || 0),
      configured_position_size_usdt: Number(config.max_position_usdt || 0),
      configured_max_open_positions: Number(config.max_open_positions || 0),
      recommended_initial_position_usdt: 10,
      recommended_reserve_pct: 50
    },
    engine: {
      enabled: config.enabled === true,
      kill_switch: config.kill_switch === true,
      new_entries_enabled: config.new_entries_enabled === true,
      real_sells_enabled: config.real_sells_enabled === true,
      auto_order_execution: config.auto_order_execution === true,
      spot_only: config.spot_only === true,
      futures_allowed: config.futures_allowed === true,
      open_positions: openPositions.length
    },
    performance: {
      ...stats,
      today: periodMetrics(results, startDay),
      last_7_days: periodMetrics(results, startWeek),
      current_month: periodMetrics(results, startMonth)
    },
    assets: assets.map((asset) => ({
      ...asset,
      value_usdt: Number(asset.value_usdt.toFixed(6)),
      unrealized_pnl_usdt: asset.unrealized_pnl_usdt === null ? null : Number(asset.unrealized_pnl_usdt.toFixed(6))
    })),
    api_open_positions: openPositions,
    recent_trades: recentTrades
  };
}

router.get('/internal/investments/summary', validateSummarySecret, async (req, res) => {
  try {
    return res.json(await buildSummary());
  } catch (error) {
    console.error('[INVESTMENTS_SUMMARY] Failed:', error.message);
    return res.status(500).json({ ok: false, error: 'SUMMARY_FAILED', details: error.message });
  }
});

router.get('/investments-dashboard', (req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proypers25 · Inversiones</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}body{margin:0;background:#07111f;color:#e9f2ff}.wrap{max-width:1100px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap;align-items:center}.top input{flex:1;min-width:230px;padding:13px;border-radius:10px;border:1px solid #29415f;background:#0d1b2d;color:white}.top button{padding:13px 18px;border:0;border-radius:10px;font-weight:700;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:12px;margin:18px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:14px;padding:16px}.label{color:#8fa7c2;font-size:13px}.value{font-size:25px;font-weight:800;margin-top:7px}.good{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}table{width:100%;border-collapse:collapse;font-size:14px}th,td{text-align:left;padding:11px 8px;border-bottom:1px solid #203853}th{color:#8fa7c2}.status{padding:4px 8px;border-radius:999px;background:#1b3048;font-size:12px}.error{margin-top:14px;color:#ff718a;white-space:pre-wrap}.muted{color:#8fa7c2}h1{margin-bottom:4px}h2{margin-top:26px}</style></head>
<body><main class="wrap"><h1>Proypers25</h1><div class="muted">Panel privado de inversiones Spot</div>
<div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button></div><div id="error" class="error"></div>
<div id="content" hidden><section id="cards" class="grid"></section><h2>Activos</h2><div class="card" style="overflow:auto"><table><thead><tr><th>Activo</th><th>Valor</th><th>Cantidad</th><th>Origen</th><th>PnL API</th></tr></thead><tbody id="assets"></tbody></table></div>
<h2>Últimas operaciones cerradas</h2><div class="card" style="overflow:auto"><table><thead><tr><th>Par</th><th>Resultado</th><th>%</th><th>Motivo</th><th>Fecha</th></tr></thead><tbody id="trades"></tbody></table></div></div>
<script>
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(n||0));
const pct=n=>Number(n||0).toFixed(2)+'%';
async function load(){const secret=document.getElementById('secret').value;localStorage.setItem('proypers25_summary_secret',secret);document.getElementById('error').textContent='Cargando...';
try{const r=await fetch('/internal/investments/summary',{headers:{'x-investments-secret':secret}});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);document.getElementById('error').textContent='';}catch(e){document.getElementById('content').hidden=true;document.getElementById('error').textContent=e.message;}}
function render(d){document.getElementById('content').hidden=false;const c=[['Capital total',money(d.account.total_equity_usdt),''],['USDT disponible',money(d.account.available_usdt),''],['Exposición API',money(d.allocation.api_exposure_usdt),''],['PnL realizado',money(d.performance.realized_pnl_usdt),d.performance.realized_pnl_usdt>=0?'good':'bad'],['Win rate',pct(d.performance.win_rate_pct),d.performance.win_rate_pct>=50?'good':'warn'],['Posiciones abiertas',d.engine.open_positions,''],['Ventas reales',d.engine.real_sells_enabled?'ACTIVAS':'BLOQUEADAS',d.engine.real_sells_enabled?'bad':'good'],['Tamaño sugerido',money(d.allocation.recommended_initial_position_usdt),'']];
document.getElementById('cards').innerHTML=c.map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');
document.getElementById('assets').innerHTML=d.assets.map(a=>'<tr><td><b>'+a.asset+'</b></td><td>'+money(a.value_usdt)+'</td><td>'+Number(a.quantity).toLocaleString('es-CL',{maximumFractionDigits:8})+'</td><td><span class="status">'+(a.managed_by_api?'API':'Cuenta')+'</span></td><td class="'+((a.unrealized_pnl_usdt||0)>=0?'good':'bad')+'">'+(a.unrealized_pnl_usdt===null?'—':money(a.unrealized_pnl_usdt))+'</td></tr>').join('');
document.getElementById('trades').innerHTML=d.recent_trades.map(t=>'<tr><td>'+String(t.symbol||'—')+'</td><td class="'+(t.net_pnl_usdt>=0?'good':'bad')+'">'+money(t.net_pnl_usdt)+'</td><td>'+pct(t.net_pnl_pct)+'</td><td>'+String(t.closing_reason||'—')+'</td><td>'+String(t.closed_at||'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">Aún no hay cierres registrados.</td></tr>';}
document.getElementById('secret').value=localStorage.getItem('proypers25_summary_secret')||'';
</script></main></body></html>`);
});

module.exports = router;
