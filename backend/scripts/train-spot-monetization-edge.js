'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const COST=.004;
const RULE={wait:1,minRet:.003,maxDraw:-.04,minClose:.35,minVol:.70,source:'V13/V14 development consensus; frozen before holdouts'};

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function delayed(lib,s,bars){
  const ni=s.index+bars;if(ni+145>=s.series.length)return null;
  const z={...s,index:ni,t:s.series[ni].t};z.outcome=lib.futureOutcome(z);return z.outcome?z:null;
}
function cf(s){
  const a=s.series,i=s.index,entry=Number(a[i+1]?.o||0),j=i+RULE.wait;if(!(entry>0)||j>=a.length)return null;
  let hi=entry,lo=entry,vol=0;
  for(let k=i+1;k<=j;k++){hi=Math.max(hi,Number(a[k].h||0));lo=Math.min(lo,Number(a[k].l||0));vol+=Number(a[k].q||0)}
  const r=a[j],close=Number(r.c||0),low=Number(r.l||0),high=Number(r.h||0),rg=Math.max(1e-12,high-low);
  const prev=a.slice(Math.max(0,i-5),i+1),pv=avg(prev.map(x=>Number(x.q||0)));
  return {ret:close/entry-1,draw:lo/entry-1,close_loc:(close-low)/rg,volume:pv>0?(vol/RULE.wait)/pv:1};
}
function confirmed(lib,s){const x=cf(s);return x&&x.ret>=RULE.minRet&&x.draw>=RULE.maxDraw&&x.close_loc>=RULE.minClose&&x.volume>=RULE.minVol?delayed(lib,s,RULE.wait):null}

const EXITS=[];
for(const tp of [.035,.04,.045,.05,.055,.06])
for(const sl of [.025,.03,.035,.04,.05])
for(const hours of [4,8,12])
 EXITS.push({id:`TP${Math.round(tp*1000)}_SL${Math.round(sl*1000)}_${hours}H`,tp,sl,bars:hours*12});
EXITS.push({id:'BASE'});

function tpExit(s,p,lib){
 if(p.id==='BASE')return lib.r.simulateExit(s,lib.b.BASE_EXIT);
 const a=s.series,e=s.index+1,entry=Number(a[e]?.o||0);if(!(entry>0))return null;
 let high=entry,low=entry,exit=entry,exitI=e,reason='TIMEOUT',hit10=null,stopBefore10=false;
 const stop=entry*(1-p.sl),take=entry*(1+p.tp),end=Math.min(a.length-1,e+p.bars);
 for(let k=e;k<=end;k++){
   const b=a[k],hitStop=Number(b.l)<=stop,hitTp=Number(b.h)>=take;
   high=Math.max(high,Number(b.h));low=Math.min(low,Number(b.l));
   if(hit10===null&&Number(b.h)/entry-1>=.10)hit10=(k-e)*5;
   if(hitStop&&hitTp){exit=stop;exitI=k;reason='AMBIGUOUS_STOP_FIRST';if(hit10===null)stopBefore10=true;break}
   if(hitStop){exit=stop;exitI=k;reason='HARD_STOP';if(hit10===null)stopBefore10=true;break}
   if(hitTp){exit=take;exitI=k;reason='TAKE_PROFIT';break}
   exit=Number(b.c);exitI=k;
 }
 const gross=exit/entry-1,net=gross-COST,mfe=high/entry-1;
 return {net,gross,mfeDuringTrade:mfe,mfeFixed24h:0,captureRatioDuringTrade:mfe>0?Math.max(0,net)/mfe:0,captureRatioFixed24h:0,captureLoss24h:0,holdingMin:(exitI-e)*5,exitReason:reason,stopBefore10,hit10};
}
function metrics(lib,signals,all,p){
 const pred=lib.predictionMetrics(signals);
 const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>tpExit(s,p,lib),()=>lib.b.FIXED_SIZE);
 lib.r.withRecall(m,m._trades||[],all);
 return {prediction:pred,economic:lib.r.safeMetrics(m)};
}
function delta(a,b){return {
 winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
 winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
 avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
 net_growth:a.economic.netGrowth-b.economic.netGrowth,
 avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
 max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
}}
function acceptable(m,b){
 return m.prediction.signals>=8&&m.economic.netGrowth>0&&m.economic.avgNetRet>0&&
 m.economic.maxDrawdown>=b.economic.maxDrawdown&&
 m.prediction.winner5Precision>=b.prediction.winner5Precision&&m.prediction.winner10Precision>=b.prediction.winner10Precision;
}
function objective(d){return d.net_growth*18+d.avg_net_ret*12+d.max_drawdown*4+d.winner5_precision*2+d.winner10_precision*3}
function evaluateSegment(lib,orig,rows,p){
 const sig=orig.map(s=>confirmed(lib,s)).filter(Boolean),bm=metrics(lib,orig,rows,{id:'BASE'}),m=metrics(lib,sig,rows,p),d=delta(m,bm);
 return {signals:sig.length,retention:orig.length?sig.length/orig.length:0,baseline:bm,metrics:m,delta:d,pass:acceptable(m,bm)};
}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';
 process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-09-16T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=Date.parse('2026-04-01T00:00:00Z')&&s.t<Date.parse('2026-07-01T00:00:00Z'));
 const july=raw.filter(s=>s.t>=Date.parse('2026-07-01T00:00:00Z')&&s.t<Date.parse('2026-08-01T00:00:00Z'));
 const finalRaw=raw.filter(s=>s.t>=Date.parse('2026-08-01T00:00:00Z')&&s.t<Date.parse('2026-09-16T00:00:00Z'));
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t);
 const js=base.selectSignals(lib,july,0,0).sort((a,b)=>a.t-b.t);
 const fsig=base.selectSignals(lib,finalRaw,0,0).sort((a,b)=>a.t-b.t);

 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));
 const candidates=[];
 for(const p of EXITS){
   let start=initial,folds=[],allSig=[];
   for(let round=1;round<=4&&start<ds.length;round++){
     const end=round===4?ds.length:Math.min(ds.length,start+fold),val=ds.slice(start,end);
     const rows=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t+15*60000);
     const ev=evaluateSegment(lib,val,rows,p);folds.push({round,...ev});allSig.push(...val.map(s=>confirmed(lib,s)).filter(Boolean));start=end;
   }
   const walk=ds.slice(initial),walkRows=dev.filter(s=>s.t>=walk[0].t),agg=evaluateSegment(lib,walk,walkRows,p),pf=folds.filter(x=>x.pass).length;
   const viable=pf>=3&&agg.pass&&agg.signals>=24;
   candidates.push({profile:p,folds,aggregate:{...agg,pass_folds:pf,objective:objective(agg.delta)},viable});
 }
 candidates.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
 const chosen=candidates.find(x=>x.viable)||null;
 let julyTest=null,finalTest=null,ready=false;
 if(chosen){
   julyTest=evaluateSegment(lib,js,july,chosen.profile);
   if(julyTest.pass){
     finalTest=evaluateSegment(lib,fsig,finalRaw,chosen.profile);
     ready=finalTest.pass;
   }
 }
 const report={version:'MONETIZATION_EDGE_V16_FROZEN_CONFIRM_TP_DOUBLE_HOLDOUT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'Consolidate the development-discovered 5-minute confirmation rule, evaluate a fixed take-profit/stop family over four Apr-Jun development folds, freeze the best policy only if >=3/4 folds plus aggregate pass, then open July once. Only if July passes, evaluate the exact same frozen policy on a second untouched Aug 1-Sep 15 holdout. No refitting after development.',
   frozen_rule:RULE,exit_candidates:EXITS.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,july_signals:js.length,final_holdout_signals:fsig.length},
   selected:chosen?{profile:chosen.profile,aggregate:chosen.aggregate,folds:chosen.folds}:null,
   top_candidates:candidates.slice(0,12).map(x=>({profile:x.profile,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
   july_test:julyTest,final_holdout_test:finalTest,production_candidate_ready:ready,
   decision:!chosen?{label:'FROZEN_CONFIRM_TP_NOT_STABLE_IN_DEVELOPMENT',ready:false}:!julyTest?.pass?{label:'FROZEN_CONFIRM_TP_FAILED_JULY',ready:false}:!finalTest?.pass?{label:'FROZEN_CONFIRM_TP_FAILED_SECOND_HOLDOUT',ready:false}:{label:'FROZEN_CONFIRM_TP_DOUBLE_HOLDOUT_CONFIRMED',ready:true}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
