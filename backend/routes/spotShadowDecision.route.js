'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const {
  runShadowDecisionCycle,
  getShadowPortfolioDiagnostic
} = require('../services/spotShadowDecisionEngine');

const router = express.Router();

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

router.post('/internal/shadow-decision/cycle', privateOnly, async (req, res) => {
  try {
    const result = await runShadowDecisionCycle(db, req.body || {});
    return res.json({ ok: true, generated_at: new Date().toISOString(), ...result });
  } catch (error) {
    console.error('[SHADOW_DECISION] cycle failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'SHADOW_DECISION_CYCLE_FAILED', details: error?.message || String(error) });
  }
});

router.get('/internal/shadow-decision/portfolio', privateOnly, async (_req, res) => {
  try {
    const result = await getShadowPortfolioDiagnostic(db);
    return res.json({ ok: true, generated_at: new Date().toISOString(), ...result });
  } catch (error) {
    console.error('[SHADOW_DECISION] diagnostic failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'SHADOW_PORTFOLIO_FAILED', details: error?.message || String(error) });
  }
});

router.get('/shadow-decision-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 Shadow Decision</title><style>body{margin:0;background:#07111f;color:#edf5ff;font-family:Inter,system-ui,sans-serif}.w{max-width:1180px;margin:auto;padding:22px}.bar{display:flex;gap:10px;flex-wrap:wrap}.bar input{flex:1;min-width:240px;padding:12px;border-radius:9px;border:1px solid #29415f;background:#0d1b2d;color:#fff}.bar button{padding:12px 18px;border:0;border-radius:9px;font-weight:800}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(165px,1fr));gap:12px;margin:20px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:13px;padding:15px}.l{font-size:12px;color:#8fa7c2}.v{font-size:22px;font-weight:850;margin-top:7px}.ok{color:#51d88a}.warn{color:#f5c451}.bad{color:#ff718a}.muted{color:#8fa7c2}.wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #203853;white-space:nowrap}th{color:#8fa7c2}.err{color:#ff718a;margin-top:12px}</style></head><body><main class="w"><h1>Decision Engine + Portafolio sombra</h1><p class="muted">Simula asignación, entradas, salidas, comisiones y PnL. No ejecuta órdenes reales.</p><div class="bar"><input id="secret" type="password" placeholder="Clave privada"><button onclick="cycle()">Ejecutar ciclo sombra</button><button onclick="load()">Actualizar</button></div><div id="error" class="err"></div><div id="content" hidden><div id="cards" class="cards"></div><h2>Posiciones abiertas</h2><div class="card wrap"><table><thead><tr><th>Par</th><th>Capital</th><th>Convicción</th><th>Riesgo</th><th>Apertura</th></tr></thead><tbody id="open"></tbody></table></div><h2>Decisiones recientes</h2><div class="card wrap"><table><thead><tr><th>Par</th><th>Acción</th><th>Asignación</th><th>Convicción</th><th>Riesgo</th><th>Motivo</th></tr></thead><tbody id="decisions"></tbody></table></div></div><script>const n=(v,d=2)=>Number(v||0).toLocaleString('es-CL',{maximumFractionDigits:d});const money=v=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(Number(v||0));function headers(){return {'content-type':'application/json','x-investments-secret':secret.value}}async function cycle(){localStorage.setItem('proypers25_summary_secret',secret.value);error.textContent='Ejecutando ciclo...';try{const r=await fetch('/internal/shadow-decision/cycle',{method:'POST',headers:headers(),body:'{}'});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));await load();}catch(e){error.textContent=e.message}}async function load(){localStorage.setItem('proypers25_summary_secret',secret.value);error.textContent='Cargando...';try{const r=await fetch('/internal/shadow-decision/portfolio',{headers:headers()});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message}}function render(d){content.hidden=false;const p=d.portfolio||{};cards.innerHTML=[['Modo',d.mode],['Capital inicial',money(p.initial_capital_usdt)],['Efectivo',money(p.cash_usdt)],['Equity',money(p.equity_usdt)],['PnL realizado',money(p.realized_pnl_usdt)],['Comisiones',money(p.fees_usdt)],['Drawdown',n(p.max_drawdown_pct)+'%'],['Abiertas',(d.open_positions||[]).length],['Cerradas',(d.closed_positions||[]).length]].map(i=>'<div class="card"><div class="l">'+i[0]+'</div><div class="v">'+i[1]+'</div></div>').join('');open.innerHTML=(d.open_positions||[]).map(i=>'<tr><td><b>'+i.symbol+'</b></td><td>'+money(i.remaining_notional_usdt)+'</td><td>'+n(i.conviction_score)+'%</td><td>'+n(i.risk_score)+'</td><td>'+String(i.opened_at||'—')+'</td></tr>').join('')||'<tr><td colspan="5" class="muted">Sin posiciones abiertas.</td></tr>';decisions.innerHTML=(d.recent_decisions||[]).map(i=>'<tr><td><b>'+i.symbol+'</b></td><td class="'+(i.action==='SHADOW_ENTRY'?'ok':'warn')+'">'+i.action+'</td><td>'+money(i.allocation_usdt)+'</td><td>'+n(i.conviction_score)+'%</td><td>'+n(i.risk_score)+'</td><td>'+(i.rejection_reason||(i.reasons||[]).join(', ')||'—')+'</td></tr>').join('')||'<tr><td colspan="6" class="muted">Sin decisiones.</td></tr>'}secret.value=localStorage.getItem('proypers25_summary_secret')||'';if(secret.value)load();</script></main></body></html>`);
});

module.exports = router;