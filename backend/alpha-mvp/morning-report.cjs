'use strict';
const fs=require('node:fs'),path=require('node:path');
const {d,fmt}=require('./accounting.cjs'),{COLLECTION}=require('./reconcile.cjs');
const TZ='America/Punta_Arenas';
function localDay(value){return new Intl.DateTimeFormat('en-CA',{timeZone:TZ,year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));}
function previousDay(now=new Date()){return localDay(new Date(now.getTime()-86400000));}
function buildReport(trades,{day=previousDay(),reconciliationRun=null}={}){
 if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw Error('INVALID_REPORT_DAY');
 const closed=trades.filter(t=>t.status==='CLOSED'&&t.reconciliation_status==='COMPLETE'&&t.exit_timestamp&&localDay(t.exit_timestamp)===day);
 const partials=trades.filter(t=>t.status!=='CLOSED'&&(t.realized_events||[]).some(e=>localDay(e.at)===day));
 const realized=trades.filter(t=>t.reconciliation_status==='COMPLETE').flatMap(t=>(t.realized_events||[]).filter(e=>localDay(e.at)===day).map(e=>({trade:t,...e})));
 const net=realized.reduce((sum,e)=>sum+d(e.net_pnl_usdt),0n),fees=realized.reduce((sum,e)=>sum+d(e.fees_usdt),0n);
 const wins=closed.filter(t=>d(t.net_pnl_usdt)>0n),losses=closed.filter(t=>d(t.net_pnl_usdt)<0n);
 const grossWins=wins.reduce((s,t)=>s+d(t.net_pnl_usdt),0n),grossLoss=losses.reduce((s,t)=>s-d(t.net_pnl_usdt),0n);
 const pf=grossLoss>0n?Number(grossWins)/Number(grossLoss):null;
 const sorted=[...closed].sort((a,b)=>d(a.net_pnl_usdt)<d(b.net_pnl_usdt)?-1:d(a.net_pnl_usdt)>d(b.net_pnl_usdt)?1:0);
 const pending=trades.filter(t=>t.reconciliation_status!=='COMPLETE'||(t.anomalies||[]).some(x=>/^(INCOMPLETE_ORDER|SELL_WITHOUT|FOREIGN_|UNVALUED_)/.test(x)));
 const issues=Array.isArray(reconciliationRun?.issues)?reconciliationRun.issues:[];
 const missingMetadata=trades.filter(t=>(t.anomalies||[]).some(x=>/^(STRATEGY_HASH_MISSING|ORIGIN_SIGNAL_MISSING|CAPITAL_AT_ENTRY_MISSING|EXIT_REASON_UNVERIFIED)$/.test(x))).length;
 const fresh=reconciliationRun?.at&&Math.abs(Date.now()-Date.parse(reconciliationRun.at))<4*3600000;
 const complete=Boolean(fresh&&reconciliationRun?.ok===true&&issues.length===0&&pending.length===0);
 const strategies=[...new Set(closed.map(t=>t.strategy_version||'DESCONOCIDA'))];
 const lines=['PROYPERS25 — REPORTE FINANCIERO DIARIO','Fecha: '+day+' ('+TZ+')','',
  'PnL neto realizado en el día: '+fmt(net)+' USDT',
  'Comisiones asignadas a ventas del día: '+fmt(fees)+' USDT',
  'Trades cerrados y conciliados: '+closed.length,
  'Trades con venta parcial y posición abierta: '+partials.length,
  'Win Rate (cierres): '+(closed.length?(100*wins.length/closed.length).toFixed(2)+'%':'N/D'),
  'Profit Factor (cierres): '+(pf===null?'N/D':pf.toFixed(4)),
  'Mejor operación: '+(sorted.length?sorted.at(-1).symbol+' '+sorted.at(-1).net_pnl_usdt+' USDT':'N/D'),
  'Peor operación: '+(sorted.length?sorted[0].symbol+' '+sorted[0].net_pnl_usdt+' USDT':'N/D'),
  'Estrategias: '+(strategies.length?strategies.join(', '):'N/D'),
  'Capital de referencia: N/D (sin patrimonio histórico comparable)',
  'Rendimiento sobre capital: N/D (sin patrimonio histórico comparable)',
  'Drawdown patrimonial: N/D (sin curva patrimonial verificable)',
  'Anomalías contables: '+(pending.length+issues.length),
  'Operaciones con metadatos faltantes: '+missingMetadata,
  'Estado conciliación: '+(complete?'COMPLETA':'PARCIAL / NO VERIFICADA'),
  '', 'DETALLE DE VENTAS REALIZADAS EN EL DÍA'];
 if(!realized.length)lines.push('Sin ventas conciliadas en este período.');
 for(const e of realized)lines.push(e.trade.symbol+' | '+e.trade.trade_id+' | '+e.net_pnl_usdt+' USDT | fee '+e.fees_usdt+' USDT | '+(e.trade.exit_reason||'MOTIVO NO VERIFICADO'));
 for(const issue of issues)lines.push('PENDIENTE '+issue.symbol+': '+issue.error);
 lines.push('','Generado: '+new Date().toISOString());
 return{day,text:lines.join('\n')+'\n',summary:{net_pnl_usdt:fmt(net),fees_usdt:fmt(fees),closed:closed.length,win_rate:closed.length?(100*wins.length/closed.length).toFixed(2):null,profit_factor:pf,anomalies:pending.length+issues.length,missing_metadata:missingMetadata,complete}};
}
async function run({db,state=process.env.PROYPERS_STATE_DIR||'/var/lib/proypers25',now=new Date()}={}){
 if(!db)throw Error('FIRESTORE_REQUIRED');
 const snap=await db.collection(COLLECTION).get(),trades=snap.docs.map(x=>x.data());
 let status=null;try{status=JSON.parse(fs.readFileSync(path.join(state,'alpha-mvp','reconcile-last.json'),'utf8'));}catch{}
 const result=buildReport(trades,{day:previousDay(now),reconciliationRun:status});
 const dir=path.join(state,'alpha-mvp','reports');fs.mkdirSync(dir,{recursive:true,mode:0o700});
 const file=path.join(dir,result.day+'.txt');fs.writeFileSync(file,result.text,{mode:0o600});
 return{filename:file,...result};
}
if(require.main===module)run({db:require('../firebase-admin-config')}).then(r=>console.log(r.text)).catch(e=>{console.error('ALPHA_REPORT_ERROR:'+e.message);process.exitCode=2;});
module.exports={buildReport,previousDay,localDay,run};
