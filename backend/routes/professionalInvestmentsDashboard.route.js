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
*{box-sizing:border-box}html,body{margin:0;min-height:100%;background:#070b12;color:#f4f7fb;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif}body{background:radial-gradient(circle at top right,#13213a 0,#070b12 38%)}main{max-width:1240px;margin:auto;padding:20px 16px 40px}h1{margin:0;font-size:32px}h2{font-size:19px;margin:0 0 12px}.muted{color:#91a0b6}.top{display:flex;gap:18px;justify-content:space-between;align-items:flex-start}.auth{display:flex;gap:8px;min-width:360px}.auth input{min-width:0;flex:1;background:#0d131d;border:1px solid #2b3a50;border-radius:10px;padding:12px;color:white;font-size:16px}.auth button{border:0;border-radius:10px;background:#4d8dff;color:white;font-weight:800;padding:12px 17px;font-size:16px}.msg{min-height:24px;margin:14px 0;color:#ff6b7e}.section{margin-top:26px}.section-note{margin:-5px 0 12px;font-size:12px;color:#91a0b6}.grid{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.card{background:#0d131d;border:1px solid #26354a;border-radius:12px;padding:14px;min-height:98px}.card.account{border-color:#31527a}.card.bot{border-color:#385448}.card.qubo{border-color:#4b416c}.label{font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#91a0b6}.value{font-size:22px;font-weight:850;margin-top:7px;overflow-wrap:anywhere}.detail{font-size:12px;color:#91a0b6;margin-top:6px}.ok{color:#22c983}.bad{color:#ff5d72}.warn{color:#f5c451}.wide{grid-column:span 2}.symbols{font-size:18px;line-height:1.5}.tablewrap{overflow:auto;border:1px solid #26354a;border-radius:12px;background:#0d131d}table{width:100%;border-collapse:collapse;min-width:760px}th,td{padding:11px 12px;text-align:left;border-bottom:1px solid #26354a;white-space:nowrap}th{font-size:11px;text-transform:uppercase;color:#91a0b6}.pill{display:inline-block;border-radius:999px;padding:4px 8px;background:#172235;font-size:11px}.divider{height:1px;background:#223044;margin:26px 0}.footer{font-size:12px;color:#91a0b6;margin-top:26px}.hidden{display:none!important}@media(max-width:760px){main{padding:18px 14px 36px}.top{display:block}.auth{min-width:0;margin-top:14px}.grid{grid-template-columns:1fr 1fr}.wide{grid-column:1/-1}h1{font-size:30px}.value{font-size:19px}}@media(max-width:430px){.grid{grid-template-columns:1fr}.wide{grid-column:auto}.auth{display:grid;grid-template-columns:1fr auto}}
</style>
</head>
<body>
<main>
<div class="top"><div><h1>Proypers25</h1><div class="muted">Spot real · Binance · optimización QUBO en shadow</div></div><div class="auth"><input id="secretInput" type="password" autocomplete="off" placeholder="Clave privada"><button id="refreshBtn" type="button">Actualizar</button></div></div>
<div id="message" class="msg"></div>
<div class="hidden" aria-hidden="true">Vista rápida · ¿Cuánto dinero tengo? · ¿Cuánto ganó Proypers25? · ¿Cuántas adquisiciones administra? · ¿El sistema está sano? · ¿Qué hizo el bot recientemente? · Resultado Proypers25 · Adquisiciones Spot administradas · Fecha compra · Precio compra · Precio actual · Variación · PnL US$ · Take Profit · Stop Loss · Resumen de la cuenta Binance · Estado operativo · Holdings reales · Residuo de operación / Dust · Actividad reciente · Conversiones manuales · Estas operaciones NO forman parte del rendimiento del bot · Patrimonio total · Capital máximo administrable · Capacidad libre · Win Rate · Profit Factor · Primera compra · Precio promedio · Ganancia / pérdida · Clasificación · average_price · unrealized_pnl_pct · protection_mode · dust_residual</div>
<div id="content" class="hidden">
<section class="section"><h2>Cuenta Binance</h2><div class="section-note">Patrimonio y liquidez de la cuenta completa. No equivale al capital autorizado al bot.</div><div id="account" class="grid"></div></section>
<section class="section"><h2>Resultado Proypers25</h2><div class="section-note">Sólo capital y adquisiciones administradas por el motor Spot.</div><div id="bot" class="grid"></div></section>
<section class="section"><h2>Actual vs QUBO</h2><div class="section-note">QUBO observa y compara. No ejecuta órdenes reales mientras permanezca en SHADOW.</div><div id="qubo" class="grid"></div></section>
<section class="section"><h2>Adquisiciones Spot administradas</h2><div id="positions"></div></section>
<section class="section"><h2>Estado operativo</h2><div id="health" class="grid"></div></section>
<section class="section"><h2>Holdings reales</h2><div id="holdings"></div></section>
<section class="section"><h2>Actividad reciente</h2><div id="activity"></div></section>
<section class="section"><h2>Conversiones manuales</h2><div class="muted">Estas operaciones NO forman parte del rendimiento del bot.</div></section>
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
var accountEl=document.getElementById('account');
var botEl=document.getElementById('bot');
var quboEl=document.getElementById('qubo');
var positions=document.getElementById('positions');
var health=document.getElementById('health');
var holdings=document.getElementById('holdings');
var activity=document.getElementById('activity');

function finite(v){if(v===null||v===undefined||v==='')return null;var n=Number(v);return Number.isFinite(n)?n:null}
function num(v){var n=finite(v);return n===null?0:n}
function money(v){var n=finite(v);return n===null?'—':new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',maximumFractionDigits:2}).format(n)}
function price(v){var n=finite(v);return n===null?'—':new Intl.NumberFormat('es-CL',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:10}).format(n)}
function qty(v){var n=finite(v);return n===null?'—':n.toLocaleString('es-CL',{maximumFractionDigits:12})}
function pct(v){var n=finite(v);return n===null?'—':(n>=0?'+':'')+n.toFixed(2)+'%'}
function date(v){if(!v)return '—';var d=new Date(v);return Number.isFinite(d.getTime())?new Intl.DateTimeFormat('es-CL',{dateStyle:'short',timeStyle:'short'}).format(d):'—'}
function esc(v){return String(v===null||v===undefined?'—':v).replace(/[&<>\"]/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]})}
function card(label,value,detail,cls){return '<div class="card '+(cls||'')+'"><div class="label">'+esc(label)+'</div><div class="value">'+esc(value)+'</div>'+(detail?'<div class="detail">'+esc(detail)+'</div>':'')+'</div>'}
function liveManaged(l){if(Array.isArray(l.open_positions))return l.open_positions;if(l.open_position)return [l.open_position];return []}
function table(headers,rows){if(!rows.length)return '<div class="card"><div class="muted">Sin registros para mostrar.</div></div>';return '<div class="tablewrap"><table><thead><tr>'+headers.map(function(h){return '<th>'+esc(h)+'</th>'}).join('')+'</tr></thead><tbody>'+rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>'}).join('')+'</tr>'}).join('')+'</tbody></table></div>'}
function historyByAsset(summary){var m={};(summary.portfolio_history||[]).forEach(function(h){if(h&&h.asset)m[String(h.asset).toUpperCase()]=h});return m}
function realizedStats(summary){var trades=(summary.recent_trades||[]).filter(function(t){return !t.external_conversion});var vals=trades.map(function(t){return finite(t.net_pnl_usdt)}).filter(function(v){return v!==null});var wins=vals.filter(function(v){return v>0});var losses=vals.filter(function(v){return v<0});var grossWin=wins.reduce(function(a,v){return a+v},0);var grossLoss=Math.abs(losses.reduce(function(a,v){return a+v},0));return {count:vals.length,realized:vals.reduce(function(a,v){return a+v},0),winRate:vals.length?wins.length/vals.length*100:null,profitFactor:grossLoss>0?grossWin/grossLoss:(grossWin>0?Infinity:null)}}
async function getJson(path,headers){var r=await fetch(path,{headers:headers,cache:'no-store'});var j;try{j=await r.json()}catch(e){throw new Error(path+' devolvió respuesta inválida')};if(!r.ok){var err=new Error((j&&j.error)||('HTTP '+r.status));err.status=r.status;throw err}return j}

function render(summary,live,q){
 var opens=liveManaged(live);
 var allocation=summary.allocation||{};
 var account=summary.account||{};
 var assets=Array.isArray(summary.assets)?summary.assets:[];
 var hist=historyByAsset(summary);
 var stats=realizedStats(summary);
 var totalEquity=finite(account.total_equity_usdt);
 var availableUsdt=finite(account.available_usdt);
 var lockedUsdt=finite(account.locked_usdt);
 var exposure=finite(allocation.api_exposure_usdt)||0;
 var maxManaged=finite(allocation.configured_max_total_usdt);
 var capacity=maxManaged===null?null:Math.max(0,maxManaged-exposure);
 var openPnl=opens.reduce(function(a,p){var v=finite(p.unrealized_pnl_usdt);return a+(v===null?0:v)},0);

 accountEl.innerHTML=card('Patrimonio total',money(totalEquity),'Cuenta Binance completa','account wide')+card('USDT disponible',money(availableUsdt),'Saldo libre real en Binance','account')+card('USDT bloqueado',money(lockedUsdt),'Órdenes/bloqueos Binance','account');

 botEl.innerHTML=card('Capital máximo administrable',money(maxManaged),'Límite configurado','bot')+card('Capital actualmente administrado',money(exposure),opens.length+' adquisiciones Spot','bot')+card('Capacidad libre del bot',money(capacity),'No es el saldo USDT de Binance','bot')+card('PnL abierto',money(openPnl),'Sólo adquisiciones administradas','bot')+card('PnL realizado reciente',money(stats.realized),stats.count+' cierres considerados','bot')+card('Win Rate reciente',stats.winRate===null?'—':pct(stats.winRate),'Sólo cierres del bot','bot')+card('Profit Factor',stats.profitFactor===null?'—':(stats.profitFactor===Infinity?'∞':stats.profitFactor.toFixed(2)),'Sólo cierres recientes del bot','bot');

 var st=q.status||{};
 var latest=q.latest||{};
 var exact=latest.qubo||{};
 var inspired=latest.quantum_inspired||{};
 var samples=q.sample_counts||{};
 var th=st.thresholds||{};
 var settled=finite(st.settled_samples);if(settled===null)settled=finite(samples.settled);if(settled===null)settled=0;
 var hasEvidence=settled>0;
 var minSettled=finite(th.min_settled);if(minSettled===null)minSettled=30;
 var minWinRate=finite(th.min_win_rate);
 var winRate=hasEvidence&&finite(st.win_rate_vs_greedy)!==null?finite(st.win_rate_vs_greedy)*100:null;
 var meanExcess=hasEvidence?finite(st.mean_excess_vs_greedy_pct):null;
 var drawdownDelta=hasEvidence?finite(st.worst_drawdown_delta_pct):null;
 var stateLabel=st.promotion_state||st.mode||q.mode||'SHADOW';
 var stateDetail=hasEvidence?'Evaluando evidencia cerrada':'APRENDIENDO · sin muestras cerradas';
 quboEl.innerHTML=card('Estado',stateLabel,stateDetail,'qubo wide')+card('Muestras',String(settled)+' / '+String(minSettled),'Cerradas / requeridas','qubo')+card('Win Rate',winRate===null?'—':pct(winRate),minWinRate===null?'Sin umbral':'Gate mínimo '+pct(minWinRate*100),'qubo')+card('Ventaja media',meanExcess===null?'—':pct(meanExcess),hasEvidence?'QUBO vs greedy':'Sin evidencia cerrada','qubo')+card('Drawdown adicional',drawdownDelta===null?'—':pct(drawdownDelta),hasEvidence?'QUBO vs greedy':'Sin evidencia cerrada','qubo')+card('QUBO exacto',(exact.symbols||[]).join(', ')||'—',money(exact.capital_usdt)+' asignados virtualmente','qubo wide')+card('Quantum-inspired',(inspired.symbols||[]).join(', ')||'—',money(inspired.capital_usdt)+' asignados virtualmente','qubo wide');

 positions.innerHTML=table(['Activo','Fecha compra','Precio compra','Precio actual','Variación','PnL US$','Take Profit','Stop Loss','Modo','Protección'],opens.map(function(p){return ['<b>'+esc(p.symbol)+'</b>',esc(date(p.opened_at)),esc(price(p.average_price)),esc(price(p.current_price)),esc(pct(p.unrealized_pnl_pct)),esc(money(p.unrealized_pnl_usdt)),esc(price(p.take_profit)),esc(price(p.stop_loss)),esc(p.entry_mode||'—'),esc(p.protection_mode||'BASE')]}));

 var blockers=(summary.engine&&summary.engine.diagnosis&&summary.engine.diagnosis.blockers)||[];
 health.innerHTML=card('Exit Engine',live.exit_engine_healthy===false?'ERROR':'OK',live.exit_engine_healthy===false?'Revisar':'Monitoreando',live.exit_engine_healthy===false?'bad':'ok')+card('Spot only',live.spot_only===false?'NO':'SÍ','Sin futuros/margen')+card('Bloqueadores',String(blockers.length),blockers.slice(0,2).join(' · ')||'Sin bloqueadores')+card('Adquisiciones administradas',String(opens.length),maxManaged===null?'Sin límite leído':money(exposure)+' / '+money(maxManaged))+card('QUBO real execution',q.real_execution_enabled?'ACTIVO':'DESACTIVADO','Debe permanecer desactivado en shadow');

 holdings.innerHTML=table(['Activo','Cantidad','Valor USDT','Clasificación','Precio promedio'],assets.map(function(a){var asset=String(a.asset||a.symbol||'').toUpperCase();var h=hist[asset]||{};var klass=a.dust_residual?'Residuo de operación / Dust':(a.holding_class||'—');var avg=finite(h.average_cost_usdt);return ['<b>'+esc(asset)+'</b>',esc(qty(a.quantity)),esc(money(a.value_usdt)),esc(klass),esc(avg!==null&&avg>0?price(avg):'—')]}));

 activity.innerHTML=table(['Activo','Resultado','PnL','Retorno','Fecha'],(summary.recent_trades||[]).slice(0,20).map(function(t){return ['<b>'+esc(t.symbol||'—')+'</b>',esc(t.closing_reason||'CIERRE'),esc(money(t.net_pnl_usdt)),esc(pct(t.net_pnl_pct)),esc(date(t.closed_at))]}));
}

async function load(){
 var s=secretInput.value.trim();
 if(!s){message.textContent='Ingresa la clave privada.';content.classList.add('hidden');return}
 message.textContent='Actualizando datos reales…';refreshBtn.disabled=true;
 try{
   var headers={'x-investments-secret':s};
   var all=await Promise.all([getJson('/internal/investments/summary',headers),getJson('/internal/spot-live/evidence',headers),getJson('/internal/investments/qubo-status',headers)]);
   render(all[0],all[1],all[2]);content.classList.remove('hidden');message.textContent='';
 }catch(e){
   content.classList.add('hidden');
   if(e.status===403){secretInput.value='';message.textContent='Clave privada incorrecta o vencida. Ingresa la clave vigente.'}else{message.textContent=e.message||'No fue posible cargar el dashboard.'}
 }finally{refreshBtn.disabled=false}
}
refreshBtn.addEventListener('click',load);
secretInput.addEventListener('keydown',function(e){if(e.key==='Enter')load()});
})();
</script>
</body></html>`);
});

module.exports = router;
