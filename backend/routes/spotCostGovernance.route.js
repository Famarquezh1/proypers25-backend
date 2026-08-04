'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runCostGovernance } = require('../services/spotCostGovernance');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireSecret(req, res, next) {
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  if (!expected) return res.status(503).json({ ok: false, error: 'COST_GOVERNANCE_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

router.post('/internal/cron/binance/spot-cost-governance', requireSecret, async (req, res) => {
  try {
    const result = await runCostGovernance(db, req.body || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'SPOT_COST_GOVERNANCE_FAILED', details: error.message });
  }
});

router.get('/internal/spot-cost-governance/status', requireSecret, async (_req, res) => {
  try {
    const snap = await db.doc('real_spot_config/cost_governance').get();
    const latest = await db.collection('spot_cost_governance_runs').orderBy('created_at', 'desc').limit(1).get();
    return res.json({
      ok: true,
      config: snap.exists ? snap.data() : null,
      latest: latest.empty ? null : latest.docs[0].data()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.get('/cost-efficiency-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 · Economía real</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#edf5ff}.wrap{max-width:1180px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap}.top input{flex:1;min-width:220px}.top input,.top button{padding:14px;border-radius:12px;border:1px solid #29415f;background:#0d1b2d;color:white}.top button{background:#e8edf4;color:#07111f;font-weight:800;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:18px;padding:18px}.label,.muted,.note{color:#91a8c2}.label{font-size:13px}.value{font-size:25px;font-weight:850;margin-top:7px}.good{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}h1{font-size:42px;margin:0 0 4px}h2{font-size:29px;margin:34px 0 16px}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid #203853}.row:last-child{border:0}.pill{display:inline-block;padding:6px 10px;border-radius:999px;background:#1b3048;font-size:12px}.error{margin-top:14px;color:#ff718a}@media(max-width:680px){.wrap{padding:16px}h1{font-size:34px}.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}.value{font-size:28px}}
</style></head><body><main class="wrap"><h1>Economía real del sistema</h1><div class="muted">PnL de trading menos costos de infraestructura</div><div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="loadData()">Actualizar</button><button onclick="recalculate()">Recalcular</button></div><div id="error" class="error"></div><div id="content" hidden><section id="cards" class="grid"></section><h2>Fuente del costo</h2><div id="billing" class="card"></div><h2>Decisión económica</h2><div id="decision" class="card"></div><h2>Costos estimados por servicio</h2><div id="services" class="card"></div><h2>Tareas de Cloud Run</h2><div id="tasks" class="card"></div></div><script>
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(Number(n||0));const num=(n,d=2)=>n===null||n===undefined?'—':Number(n).toLocaleString('es-CL',{maximumFractionDigits:d});
async function request(path,method='GET'){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);const r=await fetch(path,{method,headers:{'x-investments-secret':s,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify({}):undefined});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));return d;}
async function loadData(){error.textContent='Consultando costos...';try{const d=await request('/internal/spot-cost-governance/status');if(!d.latest){content.hidden=true;error.textContent='Aún no existe una medición. Pulsa Recalcular.';return;}render(d.latest);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
async function recalculate(){error.textContent='Calculando economía real...';try{const d=await request('/internal/cron/binance/spot-cost-governance','POST');render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
function render(d){content.hidden=false;const e=d.estimate||{},x=d.decision||{},b=d.billing||{},q=d.economics||{},gh=e.github_actions||{},cb=e.cloud_build||{},fs=e.firestore||{};const rows=[['PnL realizado 30 días',money(q.realized_pnl_30d_usd),Number(q.realized_pnl_30d_usd)>=0?'good':'bad'],['Costo infraestructura 30 días',money(q.infrastructure_cost_30d_usd),'warn'],['Neto real después de infraestructura',money(q.net_after_infrastructure_30d_usd),Number(q.net_after_infrastructure_30d_usd)>=0?'good':'bad'],['Operaciones cerradas 30 días',num(q.closed_trades_30d,0),''],['Costo de infraestructura por operación',q.infrastructure_cost_per_closed_trade_usd===null?'Sin base':money(q.infrastructure_cost_per_closed_trade_usd),'warn'],['Retorno mínimo por operación para cubrir infraestructura',q.minimum_return_per_trade_to_cover_infrastructure_pct===null?'Sin base':num(q.minimum_return_per_trade_to_cover_infrastructure_pct,4)+'%',q.minimum_return_per_trade_to_cover_infrastructure_pct>5?'bad':'warn'],['Costo mensual proyectado',money(e.projected_monthly_usd),''],['Tamaño configurado por operación',money(q.configured_position_size_usd),'']];cards.innerHTML=rows.map(c=>'<div class="card"><div class="label">'+c[0]+'</div><div class="value '+c[2]+'">'+c[1]+'</div></div>').join('');
const connected=b.connected===true;billing.innerHTML='<div class="pill '+(connected?'good':'warn')+'">'+(connected?'COSTO MEDIDO':'ESTIMACIÓN CONFIGURADA')+'</div><div class="value">'+String(q.cost_source||x.cost_source||'ESTIMATE')+'</div><div>'+(connected?'El costo de 30 días proviene de la fuente de facturación configurada.':'No fue posible leer una factura exacta. Se usa la estimación pública configurada y no se presenta como costo facturado.')+'</div>'+(b.error?'<div class="bad" style="margin-top:10px">'+b.error+'</div>':'');
decision.innerHTML='<div class="value '+(x.mode==='NORMAL'?'good':'warn')+'">'+String(x.mode||'UNKNOWN')+'</div><div>'+(x.reasons||[]).map(r=>'• '+r).join('<br>')+'</div><div class="note">Frecuencia de investigación: '+num(x.research_frequency_multiplier,0)+'×. Las ventas protectoras nunca se detienen por ahorro.</div>';
services.innerHTML=[['Cloud Run',e.cloud_run_usd],['GitHub Actions',gh.total_usd],['Cloud Build',cb.total_usd],['Firestore',fs.total_usd],['Cloud Scheduler',e.cloud_scheduler_usd],['Artifact Registry',e.artifact_registry_usd],['Cloud Logging',e.cloud_logging_usd],['Otros',e.other_monthly_usd]].map(v=>'<div class="row"><div class="wide"><b>'+v[0]+'</b></div><div>'+money(v[1])+'</div><div></div><div></div></div>').join('');
tasks.innerHTML=(e.tasks||[]).map(t=>'<div class="row"><div class="wide"><b>'+t.id+'</b></div><div><span class="label">Ejecuciones/mes</span><br>'+num(t.runs,0)+'</div><div><span class="label">Segundos</span><br>'+num(t.seconds,0)+'</div><div><span class="label">Costo</span><br>'+money(t.cloud_run.total_usd)+'</div></div>').join('');}
secret.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
