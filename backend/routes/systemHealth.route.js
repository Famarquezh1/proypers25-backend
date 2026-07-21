'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { assessPortfolioHealth, calculateSuggestedAllocation } = require('../services/spotPortfolioHealth');

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
  if (!expected) return res.status(503).json({ ok: false, error: 'SYSTEM_HEALTH_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

function toDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function ageMinutes(value) {
  const date = toDate(value);
  return date ? Math.max(0, (Date.now() - date.getTime()) / 60000) : null;
}

function freshness(value, warnMinutes, failMinutes) {
  const age = ageMinutes(value);
  if (age === null) return { state: 'UNKNOWN', age_minutes: null };
  if (age > failMinutes) return { state: 'RED', age_minutes: age };
  if (age > warnMinutes) return { state: 'YELLOW', age_minutes: age };
  return { state: 'GREEN', age_minutes: age };
}

function isBlockedGate(value) {
  return ['BLOCK', 'FAIL', 'FAILED', 'RED', 'UNHEALTHY'].includes(String(value || '').toUpperCase());
}

function firstExitFailure(cycleRun) {
  const failures = cycleRun?.exit_diagnostics?.failures;
  return Array.isArray(failures) && failures.length ? failures[0] : null;
}

function exitDetail(cycleRun, control) {
  if (!cycleRun) return 'Sin ciclo real registrado';
  const failure = firstExitFailure(cycleRun);
  if (failure) {
    const subject = failure.symbol || failure.position_id || 'posición no identificada';
    const cause = failure.reason || failure.message || 'causa no informada';
    const stage = failure.stage ? ` · etapa ${failure.stage}` : '';
    return `${subject}: ${cause}${stage}`;
  }
  if (isBlockedGate(cycleRun?.gates?.exit_engine)) {
    const reasons = cycleRun?.exit_diagnostics?.failure_reasons || cycleRun?.reasons || [];
    return Array.isArray(reasons) && reasons.length ? reasons.join(' · ') : 'Motor bloqueado sin detalle disponible';
  }
  if (control?.real_sells_enabled !== true) return 'Ventas automáticas no habilitadas';
  if (control?.auto_order_execution !== true) return 'Ejecución automática no habilitada';
  return 'Último ciclo procesó el motor de salidas sin bloqueo';
}

async function safeDoc(path) {
  try {
    const snap = await db.doc(path).get();
    return snap.exists ? snap.data() : null;
  } catch (error) {
    return { _error: error.message };
  }
}

async function safeLatest(collection, orderField) {
  try {
    const snap = await db.collection(collection).orderBy(orderField, 'desc').limit(1).get();
    return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
  } catch (error) {
    return { _error: error.message };
  }
}

async function buildHealth() {
  const [control, balance, adaptive, promotion, champion, cost, quantRun, adaptiveRun, discoveryRun, costRun, reconciliationRun, cycleRun, openPositions] = await Promise.all([
    safeDoc('real_spot_config/control'),
    safeDoc('real_spot_config/balance'),
    safeDoc('real_spot_config/adaptive_strategy'),
    safeDoc('real_spot_config/strategy_promotion'),
    safeDoc('spot_quant_champions/current'),
    safeDoc('real_spot_config/cost_governance'),
    safeLatest('spot_quant_research_runs', 'created_at'),
    safeLatest('spot_adaptive_strategy_runs', 'created_at'),
    safeLatest('spot_new_asset_discovery_runs', 'created_at'),
    safeLatest('spot_cost_governance_runs', 'created_at'),
    safeLatest('real_spot_reconciliations', 'created_at'),
    safeLatest('real_spot_cycle_decisions', 'timestamp'),
    db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get()
  ]);

  const promotionState = promotion?.state || 'NOT_INITIALIZED';
  const promotionFreshness = freshness(promotion?.updated_at || promotion?.created_at, 150, 300);
  const exitGate = cycleRun?.gates?.exit_engine || null;
  const exitBlocked = isBlockedGate(exitGate)
    || cycleRun?.exit_diagnostics?.blocked === true
    || cycleRun?.exit_diagnostics?.healthy === false
    || Number(cycleRun?.execution?.exit_failures || cycleRun?.exit_diagnostics?.failure_count || 0) > 0;
  const exitStatus = cycleRun ? {
    ok: !exitBlocked,
    blocked: exitBlocked,
    exit_engine_healthy: !exitBlocked,
    failures: cycleRun?.exit_diagnostics?.failures || []
  } : null;
  const portfolioHealth = assessPortfolioHealth({
    config: control,
    reconciliation: reconciliationRun,
    exitStatus,
    balance,
    adaptive,
    promotion
  });
  const allocationAdvisory = calculateSuggestedAllocation(balance, control, portfolioHealth.state);
  const exitsConfigured = control?.real_sells_enabled === true && control?.auto_order_execution === true;

  const components = [
    {
      id: 'portfolio_health', label: 'Salud del portafolio',
      state: portfolioHealth.state === 'HEALTHY' ? 'GREEN' : portfolioHealth.state === 'DEGRADED' ? 'YELLOW' : 'RED',
      detail: portfolioHealth.critical_reasons[0] || portfolioHealth.degraded_reasons[0] || 'Entradas y salidas coherentes',
      updated_at: cycleRun?.timestamp || reconciliationRun?.created_at || balance?.updated_at || null
    },
    {
      id: 'real_spot', label: 'Motor Spot real',
      state: control && control.enabled === true && control.kill_switch !== true && control.real_sells_enabled === true ? 'GREEN' : 'RED',
      detail: control ? (control.entry_block_reason || 'Configuración cargada') : 'Sin configuración',
      updated_at: control?.updated_at || control?.reconciliation_gate_released_at || null
    },
    {
      id: 'exit_engine', label: 'Motor de salidas',
      state: !exitsConfigured || exitBlocked ? 'RED' : 'GREEN',
      detail: exitDetail(cycleRun, control),
      updated_at: cycleRun?.timestamp || control?.updated_at || null
    },
    {
      id: 'reconciliation', label: 'Reconciliación Binance',
      state: control && control.reconciliation_required !== true && control.account_consistent !== false ? 'GREEN' : 'RED',
      detail: control?.account_consistent === false ? 'Cuenta inconsistente' : 'Sin bloqueo de reconciliación',
      updated_at: reconciliationRun?.created_at || control?.reconciliation_gate_released_at || control?.updated_at || null
    },
    {
      id: 'discovery', label: 'Descubrimiento de activos',
      ...freshness(discoveryRun?.created_at || discoveryRun?.detected_at, 75, 150),
      detail: discoveryRun?._error || (discoveryRun ? 'Última búsqueda registrada' : 'Sin ejecución registrada'),
      updated_at: discoveryRun?.created_at || discoveryRun?.detected_at || null
    },
    {
      id: 'adaptive', label: 'Estrategia adaptativa',
      ...freshness(adaptive?.updated_at || adaptiveRun?.created_at, 150, 300),
      detail: adaptive?._error || adaptive?.state || adaptiveRun?.decision?.state || 'Sin estado',
      updated_at: adaptive?.updated_at || adaptiveRun?.created_at || null
    },
    {
      id: 'promotion', label: 'Promoción Paper → Real',
      state: promotionState === 'PROMOTED_LIMITED' ? promotionFreshness.state : 'YELLOW',
      detail: promotion?._error || `${promotionState}${promotion?.symbol ? ` · ${promotion.symbol}` : ''}`,
      updated_at: promotion?.updated_at || promotion?.created_at || null
    },
    {
      id: 'quant', label: 'Laboratorio cuantitativo',
      ...freshness(quantRun?.created_at, 300, 600),
      detail: quantRun?._error || (quantRun ? 'Walk-forward actualizado' : 'Sin ejecución registrada'),
      updated_at: quantRun?.created_at || null
    },
    {
      id: 'costs', label: 'Gobernanza de costos',
      ...freshness(cost?.updated_at || costRun?.created_at, 420, 840),
      detail: cost?._error || cost?.current_mode || costRun?.decision?.mode || 'Sin medición',
      updated_at: cost?.updated_at || costRun?.created_at || null
    },
    {
      id: 'scheduler_auth', label: 'Autenticación scheduler',
      state: process.env.CRON_SECRET ? 'GREEN' : 'RED',
      detail: process.env.CRON_SECRET ? 'CRON_SECRET cargado en Cloud Run' : 'CRON_SECRET ausente',
      updated_at: null
    }
  ];

  const red = components.filter((item) => item.state === 'RED').length;
  const yellow = components.filter((item) => item.state === 'YELLOW' || item.state === 'UNKNOWN').length;
  const overall = red > 0 ? 'RED' : yellow > 0 ? 'YELLOW' : 'GREEN';

  return {
    ok: true,
    generated_at: new Date().toISOString(),
    overall,
    summary: { green: components.filter((item) => item.state === 'GREEN').length, yellow, red },
    open_positions: openPositions.size,
    limits: {
      max_position_usdt: Number(control?.max_position_usdt || 0),
      max_open_positions: Number(control?.max_open_positions || 0),
      max_total_capital_usdt: Number(control?.max_total_capital_usdt || 0)
    },
    portfolio: {
      ...portfolioHealth,
      allocation_advisory: allocationAdvisory,
      current_balance: balance || null
    },
    latest_cycle: cycleRun ? {
      timestamp: cycleRun.timestamp || null,
      decision: cycleRun.decision || null,
      action: cycleRun.action || null,
      reason: cycleRun.reason || null,
      reasons: cycleRun.reasons || [],
      gates: cycleRun.gates || {},
      execution: cycleRun.execution || {},
      exit_diagnostics: cycleRun.exit_diagnostics || null
    } : null,
    intelligence: {
      champion_symbol: champion?.symbol || null,
      champion_eligible: champion?.promotion_eligible === true,
      market_regime: adaptive?.regime?.regime || null,
      strategy_state: adaptive?.state || null,
      promotion_state: promotionState,
      promotion_reasons: promotion?.reasons || [],
      paper_validations: Number(promotion?.paper?.validations || 0),
      real_trades: Number(promotion?.real?.trades || 0),
      real_expectancy: promotion?.real?.expectancy ?? null,
      real_profit_factor: promotion?.real?.profit_factor ?? null,
      expectancy_gap: promotion?.divergence?.expectancy_gap ?? null
    },
    components
  };
}

router.get('/internal/system-health/status', requireSecret, async (_req, res) => {
  try {
    return res.json(await buildHealth());
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'SYSTEM_HEALTH_FAILED', details: error.message });
  }
});

router.get('/system-health-dashboard', (_req, res) => {
  res.type('html').send(`<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Proypers25 · Salud</title><style>
:root{color-scheme:dark;font-family:Inter,system-ui,sans-serif}*{box-sizing:border-box}body{margin:0;background:#07111f;color:#edf5ff}.wrap{max-width:1120px;margin:auto;padding:20px}.top{display:flex;gap:10px;flex-wrap:wrap}.top input{flex:1;min-width:220px}.top input,.top button{padding:14px;border-radius:12px;border:1px solid #29415f;background:#0d1b2d;color:white}.top button{background:#e8edf4;color:#07111f;font-weight:800}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:18px 0}.card{background:#0d1b2d;border:1px solid #203853;border-radius:18px;padding:18px}.label,.muted{color:#91a8c2}.value{font-size:26px;font-weight:850;margin-top:7px}.green{color:#51d88a}.yellow{color:#ffd166}.red{color:#ff718a}h1{font-size:40px;margin:0}h2{margin-top:32px}.row{display:grid;grid-template-columns:1.3fr .7fr 1.4fr 1fr;gap:10px;align-items:center;padding:14px 0;border-bottom:1px solid #203853}.dot{width:12px;height:12px;border-radius:50%;display:inline-block;margin-right:8px;background:currentColor}.error{color:#ff718a;margin-top:12px}.failure{border-left:4px solid #ff718a;margin-top:10px}.failure-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px;margin-top:12px}@media(max-width:680px){.row{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}h1{font-size:34px}}
</style></head><body><main class="wrap"><h1>Salud del sistema</h1><div class="muted">Proypers25 · Spot real, portafolio, investigación, promoción y costos</div><div class="top"><input id="secret" type="password" placeholder="Clave privada"><button onclick="load()">Actualizar</button></div><div id="error" class="error"></div><section id="summary" class="grid"></section><h2>Último ciclo Spot real</h2><section id="cycle" class="card"></section><div id="exitFailures"></div><h2>Portafolio</h2><section id="portfolio" class="grid"></section><h2>Inteligencia y promoción</h2><section id="intelligence" class="grid"></section><div id="components" class="card" hidden></div><script>
const date=v=>v?new Intl.DateTimeFormat('es-CL',{dateStyle:'short',timeStyle:'short'}).format(new Date(v)):'—';const cls=s=>String(s||'UNKNOWN').toLowerCase();const pct=v=>v===null||v===undefined?'—':(Number(v)*100).toFixed(2)+'%';const usd=v=>'US$ '+Number(v||0).toFixed(2);const text=v=>v===null||v===undefined||v===''?'—':String(v);
async function load(){error.textContent='Consultando salud...';try{const s=secret.value;localStorage.setItem('proypers25_summary_secret',s);const r=await fetch('/internal/system-health/status',{headers:{'x-investments-secret':s}});const d=await r.json();if(!r.ok)throw new Error(d.error+(d.details?' · '+d.details:''));render(d);error.textContent='';}catch(e){components.hidden=true;error.textContent=e.message;}}
function render(d){summary.innerHTML=[['Estado general',d.overall,cls(d.overall)],['Componentes sanos',d.summary.green,'green'],['Advertencias',d.summary.yellow,'yellow'],['Bloqueos',d.summary.red,'red'],['Posiciones abiertas',d.open_positions,''],['Límite actual',usd(d.limits.max_position_usdt),'']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');const c=d.latest_cycle||{},g=c.gates||{},x=c.execution||{},ed=c.exit_diagnostics||{},blocked=['BLOCK','FAIL','FAILED','RED','UNHEALTHY'].includes(String(g.exit_engine||'').toUpperCase())||Number(x.exit_failures||ed.failure_count||0)>0;cycle.innerHTML='<div class="grid"><div><div class="label">Fecha</div><b>'+date(c.timestamp)+'</b></div><div><div class="label">Decisión</div><b>'+text(c.decision)+'</b></div><div><div class="label">Acción</div><b>'+text(c.action)+'</b></div><div><div class="label">Motor de salidas</div><b class="'+(blocked?'red':'green')+'">'+text(g.exit_engine)+'</b></div><div><div class="label">Fallos de salida</div><b class="'+(Number(x.exit_failures||ed.failure_count||0)>0?'red':'green')+'">'+Number(x.exit_failures||ed.failure_count||0)+'</b></div></div><div class="muted">Motivo: '+text(c.reason)+'</div>';const failures=Array.isArray(ed.failures)?ed.failures:[];exitFailures.innerHTML=failures.map(f=>'<div class="card failure"><b class="red">'+text(f.symbol||f.position_id||'Salida fallida')+'</b><div class="failure-grid"><div><div class="label">Causa</div><b>'+text(f.reason||f.message)+'</b></div><div><div class="label">Etapa</div><b>'+text(f.stage)+'</b></div><div><div class="label">Reintentable</div><b>'+text(f.retryable)+'</b></div><div><div class="label">Intento</div><b>'+text(f.attempt)+'</b></div><div><div class="label">Recuperación</div><b>'+text(f.retry_state||ed.recovery_state)+'</b></div></div></div>').join('');const p=d.portfolio||{},a=p.allocation_advisory||{};portfolio.innerHTML=[['Salud',p.state||'—',p.state==='HEALTHY'?'green':p.state==='DEGRADED'?'yellow':'red'],['Entrada permitida',p.entry_allowed?'Sí':'No',p.entry_allowed?'green':'red'],['Salida permitida',p.exit_allowed?'Sí':'No',p.exit_allowed?'green':'red'],['Patrimonio',usd(a.total_portfolio_usdt),''],['USDT disponible',usd(a.available_usdt),''],['En posiciones',usd(a.in_positions_usdt),''],['Reserva sugerida',usd(a.reserve_usdt),''],['Tamaño sugerido',usd(a.suggested_position_usdt),'']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');const i=d.intelligence||{};intelligence.innerHTML=[['Campeón actual',i.champion_symbol||'—',''],['Régimen',i.market_regime||'—',''],['Promoción',i.promotion_state||'—',i.promotion_state==='PROMOTED_LIMITED'?'green':'yellow'],['Validaciones Paper',i.paper_validations||0,''],['Operaciones reales',i.real_trades||0,''],['Expectancy real',pct(i.real_expectancy),Number(i.real_expectancy||0)>=0?'green':'red'],['Profit factor real',i.real_profit_factor===null?'—':Number(i.real_profit_factor).toFixed(2),Number(i.real_profit_factor||0)>=1.05?'green':'yellow'],['Brecha Paper/Real',pct(i.expectancy_gap),i.expectancy_gap!==null&&Number(i.expectancy_gap)>0.02?'red':'green']].map(x=>'<div class="card"><div class="label">'+x[0]+'</div><div class="value '+x[2]+'">'+x[1]+'</div></div>').join('');components.hidden=false;components.innerHTML=d.components.map(c=>'<div class="row"><div class="wide"><b>'+c.label+'</b></div><div class="'+cls(c.state)+'"><span class="dot"></span><b>'+c.state+'</b></div><div>'+c.detail+'</div><div class="muted">'+date(c.updated_at)+'</div></div>').join('');}
secret.value=localStorage.getItem('proypers25_summary_secret')||'';</script></main></body></html>`);
});

module.exports = router;
