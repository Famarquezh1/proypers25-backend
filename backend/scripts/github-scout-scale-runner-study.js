'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const HIST=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const BIN='https://data-api.binance.vision';
const START=Date.parse(process.env.SSR_START||'2026-04-01T00:00:00Z');
const END=Date.parse(process.env.SSR_END||'2026-09-01T00:00:00Z');
const MAX_ROWS=Math.max(250,Math.min(700,Number(process.env.SSR_MAX_ROWS||450)));
const H=240,COST=.004,SCOUT=.20,RUNNER_TARGET=.07;
const CONFIRM_GRID=[.005,.008,.010,.015];
const FAIL_GRID=[.003,.005,.008];
const WAIT_GRID=[5,10,15,20];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadLib(){
 let src=fs.readFileSync(HIST,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__x={loadR7,buildRaw,productionEligible};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:HIST});
 vm.runInContext(src,c,{filename:HIST}); return c.__x;
}
async function getJson(url){
 let last;for(let i=0;i<5;i++){try{const r=await fetch(url,{headers:{'user-agent':'proypers25-scout-scale-runner/1.0'}});if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(250*(i+1));continue}throw Error('HTTP_'+r.status)}catch(e){last=e;if(i<4)await sleep(250*(i+1))}}throw last||Error('fetch failed');
}
function dedupe(rows){const out=[],last=new Map();for(const s of [...rows].sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol))){const p=last.get(s.symbol)||-Infinity;if(s.t-p<30*60*1000)continue;out.push(s);last.set(s.symbol,s.t)}return out}
async function pathFor(s){
 const start=s.t+5*60000;
 const q=new URLSearchParams({symbol:s.symbol,interval:'1m',startTime:String(start),endTime:String(start+(H+25)*60000),limit:'500'});
 const k=await getJson(BIN+'/api/v3/klines?'+q);if(!Array.isArray(k)||k.length<H+21)return null;return {symbol:s.symbol,t:s.t,k};
}
function baseline(path){
 const k=path.k,entry=Number(k[0][1]);let tp=null,sl=null;
 for(let i=0;i<=H;i++){const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;if(sl===null&&lo<=-.01)sl=i;if(tp===null&&hi>=.03)tp=i;}
 let gross,status;
 if(sl!==null&&tp!==null&&sl===tp){gross=-.01;status='SL';}
 else if(tp!==null&&(sl===null||tp<sl)){gross=.03;status='TP';}
 else if(sl!==null&&(tp===null||sl<tp)){gross=-.01;status='SL';}
 else {gross=Number(k[Math.min(H,k.length-1)][4])/entry-1;status='TIMEOUT';}
 return {net_pct:(gross-COST)*100,status,full_scale:true,tp1:status==='TP',runner_hit:false,max_fraction:1};
}
function effectivePrice(p0,p1){return 1/(SCOUT/p0+(1-SCOUT)/p1)}
function simulate(path,cfg){
 const k=path.k,p0=Number(k[0][1]);if(!(p0>0))return null;
 let confirmIdx=null,failIdx=null;
 const last=Math.min(cfg.wait,k.length-2);
 for(let i=0;i<=last;i++){
  const hi=Number(k[i][2])/p0-1,lo=Number(k[i][3])/p0-1;
  const hitFail=lo<=-cfg.fail,hitConfirm=Number(k[i][4])/p0-1>=cfg.confirm;
  if(hitFail&&hitConfirm){failIdx=i;break}
  if(hitFail){failIdx=i;break}
  if(hitConfirm){confirmIdx=i;break}
 }
 if(failIdx!==null){
  const exit=p0*(1-cfg.fail),gross=SCOUT*(exit/p0-1);
  return {net_pct:(gross-COST*SCOUT)*100,status:'SCOUT_FAIL',full_scale:false,tp1:false,runner_hit:false,max_fraction:SCOUT,confirm_min:null};
 }
 if(confirmIdx===null){
  const exit=Number(k[last][4]),gross=SCOUT*(exit/p0-1);
  return {net_pct:(gross-COST*SCOUT)*100,status:'SCOUT_TIMEOUT',full_scale:false,tp1:false,runner_hit:false,max_fraction:SCOUT,confirm_min:null};
 }
 const addIdx=confirmIdx+1,p1=Number(k[addIdx][1]);if(!(p1>0))return null;
 const eff=effectivePrice(p0,p1),stop=eff*.99,tp1px=eff*1.03,runnerStop=eff*1.01,runnerTarget=eff*(1+RUNNER_TARGET);
 const end=Math.min(k.length-1,addIdx+H);
 for(let i=addIdx;i<=end;i++){
  const lo=Number(k[i][3]),hi=Number(k[i][2]);
  if(lo<=stop&&hi>=tp1px){
   const gross=SCOUT*(stop/p0-1)+(1-SCOUT)*(stop/p1-1);
   return {net_pct:(gross-COST)*100,status:'FULL_STOP_SAME',full_scale:true,tp1:false,runner_hit:false,max_fraction:1,confirm_min:confirmIdx};
  }
  if(lo<=stop){
   const gross=SCOUT*(stop/p0-1)+(1-SCOUT)*(stop/p1-1);
   return {net_pct:(gross-COST)*100,status:'FULL_STOP',full_scale:true,tp1:false,runner_hit:false,max_fraction:1,confirm_min:confirmIdx};
  }
  if(hi>=tp1px){
   let runnerExit=null,runnerHit=false,runnerStatus='RUNNER_TIMEOUT';
   for(let j=i+1;j<=end;j++){
    const l=Number(k[j][3]),h=Number(k[j][2]);
    if(l<=runnerStop&&h>=runnerTarget){runnerExit=runnerStop;runnerStatus='RUNNER_LOCK_SAME';break}
    if(l<=runnerStop){runnerExit=runnerStop;runnerStatus='RUNNER_LOCK';break}
    if(h>=runnerTarget){runnerExit=runnerTarget;runnerHit=true;runnerStatus='RUNNER_TARGET';break}
   }
   if(runnerExit===null)runnerExit=Number(k[end][4]);
   const gross=.5*.03+.5*(runnerExit/eff-1);
   return {net_pct:(gross-COST)*100,status:runnerStatus,full_scale:true,tp1:true,runner_hit:runnerHit,max_fraction:1,confirm_min:confirmIdx};
  }
 }
 const exit=Number(k[end][4]),gross=SCOUT*(exit/p0-1)+(1-SCOUT)*(exit/p1-1);
 return {net_pct:(gross-COST)*100,status:'FULL_TIMEOUT',full_scale:true,tp1:false,runner_hit:false,max_fraction:1,confirm_min:confirmIdx};
}
function mean(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function summary(rows){
 const n=rows.length;return {n,avg_net_pct:mean(rows.map(x=>x.net_pct)),median_net_pct:n?[...rows].sort((a,b)=>a.net_pct-b.net_pct)[Math.floor(n/2)].net_pct:null,
  positive_rate:n?rows.filter(x=>x.net_pct>0).length/n:null,full_scale_rate:n?rows.filter(x=>x.full_scale).length/n:null,tp1_rate:n?rows.filter(x=>x.tp1).length/n:null,
  runner_hit_rate:n?rows.filter(x=>x.runner_hit).length/n:null,avg_max_fraction:mean(rows.map(x=>x.max_fraction)),worst_pct:n?Math.min(...rows.map(x=>x.net_pct)):null,best_pct:n?Math.max(...rows.map(x=>x.net_pct)):null};
}
function evalCfg(paths,cfg){return summary(paths.map(p=>simulate(p,cfg)).filter(Boolean))}
function base(paths){return summary(paths.map(baseline))}
function score(s,b){
 if(!s||s.full_scale_rate<.12||!(s.avg_net_pct>0))return -Infinity;
 return s.avg_net_pct+0.5*(s.avg_net_pct-b.avg_net_pct)+.5*(s.tp1_rate||0)+.35*(s.runner_hit_rate||0)-.1*(s.avg_max_fraction||0);
}

(async()=>{
 process.env.DEV_START=new Date(START).toISOString();process.env.DEV_END=new Date(START+Math.floor((END-START)*.6)).toISOString();process.env.CONFIRM_START=process.env.DEV_END;process.env.CONFIRM_END=new Date(END).toISOString();
 const h=loadLib(),lib=h.loadR7(),built=await h.buildRaw(lib);
 const eligible=dedupe(built.raw.filter(x=>x.t>=START&&x.t<END).filter(h.productionEligible).filter(x=>Number(x.productionV42?.detail?.r24||0)<0.10)).slice(0,MAX_ROWS);
 const paths=[],skipped=[];for(const s of eligible){try{const p=await pathFor(s);if(p)paths.push(p);else skipped.push({symbol:s.symbol,t:s.t})}catch(e){skipped.push({symbol:s.symbol,t:s.t,error:e.message})}await sleep(10)}
 paths.sort((a,b)=>a.t-b.t);if(paths.length<180)throw Error('insufficient paths '+paths.length);
 const a=Math.floor(paths.length*.6),b=Math.floor(paths.length*.8),train=paths.slice(0,a),validation=paths.slice(a,b),holdout=paths.slice(b);
 const baseV=base(validation),baseH=base(holdout),candidates=[];
 for(const wait of WAIT_GRID)for(const confirm of CONFIRM_GRID)for(const fail of FAIL_GRID){const cfg={wait,confirm,fail};const s=evalCfg(validation,cfg);candidates.push({cfg,validation:s,score:score(s,baseV)})}
 candidates.sort((x,y)=>y.score-x.score);const selected=candidates.find(x=>Number.isFinite(x.score)&&x.score>-Infinity)||null;
 let holdoutResult=null,promote=false;
 if(selected){const hs=evalCfg(holdout,selected.cfg),delta=hs.avg_net_pct-baseH.avg_net_pct;
  promote=Boolean(hs.full_scale_rate>=.12&&hs.avg_net_pct>0&&delta>=.50&&hs.tp1_rate>=.10&&hs.runner_hit_rate>0);
  holdoutResult={cfg:selected.cfg,baseline:baseH,selected:hs,delta_avg_net_pct:delta,pass:promote};
 }
 console.log(JSON.stringify({ok:true,research_only:true,no_order_created:true,family:'SCOUT_CONFIRM_SCALE_RUNNER_ANTICHASE_V2',
  design:{scout_fraction:SCOUT,runner_target_pct:RUNNER_TARGET*100,tp1_pct:3,full_stop_pct:-1,runner_lock_pct:1,cost_pct:COST*100},
  rows:paths.length,skipped:skipped.length,blocks:{train:train.length,validation:validation.length,holdout:holdout.length},
  baselines:{validation:baseV,holdout:baseH},candidate_count:candidates.length,top_validation:candidates.slice(0,10),selected_config:selected,holdout_result:holdoutResult,
  production_decision:promote?'PROMOTE_TO_SHADOW':'REJECT_EXECUTION_ARCHITECTURE',promote_to_shadow:promote,
  anti_chase_r24_max_pct:10,success_gate:'holdout positive avg net, >=+0.50pp vs immediate full entry, >=12% full-scale rate, >=10% TP1 rate, at least one +7% runner hit'},null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
