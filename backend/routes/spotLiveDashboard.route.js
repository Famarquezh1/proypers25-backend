'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../firebase-admin-config');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left); const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function requireSecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'PRIVATE_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}
function sign(params, secret) {
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  return `${query}&signature=${crypto.createHmac('sha256', secret).update(query).digest('hex')}`;
}
async function signedGet(path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = sign({ ...params, recvWindow: 10000, timestamp: Date.now() }, apiSecret);
  const response = await axios.get(`https://api.binance.com${path}?${query}`, { headers: { 'X-MBX-APIKEY': apiKey }, timeout: 15000 });
  return response.data;
}
async function latest(collection, orderField) {
  const snap = await db.collection(collection).orderBy(orderField, 'desc').limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}
async function recent(collection, orderField, limit = 50) {
  const snap = await db.collection(collection).orderBy(orderField, 'desc').limit(limit).get();
  return snap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
}
function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const d = new Date(value); return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}
function n(value, fallback = null) { const parsed = Number(value); return Number.isFinite(parsed) ? parsed : fallback; }
function positionView(position, price, cycle) {
  const quantity = n(position.quantity ?? position.executed_qty ?? position.base_quantity, 0);
  const entry = n(position.average_entry_price ?? position.entry_price ?? position.avg_price, 0);
  const current = n(price, 0);
  const openedAt = toIso(position.opened_at || position.created_at || position.entry_time);
  const timeoutAt = toIso(position.effective_timeout_at || position.timeout_at);
  return {
    id: position.id,
    symbol: position.symbol,
    asset: String(position.symbol || '').replace(/USDT$/i, ''),
    quantity,
    average_price: entry,
    current_price: current,
    current_value_usdt: quantity * current,
    unrealized_pnl_usdt: entry > 0 ? quantity * (current - entry) : null,
    unrealized_pnl_pct: entry > 0 ? ((current - entry) / entry) * 100 : null,
    realized_pnl_usdt: n(position.realized_pnl_usdt, 0),
    take_profit: n(position.effective_tp_price ?? position.tp1_price ?? position.take_profit, null),
    stop_loss: n(position.effective_sl_price ?? position.sl_price ?? position.stop_loss, null),
    opened_at: openedAt,
    timeout_at: timeoutAt,
    timeout_remaining_ms: timeoutAt ? Math.max(0, new Date(timeoutAt).getTime() - Date.now()) : null,
    exit_engine_state: cycle?.gates?.exit_engine || 'UNKNOWN',
    exit_diagnostics: cycle?.exit_diagnostics || null
  };
}
async function buildLiveEvidence() {
  const [cycle, scheduler, reconciliation, events, openSnap, latestScan] = await Promise.all([
    latest('real_spot_cycle_decisions', 'timestamp'),
    latest('real_spot_scheduler_runs', 'started_at'),
    latest('real_spot_reconciliations', 'created_at'),
    recent('real_spot_activity_events', 'created_at', 60),
    db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get(),
    latest('spot_opportunity_scans', 'created_at')
  ]);
  const positions = openSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const symbols = [...new Set(positions.map((p) => String(p.symbol || '').toUpperCase()).filter(Boolean))];
  const prices = {};
  await Promise.all(symbols.map(async (symbol) => {
    try {
      const response = await axios.get('https://api.binance.com/api/v3/ticker/price', { params: { symbol }, timeout: 10000 });
      prices[symbol] = n(response.data?.price, 0);
    } catch (_error) { prices[symbol] = 0; }
  }));

  let account = null; let lastOrder = null; let lastFill = null; let binanceError = null;
  try {
    account = await signedGet('/api/v3/account');
    const evidenceSymbol = symbols[0] || cycle?.candidate?.symbol || cycle?.market?.promoted_symbol || null;
    if (evidenceSymbol) {
      const [orders, fills] = await Promise.all([
        signedGet('/api/v3/allOrders', { symbol: evidenceSymbol, limit: 20 }),
        signedGet('/api/v3/myTrades', { symbol: evidenceSymbol, limit: 20 })
      ]);
      lastOrder = Array.isArray(orders) && orders.length ? orders[orders.length - 1] : null;
      lastFill = Array.isArray(fills) && fills.length ? fills[fills.length - 1] : null;
    }
  } catch (error) {
    binanceError = error.response?.data?.msg || error.message;
  }

  const balances = (account?.balances || []).map((b) => ({ asset: b.asset, free: n(b.free, 0), locked: n(b.locked, 0), total: n(b.free, 0) + n(b.locked, 0) })).filter((b) => b.total > 0);
  const differences = positions.map((position) => {
    const asset = String(position.symbol || '').replace(/USDT$/i, '');
    const actual = balances.find((b) => b.asset === asset)?.total || 0;
    const recorded = n(position.quantity ?? position.executed_qty ?? position.base_quantity, 0);
    return { symbol: position.symbol, firestore_quantity: recorded, binance_quantity: actual, difference: actual - recorded, consistent: Math.abs(actual - recorded) <= Math.max(1e-8, recorded * 0.0001) };
  });

  const selected = cycle?.candidate || null;
  const latestPosition = positions[0] ? positionView(positions[0], prices[positions[0].symbol], cycle) : null;
  const latestCycle = cycle ? {
    timestamp: cycle.timestamp,
    started_at: cycle.started_at,
    completed_at: cycle.completed_at,
    symbol: selected?.symbol || cycle.market?.promoted_symbol || latestPosition?.symbol || null,
    decision: cycle.decision,
    reason: cycle.reason,
    reasons: cycle.reasons || [],
    score: selected?.score ?? null,
    entry_price: latestPosition?.average_price ?? cycle.entries?.entry_price ?? null,
    current_price: latestPosition?.current_price ?? null,
    pnl_usdt: latestPosition?.unrealized_pnl_usdt ?? cycle.entries?.pnl_usdt ?? null,
    action: cycle.action,
    result: cycle.scheduler?.result || cycle.decision,
    duration_ms: cycle.execution?.duration_ms ?? cycle.scheduler?.duration_ms ?? null,
    blockers: cycle.blockers || [],
    gates: cycle.gates || {},
    exit_diagnostics: cycle.exit_diagnostics || null
  } : null;

  const discarded = Array.isArray(latestScan?.discarded) ? latestScan.discarded : [];
  return {
    ok: true,
    generated_at: new Date().toISOString(),
    real_mode: true,
    spot_only: true,
    latest_cycle: latestCycle,
    scheduler: scheduler || cycle?.scheduler || null,
    open_position: latestPosition,
    engine: {
      last_analysis_at: latestScan?.created_at || cycle?.timestamp || null,
      last_symbol_evaluated: latestCycle?.symbol || null,
      assets_analyzed: n(latestScan?.total_candidates ?? latestScan?.assets_analyzed ?? latestScan?.symbols_scanned, 0),
      discarded_assets: discarded,
      selected_asset: selected,
      blockers: latestCycle?.blockers || []
    },
    binance: {
      last_balance_read_at: account ? new Date().toISOString() : null,
      balances,
      last_order: lastOrder,
      last_fill: lastFill,
      last_reconciliation: reconciliation,
      firestore_differences: differences,
      error: binanceError
    },
    activity: events
  };
}

router.get('/internal/spot-live/evidence', requireSecret, async (_req, res) => {
  try { return res.json(await buildLiveEvidence()); }
  catch (error) { return res.status(500).json({ ok: false, error: 'SPOT_LIVE_EVIDENCE_FAILED', details: error.message }); }
});

router.get('/spot-live-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 · Spot Real Live</title><style>:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#eef5ff}.w{max-width:1250px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap}.top input,.top button{padding:13px;border-radius:11px;border:1px solid #29415f;background:#0d1b2d;color:#fff}.top input{flex:1}.top button{background:#eef5ff;color:#07111f;font-weight:800}.g{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:16px 0}.c{background:#0d1b2d;border:1px solid #203853;border-radius:16px;padding:16px}.l,.m{color:#91a8c2}.v{font-size:22px;font-weight:850;margin-top:5px}.ok{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}.row{display:grid;grid-template-columns:1fr 1fr 1.5fr 1fr;gap:10px;padding:11px 0;border-bottom:1px solid #203853}.row:last-child{border:0}h1{font-size:40px;margin:0}h2{margin-top:30px}.err{color:#ff718a;margin:12px 0}@media(max-width:720px){.row{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}}</style></head><body><main class="w"><h1>Spot real · Evidencia viva</h1><div class="m">Datos persistidos por el backend y lecturas reales de Binance.</div><div class="top"><input id="s" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button></div><div id="e" class="err"></div><div id="x" hidden><h2>Último ciclo real</h2><section id="cycle" class="g"></section><h2>Scheduler</h2><section id="scheduler" class="g"></section><h2>Posición abierta real</h2><section id="position" class="g"></section><h2>Bloqueos activos</h2><div id="blockers" class="c"></div><h2>Evidencia Binance</h2><section id="binance" class="g"></section><div id="diffs" class="c"></div><h2>Actividad reciente</h2><div id="activity" class="c"></div></div><script>const d=v=>v?new Intl.DateTimeFormat('es-CL',{dateStyle:'short',timeStyle:'medium'}).format(new Date(v)):'—';const n=(v,x=6)=>v===null||v===undefined?'—':Number(v).toLocaleString('es-CL',{maximumFractionDigits:x});const u=v=>v===null||v===undefined?'—':'US$ '+Number(v).toFixed(4);const card=(a,b,c='')=>'<div class="c"><div class="l">'+a+'</div><div class="v '+c+'">'+b+'</div></div>';async function load(){e.textContent='Consultando backend y Binance...';const secret=s.value;localStorage.setItem('proypers25_summary_secret',secret);try{const r=await fetch('/internal/spot-live/evidence',{headers:{'x-investments-secret':secret}});const z=await r.json();if(!r.ok)throw new Error(z.error+' · '+(z.details||''));render(z);e.textContent='';}catch(err){x.hidden=true;e.textContent=err.message}}function render(z){x.hidden=false;const c=z.latest_cycle||{};cycle.innerHTML=card('Fecha',d(c.timestamp))+card('Símbolo',c.symbol||'—')+card('Decisión',c.decision||'—',c.decision==='EXECUTED'?'ok':c.decision==='FAILED'?'bad':'warn')+card('Motivo',c.reason||'—')+card('Score',n(c.score,2))+card('Entrada',u(c.entry_price))+card('Precio actual',u(c.current_price))+card('PnL',u(c.pnl_usdt),Number(c.pnl_usdt||0)>=0?'ok':'bad')+card('Acción',c.action||'—')+card('Resultado',c.result||'—');const q=z.scheduler||{};scheduler.innerHTML=card('Inicio',d(q.started_at))+card('Duración',n((q.duration_ms||0)/1000,2)+' s')+card('Resultado',q.result||'—',q.error?'bad':'ok')+card('Siguiente ejecución',d(q.next_execution_at))+card('Error',q.error||'Sin errores',q.error?'bad':'ok');const p=z.open_position;position.innerHTML=p?card('Activo',p.asset)+card('Cantidad',n(p.quantity,12))+card('Precio promedio',u(p.average_price))+card('Precio Binance',u(p.current_price))+card('PnL realizado',u(p.realized_pnl_usdt))+card('PnL no realizado',u(p.unrealized_pnl_usdt),Number(p.unrealized_pnl_usdt||0)>=0?'ok':'bad')+card('Take profit',u(p.take_profit))+card('Stop loss',u(p.stop_loss))+card('Timeout restante',p.timeout_remaining_ms===null?'—':n(p.timeout_remaining_ms/60000,1)+' min')+card('Exit Engine',p.exit_engine_state,p.exit_engine_state==='PASS'?'ok':'bad'):card('Posición','No hay posición REAL_OPEN','warn');const bs=c.blockers||[];blockers.innerHTML=bs.length?bs.map(b=>'<div class="row"><div><b>'+b.component+'</b></div><div class="bad">BLOQUEA</div><div class="wide">'+b.reason+'<div class="m">Falta: '+b.missing_condition+'</div></div><div>'+d(b.since)+'</div></div>').join(''):'<div class="ok"><b>Sin bloqueos activos.</b></div>';const b=z.binance||{};binance.innerHTML=card('Último balance leído',d(b.last_balance_read_at),b.error?'bad':'ok')+card('Última orden',b.last_order?(b.last_order.symbol+' · '+b.last_order.status):'—')+card('Último fill',b.last_fill?(b.last_fill.symbol+' · '+n(b.last_fill.qty,10)):'—')+card('Última reconciliación',d(b.last_reconciliation&&b.last_reconciliation.created_at))+card('Error Binance',b.error||'Sin errores',b.error?'bad':'ok');diffs.innerHTML=(b.firestore_differences||[]).map(i=>'<div class="row"><div><b>'+i.symbol+'</b></div><div>Firestore '+n(i.firestore_quantity,12)+'</div><div>Binance '+n(i.binance_quantity,12)+'</div><div class="'+(i.consistent?'ok':'bad')+'">Δ '+n(i.difference,12)+'</div></div>').join('')||'<div class="m">Sin posiciones administradas para comparar.</div>';activity.innerHTML=(z.activity||[]).map(a=>'<div class="row"><div><b>'+d(a.created_at)+'</b></div><div>'+a.event_type+'</div><div class="wide">'+(a.symbol||a.result||a.error||a.source||'—')+'</div><div>'+a.source+'</div></div>').join('')||'<div class="m">Aún no hay eventos persistidos.</div>'}s.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
