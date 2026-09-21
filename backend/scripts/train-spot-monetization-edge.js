'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const DELAYS=[0,1,2,3,4];
const LAMBDAS=[.1,.3,1,3];
const ROUTE_Q=[0,.50,.70,.85];

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function sd(x){const m=avg(x);return Math.sqrt(avg(x.map(v=>(v-m)**2)))||1}
function qtl(x,q){if(!x.length)return 0;const a=[...x].sort((a,b)=>a-b),p=(a.length-1)*q,i=Math.floor(p),f=p-i;return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2))}

const FEATURES=['trade_accel','breakout60','breakout240','breakout_x_volume','r15','r60','r240','rs60','extension','vol_slope','continuation','confirm','ret5','ret15','ret30','rv15','down_ratio30','body','upper_wick','lower_wick','range','vol_jump'];
function vec(s){
  const f=s.f||{},d=s.productionV42?.detail||{},a=s.series,i=s.index;
  const px=k=>Number(a[Math.max(0,i-k)]?.c||0),ret=k=>px(k)>0&&px(0)>0?px(0)/px(k)-1:0;
  const rs=[];for(let k=Math.max(1,i-5);k<=i;k++){const p=Number(a[k-1]?.c||0),z=Number(a[k]?.c||0);rs.push(p>0&&z>0?z/p-1:0)}
  const row=a[i]||{},o=Number(row.o||0),h=Number(row.h||0),l=Number(row.l||0),cl=Number(row.c||0),rg=Math.max(1e-12,h-l);
  const qs=a.slice(Math.max(0,i-5),i+1).map(x=>Math.log1p(Number(x.q||0))),ql=Math.log1p(Number(row.q||0));
  return [
    logSafe(f.tradeAccel),Number(f.breakout60||0),Number(f.breakout240||0),Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),
    Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(f.rs60||0),Number(d.extension||0),logSafe(f.vol15)-logSafe(f.vol30),Number(s.continuationScore||0),Number(d.confirm||0),
    ret(1),ret(3),ret(6),sd(rs.slice(-3)),rs.length?rs.filter(x=>x<0).length/rs.length:0,(cl-o)/Math.max(1e-12,o),(h-Math.max(o,cl))/rg,(Math.min(o,cl)-l)/rg,rg/Math.max(1e-12,o),ql-avg(qs)
  ].map(x=>Number.isFinite(x)?x:0);
}
function solve(A,y){
  const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
  for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;if(Math.abs(M[p][c])<1e-12)return null;[M[c],M[p]]=[M[p],M[c]];const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j]}}
  return M.map(r=>r[n]);
}
function fit(rows,lambda){
  if(rows.length<30)return null;
  const X=rows.map(x=>vec(x.s)),p=X[0].length,mean=Array(p).fill(0),scale=Array(p).fill(1);
  for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);scale[j]=sd(col)}
  const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
  rows.forEach((r,k)=>{const x=[1,...X[k].map((v,j)=>(v-mean[j])/scale[j])];for(let i=0;i<d;i++){Y[i]+=x[i]*r.y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j]}});
  for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
  const beta=solve(A,Y);return beta?{beta,mean,scale}:null;
}
function pred(m,s){const x=vec(s);let z=m.beta[0];for(let j=0;j<x.length;j++)z+=m.beta[j+1]*((x[j]-m.mean[j])/m.scale[j]);return z}
function delayed(lib,s,bars){
  if(!bars)return s;
  const ni=s.index+bars;if(ni+145>=s.series.length)return null;
  const z={...s,index:ni,t:s.series[ni].t};z.outcome=lib.futureOutcome(z);return z.outcome?z:null;
}
function net(lib,s){return Number(lib.r.simulateExit(s,lib.b.BASE_EXIT)?.net||0)}
function utility(lib,s){
  if(!s||!s.outcome)return -.1;
  return net(lib,s)+.03*(s.outcome.winner5?1:0)+.055*(s.outcome.winner10?1:0)+.08*Math.min(.10,Math.max(0,Number(s.outcome.mfe12||0)))-.04*Math.max(0,-Number(s.outcome.maeToPeak||0));
}
function fitRouter(lib,train,lambda,q){
  const models={};
  for(const d of DELAYS.slice(1)){
    const rows=train.map(s=>{const z=delayed(lib,s,d);return {s,y:utility(lib,z)-utility(lib,s)}});
    const m=fit(rows,lambda);if(!m)return null;
    const scores=train.map(s=>pred(m,s));
    models[d]={model:m,threshold:q===0?0:Math.max(0,qtl(scores,q))};
  }
  return models;
}
function choose(models,s){
  let best=0,gain=0;
  for(const d of DELAYS.slice(1)){const x=models[d],g=pred(x.model,s);if(g>=x.threshold&&g>gain){gain=g;best=d}}
  return {delay:best,predicted_gain:gain};
}
function route(lib,models,s){const c=choose(models,s);return delayed(lib,s,c.delay)||s}
function metrics(lib,signals,all){return {prediction:lib.predictionMetrics(signals),economic:lib.economicMetrics(signals,all)}}
function delta(a,b){return {
 winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
 winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
 avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
 net_growth:a.economic.netGrowth-b.economic.netGrowth,
 avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
 max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
}}
function nonneg(d){return d.winner5_precision>=0&&d.winner10_precision>=0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}
function objective(d){return d.net_growth*16+d.avg_net_ret*10+d.max_drawdown*4+d.winner5_precision*2+d.winner10_precision*3}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
 const configs=[];for(const lambda of LAMBDAS)for(const q of ROUTE_Q)configs.push({lambda,q,folds:[],routed:[]});
 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
 for(let round=1;round<=4&&start<ds.length;round++){
   const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t+30*60000),bm=metrics(lib,val,all);
   for(const cfg of configs){
     const models=fitRouter(lib,train,cfg.lambda,cfg.q);if(!models)continue;
     const sig=val.map(s=>route(lib,models,s)),m=metrics(lib,sig,all),d=delta(m,bm),counts={0:0,5:0,10:0,15:0,20:0};
     val.forEach(s=>counts[choose(models,s).delay*5]++);
     cfg.routed.push(...sig);
     cfg.folds.push({round,signals:sig.length,counts,metrics:m,delta:d,pass:sig.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0});
   }
   start=end;
 }
 const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=metrics(lib,walk,walkAll);
 for(const cfg of configs){
   const models=fitRouter(lib,ds.slice(0,initial),cfg.lambda,cfg.q); // only for metadata; aggregate uses concatenated unseen routed folds
   const sig=cfg.routed,m=metrics(lib,sig,walkAll),d=delta(m,bm);
   cfg.aggregate={signals:sig.length,metrics:m,delta:d,objective:objective(d),pass_folds:cfg.folds.filter(x=>x.pass).length};
   cfg.viable=cfg.aggregate.pass_folds>=3&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
   delete cfg.routed;
 }
 configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);const chosen=configs.find(x=>x.viable)||null;
 let confirmation=null,confirmationPass=false,attribution=null;
 if(chosen){
   const models=fitRouter(lib,ds,chosen.lambda,chosen.q),sig=hs.map(s=>route(lib,models,s)),bm=metrics(lib,hs,hold),m=metrics(lib,sig,hold),d=delta(m,bm),counts={0:0,5:0,10:0,15:0,20:0};
   hs.forEach(s=>counts[choose(models,s).delay*5]++);
   confirmation={signals:sig.length,counts,baseline:bm,metrics:m,delta:d};confirmationPass=sig.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
   attribution={};for(const [delay,x] of Object.entries(models))attribution[delay*5+'m']=FEATURES.map((n,i)=>({feature:n,coefficient:x.model.beta[i+1],abs:Math.abs(x.model.beta[i+1])})).sort((a,b)=>b.abs-a.abs).slice(0,10);
 }
 const report={version:'MONETIZATION_EDGE_V12_CONDITIONAL_TIMING_ROUTER',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'Learn from Apr-Jun which original CORE states benefit from immediate entry versus 5/10/15/20-minute delay. The routing model sees only information available at the original signal; delayed outcomes are training labels. Every routed signal recomputes +5%, +10%, MFE, MAE and BASE_EXIT economics from its actual delayed price. July opens only after stable positive walk-forward.',
   delays_minutes:DELAYS.map(x=>x*5),features:FEATURES,candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
   selected:chosen?{lambda:chosen.lambda,q:chosen.q,aggregate:chosen.aggregate,folds:chosen.folds}:null,
   top_candidates:configs.slice(0,12).map(x=>({lambda:x.lambda,q:x.q,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
   confirmation,attribution,confirmation_pass:confirmationPass,
   decision:!chosen?{label:'CONDITIONAL_TIMING_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'CONDITIONAL_TIMING_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'CONDITIONAL_TIMING_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,selected:report.selected,top_candidates:report.top_candidates.slice(0,8),confirmation,attribution,confirmation_pass:confirmationPass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
