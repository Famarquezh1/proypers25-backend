'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const COST=.004;

function loadBase(){
 let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
 vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function delayed(lib,s){const ni=s.index+1;if(ni+145>=s.series.length)return null;const z={...s,index:ni,t:s.series[ni].t};z.outcome=lib.futureOutcome(z);return z.outcome?z:null}
function feat(s){
 const a=s.series,i=s.index,e=Number(a[i+1]?.o||0),j=i+1;if(!(e>0)||j>=a.length)return null;
 const r=a[j],c=Number(r.c||0),l=Number(r.l||0),h=Number(r.h||0),rg=Math.max(1e-12,h-l);
 const prev=a.slice(Math.max(0,i-5),i+1),pv=avg(prev.map(x=>Number(x.q||0)));
 return {ret:c/e-1,draw:l/e-1,close:(c-l)/rg,vol:pv>0?Number(r.q||0)/pv:1,ext:Number(s.productionV42?.detail?.extension||0)};
}
const POLICIES=[];
for(const extCut of [.055,.07,.085,.10])
for(const lowRet of [.002,.003,.005])
for(const highRet of [.006,.008,.010,.012])
for(const highClose of [.50,.60])
for(const highVol of [.70,1])
 POLICIES.push({extCut,lowRet,highRet,highClose,highVol,maxDraw:-.04,lowClose:.35,lowVol:.70});
function confirmed(lib,s,p){
 const x=feat(s);if(!x||x.draw<p.maxDraw)return null;
 const ok=x.ext<=p.extCut
   ? x.ret>=p.lowRet&&x.close>=p.lowClose&&x.vol>=p.lowVol
   : x.ret>=p.highRet&&x.close>=p.highClose&&x.vol>=p.highVol;
 return ok?delayed(lib,s):null;
}
const EXITS=[];
for(const tp of [.05,.06])
for(const sl of [.025,.03,.035,.04])
for(const hours of [4,8])EXITS.push({id:`TP${Math.round(tp*1000)}_SL${Math.round(sl*1000)}_${hours}H`,tp,sl,bars:hours*12});
function sim(s,p){
 const a=s.series,e=s.index+1,entry=Number(a[e]?.o||0);if(!(entry>0))return null;
 let high=entry,exit=entry,exitI=e,reason='TIMEOUT',hit10=null,stopBefore10=false;
 const stop=entry*(1-p.sl),take=entry*(1+p.tp),end=Math.min(a.length-1,e+p.bars);
 for(let k=e;k<=end;k++){
  const b=a[k],hs=Number(b.l)<=stop,ht=Number(b.h)>=take;high=Math.max(high,Number(b.h));
  if(hit10===null&&Number(b.h)/entry-1>=.10)hit10=(k-e)*5;
  if(hs&&ht){exit=stop;exitI=k;reason='AMBIGUOUS_STOP_FIRST';if(hit10===null)stopBefore10=true;break}
  if(hs){exit=stop;exitI=k;reason='HARD_STOP';if(hit10===null)stopBefore10=true;break}
  if(ht){exit=take;exitI=k;reason='TAKE_PROFIT';break}
  exit=Number(b.c);exitI=k;
 }
 const gross=exit/entry-1,net=gross-COST,mfe=high/entry-1;
 return {net,gross,mfeDuringTrade:mfe,mfeFixed24h:0,captureRatioDuringTrade:mfe>0?Math.max(0,net)/mfe:0,captureRatioFixed24h:0,captureLoss24h:0,holdingMin:(exitI-e)*5,exitReason:reason,stopBefore10,hit10};
}
function metrics(lib,sigs,rows,p,base=false){
 const pred=lib.predictionMetrics(sigs);
 const m=lib.r.portfolio(sigs,rows,lib.b.META_FALLBACK,s=>base?lib.r.simulateExit(s,lib.b.BASE_EXIT):sim(s,p),()=>lib.b.FIXED_SIZE);
 lib.r.withRecall(m,m._trades||[],rows);return {prediction:pred,economic:lib.r.safeMetrics(m)};
}
function delta(a,b){return {winner5:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10:a.prediction.winner10Precision-b.prediction.winner10Precision,net:a.economic.netGrowth-b.economic.netGrowth,avg:a.economic.avgNetRet-b.economic.avgNetRet,dd:a.economic.maxDrawdown-b.economic.maxDrawdown}}
function pass(m,b,min){return m.prediction.signals>=min&&m.economic.netGrowth>0&&m.economic.avgNetRet>0&&m.economic.maxDrawdown>=b.economic.maxDrawdown&&m.prediction.winner5Precision>=b.prediction.winner5Precision&&m.prediction.winner10Precision>=b.prediction.winner10Precision}
function ev(lib,orig,rows,r,p,min){const sig=orig.map(s=>confirmed(lib,s,r)).filter(Boolean),b=metrics(lib,orig,rows,null,true),m=metrics(lib,sig,rows,p),d=delta(m,b);return {signals:sig.length,retention:orig.length?sig.length/orig.length:0,baseline:b,metrics:m,delta:d,pass:pass(m,b,min)}}
function score(x){return x.metrics.economic.netGrowth*20+x.metrics.economic.avgNetRet*12+x.metrics.economic.maxDrawdown*5+x.metrics.prediction.winner5Precision*2+x.metrics.prediction.winner10Precision*3+.25*x.retention}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-08-01T00:00:00Z';process.env.CONFIRM_START='2026-08-01T00:00:00Z';process.env.CONFIRM_END='2026-09-22T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const recentRaw=raw.filter(s=>s.t>=Date.parse('2026-08-01T00:00:00Z')&&s.t<Date.parse('2026-09-16T00:00:00Z'));
 const freshRaw=raw.filter(s=>s.t>=Date.parse('2026-09-16T00:00:00Z')&&s.t<Date.parse('2026-09-22T00:00:00Z'));
 const rs=base.selectSignals(lib,recentRaw,0,0).sort((a,b)=>a.t-b.t),fsig=base.selectSignals(lib,freshRaw,0,0).sort((a,b)=>a.t-b.t);
 const n=rs.length,c1=Math.floor(n/3),c2=Math.floor(2*n/3),foldOrig=[rs.slice(0,c1),rs.slice(c1,c2),rs.slice(c2)];
 const candidates=[];
 for(const r of POLICIES)for(const p of EXITS){
  const folds=foldOrig.map((orig,idx)=>{const rows=recentRaw.filter(x=>x.t>=orig[0].t&&x.t<=orig[orig.length-1].t+15*60000);return {round:idx+1,...ev(lib,orig,rows,r,p,6)}});
  const agg=ev(lib,rs,recentRaw,r,p,20),pf=folds.filter(x=>x.pass).length;
  const viable=pf>=2&&agg.pass&&folds.every(x=>x.signals>=6);
  candidates.push({policy:r,profile:p,folds,aggregate:{...agg,pass_folds:pf,score:score(agg)},viable});
 }
 candidates.sort((a,b)=>b.aggregate.score-a.aggregate.score);
 const chosen=candidates.find(x=>x.viable)||null;
 let fresh=null,ready=false;
 if(chosen){fresh=ev(lib,fsig,freshRaw,chosen.policy,chosen.profile,6);ready=fresh.pass;}
 const report={version:'MONETIZATION_EDGE_V18_EXTENSION_AWARE_CONFIRMATION',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
  objective:'Use the V16/V17 regime finding directly: low-extension CORE signals may enter after modest 5m continuation, while already-extended signals require materially stronger 5m continuation/close/volume. Search only this bifurcated family on Aug1-Sep15 across three chronological folds, freeze a policy only with >=2/3 profitable/non-inferior folds, at least 6 signals in every fold and >=20 aggregate, then open untouched Sep16-Sep21 once.',
  policies:POLICIES.length,exits:EXITS.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,recent_signals:rs.length,fresh_signals:fsig.length},
  selected:chosen?{policy:chosen.policy,profile:chosen.profile,folds:chosen.folds,aggregate:chosen.aggregate}:null,
  top_candidates:candidates.slice(0,12).map(x=>({policy:x.policy,profile:x.profile,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
  fresh_holdout:fresh,production_candidate_ready:ready,
  decision:!chosen?{label:'EXTENSION_AWARE_POLICY_NOT_STABLE',ready:false}:ready?{label:'EXTENSION_AWARE_FRESH_HOLDOUT_CONFIRMED',ready:true}:{label:'EXTENSION_AWARE_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
