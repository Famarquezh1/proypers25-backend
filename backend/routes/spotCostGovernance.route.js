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
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 · Costos</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#edf5ff}.wrap{max-width:1180px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap}.top input{flex:1;min-width:220px}.top input,.top button{padding:14px;border-radius:12px;border:1px solid #29415f;background:#0d1b2d;color:white}.top button{background:#e8edf4;color:#07111f;font-weight:800;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px;margin:18px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:18px;padding:18px}.label,.muted,.note{color:#91a8c2}.label{font-size:13px}.value{font-size:25px;font-weight:850;margin-top:7px}.good{color:#51d88a}.bad{color:#ff718a}.warn{color:#ffd166}h1{font-size:42px;margin:0 0 4px}h2{font-size:29px;margin:34px 0 16px}.row{display:grid;grid-template-columns:1.2fr 1fr 1fr 1fr;gap:10px;align-items:center;padding:12px 0;border-bottom:1px solid #203853}.row:last-child{border:0}.error{margin-top:14px;color:#ff718a}@media(max-width:680px){.wrap{padding:16px}h1{font-size:34px}.grid{grid-template-columns:1fr}.row{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}.value{font-size:28px}}
</style></head><body><main class="wrap"><h1>Costos y productividad</h1><div class="muted">Proypers25 · Estimación económica de infraestructura</div><div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button><button onclick="recalc()">Recalcular</button></div><div id="error" class="error"></div><div id="content" hidden><section id="cards" class="grid"></section><h2>Decisión económica</h2><div id="decision" class="card"></div><h2>Costo por tarea</h2><div id="tasks" class="card"></div><h2>Servicios incluidos</h2><div id="services" class="card"></div><h2>Alcance de la medición</h2><div class="card note">Los valores son estimaciones basadas en tarifas públicas y frecuencias configuradas. Para mostrar cargos exactos de la factura se debe habilitar Google Cloud Billing Export y conectar el reporte de uso de GitHub. Las salidas reales nunca se detienen por ahorro de infraestructura.</div></div><script>
const money=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(Number(n||0));const num=(n,d=2)=>Number(n||0).toLocaleString('es-CL',{maximumFractionDigits:d});
async function request(path,method='GET'){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);const r=await fetch(path,{method,headers:{'x-investments-secret':s,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify({}):undefined});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));return d;}
async function load(){error.textContent='Consultando costos...';try{const d=await request('/internal/spot-cost-governance/status');if(!d.latest){error.textContent='Aún no existe una medición. Pulsa Recalcular.';content.hidden=true;return;}render(d.latest);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
async function recalc(){error.textContent='Calculando productividad...';try{const d=await request('/internal/cron/binance/spot-cost-governance','POST');render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
function render(d){content.hidden=false;const e=d.estimate||{},x=d.decision||{},gh=e.github_actions||{};const cards=[['Costo mensual proyectado',money(e.projected_monthly_usd),'warn'],['PnL real 30 días',money(x.realized_pnl_30d_usd),x.realized_pnl_30d_usd>=0?'good':'bad'],['Neto después de infraestructura',money(x.projected_net_after_infrastructure_usd),x.projected_net_after_infrastructure_usd>=0?'good':'bad'],['Cloud Run proyectado',money(e.cloud_run_usd),''],['GitHub Actions proyectado',money(gh.total_usd),gh.total_usd>0?'warn':'good'],['Minutos GitHub',num(gh.total_minutes,0)+' / '+num(gh.included_minutes,0),''],['Participación del costo',x.cost_share_of_positive_pnl_pct===null?'Sin base positiva':num(x.cost_share_of_positive_pnl_pct)+'%',x.cost_share_of_positive_pnl_pct!==null&&x.cost_share_of_positive_pnl_pct>x.max_cost_share_pct?'bad':'good'],['Presupuesto mensual',money(x.monthly_budget_usd),'']];cardsEl.innerHTML=cards.map(c=>'<div class="card"><div class="label">'+c[0]+'</div><div class="value '+c[2]+'">'+c[1]+'</div></div>').join('');decision.innerHTML='<div class="value '+(x.mode==='NORMAL'?'good':'warn')+'">'+x.mode+'</div><div>'+(x.reasons||[]).map(r=>'• '+r).join('<br>')+'</div><div class="note">Multiplicador de frecuencia de investigación: '+x.research_frequency_multiplier+'×. Las ventas protectoras permanecen activas.</div>';tasks.innerHTML=(e.tasks||[]).map(t=>'<div class="row"><div class="wide"><b>'+t.id+'</b></div><div><span class="label">Ejecuciones/mes</span><br>'+num(t.runs,0)+'</div><div><span class="label">Segundos por corrida</span><br>'+num(t.seconds,0)+'</div><div><span class="label">Cloud Run</span><br>'+money(t.cloud_run.total_usd)+'</div></div>').join('');const p=d.pricing||{};services.innerHTML=['Cloud Run: CPU '+money(p.cloud_run?.cpu_per_vcpu_second)+'/vCPU-s; memoria '+money(p.cloud_run?.memory_per_gib_second)+'/GiB-s.','GitHub Actions Linux: '+money(p.github_actions?.linux_2_core_per_minute)+'/minuto sobre cuota.','Cloud Build: '+money(p.cloud_build?.e2_standard_2_per_minute)+'/minuto; '+num(p.cloud_build?.included_minutes,0)+' minutos incluidos.','Cloud Scheduler: '+money(p.cloud_scheduler?.per_job_month)+'/trabajo/mes; '+num(p.cloud_scheduler?.included_jobs,0)+' incluidos. Actualmente 0 configurados.','Firestore: lecturas '+money(p.firestore?.reads_per_100k)+'/100k; escrituras '+money(p.firestore?.writes_per_100k)+'/100k.','Artifact Registry: '+money(p.artifact_registry?.storage_per_gib_month)+'/GiB-mes sobre 0,5 GiB.','Cloud Logging: '+money(p.cloud_logging?.ingestion_per_gib)+'/GiB sobre 50 GiB/mes.'].map(v=>'<div style="padding:8px 0">'+v+'</div>').join('');}
const cardsEl=document.getElementById('cards');secret.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
