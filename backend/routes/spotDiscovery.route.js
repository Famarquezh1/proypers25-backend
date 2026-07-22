'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getDiscoveryIntelligence } = require('../services/spotDiscoveryIntelligence');

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

router.get('/internal/discovery-engine', privateOnly, async (req, res) => {
  try {
    const intelligence = await getDiscoveryIntelligence(db, { limit: req.query.limit });
    return res.json({ ok: true, generated_at: new Date().toISOString(), ...intelligence });
  } catch (error) {
    console.error('[DISCOVERY_ENGINE] Failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'DISCOVERY_ENGINE_FAILED', details: error?.message || String(error) });
  }
});

router.get('/discovery-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 Discovery</title><style>body{margin:0;background:#07111f;color:#edf5ff;font-family:Inter,system-ui,sans-serif}.w{max-width:1180px;margin:auto;padding:22px}.bar{display:flex;gap:10px;flex-wrap:wrap}.bar input{flex:1;min-width:240px;padding:12px;border-radius:9px;border:1px solid #29415f;background:#0d1b2d;color:#fff}.bar button{padding:12px 18px;border:0;border-radius:9px;font-weight:800}.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px;margin:20px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:13px;padding:15px}.l{font-size:12px;color:#8fa7c2}.v{font-size:23px;font-weight:850;margin-top:7px}.ok{color:#51d88a}.warn{color:#f5c451}.bad{color:#ff718a}.muted{color:#8fa7c2}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:10px 8px;border-bottom:1px solid #203853;white-space:nowrap}th{color:#8fa7c2}.wrap{overflow:auto}.err{color:#ff718a;margin-top:12px}</style></head><body><main class="w"><h1>Discovery Engine</h1><p class="muted">Investigación y convicción en modo sombra. No ejecuta órdenes reales.</p><div class="bar"><input id="secret" type="password" placeholder="Clave privada"><button onclick="loadData()">Actualizar</button></div><div id="error" class="err"></div><div id="content" hidden><div id="cards" class="cards"></div><div class="card wrap"><table><thead><tr><th>#</th><th>Par</th><th>Convicción</th><th>Asimetría</th><th>Oportunidad</th><th>Riesgo</th><th>Estado</th><th>Evidencia</th><th>Validación</th></tr></thead><tbody id="rows"></tbody></table></div></div><script>const n=v=>Number(v||0).toFixed(2);async function loadData(){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);error.textContent='Cargando investigación...';try{const r=await fetch('/internal/discovery-engine',{headers:{'x-investments-secret':s}});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message}}function render(d){content.hidden=false;const x=d.summary||{};cards.innerHTML=[['Modo',d.mode],['Candidatos',x.tracked],['Accionables',x.actionable],['Alta convicción',x.high_conviction],['Rechazados por riesgo',x.rejected_risk],['Líder',x.top_symbol||'—'],['Convicción líder',x.top_conviction===null?'—':n(x.top_conviction)+'%']].map(i=>'<div class="card"><div class="l">'+i[0]+'</div><div class="v">'+i[1]+'</div></div>').join('');rows.innerHTML=(d.ranking||[]).map(i=>{const cls=i.status==='HIGH_CONVICTION'?'ok':i.status==='REJECTED_RISK'?'bad':'warn';const val=i.validation?i.validation.horizon+' · MFE '+n(i.validation.max_favorable_move_pct)+'%':'Pendiente';return '<tr><td>'+i.rank+'</td><td><b>'+i.symbol+'</b></td><td class="'+cls+'"><b>'+n(i.conviction_score)+'%</b></td><td>'+n(i.asymmetry_score)+'</td><td>'+n(i.opportunity_score)+'</td><td>'+n(i.risk_score)+'</td><td class="'+cls+'">'+i.status+'</td><td>'+(i.reasons||[]).join(', ')+'</td><td>'+val+'</td></tr>'}).join('')||'<tr><td colspan="9" class="muted">Sin escaneos disponibles.</td></tr>'}secret.value=localStorage.getItem('proypers25_summary_secret')||'';if(secret.value)loadData();</script></main></body></html>`);
});

module.exports = router;
