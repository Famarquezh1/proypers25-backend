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
   if(!chosen){folds.push({round,rule:null,pass:false});start=end;continue}
   const sig=val.map(s=>routed(lib,s,chosen.rule)).filter(Boolean),m=metrics(lib,sig,valAll),d=delta(m,bm);
   const pass=sig.length>=8&&acceptable(m,bm);
   folds.push({round,rule:chosen.rule,train_retention:chosen.retention,signals:sig.length,retention:sig.length/val.length,metrics:m,delta:d,pass});
   routedAll.push(...sig);start=end;
 }
 const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=metrics(lib,walk,walkAll),m=metrics(lib,routedAll,walkAll),d=delta(m,bm);
 const passFolds=folds.filter(x=>x.pass).length;
 const aggregatePass=passFolds>=3&&routedAll.length>=24&&acceptable(m,bm);
 let finalRule=null,confirmation=null,confirmationPass=false;
 if(aggregatePass){
   const tr=trainRule(lib,ds,dev);finalRule=tr?.rule||null;
   if(finalRule){
     const sig=hs.map(s=>routed(lib,s,finalRule)).filter(Boolean),hb=metrics(lib,hs,hold),hm=metrics(lib,sig,hold),hd=delta(hm,hb);
     confirmation={rule:finalRule,signals:sig.length,retention:sig.length/hs.length,baseline:hb,metrics:hm,delta:hd};
     confirmationPass=sig.length>=8&&acceptable(hm,hb);
   }
 }
 const report={version:'MONETIZATION_EDGE_V13_POST_SIGNAL_CONFIRMATION',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'Use information that becomes observable after a CORE signal but before execution. Wait 5 or 10 minutes, require acceptable retest depth, close location and volume confirmation, then enter at the new price. Rule is calibrated only on prior development data per walk-forward fold. July opens only if >=3/4 folds plus aggregate are positive and non-inferior.',
   rule_grid_count:RULES.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
   folds,aggregate:{signals:routedAll.length,retention:routedAll.length/walk.length,baseline:bm,metrics:m,delta:d,pass_folds:passFolds,pass:aggregatePass},
   final_rule:finalRule,confirmation,confirmation_pass:confirmationPass,
   decision:!aggregatePass?{label:'POST_SIGNAL_CONFIRMATION_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'POST_SIGNAL_CONFIRMATION_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'POST_SIGNAL_CONFIRMATION_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
