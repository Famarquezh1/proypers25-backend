'use strict';

const express = require('express');
const router = express.Router();

router.get('/investments-dashboard', (_req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0');
  res.type('html').send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="dark">
<title>Proypers25 · Spot Real</title>
<style>
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#070b12;color:#f4f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}body{background:radial-gradient(circle at top right,#13213a 0,#070b12 38%)}main{max-width:1200px;margin:auto;padding:20px 16px 40px}h1{margin:0;font-size:32px}h2{font-size:18px;margin:0 0 12px}.muted{color:#91a0b6}.top{display:flex;gap:18px;justify-content:space-between;align-items:flex-start}.auth{display:flex;gap:8px;min-width:360px}.auth input{min-width:0;flex:1;background:#0d131d;border:1px solid #2b3a50;border-radius:10px;padding:12px;color:white;font-size:16px}.auth button{border:0;border-radius:10px;background:#4d8dff;color:white;font-weight:800;padding:12px 17px;font-size:16px}.msg{min-height:24px;margin:14px 0;color:#ff6b7e}.section{margin-top:24px}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{background:#0d131d;border:1px solid #26354a;border-radius:12px;padding:14px;min-height:98px}.label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#91a0b6}.value{font-size:22px;font-weight:850;margin-top:7px;overflow-wrap:anywhere}.detail{font-size:12px;color:#91a0b6;margin-top:6px}.ok{color:#22c983}.bad{color:#ff5d72}.warn{color:#f5c451}.wide{grid-column:span 2}.symbols{font-size:18px;line-height:1.5}.tablewrap{overflow:auto;border:1px solid #26354a;border-radius:12px;background:#0d131d}table{width:100%;border-collapse:collapse;min-width:720px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid #26354a;white-space:nowrap}th{font-size:11px;text-transform:uppercase;color:#91a0b6}.pill{display:inline-block;border-radius:999px;padding:4px 8px;background:#172235;font-size:11px}.footer{font-size:12px;color:#91a0b6;margin-top:26px}.hidden{display:none!important}@media(max-width:760px){main{padding:18px 14px 36px}.top{display:block}.auth{min-width:0;margin-top:14px}.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}h1{font-size:30px}.value{font-size:19px}}@media(max-width:430px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.auth{display:grid;grid-template-columns:1fr auto}}
</style>
</head>
<body>
<main>
<div class="top"><div><h1>Proypers25</h1><div class="muted">Spot real · Binance · optimización QUBO en shadow</div></div><div class="auth"><input id="secretInput" type="password" autocomplete="off" placeholder="Clave privada"><button id="refreshBtn" type="button">Actualizar</button></div></div>
<div id="message" class="msg"></div>
<div id="content" class="hidden">
<section class="section"><h2>Vista rápida</h2><div id="quick" class="grid"></div></section>
<section class="section"><h2>Actual vs QUBO</h2><div id="qubo" class="grid"></div></section>
<section class="section"><h2>Adquisiciones Spot administradas</h2><div id="positions"></div></section>
<section class="section"><h2>Estado operativo</h2><div id="health" class="grid"></div></section>
<section class="section"><h2>Holdings Binance</h2><div id="holdings"></div></section>
<section class="section"><h2>Actividad reciente</h2><div id="activity"></div></section>
</div>
<div class="footer">QUBO permanece SHADOW_ONLY y no crea órdenes reales. Los datos proceden de los endpoints privados del backend.</div>
</main>
<script>
(function(){
'use strict';
var secretInput=document.getElementById('secretInput');
var refreshBtn=document.getElementById('refreshBtn');
var message=document.getElementById('message');
var content=document.getElementById('content');
var quick=document.getElementById('quick');
var qubo=document.getElementById('qubo');
var positions=document.getElementById('positions');
var health=document.getElementById('health');
var holdings=document.getElementById('holdings');
var activity=document.getElementById('activity');

function num(v){var n=Number(v);return Number.isFinite(n)?n:0}
function money(v){var n=Number(v);return Number.isFinite(n)?new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n):'—'}
function pct(v){if(v===null||v===undefined||!Number.isFinite(Number(v)))return '—';var n=Number(v);return (n>=0?'+':'')+n.toFixed(2)+'%'}
function esc(v){return String(v===null||v===undefined?'—':v).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}
function card(label,value,detail,cls){return '<div class="card '+(cls||'')+'"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div>'+(detail?'<div class="detail">'+esc(detail)+'</div>':'')+'</div>'}
function managed(live){if(Array.isArray(live.open_positions))return live.open_positions;if(live.open_position)return [live.open_position];return []}
function table(headers,rows){if(!rows.length)return '<div class="card"><div class="muted">Sin registros para mostrar.</div></div>';return '<div class="tablewrap"><table><thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}

async function getJson(path,headers){var r=await fetch(path,{headers:headers,cache:'no-store'});var j;try{j=await r.json()}catch(e){throw new Error(path+' devolvió respuesta inválida')};if(!r.ok)throw new Error((j&&j.error)||('HTTP '+r.status));return j}

function render(summary,live,q){
 var opens=managed(live);
 var allocation=summary.allocation||{};
 var account=summary.account||summary.binance_account||{};
 var assets=summary.assets||summary.holdings||[];
 var recent=summary.recent_trades||[];
 var equity=num(account.total_equity_usdt||summary.total_equity_usdt||summary.account_total_usdt);
 var usdt=num(account.usdt_balance||summary.usdt_balance||summary.available_usdt);
 var exposure=num(allocation.api_exposure_usdt||allocation.managed_capital_usdt);
 var unrealized=opens.reduce(function(a,p){return a+num(p.unrealized_pnl_usdt)},0);
 quick.innerHTML=card('Patrimonio Binance',money(equity),'Cuenta completa','wide')+card('USDT disponible',money(usdt),'Saldo disponible')+card('Capital administrado',money(exposure),opens.length+' adquisiciones')+card('PnL abierto',money(unrealized),opens.length?'Posiciones administradas':'Sin posiciones')+card('Motor Spot',live.exit_engine_healthy===false?'REVISAR':'OPERATIVO',live.spot_only===false?'Spot only no confirmado':'Spot only');

 var st=q.status||{};var latest=q.latest||{};var exact=latest.qubo||{};var inspired=latest.quantum_inspired||{};var samples=q.sample_counts||{};var th=st.thresholds||{};
 qubo.innerHTML=card('Estado',st.promotion_state||st.mode||q.mode||'SHADOW','No ejecuta órdenes','wide')+card('Muestras',String(st.settled_samples||samples.settled||0)+' / '+String(th.min_settled||30),'Cerradas / requeridas')+card('Win rate vs baseline',pct(num(st.win_rate_vs_greedy)*100),'Gate mínimo '+pct(num(th.min_win_rate)*100))+card('Ventaja media',pct(st.mean_excess_vs_greedy_pct),'QUBO vs greedy')+card('QUBO exacto',(exact.symbols||[]).join(', ')||'—',money(exact.capital_usdt)+' asignados','wide')+card('Quantum-inspired',(inspired.symbols||[]).join(', ')||'—',money(inspired.capital_usdt)+' asignados','wide');

 positions.innerHTML=table(['Activo','Entrada','Actual','PnL','Modo','Acción'],opens.map(function(p){var cp=p.current_price||p.current_price_usdt||p.mark_price;var ep=p.entry_price;var gp=ep&&cp?((num(cp)/num(ep)-1)*100):null;return ['<b>'+esc(p.symbol)+'</b>',esc(money(ep)),esc(money(cp)),esc(pct(gp)),esc(p.entry_mode||'—'),'<span class="pill">'+esc(p.action||'HOLD')+'</span>']}));

 var blockers=(summary.engine_diagnosis&&summary.engine_diagnosis.blockers)||[];
 health.innerHTML=card('Exit Engine',live.exit_engine_healthy===false?'ERROR':'OK',live.exit_engine_healthy===false?'Revisar':'Monitoreando',live.exit_engine_healthy===false?'bad':'ok')+card('Spot only',live.spot_only===false?'NO':'SÍ','Sin futuros/margen')+card('Bloqueadores',String(blockers.length),blockers.slice(0,2).join(' · ')||'Sin bloqueadores')+card('QUBO real execution',q.real_execution_enabled?'ACTIVO':'DESACTIVADO','Debe permanecer desactivado en shadow');

 holdings.innerHTML=table(['Activo','Cantidad','Valor USDT','Clase'],(Array.isArray(assets)?assets:[]).map(function(a){return ['<b>'+esc(a.asset||a.symbol)+'</b>',esc(a.quantity),' '+esc(money(a.value_usdt)),esc(a.holding_class||'—')]}));
 activity.innerHTML=table(['Activo','Resultado','PnL','Fecha'],recent.slice(0,20).map(function(t){return ['<b>'+esc(t.symbol||t.asset)+'</b>',esc(t.action||t.status||t.result||'—'),esc(money(t.net_pnl_usdt||t.pnl_usdt)),esc(t.closed_at||t.created_at||t.timestamp||'—')]}));
}

async function load(){
 var s=secretInput.value.trim();if(!s){message.textContent='Ingresa la clave privada.';content.classList.add('hidden');return}
 try{localStorage.setItem('proypers25_summary_secret',s)}catch(e){}
 message.textContent='Actualizando datos…';refreshBtn.disabled=true;
 try{var headers={'x-investments-secret':s};var all=await Promise.all([getJson('/internal/investments/summary',headers),getJson('/internal/spot-live/evidence',headers),getJson('/internal/investments/qubo-status',headers)]);render(all[0],all[1],all[2]);content.classList.remove('hidden');message.textContent='';}
 catch(e){content.classList.add('hidden');message.textContent=e.message||'No fue posible cargar el dashboard.'}
 finally{refreshBtn.disabled=false}
}
refreshBtn.addEventListener('click',load);
secretInput.addEventListener('keydown',function(e){if(e.key==='Enter')load()});
try{var saved=localStorage.getItem('proypers25_summary_secret');if(saved)secretInput.value=saved}catch(e){}
})();
</script>
</body></html>`);
});

module.exports = router;
