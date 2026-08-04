'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { runProfitTargetGovernance } = require('../services/spotProfitTargetGovernance');

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
    const result = await runProfitTargetGovernance(db, req.body || {});
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
</style></head><body><main class="wrap"><h1>Economía real del sistema</h1><div class="muted">Trading neto de comisiones menos infraestructura, con frecuencia completa</div><div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="loadData()">Actualizar</button><button onclick="recalculate()">Recalcular</button></div><div id="error" class="error"></div><div id="content" hidden><section id="cards" class="grid"></section><h2>Meta de rentabilidad</h2><div id="target" class="card"></div><h2>Fuente del costo</h2><div id="billing" class="card"></div><h2>Política operativa</h2><div id="decision" class="card"></div><h2>Costos estimados por servicio</h2><div id="services" class="card"></div><h2>Tareas de Cloud Run</h2><div id="tasks" class="card"></div></div><script>
const usd=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(Number(n||0));const clp=n=>new Intl.NumberFormat('es-CL',{style:'currency',currency:'CLP',maximumFractionDigits:0}).format(Number(n||0));const num=(n,d=2)=>n===null||n===undefined?'—':Number(n).toLocaleString('es-CL',{maximumFractionDigits:d});
async function request(path,method='GET'){const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);const r=await fetch(path,{method,headers:{'x-investments-secret':s,'Content-Type':'application/json'},body:method==='POST'?JSON.stringify({}):undefined});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));return d;}
async function loadData(){error.textContent='Consultando costos y meta...';try{const d=await request('/internal/spot-cost-governance/status');if(!d.latest){content.hidden=true;error.textContent='Aún no existe una medición. Pulsa Recalcular.';return;}render(d.latest);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
async function recalculate(){error.textContent='Calculando economía real...';try{const d=await request('/internal/cron/binance/spot-cost-governance','POST');render(d);error.textContent='';}catch(e){content.hidden=true;error.textContent=e.message;}}
function render(d){content.hidden=false;const e=d.estimate||{},x=d.decision||{},b=d.billing||{},q=d.economics||{},p=d.profit_target||{},fx=d.fx||{},gh=e.github_actions||{},cb=e.cloud_build||{},fs=e.firestore||{};const rows=[['PnL trading 30 días',usd(p.realized_trading_pnl_30d_usd??q.realized_pnl_30d_usd),Number(p.realized_trading_pnl_30d_usd??q.realized_pnl_30d_usd)>=0?'good':'bad'],['Costo efectivo 30 días',clp(p.effective_infrastructure_cost_clp),'warn'],['Neto después de infraestructura',clp(p.net_after_infrastructure_30d_clp),Number(p.net_after_infrastructure_30d_clp)>=0?'good':'bad'],['Meta total de trading',clp(p.target_trading_pnl_clp),''],['Ganancia neta objetivo',clp(p.target_net_profit_clp),'good'],['Avance de la meta',num(p.target_progress_pct,2)+'%',Number(p.target_progress_pct)>=100?'good':'warn'],['Falta para la meta',clp(p.remaining_to_profit_target_clp),Number(p.remaining_to_profit_target_clp)<=0?'good':'warn'],['Retorno mensual requerido sobre capital',p.required_monthly_return_on_current_capital_pct===null?'Sin base':num(p.required_monthly_return_on_current_capital_pct,2)+'%',Number(p.required_monthly_return_on_current_capital_pct)>100?'bad':'warn']];cards.innerHTML=rows.map(c=>'<div class="card"><div class="label">'+c[0]+'</div><div class="value '+c[2]+'">'+c[1]+'</div></div>').join('');
target.innerHTML='<div class="pill '+(p.status==='PROFIT_TARGET_MET'?'good':'warn')+'">'+String(p.status||'SIN DATOS')+'</div><div class="value">Costo piso '+clp(p.monthly_cost_floor_clp)+' + margen '+num(p.target_net_profit_margin_pct,0)+'%</div><div>La meta mensual exige '+clp(p.target_trading_pnl_clp)+' de PnL de trading neto de comisiones. Capital observado: '+usd(p.total_capital_usd)+'.</div>'+((p.warnings||[]).map(v=>'<div class="bad" style="margin-top:8px">• '+v+'</div>').join(''));
const connected=b.connected===true;billing.innerHTML='<div class="pill '+(connected?'good':'warn')+'">'+(connected?'COSTO MEDIDO':'PISO/ESTIMACIÓN')+'</div><div class="value">'+String(p.cost_source||q.cost_source||x.cost_source||'ESTIMATE')+'</div><div>Dólar observado: '+num(fx.clp_per_usd,2)+' CLP/USD · '+String(fx.source||'sin fuente')+'. El costo efectivo nunca baja del piso de '+clp(p.monthly_cost_floor_clp)+'.</div>'+(b.error?'<div class="bad" style="margin-top:10px">'+b.error+'</div>':'');
decision.innerHTML='<div class="value '+(p.status==='PROFIT_TARGET_MET'?'good':'warn')+'">FRECUENCIA COMPLETA</div><div>Los jobs de Discovery, Gem Radar, Adaptive, Quant y Promotion no se reducen por costo.</div><div class="note">Multiplicador: 1×. Las protecciones y ventas permanecen siempre activas. La meta económica informa el déficit; no obliga a aumentar el riesgo ni el tamaño de las posiciones.</div>';
services.innerHTML=[['Cloud Run',e.cloud_run_usd],['GitHub Actions',gh.total_usd],['Cloud Build',cb.total_usd],['Firestore',fs.total_usd],['Cloud Scheduler',e.cloud_scheduler_usd],['Artifact Registry',e.artifact_registry_usd],['Cloud Logging',e.cloud_logging_usd],['Otros',e.other_monthly_usd]].map(v=>'<div class="row"><div class="wide"><b>'+v[0]+'</b></div><div>'+usd(v[1])+'</div><div></div><div></div></div>').join('');
tasks.innerHTML=(e.tasks||[]).map(t=>'<div class="row"><div class="wide"><b>'+t.id+'</b></div><div><span class="label">Ejecuciones/mes</span><br>'+num(t.runs,0)+'</div><div><span class="label">Segundos</span><br>'+num(t.seconds,0)+'</div><div><span class="label">Costo</span><br>'+usd(t.cloud_run.total_usd)+'</div></div>').join('');}
secret.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
