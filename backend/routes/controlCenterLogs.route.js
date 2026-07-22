'use strict';

const express = require('express');

const router = express.Router();

router.get('/control-center/logs', (_req, res) => {
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proypers25 · Logs</title>
<style>
:root{color-scheme:dark;--bg:#081018;--panel:#101b26;--line:#203244;--text:#eff6fc;--muted:#8ea2b6;--good:#61d49b;--warn:#f2c66d;--bad:#ff7788}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px Inter,system-ui,sans-serif}.wrap{max-width:1250px;margin:auto;padding:20px}.top{display:flex;justify-content:space-between;gap:12px;align-items:center;margin-bottom:18px}.title{font-size:28px;font-weight:900}.sub{color:var(--muted)}button{border:1px solid var(--line);background:#eaf2fa;color:#07101a;border-radius:10px;padding:10px 14px;font-weight:850;cursor:pointer}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px;margin:16px 0}.card{background:var(--panel);border:1px solid var(--line);border-radius:14px;padding:15px}.label{font-size:11px;color:var(--muted);text-transform:uppercase}.value{font-size:20px;font-weight:850;margin-top:6px}.good{color:var(--good)}.warn{color:var(--warn)}.bad{color:var(--bad)}.row{display:grid;grid-template-columns:170px 150px 1fr;gap:12px;padding:12px 0;border-bottom:1px solid var(--line)}.row:last-child{border-bottom:0}.error{color:var(--bad);margin:12px 0}.empty{color:var(--muted);padding:18px 0}@media(max-width:720px){.top{align-items:flex-start;flex-direction:column}.row{grid-template-columns:1fr}.wrap{padding:14px}}
</style>
</head>
<body>
<main class="wrap">
  <div class="top"><div><div class="title">Logs y actividad Spot</div><div class="sub">Ciclos, scheduler y eventos recientes del backend.</div></div><button id="refresh" type="button">Actualizar</button></div>
  <div id="error" class="error"></div>
  <section id="summary" class="grid"></section>
  <section class="card"><div class="label">Actividad reciente</div><div id="rows"></div></section>
</main>
<script>
(() => {
  'use strict';
  const el={refresh:document.getElementById('refresh'),error:document.getElementById('error'),summary:document.getElementById('summary'),rows:document.getElementById('rows')};
  const esc=v=>String(v??'—').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const when=v=>v?new Date(v).toLocaleString('es-CL'):'Sin registro';
  const card=(label,value,klass='')=>'<div class="card"><div class="label">'+esc(label)+'</div><div class="value '+klass+'">'+esc(value)+'</div></div>';
  async function load(){
    const secret=(localStorage.getItem('proypers25_summary_secret')||'').trim();
    if(!secret){el.error.textContent='La clave privada no está disponible. Regrese al Home e ingrésela nuevamente.';return;}
    el.error.textContent='Cargando actividad…';el.refresh.disabled=true;
    const controller=new AbortController();const timeout=setTimeout(()=>controller.abort(),20000);
    try{
      const response=await fetch('/internal/spot-live/evidence',{headers:{'x-investments-secret':secret},signal:controller.signal});
      const text=await response.text();let data;try{data=JSON.parse(text)}catch{throw new Error('Respuesta inválida del servidor.')}
      if(!response.ok)throw new Error((data.error||'ERROR')+(data.details?' · '+data.details:''));
      const cycle=data.latest_cycle||{};const scheduler=data.scheduler||{};const activity=Array.isArray(data.activity)?data.activity:[];
      el.summary.innerHTML=card('Último ciclo',when(cycle.timestamp))+card('Decisión',cycle.decision||'Sin decisión',cycle.decision==='EXECUTED'?'good':'warn')+card('Scheduler',scheduler.result||'Sin resultado',scheduler.error?'bad':'good')+card('Eventos',activity.length);
      el.rows.innerHTML=activity.length?activity.map(item=>'<div class="row"><div>'+esc(when(item.created_at||item.timestamp))+'</div><div><b>'+esc(item.type||item.action||item.event||'EVENT')+'</b></div><div>'+esc(item.message||item.reason||item.detail||JSON.stringify(item))+'</div></div>').join(''):'<div class="empty">No existen eventos recientes.</div>';
      el.error.textContent='';
    }catch(error){el.error.textContent=error.name==='AbortError'?'La carga superó 20 segundos. Reintente.':error.message;}finally{clearTimeout(timeout);el.refresh.disabled=false;}
  }
  el.refresh.addEventListener('click',load);load();
})();
</script>
</body>
</html>`);
});

module.exports = router;
