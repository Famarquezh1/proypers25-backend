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
:root{color-scheme:dark;--bg:#071019;--side:#0b1621;--panel:#101d29;--panel2:#0b1722;--line:#213547;--text:#eff6fc;--muted:#8ea2b6;--good:#61d49b;--warn:#f2c66d;--bad:#ff7788;--accent:#7db2ff}*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,system-ui,sans-serif;overflow:hidden}.app{display:grid;grid-template-columns:250px 1fr;height:100vh}.sidebar{background:linear-gradient(180deg,#0c1925,#08121b);border-right:1px solid var(--line);display:flex;flex-direction:column;min-height:0}.brand{padding:20px 18px 16px;border-bottom:1px solid var(--line)}.brand strong{display:block;font-size:19px}.brand span{display:block;color:var(--muted);font-size:11px;margin-top:4px}.nav{padding:12px;overflow:auto}.nav button{width:100%;border:0;background:transparent;color:var(--muted);padding:11px 12px;border-radius:10px;text-align:left;cursor:pointer;display:flex;align-items:center;gap:10px;margin-bottom:4px;font-weight:700}.nav button:hover{background:#122334;color:var(--text)}.nav button.active{background:#eaf3fb;color:#071019}.dot{width:8px;height:8px;border-radius:50%;background:#637485;margin-left:auto}.dot.good{background:var(--good)}.dot.warn{background:var(--warn)}.dot.bad{background:var(--bad)}.sidefoot{padding:12px;border-top:1px solid var(--line)}.sidefoot button{width:100%;padding:10px;border:1px solid var(--line);background:#10202f;color:var(--text);border-radius:10px;cursor:pointer}.main{display:flex;flex-direction:column;min-width:0;min-height:0}.topbar{height:68px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:10px 18px;gap:12px;background:rgba(8,18,27,.94)}.crumb{font-weight:850}.crumb span{color:var(--muted);font-weight:500}.tools{display:flex;gap:8px;align-items:center}.tools input,.tools button{border:1px solid var(--line);background:#0d1924;color:var(--text);border-radius:9px;padding:9px 11px}.tools input{width:220px}.tools button{cursor:pointer;font-weight:800}.workspace{position:relative;flex:1;min-height:0;overflow:auto;background:radial-gradient(circle at top left,#12263a 0,#071019 48%)}.view{min-height:100%;padding:18px}.hidden{display:none!important}.panel,.card{background:linear-gradient(180deg,rgba(17,31,44,.97),rgba(10,21,31,.97));border:1px solid var(--line);border-radius:15px}.panel{padding:18px;margin-bottom:14px}.hero{display:grid;grid-template-columns:1.5fr .8fr;gap:14px}.gate{font-size:25px;font-weight:900;margin-top:7px}.sub{color:var(--muted);font-size:12px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:12px}.module{padding:15px;min-height:140px;display:flex;flex-direction:column;cursor:pointer;transition:.16s}.module:hover{transform:translateY(-2px);border-color:#53728f}.module h3{margin:10px 0 5px}.icon{font-size:22px}.meta{color:var(--muted);font-size:11px;margin-top:auto}.compare{display:grid;grid-template-columns:1fr 1fr;gap:14px}.table{width:100%;border-collapse:collapse}.table th,.table td{padding:10px 8px;border-bottom:1px solid var(--line);text-align:left}.table th{color:var(--muted)}.check{padding:14px;margin-bottom:10px}.checkhead{display:flex;justify-content:space-between;font-weight:800}.detail{color:var(--muted);font-size:12px;margin-top:8px}.frameview{padding:0;height:100%;min-height:100%}.framehead{height:52px;display:flex;align-items:center;justify-content:space-between;padding:8px 14px;border-bottom:1px solid var(--line);background:#0b1722}.framehead button,.framehead a{border:1px solid var(--line);background:#102131;color:var(--text);border-radius:8px;padding:8px 10px;text-decoration:none;cursor:pointer}.framewrap{height:calc(100vh - 120px);background:#fff}.framewrap iframe{width:100%;height:100%;border:0;background:#fff}#error{color:var(--bad);font-size:12px;padding:0 18px;min-height:18px}.mobileHome{display:none}@media(max-width:820px){body{overflow:auto}.app{display:block;height:auto;min-height:100vh}.sidebar{position:sticky;top:0;z-index:20;border-right:0;border-bottom:1px solid var(--line)}.brand{padding:11px 13px}.brand span{display:none}.nav{display:flex;padding:8px;overflow:auto}.nav button{width:auto;white-space:nowrap;margin:0 4px 0 0}.nav .dot{display:none}.sidefoot{display:none}.main{min-height:calc(100vh - 102px)}.topbar{height:auto;align-items:flex-start;padding:9px 12px;flex-direction:column}.tools{width:100%}.tools input{min-width:0;flex:1;width:auto}.workspace{min-height:calc(100vh - 150px)}.view{padding:12px}.hero,.compare{grid-template-columns:1fr}.framewrap{height:calc(100vh - 205px)}.mobileHome{display:inline-block}}
</style>
</head>
<body>
<div class="app">
  <aside class="sidebar">
    <div class="brand"><strong>Proypers25</strong><span>High Conviction Control Center</span></div>
    <nav id="sidebarNav" class="nav">
      <button data-kind="internal" data-view="home"><span>⌂</span> Home</button>
      <button data-kind="internal" data-view="comparison"><span>◈</span> CORE vs GEM</button>
      <button data-kind="internal" data-view="gate"><span>✓</span> Production Gate</button>
      <button data-kind="internal" data-view="settings"><span>⚙</span> Settings</button>
    </nav>
    <div class="sidefoot"><button id="sideRefresh" type="button">↻ Actualizar sistema</button></div>
  </aside>
  <main class="main">
    <header class="topbar">
      <div class="crumb"><span>Control Center / </span><b id="crumbTitle">Home</b></div>
      <div class="tools"><input id="secretInput" type="password" placeholder="Clave privada" autocomplete="current-password"><button id="loadButton" type="button">Acceder / actualizar</button></div>
    </header>
    <div id="error"></div>
    <section class="workspace">
      <div id="home" class="view internalView">
        <div class="hero"><div class="panel"><div class="sub">Estado general</div><div class="gate" id="headline">Ingrese la clave para cargar</div><div class="sub" id="generated"></div></div><div class="panel"><div class="sub">Modo operativo</div><div class="gate good">CONTROL ONLY</div><div class="sub">La navegación no modifica Spot, Binance, Scheduler ni capital.</div></div></div>
        <div id="modules" class="grid"></div>
      </div>
      <div id="comparison" class="view internalView hidden"><div class="panel"><div class="sub">Estrategia líder</div><div id="leader" class="gate">—</div></div><div id="compare" class="compare"></div></div>
      <div id="gate" class="view internalView hidden"><div class="panel"><div class="sub">Production Gate informativo</div><div id="gateStatus" class="gate">—</div></div><div id="checks"></div></div>
      <div id="settings" class="view internalView hidden"><div class="panel"><h2>Settings</h2><p class="sub">Vista de solo lectura. Este portal no habilita órdenes ni modifica la ejecución Spot.</p></div></div>
      <div id="frameView" class="frameview hidden"><div class="framehead"><div><button id="frameHome" class="mobileHome" type="button">⌂ Home</button> <b id="frameTitle">Módulo</b></div><a id="openExternal" href="#" target="_blank" rel="noopener">Abrir aparte ↗</a></div><div class="framewrap"><iframe id="moduleFrame" title="Módulo Proypers25"></iframe></div></div>
    </section>
  </main>
</div>
<script>
(() => {
  'use strict';
  const initialView = ${JSON.stringify(initialView)};
  const icons = {'CORE AI':'◈','GEM Hunter':'✦','Discovery':'⌁','Decision Engine':'◎','Shadow Portfolio':'◐','Portfolio':'▦','Binance':'₿','Learning':'↻','Analytics':'▥','Health':'♥','Logs':'≡','Settings':'⚙','Production Gate':'✓'};
  const el = {
    secret:document.getElementById('secretInput'),load:document.getElementById('loadButton'),error:document.getElementById('error'),headline:document.getElementById('headline'),generated:document.getElementById('generated'),modules:document.getElementById('modules'),leader:document.getElementById('leader'),compare:document.getElementById('compare'),gateStatus:document.getElementById('gateStatus'),checks:document.getElementById('checks'),nav:document.getElementById('sidebarNav'),crumb:document.getElementById('crumbTitle'),frameView:document.getElementById('frameView'),frame:document.getElementById('moduleFrame'),frameTitle:document.getElementById('frameTitle'),openExternal:document.getElementById('openExternal'),frameHome:document.getElementById('frameHome'),sideRefresh:document.getElementById('sideRefresh')
  };
  let state = null;
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when = value => value ? new Date(value).toLocaleString('es-CL') : 'Sin ciclo registrado';
  const cls = value => { const s=String(value||''); return s.includes('READY') || ['PASS','HEALTHY','AVAILABLE','ACTIVE'].includes(s) ? 'good' : s.includes('BLOCK') || s==='UNKNOWN' ? 'bad' : 'warn'; };
  function statusDot(status){ return cls(status); }
  function setActive(key){ document.querySelectorAll('#sidebarNav button').forEach(button => button.classList.toggle('active',(button.dataset.view||button.dataset.route)===key)); }
  function remember(value){ localStorage.setItem('proypers25_control_view',value); }
  function showInternal(name, updateHistory=true){
    document.querySelectorAll('.internalView').forEach(node=>node.classList.add('hidden'));
    el.frameView.classList.add('hidden');
    const target=document.getElementById(name)||document.getElementById('home');
    target.classList.remove('hidden');
    const titles={home:'Home',comparison:'CORE vs GEM',gate:'Production Gate',settings:'Settings'};
    el.crumb.textContent=titles[name]||'Home';
    setActive(name);
    remember('internal:'+name);
    if(updateHistory) history.replaceState(null,'','/dashboard'+(name==='home'?'':'/'+(name==='gate'?'production-gate':name)));
  }
  function openModule(name,route){
    document.querySelectorAll('.internalView').forEach(node=>node.classList.add('hidden'));
    el.frameView.classList.remove('hidden');
    el.frameTitle.textContent=name;
    el.crumb.textContent=name;
    el.frame.src=route;
    el.openExternal.href=route;
    setActive(route);
    remember('module:'+name+'|'+route);
    history.replaceState(null,'','/dashboard#module='+encodeURIComponent(name));
  }
  function buildNavigation(modules){
    el.nav.querySelectorAll('[data-dynamic="true"]').forEach(node=>node.remove());
    (modules||[]).filter(module=>!['Settings','Production Gate','CORE AI'].includes(module.name)).forEach(module=>{
      const button=document.createElement('button');
      button.dataset.dynamic='true';button.dataset.kind='module';button.dataset.route=module.route;button.dataset.name=module.name;
      button.innerHTML='<span>'+esc(icons[module.name]||'•')+'</span> '+esc(module.name)+'<i class="dot '+statusDot(module.status)+'"></i>';
      button.addEventListener('click',()=>openModule(module.name,module.route));
      el.nav.insertBefore(button,el.nav.querySelector('[data-view="settings"]'));
    });
  }
  function render(data){
    state=data;
    el.headline.textContent=data.production_gate?.status||'SIN DATOS';el.headline.className='gate '+cls(data.production_gate?.status);el.generated.textContent='Actualizado: '+when(data.generated_at);
    el.modules.innerHTML=(data.modules||[]).map(module=>'<div class="card module" data-name="'+esc(module.name)+'" data-route="'+esc(module.route)+'"><div class="icon">'+esc(icons[module.name]||'•')+'</div><h3>'+esc(module.name)+'</h3><div class="'+cls(module.status)+'">'+esc(module.status)+'</div><div class="meta">Último ciclo: '+esc(when(module.last_cycle_at))+'</div></div>').join('');
    el.modules.querySelectorAll('.module').forEach(card=>card.addEventListener('click',()=>{const n=card.dataset.name,r=card.dataset.route;if(n==='CORE AI')showInternal('comparison');else if(n==='Production Gate')showInternal('gate');else if(n==='Settings')showInternal('settings');else openModule(n,r);}));
    el.leader.textContent=data.comparison?.leader?.strategy||'Sin líder';el.leader.className='gate '+(data.comparison?.leader?.strategy?'good':'warn');
    const labels=[['Win Rate','win_rate_pct'],['Profit Factor','profit_factor'],['Expectancy','expectancy_usdt'],['Drawdown','drawdown_pct'],['Equity','equity_usdt'],['PnL','pnl_usdt'],['Operaciones','operations_count'],['Estado','status']];
    el.compare.innerHTML=[data.comparison?.core,data.comparison?.gem_hunter].filter(Boolean).map(strategy=>'<div class="panel"><h2>'+esc(strategy.strategy)+'</h2><table class="table"><tbody>'+labels.map(pair=>'<tr><th>'+pair[0]+'</th><td>'+esc(strategy[pair[1]])+'</td></tr>').join('')+'</tbody></table></div>').join('');
    el.gateStatus.textContent=data.production_gate?.status||'SIN DATOS';el.gateStatus.className='gate '+cls(data.production_gate?.status);
    el.checks.innerHTML=(data.production_gate?.checks||[]).map(check=>'<div class="card check"><div class="checkhead"><span>'+esc(check.name)+'</span><span class="'+cls(check.status)+'">'+esc(check.status)+'</span></div><div class="detail">'+esc(check.detail)+'</div></div>').join('');
    buildNavigation(data.modules);
  }
  async function load(){
    const secret=el.secret.value.trim();if(!secret){el.error.textContent='Ingrese la clave privada.';return;}localStorage.setItem('proypers25_summary_secret',secret);el.error.textContent='Cargando datos reales…';el.load.disabled=true;
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
    try{const response=await fetch('/internal/dashboard/control-center',{headers:{'x-investments-secret':secret},signal:controller.signal});const text=await response.text();let data;try{data=JSON.parse(text);}catch{throw new Error('Respuesta inválida del servidor ('+response.status+').');}if(!response.ok)throw new Error((data.error||'ERROR')+(data.details?' · '+data.details:''));render(data);el.error.textContent='';restoreLastView();}
    catch(error){el.headline.textContent='NO SE PUDO CARGAR';el.headline.className='gate bad';el.error.textContent=error.name==='AbortError'?'La consulta superó 20 segundos. Reintente.':error.message;}
    finally{clearTimeout(timeout);el.load.disabled=false;}
  }
  function restoreLastView(){
    const saved=localStorage.getItem('proypers25_control_view');if(!saved)return;
    if(saved.startsWith('internal:'))showInternal(saved.slice(9),false);
    else if(saved.startsWith('module:')){const payload=saved.slice(7);const split=payload.indexOf('|');if(split>0)openModule(payload.slice(0,split),payload.slice(split+1));}
  }
  el.nav.querySelectorAll('[data-kind="internal"]').forEach(button=>button.addEventListener('click',()=>showInternal(button.dataset.view)));
  el.load.addEventListener('click',load);el.sideRefresh.addEventListener('click',load);el.frameHome.addEventListener('click',()=>showInternal('home'));el.secret.addEventListener('keydown',event=>{if(event.key==='Enter')load();});
  el.secret.value=localStorage.getItem('proypers25_summary_secret')||'';
  showInternal(initialView==='production-gate'?'gate':initialView,false);
  if(el.secret.value)load();
})();
</script>
</body>
</html>`;

router.get('/dashboard', (_req, res) => res.type('html').send(page('home')));
router.get('/dashboard/comparison', (_req, res) => res.type('html').send(page('comparison')));
router.get('/dashboard/production-gate', (_req, res) => res.type('html').send(page('production-gate')));
router.get('/dashboard/settings', (_req, res) => res.type('html').send(page('settings')));

module.exports = router;
