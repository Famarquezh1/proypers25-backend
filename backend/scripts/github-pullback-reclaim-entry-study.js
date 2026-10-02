'use strict';
// Trigger after workflow registration.

const fs=require('fs'),path=require('path'),vm=require('vm');
const HIST=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const BIN='https://data-api.binance.vision';
const START=Date.parse(process.env.PR_START||'2026-04-01T00:00:00Z');
const END=Date.parse(process.env.PR_END||'2026-09-01T00:00:00Z');
const MAX_ROWS=Math.max(250,Math.min(700,Number(process.env.PR_MAX_ROWS||450)));
const H=240,COST=0.004;
const WAIT_GRID=[5,10,15,20];
const PULLBACK_GRID=[0.003,0.005,0.008,0.010,0.015];
const RECLAIM_GRID=[0.002,0.003,0.005];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadLib(){
 let src=fs.readFileSync(HIST,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__x={loadR7,buildRaw,productionEligible};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:HIST});
 vm.runInContext(src,c,{filename:HIST}); return c.__x;
}
async function getJson(url){
 let last;
 for(let i=0;i<5;i++){try{
  const r=await fetch(url,{headers:{'user-agent':'proypers25-pullback-reclaim/1.0'}});
  if(r.ok)return await r.json();
  if(r.status===429||r.status>=500){await sleep(250*(i+1));continue}
  throw Error('HTTP_'+r.status);
 }catch(e){last=e;if(i<4)await sleep(250*(i+1))}}
 throw last||Error('fetch failed');
}
function dedupe(rows){
 const out=[],last=new Map();
 for(const s of [...rows].sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol))){
  const p=last.get(s.symbol)||-Infinity;
  if(s.t-p<30*60*1000)continue;
  out.push(s);last.set(s.symbol,s.t);
 }
 return out;
}
async function pathFor(s){
 const start=s.t+5*60000;
 const q=new URLSearchParams({symbol:s.symbol,interval:'1m',startTime:String(start),endTime:String(start+(H+25)*60000),limit:'500'});
 const k=await getJson(BIN+'/api/v3/klines?'+q);
 if(!Array.isArray(k)||k.length<H+21)return null;
 return {symbol:s.symbol,t:s.t,k};
}
function outcomeFrom(k,entryIdx){
 if(entryIdx<0||entryIdx>=k.length-1)return null;
 const entry=Number(k[entryIdx][1]);
 if(!(entry>0))return null;
 const end=Math.min(k.length-1,entryIdx+H);
 let mfe=-Infinity,mae=Infinity,firstTp=null,firstSl=null;
 for(let i=entryIdx;i<=end;i++){
  const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
  mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
  if(firstSl===null&&lo<=-.01)firstSl=i-entryIdx;
  if(firstTp===null&&hi>=.03)firstTp=i-entryIdx;
 }
 let gross;
 let status;
 if(firstSl!==null&&firstTp!==null&&firstSl===firstTp){gross=-.01;status='SL_SAME_CANDLE';}
 else if(firstTp!==null&&(firstSl===null||firstTp<firstSl)){gross=.03;status='TP';}
 else if(firstSl!==null&&(firstTp===null||firstSl<firstTp)){gross=-.01;status='SL';}
 else {gross=Number(k[end][4])/entry-1;status='TIMEOUT';}
 return {status,entry,entry_idx:entryIdx,first_tp_min:firstTp,first_sl_min:firstSl,mfe_pct:mfe*100,mae_pct:mae*100,gross_pct:gross*100,net_pct:(gross-COST)*100};
}
function baseline(path){return outcomeFrom(path.k,0)}
function pullbackReclaim(path,cfg){
 const k=path.k,anchor=Number(k[0][1]); if(!(anchor>0))return null;
 let low=anchor,pulled=false,pullIdx=null;
 const last=Math.min(cfg.wait,k.length-2);
 for(let i=0;i<=last;i++){
  low=Math.min(low,Number(k[i][3]));
  if(!pulled&&low/anchor-1<=-cfg.pullback){pulled=true;pullIdx=i;}
  if(pulled&&Number(k[i][4])/low-1>=cfg.reclaim){
    const entryIdx=i+1;
    const out=outcomeFrom(k,entryIdx);
    return out?{...out,trigger_min:i,pullback_seen_min:pullIdx,entry_discount_pct:(out.entry/anchor-1)*100}:null;
  }
 }
 return null;
}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function summarize(rows,totalSignals){
 const trades=rows.filter(Boolean),wins=trades.filter(x=>x.status==='TP').length,losses=trades.filter(x=>x.status==='SL'||x.status==='SL_SAME_CANDLE').length;
 return {signals:totalSignals,trades:trades.length,entry_rate:totalSignals?trades.length/totalSignals:null,wins,losses,win_rate:trades.length?wins/trades.length:null,
  avg_net_pct:mean(trades.map(x=>x.net_pct)),median_net_pct:trades.length?[...trades].sort((a,b)=>a.net_pct-b.net_pct)[Math.floor(trades.length/2)].net_pct:null,
  avg_entry_discount_pct:mean(trades.map(x=>x.entry_discount_pct).filter(Number.isFinite)),hit5_rate:trades.length?trades.filter(x=>x.mfe_pct>=5).length/trades.length:null,
  hit10_rate:trades.length?trades.filter(x=>x.mfe_pct>=10).length/trades.length:null};
}
function evalCfg(paths,cfg){return summarize(paths.map(p=>pullbackReclaim(p,cfg)),paths.length)}
function baseSummary(paths){return summarize(paths.map(baseline),paths.length)}
function score(s,b){
 if(!s||s.trades<15||s.entry_rate<.15||!(s.avg_net_pct>0))return -Infinity;
 const wrGain=(s.win_rate||0)-(b.win_rate||0),netGain=s.avg_net_pct-(b.avg_net_pct||0);
 return s.avg_net_pct + 2*wrGain + .25*netGain + .15*(s.hit5_rate||0);
}

(async()=>{
 process.env.DEV_START=new Date(START).toISOString();
 process.env.DEV_END=new Date(START+Math.floor((END-START)*.6)).toISOString();
 process.env.CONFIRM_START=process.env.DEV_END;
 process.env.CONFIRM_END=new Date(END).toISOString();

 const h=loadLib(),lib=h.loadR7(),built=await h.buildRaw(lib);
 const eligible=dedupe(built.raw.filter(x=>x.t>=START&&x.t<END).filter(h.productionEligible)).slice(0,MAX_ROWS);
 const paths=[],skipped=[];
 for(const s of eligible){
  try{const p=await pathFor(s);if(p)paths.push(p);else skipped.push({symbol:s.symbol,t:s.t,reason:'INSUFFICIENT_1M'});}
  catch(e){skipped.push({symbol:s.symbol,t:s.t,reason:e.message});}
  await sleep(10);
 }
 paths.sort((a,b)=>a.t-b.t);
 if(paths.length<180)throw Error('insufficient paths '+paths.length);
 const a=Math.floor(paths.length*.6),b=Math.floor(paths.length*.8);
 const train=paths.slice(0,a),validation=paths.slice(a,b),holdout=paths.slice(b);
 const baseV=baseSummary(validation),baseH=baseSummary(holdout);

 const candidates=[];
 for(const wait of WAIT_GRID)for(const pullback of PULLBACK_GRID)for(const reclaim of RECLAIM_GRID){
  const cfg={wait,pullback,reclaim};
  const s=evalCfg(validation,cfg);
  candidates.push({cfg,validation:s,score:score(s,baseV)});
 }
 candidates.sort((x,y)=>y.score-x.score);
 const selected=candidates.find(x=>Number.isFinite(x.score)&&x.score>-Infinity)||null;
 let holdoutResult=null,promote=false;
 if(selected){
  const hsum=evalCfg(holdout,selected.cfg);
  const wrDelta=(hsum.win_rate||0)-(baseH.win_rate||0);
  const netDelta=hsum.avg_net_pct-(baseH.avg_net_pct||0);
  promote=Boolean(
    hsum.trades>=15 &&
    hsum.entry_rate>=.15 &&
    hsum.avg_net_pct>0 &&
    hsum.win_rate>=.38 &&
    wrDelta>=.08 &&
    netDelta>0
  );
  holdoutResult={cfg:selected.cfg,baseline:baseH,selected:hsum,delta_win_rate:wrDelta,delta_avg_net_pct:netDelta,pass:promote};
 }

 console.log(JSON.stringify({
  ok:true,research_only:true,no_order_created:true,family:'PULLBACK_RECLAIM_ENTRY_V1',
  objective:'improve entry price and require renewed strength after a production signal',
  rows:paths.length,skipped:skipped.length,blocks:{train:train.length,validation:validation.length,holdout:holdout.length},
  baselines:{validation:baseV,holdout:baseH},candidate_count:candidates.length,
  top_validation:candidates.slice(0,10),selected_config:selected,holdout_result:holdoutResult,
  production_decision:promote?'PROMOTE_TO_SHADOW':'REJECT_ENTRY_MECHANIC',
  promote_to_shadow:promote,
  success_gate:'holdout >=15 trades, >=15% entry rate, >=38% win rate, +8pp vs immediate entry, positive avg net and better than baseline'
 },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
