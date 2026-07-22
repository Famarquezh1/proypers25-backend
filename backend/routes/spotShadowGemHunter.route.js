'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runGemHunterCycle } = require('../services/spotShadowGemHunter');
const unifiedControlPortalRoute = require('./unifiedControlPortal.route');
const controlCenterLogsRoute = require('./controlCenterLogs.route');

const router = express.Router();
const PORTFOLIOS = 'spot_shadow_gem_portfolios';
const POSITIONS = 'spot_shadow_gem_positions';
const DECISIONS = 'spot_shadow_gem_decisions';

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function privateOnly(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'PRIVATE_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.post('/internal/gem-hunter/cycle', privateOnly, async (req, res) => {
  try {
    const result = await runGemHunterCycle(db, req.body || {});
    return res.json({ ok: true, generated_at: new Date().toISOString(), ...result });
  } catch (error) {
    console.error('[GEM_HUNTER] cycle failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'GEM_HUNTER_CYCLE_FAILED', details: error?.message || String(error) });
  }
});

router.get('/internal/gem-hunter/portfolio', privateOnly, async (_req, res) => {
  try {
    const [portfolioDoc, openSnapshot, closedSnapshot, decisionSnapshot] = await Promise.all([
      db.collection(PORTFOLIOS).doc('gem_hunter_default').get(),
      db.collection(POSITIONS).where('status', '==', 'OPEN').get(),
      db.collection(POSITIONS).where('status', '==', 'CLOSED').limit(50).get(),
      db.collection(DECISIONS).orderBy('created_at', 'desc').limit(50).get()
    ]);
    return res.json({
      ok: true,
      strategy: 'GEM_HUNTER',
      mode: 'SHADOW',
      real_orders_enabled: false,
      portfolio: portfolioDoc.exists ? portfolioDoc.data() : null,
      open_positions: openSnapshot.docs.map((doc) => doc.data()),
      closed_positions: closedSnapshot.docs.map((doc) => doc.data()),
      recent_decisions: decisionSnapshot.docs.map((doc) => doc.data())
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'GEM_HUNTER_PORTFOLIO_FAILED', details: error?.message || String(error) });
  }
});

router.get('/gem-hunter-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 Gem Hunter</title><style>body{margin:0;background:#07111f;color:#edf5ff;font-family:Inter,system-ui,sans-serif}.w{max-width:1180px;margin:auto;padding:22px}.bar{display:flex;gap:10px;flex-wrap:wrap}.bar input{flex:1;min-width:240px;padding:12px;border-radius:9px;border:1px solid #29415f;background:#0d1b2d;color:#fff}.bar button{padding:12px 18px;border:0;border-radius:9px;font-weight:800}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:13px;padding:15px}.l{font-size:12px;color:#8fa7c2}.v{font-size:23px;font-weight:850;margin-top:7px}.ok{color:#51d88a}.warn{color:#f5c451}.bad{color:#ff718a}.muted{color:#8fa7c2}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #203853;white-space:nowrap}th{color:#8fa7c2}.wrap{overflow:auto}.err{color:#ff718a;margin-top:12px}</style></head><body><main class="w"><h1>Gem Hunter</h1><p class="muted">Estrategia especulativa aislada, capital pequeño y modo sombra. No ejecuta órdenes reales.</p><div class="bar"><input id="secret" type="password" placeholder="Clave privada"><button onclick="loadData()">Actualizar</button><button onclick="runCycle()">Ejecutar ciclo sombra</button></div><div id="error" class="err"></div><div id="content" hidden><div id="cards" class="cards"></div><h2>Posiciones abiertas</h2><div class="card wrap"><table><thead><tr><th>Par</th><th>Capital</th><th>Convicción</th><th>Asimetría</th><th>Riesgo</th><th>Pico</th><th>Parciales</th></tr></thead><tbody id="openRows"></tbody></table></div><h2>Decisiones recientes</h2><div class="card wrap"><table><thead><tr><th>Par</th><th>Acción</th><th>Asignación</th><th>Convicción</th><th>Asimetría</th><th>Riesgo</th><th>Motivo</th></tr></thead><tbody id="decisionRows"></tbody></table></div></div><script>const n=v=>Number(v||0).toFixed(2);async function api(path,method='GET'){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);const r=await fetch(path,{method,headers:{'x-investments-secret':s,'content-type':'application/json'},body:method==='POST'?'{}':undefined});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));return d}async function loadData(){error.textContent='Cargando...';try{render(await api('/internal/gem-hunter/portfolio'));error.textContent=''}catch(e){content.hidden=true;error.textContent=e.message}}async function runCycle(){error.textContent='Ejecutando ciclo sombra...';try{await api('/internal/gem-hunter/cycle','POST');await loadData()}catch(e){error.textContent=e.message}}function render(d){content.hidden=false;const p=d.portfolio||{};cards.innerHTML=[['Modo',d.mode],['Capital inicial','$'+n(p.initial_capital_usdt)],['Efectivo','$'+n(p.cash_usdt)],['Equity','$'+n(p.equity_usdt)],['PnL realizado','$'+n(p.realized_pnl_usdt)],['Comisiones','$'+n(p.fees_usdt)],['Drawdown',n(p.max_drawdown_pct)+'%'],['Abiertas',(d.open_positions||[]).length],['Cerradas',(d.closed_positions||[]).length]].map(i=>'<div class="card"><div class="l">'+i[0]+'</div><div class="v">'+i[1]+'</div></div>').join('');openRows.innerHTML=(d.open_positions||[]).map(i=>'<tr><td><b>'+i.symbol+'</b></td><td>$'+n(i.remaining_notional_usdt)+'</td><td>'+n(i.conviction_score)+'</td><td>'+n(i.asymmetry_score)+'</td><td>'+n(i.risk_score)+'</td><td>'+n(i.peak_move_pct)+'%</td><td>'+(i.first_partial_taken?'TP1 ':'')+(i.second_partial_taken?'TP2':'')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">Sin posiciones abiertas.</td></tr>';decisionRows.innerHTML=(d.recent_decisions||[]).map(i=>'<tr><td><b>'+i.symbol+'</b></td><td class="'+(i.action==='GEM_SHADOW_ENTRY'?'ok':'warn')+'">'+i.action+'</td><td>$'+n(i.allocation_usdt)+'</td><td>'+n(i.conviction_score)+'</td><td>'+n(i.asymmetry_score)+'</td><td>'+n(i.risk_score)+'</td><td>'+(i.rejection_reason||'Patrón gema aceptado')+'</td></tr>').join('')||'<tr><td colspan="7" class="muted">Sin decisiones.</td></tr>'}secret.value=localStorage.getItem('proypers25_summary_secret')||'';if(secret.value)loadData();</script></main></body></html>`);
});

router.use(controlCenterLogsRoute);
router.use(unifiedControlPortalRoute);

module.exports = router;
