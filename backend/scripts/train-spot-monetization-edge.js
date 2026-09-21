'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');

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
function confirmFeatures(s,bars){
  const a=s.series,i=s.index,entry=Number(a[i+1]?.o||0),j=i+bars;
  if(!(entry>0)||j>=a.length)return null;
  let hi=entry,lo=entry,vol=0;
  for(let k=i+1;k<=j;k++){hi=Math.max(hi,Number(a[k].h||0));lo=Math.min(lo,Number(a[k].l||0));vol+=Number(a[k].q||0)}
  const r=a[j],close=Number(r.c||0),open=Number(r.o||0),high=Number(r.h||0),low=Number(r.l||0),rg=Math.max(1e-12,high-low);
  const prev=a.slice(Math.max(0,i-5),i+1),prevVol=avg(prev.map(x=>Number(x.q||0)));
  return {
    ret:close/entry-1,
    draw:lo/entry-1,
    excursion:hi/entry-1,
    close_loc:(close-low)/rg,
    body:(close-open)/Math.max(1e-12,open),
    volume:prevVol>0?(vol/bars)/prevVol:1
  };
}
const RULES=[];
for(const wait of [1,2])
for(const minRet of [-.015,-.010,-.005,0,.003])
for(const maxDraw of [-.04,-.03,-.02,-.015])
for(const minClose of [.35,.50,.65])
for(const minVol of [.70,1,1.25])
  RULES.push({wait,minRet,maxDraw,minClose,minVol});


function exitProfiles(lib){return [
  {id:'BASE',cfg:lib.b.BASE_EXIT},
  {id:'FAST_35',cfg:{hardStop:.035,beTrigger:.018,beLock:.001,trailTrigger:.035,trailGap:.015,staleBars:96}},
  {id:'BAL_40',cfg:{hardStop:.040,beTrigger:.020,beLock:.001,trailTrigger:.040,trailGap:.018,staleBars:120}},
  {id:'MID_45',cfg:{hardStop:.045,beTrigger:.030,beLock:.0015,trailTrigger:.055,trailGap:.022,staleBars:156}},
  {id:'TREND',cfg:{hardStop:.050,beTrigger:.060,beLock:.002,trailTrigger:.100,trailGap:.035,staleBars:240}},
  {id:'RUNNER',cfg:{hardStop:.055,beTrigger:.070,beLock:.002,trailTrigger:.120,trailGap:.045,staleBars:264}}
]}
function metricsExit(lib,signals,all,profile){
  const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,profile.cfg),()=>lib.b.FIXED_SIZE);
  lib.r.withRecall(m,m._trades||[],all);
  return {prediction:lib.predictionMetrics(signals),economic:lib.r.safeMetrics(m)};
}
function chooseExit(lib,signals,all){
  let best=null;
  for(const p of exitProfiles(lib)){
    const m=metricsExit(lib,signals,all,p);
    if(signals.length<8)continue;
    const score=m.economic.netGrowth*18+m.economic.avgNetRet*12+m.economic.maxDrawdown*4;
    if(!best||score>best.score)best={profile:p,metrics:m,score};
  }
  return best;
}
function passes(s,r){
  const f=confirmFeatures(s,r.wait);return !!f&&f.ret>=r.minRet&&f.draw>=r.maxDraw&&f.close_loc>=r.minClose&&f.volume>=r.minVol;
}
function routed(lib,s,r){return passes(s,r)?delayed(lib,s,r.wait):null}
function metrics(lib,signals,all){return {prediction:lib.predictionMetrics(signals),economic:lib.economicMetrics(signals,all)}}
function delta(a,b){return {
 winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
 winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
 avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
 net_growth:a.economic.netGrowth-b.economic.netGrowth,
 avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
 max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
}}
function obj(m){
 return m.economic.netGrowth*18+m.economic.avgNetRet*12+m.economic.maxDrawdown*4+
 m.prediction.winner5Precision*2+m.prediction.winner10Precision*3;
}
function acceptable(m,base){
  return m.prediction.signals>=8&&m.economic.netGrowth>0&&m.economic.avgNetRet>0&&
    m.economic.maxDrawdown>=base.economic.maxDrawdown&&
    m.prediction.winner5Precision>=base.prediction.winner5Precision&&
    m.prediction.winner10Precision>=base.prediction.winner10Precision;
}
function trainRule(lib,train,all){
  const bm=metrics(lib,train,all);
  let best=null;
  for(const r of RULES){
    const sig=train.map(s=>routed(lib,s,r)).filter(Boolean);
    if(sig.length<Math.max(10,Math.floor(train.length*.18)))continue;
    const m=metrics(lib,sig,all);
    const score=obj(m);
    if(!best||score>best.score)best={rule:r,score,metrics:m,retention:sig.length/train.length,acceptable:acceptable(m,bm)};
  }
  return best;
}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial,folds=[],routedAll=[];
 for(let round=1;round<=4&&start<ds.length;round++){
   const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end);
   const trainAll=dev.filter(s=>s.t>=train[0].t&&s.t<=train[train.length-1].t+15*60000);
   const valAll=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t+15*60000);
   const chosen=trainRule(lib,train,trainAll),bm=metrics(lib,val,valAll);
   if(!chosen){folds.push({round,rule:null,exit:null,pass:false});start=end;continue}
   const trainSig=train.map(s=>routed(lib,s,chosen.rule)).filter(Boolean);
   const ex=chooseExit(lib,trainSig,trainAll);
   if(!ex){folds.push({round,rule:chosen.rule,exit:null,pass:false});start=end;continue}
   const sig=val.map(s=>routed(lib,s,chosen.rule)).filter(Boolean),m=metricsExit(lib,sig,valAll,ex.profile),d=delta(m,bm);
   const pass=sig.length>=8&&acceptable(m,bm);
   folds.push({round,rule:chosen.rule,exit:ex.profile.id,train_retention:chosen.retention,signals:sig.length,retention:sig.length/val.length,metrics:m,delta:d,pass});
   routedAll.push(...sig.map(s=>({...s,__exit:ex.profile.id})));start=end;
 }
 const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=metrics(lib,walk,walkAll);
 const pmap=Object.fromEntries(exitProfiles(lib).map(p=>[p.id,p]));
 const mm=new Map(routedAll.map(s=>[`${s.symbol||''}:${s.t}`,s.__exit]));
 const pm=lib.r.portfolio(routedAll,walkAll,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,(pmap[mm.get(`${s.symbol||''}:${s.t}`)]||pmap.BASE).cfg),()=>lib.b.FIXED_SIZE);
 lib.r.withRecall(pm,pm._trades||[],walkAll);
 const m={prediction:lib.predictionMetrics(routedAll),economic:lib.r.safeMetrics(pm)},d=delta(m,bm);
 const passFolds=folds.filter(x=>x.pass).length;
 const aggregatePass=passFolds>=3&&routedAll.length>=24&&acceptable(m,bm);
 let finalRule=null,finalExit=null,confirmation=null,confirmationPass=false;
 if(aggregatePass){
   const tr=trainRule(lib,ds,dev);finalRule=tr?.rule||null;
   if(finalRule){
     const trainSig=ds.map(s=>routed(lib,s,finalRule)).filter(Boolean),ex=chooseExit(lib,trainSig,dev);finalExit=ex?.profile||null;
     if(finalExit){
       const sig=hs.map(s=>routed(lib,s,finalRule)).filter(Boolean),hb=metrics(lib,hs,hold),hm=metricsExit(lib,sig,hold,finalExit),hd=delta(hm,hb);
       confirmation={rule:finalRule,exit:finalExit.id,signals:sig.length,retention:sig.length/hs.length,baseline:hb,metrics:hm,delta:hd};
       confirmationPass=sig.length>=8&&acceptable(hm,hb);
     }
   }
 }
 const report={version:'MONETIZATION_EDGE_V14_CONFIRMATION_PLUS_EXIT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'Nested walk-forward: first learn a 5/10-minute post-CORE confirmation rule using only prior data; then, only on previously confirmed training signals, choose the exit profile that best monetizes them. Validation receives both choices without refitting. Require >=3/4 positive non-inferior folds and positive aggregate before opening July.',
   rule_grid_count:RULES.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
   folds,aggregate:{signals:routedAll.length,retention:routedAll.length/walk.length,baseline:bm,metrics:m,delta:d,pass_folds:passFolds,pass:aggregatePass},
   final_rule:finalRule,final_exit:finalExit?.id||null,confirmation,confirmation_pass:confirmationPass,
   decision:!aggregatePass?{label:'CONFIRMATION_PLUS_EXIT_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'CONFIRMATION_PLUS_EXIT_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'CONFIRMATION_PLUS_EXIT_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
