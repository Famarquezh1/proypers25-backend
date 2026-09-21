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
function delayed(lib,s,bars=1){const ni=s.index+bars;if(ni+145>=s.series.length)return null;const z={...s,index:ni,t:s.series[ni].t};z.outcome=lib.futureOutcome(z);return z.outcome?z:null}
function ext(s){return Number(s.productionV42?.detail?.extension||0)}
function feat(s){
 const a=s.series,i=s.index,e=Number(a[i+1]?.o||0),j=i+1;if(!(e>0)||j>=a.length)return null;
 const r=a[j],c=Number(r.c||0),l=Number(r.l||0),h=Number(r.h||0),rg=Math.max(1e-12,h-l);
 const prev=a.slice(Math.max(0,i-5),i+1),pv=avg(prev.map(x=>Number(x.q||0)));
 return {ret:c/e-1,draw:l/e-1,close:(c-l)/rg,vol:pv>0?Number(r.q||0)/pv:1,extension:ext(s)};
}
const RULES=[];
for(const minRet of [0,.003,.005,.008])
for(const maxDraw of [-.04,-.03])
for(const minClose of [.35,.55])
for(const minVol of [.70,1])
for(const maxExt of [.06,.08,.10,99])
 RULES.push({wait:1,minRet,maxDraw,minClose,minVol,maxExt});
function confirmed(lib,s,r){const x=feat(s);return x&&x.ret>=r.minRet&&x.draw>=r.maxDraw&&x.close>=r.minClose&&x.vol>=r.minVol&&x.extension<=r.maxExt?delayed(lib,s):null}

const EXITS=[];
for(const tp of [.04,.05,.06])
for(const sl of [.025,.035])
for(const hours of [4,8])EXITS.push({id:`TP${Math.round(tp*1000)}_SL${Math.round(sl*1000)}_${hours}H`,tp,sl,bars:hours*12});
function exitSim(s,p){
 const a=s.series,e=s.index+1,entry=Number(a[e]?.o||0);if(!(entry>0))return null;
 let high=entry,exit=entry,exitI=e,reason='TIMEOUT',hit10=null,stopBefore10=false;
 const stop=entry*(1-p.sl),take=entry*(1+p.tp),end=Math.min(a.length-1,e+p.bars);
 for(let k=e;k<=end;k++){const b=a[k],hs=Number(b.l)<=stop,ht=Number(b.h)>=take;high=Math.max(high,Number(b.h));
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
 const m=lib.r.portfolio(sigs,rows,lib.b.META_FALLBACK,s=>base?lib.r.simulateExit(s,lib.b.BASE_EXIT):exitSim(s,p),()=>lib.b.FIXED_SIZE);
 lib.r.withRecall(m,m._trades||[],rows);return {prediction:pred,economic:lib.r.safeMetrics(m)};
}
function delta(a,b){return {winner5:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10:a.prediction.winner10Precision-b.prediction.winner10Precision,net:a.economic.netGrowth-b.economic.netGrowth,avg:a.economic.avgNetRet-b.economic.avgNetRet,dd:a.economic.maxDrawdown-b.economic.maxDrawdown}}
function pass(m,b,min=6){return m.prediction.signals>=min&&m.economic.netGrowth>0&&m.economic.avgNetRet>0&&m.economic.maxDrawdown>=b.economic.maxDrawdown&&m.prediction.winner5Precision>=b.prediction.winner5Precision&&m.prediction.winner10Precision>=b.prediction.winner10Precision}
function ev(lib,orig,rows,r,p,min=6){const sig=orig.map(s=>confirmed(lib,s,r)).filter(Boolean),b=metrics(lib,orig,rows,null,true),m=metrics(lib,sig,rows,p),d=delta(m,b);return {signals:sig.length,retention:orig.length?sig.length/orig.length:0,baseline:b,metrics:m,delta:d,pass:pass(m,b,min)}}
function score(x){return x.metrics.economic.netGrowth*18+x.metrics.economic.avgNetRet*12+x.metrics.economic.maxDrawdown*4+x.metrics.prediction.winner5Precision*2+x.metrics.prediction.winner10Precision*3}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-08-01T00:00:00Z';process.env.CONFIRM_START='2026-08-01T00:00:00Z';process.env.CONFIRM_END='2026-09-22T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const recentRaw=raw.filter(s=>s.t>=Date.parse('2026-08-01T00:00:00Z')&&s.t<Date.parse('2026-09-16T00:00:00Z'));
 const freshRaw=raw.filter(s=>s.t>=Date.parse('2026-09-16T00:00:00Z')&&s.t<Date.parse('2026-09-22T00:00:00Z'));
 const rs=base.selectSignals(lib,recentRaw,0,0).sort((a,b)=>a.t-b.t),fsig=base.selectSignals(lib,freshRaw,0,0).sort((a,b)=>a.t-b.t);
 const n=rs.length,c1=Math.floor(n/3),c2=Math.floor(2*n/3),foldOrig=[rs.slice(0,c1),rs.slice(c1,c2),rs.slice(c2)];
 const candidates=[];
 for(const r of RULES)for(const p of EXITS){
   const folds=foldOrig.map((orig,idx)=>{const rows=recentRaw.filter(x=>x.t>=orig[0].t&&x.t<=orig[orig.length-1].t+15*60000);return {round:idx+1,...ev(lib,orig,rows,r,p,6)}});
   const agg=ev(lib,rs,recentRaw,r,p,18),pf=folds.filter(x=>x.pass).length;
   const viable=pf>=2&&agg.pass;
   candidates.push({rule:r,profile:p,folds,aggregate:{...agg,pass_folds:pf,score:score(agg)},viable});
 }
 candidates.sort((a,b)=>b.aggregate.score-a.aggregate.score);
 const chosen=candidates.find(x=>x.viable)||null;
 let fresh=null,ready=false;
 if(chosen){fresh=ev(lib,fsig,freshRaw,chosen.rule,chosen.profile,6);ready=fresh.pass;}
 const report={version:'MONETIZATION_EDGE_V17_RECENT_REGIME_FRESH_HOLDOUT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'After V16 exposed a regime break in Aug-Sep, use Aug 1-Sep 15 as a new recent-regime development set. Search a compact post-signal confirmation + extension-cap + TP/SL family across three chronological recent folds. Freeze a candidate only if >=2/3 folds and aggregate are absolutely profitable/non-inferior, then test once on untouched Sep 16-Sep 21.',
   rules:RULES.length,exits:EXITS.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,recent_signals:rs.length,fresh_signals:fsig.length},
   selected:chosen?{rule:chosen.rule,profile:chosen.profile,folds:chosen.folds,aggregate:chosen.aggregate}:null,
   top_candidates:candidates.slice(0,10).map(x=>({rule:x.rule,profile:x.profile,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
   fresh_holdout:fresh,production_candidate_ready:ready,
   decision:!chosen?{label:'RECENT_REGIME_POLICY_NOT_STABLE',ready:false}:ready?{label:'RECENT_REGIME_POLICY_FRESH_HOLDOUT_CONFIRMED',ready:true}:{label:'RECENT_REGIME_POLICY_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
