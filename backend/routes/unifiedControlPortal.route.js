'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getUnifiedControlPortal } = require('../services/unifiedControlPortal');

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

router.get('/internal/dashboard/control-center', privateOnly, async (_req, res) => {
  try {
    return res.json(await getUnifiedControlPortal(db));
  } catch (error) {
    console.error('[UNIFIED_PORTAL] failed:', error?.message || error);
    return res.status(500).json({ ok: false, error: 'UNIFIED_PORTAL_FAILED', details: error?.message || String(error) });
  }
});

const page = (initialView = 'home') => `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proypers25 Control Center</title>
<style>
:root{color-scheme:dark;--bg:#081018;--panel:#101b26;--line:#203244;--text:#eff6fc;--muted:#8ea2b6;--good:#61d49b;--warn:#f2c66d;--bad:#ff7788}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top left,#122235 0,#081018 42%);color:var(--text);font:14px Inter,system-ui,sans-serif}.shell{max-width:1400px;margin:auto;padding:18px}.top{display:flex;justify-content:space-between;gap:14px;align-items:center;padding:10px 0 20px}.brand{font-size:22px;font-weight:900}.sub{color:var(--muted);font-size:12px}.tools{display:flex;gap:8px;flex-wrap:wrap}.tools input,.tools button{border:1px solid var(--line);background:#0d1721;color:var(--text);border-radius:10px;padding:11px 12px}.tools input{min-width:240px}.tools button{font-weight:800;cursor:pointer}.nav{display:flex;gap:8px;overflow:auto;padding-bottom:14px}.nav button{border:1px solid var(--line);background:transparent;color:var(--muted);padding:9px 12px;border-radius:999px;white-space:nowrap}.nav button.active{background:var(--text);color:#07101a}.panel,.card{background:linear-gradient(180deg,rgba(18,30,42,.96),rgba(12,22,31,.96));border:1px solid var(--line);border-radius:16px}.panel{padding:20px;margin-bottom:14px}.gate{font-size:25px;font-weight:900;margin-top:8px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(205px,1fr));gap:12px}.module{padding:16px;min-height:145px;text-decoration:none;color:inherit;display:flex;flex-direction:column}.module h3{margin:8px 0}.meta{color:var(--muted);font-size:11px;margin-top:auto}.compare{display:grid;grid-template-columns:1fr 1fr;gap:14px}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left}.table th{color:var(--muted)}.check{padding:14px;margin-bottom:10px}.checkhead{display:flex;justify-content:space-between;font-weight:800}.detail{color:var(--muted);font-size:12px;margin-top:8px}.hidden{display:none}#error{padding:8px 0;color:var(--bad);white-space:pre-wrap}@media(max-width:760px){.top{align-items:flex-start;flex-direction:column}.tools{width:100%}.tools input{min-width:0;flex:1}.compare{grid-template-columns:1fr}.shell{padding:12px}}
</style>
</head>
<body>
<main class="shell">
<header class="top"><div><div class="brand">Proypers25 Control Center</div><div class="sub">Portal unificado de observación, comparación y control</div></div><div class="tools"><input id="secretInput" type="password" placeholder="Clave privada" autocomplete="current-password"><button id="loadButton" type="button">Acceder / actualizar</button></div></header>
<nav class="nav"><button data-view="home">Home</button><button data-view="comparison">CORE vs GEM</button><button data-view="gate">Production Gate</button><button data-view="settings">Settings</button></nav>
<div id="error"></div>
<section id="home" class="view"><div class="panel"><div class="sub">Estado general</div><div class="gate" id="headline">Ingrese la clave para cargar</div><div class="sub" id="generated"></div></div><div id="modules" class="grid"></div></section>
<section id="comparison" class="view hidden"><div class="panel"><div class="sub">Estrategia líder</div><div id="leader" class="gate">—</div></div><div id="compare" class="compare"></div></section>
<section id="gate" class="view hidden"><div class="panel"><div class="sub">Production Gate informativo</div><div id="gateStatus" class="gate">—</div></div><div id="checks"></div></section>
<section id="settings" class="view hidden"><div class="panel"><h2>Settings</h2><p class="sub">Vista de solo lectura. Este portal no habilita órdenes ni modifica la ejecución Spot.</p></div></section>
</main>
<script>
(() => {
  'use strict';
  const initialView = ${JSON.stringify(initialView)};
  const el = {
    secret: document.getElementById('secretInput'),
    load: document.getElementById('loadButton'),
    error: document.getElementById('error'),
    headline: document.getElementById('headline'),
    generated: document.getElementById('generated'),
    modules: document.getElementById('modules'),
    leader: document.getElementById('leader'),
    compare: document.getElementById('compare'),
    gateStatus: document.getElementById('gateStatus'),
    checks: document.getElementById('checks')
  };
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value ? new Date(value).toLocaleString('es-CL') : 'Sin ciclo registrado';
  const cls = value => { const s=String(value||''); return s.includes('READY') || ['PASS','HEALTHY','AVAILABLE','ACTIVE'].includes(s) ? 'good' : s.includes('BLOCK') || s==='UNKNOWN' ? 'bad' : 'warn'; };
  function show(name) {
    document.querySelectorAll('.view').forEach(node => node.classList.add('hidden'));
    const target = document.getElementById(name);
    if (target) target.classList.remove('hidden');
    document.querySelectorAll('.nav button').forEach(button => button.classList.toggle('active', button.dataset.view === name));
    history.replaceState(null, '', name === 'home' ? '/dashboard' : '/dashboard/' + (name === 'gate' ? 'production-gate' : name));
  }
  function render(state) {
    el.headline.textContent = state.production_gate?.status || 'SIN DATOS';
    el.headline.className = 'gate ' + cls(state.production_gate?.status);
    el.generated.textContent = 'Actualizado: ' + when(state.generated_at);
    el.modules.innerHTML = (state.modules || []).map(module => '<a class="card module" href="'+esc(module.route)+'"><h3>'+esc(module.name)+'</h3><div class="'+cls(module.status)+'">'+esc(module.status)+'</div><div class="meta">Último ciclo: '+esc(when(module.last_cycle_at))+'</div></a>').join('');
    el.leader.textContent = state.comparison?.leader?.strategy || 'Sin líder';
    el.leader.className = 'gate ' + (state.comparison?.leader?.strategy ? 'good' : 'warn');
    const labels=[['Win Rate','win_rate_pct'],['Profit Factor','profit_factor'],['Expectancy','expectancy_usdt'],['Drawdown','drawdown_pct'],['Equity','equity_usdt'],['PnL','pnl_usdt'],['Operaciones','operations_count'],['Estado','status']];
    el.compare.innerHTML = [state.comparison?.core,state.comparison?.gem_hunter].filter(Boolean).map(strategy => '<div class="panel"><h2>'+esc(strategy.strategy)+'</h2><table class="table"><tbody>'+labels.map(([label,key]) => '<tr><th>'+label+'</th><td>'+esc(strategy[key])+'</td></tr>').join('')+'</tbody></table></div>').join('');
    el.gateStatus.textContent = state.production_gate?.status || 'SIN DATOS';
    el.gateStatus.className = 'gate ' + cls(state.production_gate?.status);
    el.checks.innerHTML = (state.production_gate?.checks || []).map(check => '<div class="card check"><div class="checkhead"><span>'+esc(check.name)+'</span><span class="'+cls(check.status)+'">'+esc(check.status)+'</span></div><div class="detail">'+esc(check.detail)+'</div></div>').join('');
  }
  async function load() {
    const secret = el.secret.value.trim();
    if (!secret) { el.error.textContent = 'Ingrese la clave privada.'; return; }
    localStorage.setItem('proypers25_summary_secret', secret);
    el.error.textContent = 'Cargando datos reales…';
    el.load.disabled = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch('/internal/dashboard/control-center', { headers: { 'x-investments-secret': secret }, signal: controller.signal });
      const text = await response.text();
      let data;
      try { data = JSON.parse(text); } catch { throw new Error('Respuesta inválida del servidor (' + response.status + ').'); }
      if (!response.ok) throw new Error((data.error || 'ERROR') + (data.details ? ' · ' + data.details : ''));
      render(data);
      el.error.textContent = '';
    } catch (error) {
      el.headline.textContent = 'NO SE PUDO CARGAR';
      el.headline.className = 'gate bad';
      el.error.textContent = error.name === 'AbortError' ? 'La consulta superó 20 segundos. Reintente.' : error.message;
    } finally {
      clearTimeout(timeout);
      el.load.disabled = false;
    }
  }
  document.querySelectorAll('.nav button').forEach(button => button.addEventListener('click', () => show(button.dataset.view)));
  el.load.addEventListener('click', load);
  el.secret.addEventListener('keydown', event => { if (event.key === 'Enter') load(); });
  el.secret.value = localStorage.getItem('proypers25_summary_secret') || '';
  show(initialView === 'production-gate' ? 'gate' : initialView);
  if (el.secret.value) load();
})();
</script>
</body>
</html>`;

router.get('/dashboard', (_req, res) => res.type('html').send(page('home')));
router.get('/dashboard/comparison', (_req, res) => res.type('html').send(page('comparison')));
router.get('/dashboard/production-gate', (_req, res) => res.type('html').send(page('production-gate')));
router.get('/dashboard/settings', (_req, res) => res.type('html').send(page('settings')));

module.exports = router;
