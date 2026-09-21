'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const LAMBDAS=[.1,.3,1,3];
const ROUTE_Q=[0,.50,.65,.80,.90];

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function sd(x){const m=avg(x);return Math.sqrt(avg(x.map(v=>(v-m)**2)))||1}
function qtl(x,q){if(!x.length)return 0;const a=[...x].sort((a,b)=>a-b),p=(a.length-1)*q,i=Math.floor(p),f=p-i;return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f}
function ret(a,b){return a>0&&b>0?b/a-1:0}

const FEATURES=['ret5','ret15','ret30','ret60','rv15','rv30','rv60','down_ratio30','worst_bar30','body_last','upper_wick_last','lower_wick_last','range_last','body_mean15','upper_wick_mean15','lower_wick_mean15','range_mean15','vol_jump5_30','vol_cv30','dist_high60','dist_high240','dist_low60','trade_accel','breakout60','breakout240','r15','r60','r240','extension','continuation'];
function vec(s){
  const a=s.series,i=s.index,row=k=>a[Math.max(0,i-k)],px=k=>Number(row(k)?.c||0),r=k=>ret(px(k),px(0));
  const rs=[];for(let k=Math.max(1,i-11);k<=i;k++)rs.push(ret(Number(a[k-1]?.c||0),Number(a[k]?.c||0)));
  const bars=n=>a.slice(Math.max(0,i-n+1),i+1),b3=bars(3),b6=bars(6),b12=bars(12),b48=bars(48);
  const candle=x=>{const o=Number(x?.o||0),h=Number(x?.h||0),l=Number(x?.l||0),c=Number(x?.c||0),rg=Math.max(1e-12,h-l);return {body:(c-o)/Math.max(1e-12,o),uw:(h-Math.max(o,c))/rg,lw:(Math.min(o,c)-l)/rg,range:rg/Math.max(1e-12,o)}};
  const last=candle(a[i]),cs=b3.map(candle),rv=x=>sd(x),down=x=>x.length?x.filter(v=>v<0).length/x.length:0;
  const qs=b6.map(x=>Math.log1p(Number(x.q||0))),ql=Math.log1p(Number(a[i]?.q||0));
  const hi=x=>Math.max(...x.map(z=>Number(z.h||0))),lo=x=>Math.min(...x.map(z=>Number(z.l||0))),cur=Number(a[i]?.c||0);
  const f=s.f||{},d=s.productionV42?.detail||{};
  return [
    r(1),r(3),r(6),r(12),rv(rs.slice(-3)),rv(rs.slice(-6)),rv(rs),down(rs.slice(-6)),Math.min(...rs.slice(-6),0),
    last.body,last.uw,last.lw,last.range,avg(cs.map(x=>x.body)),avg(cs.map(x=>x.uw)),avg(cs.map(x=>x.lw)),avg(cs.map(x=>x.range)),
    ql-avg(qs),sd(qs)/Math.max(1e-9,Math.abs(avg(qs))),hi(b12)>0?cur/hi(b12)-1:0,hi(b48)>0?cur/hi(b48)-1:0,lo(b12)>0?cur/lo(b12)-1:0,
    Math.log(Math.max(.2,Number(f.tradeAccel)||.2)),Number(f.breakout60||0),Number(f.breakout240||0),Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(d.extension||0),Number(s.continuationScore||0)
  ].map(x=>Number.isFinite(x)?x:0);
}
function solve(A,y){
  const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
  for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;if(Math.abs(M[p][c])<1e-12)return null;[M[c],M[p]]=[M[p],M[c]];const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j]}}
  return M.map(r=>r[n]);
}
function fit(rows,lambda){
  if(rows.length<24)return null;
  const X=rows.map(x=>vec(x.s)),p=X[0].length,mean=Array(p).fill(0),scale=Array(p).fill(1);
  for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);scale[j]=sd(col)}
  const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
  rows.forEach((r,k)=>{const x=[1,...X[k].map((v,j)=>(v-mean[j])/scale[j])];for(let i=0;i<d;i++){Y[i]+=x[i]*r.y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j]}});
  for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
  const beta=solve(A,Y);return beta?{beta,mean,scale}:null;
}
function pred(m,s){const x=vec(s);let z=m.beta[0];for(let j=0;j<x.length;j++)z+=m.beta[j+1]*((x[j]-m.mean[j])/m.scale[j]);return z}

function profiles(lib){return [
  {id:'BASE',cfg:lib.b.BASE_EXIT},
  {id:'FAST',cfg:{hardStop:.040,beTrigger:.012,beLock:.001,trailTrigger:.025,trailGap:.012,staleBars:72}},
  {id:'BALANCED',cfg:{hardStop:.040,beTrigger:.020,beLock:.001,trailTrigger:.040,trailGap:.018,staleBars:120}},
  {id:'RUNNER',cfg:{hardStop:.040,beTrigger:.030,beLock:.002,trailTrigger:.060,trailGap:.025,staleBars:180}}
]}
function net(lib,s,p){return Number(lib.r.simulateExit(s,p.cfg)?.net||0)}
function fitRouter(lib,train,lambda,q){
  const ps=profiles(lib),models={};
  for(const p of ps.slice(1)){
    const rows=train.map(s=>({s,y:net(lib,s,p)-net(lib,s,ps[0])}));
    const m=fit(rows,lambda);if(!m)return null;
    const scores=train.map(s=>pred(m,s));
    models[p.id]={model:m,threshold:q===0?0:Math.max(0,qtl(scores,q))};
  }
  return {models,profiles:ps};
}
function route(router,s){
  let best=router.profiles[0],gain=0;
  for(const p of router.profiles.slice(1)){
    const x=router.models[p.id],g=pred(x.model,s);
    if(g>=x.threshold&&g>gain){gain=g;best=p}
  }
  return {profile:best,predicted_gain:gain};
}
function mixedEconomic(lib,signals,all,router){
  const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,route(router,s).profile.cfg),()=>lib.b.FIXED_SIZE);
  lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m);
}
function baseEconomic(lib,signals,all){
  const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,lib.b.BASE_EXIT),()=>lib.b.FIXED_SIZE);
  lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m);
}
function deltaE(a,b){return {net_growth:a.netGrowth-b.netGrowth,avg_net_ret:a.avgNetRet-b.avgNetRet,max_drawdown:a.maxDrawdown-b.maxDrawdown}}
function passE(d,m,n){return n>=8&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0&&m.netGrowth>0&&m.avgNetRet>0}
function objective(d){return d.net_growth*16+d.avg_net_ret*12+d.max_drawdown*4}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
  const configs=[];for(const lambda of LAMBDAS)for(const q of ROUTE_Q)configs.push({lambda,q,folds:[],routed:[]});
  const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
  for(let round=1;round<=4&&start<ds.length;round++){
    const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
    const bm=baseEconomic(lib,val,all);
    for(const cfg of configs){
      const router=fitRouter(lib,train,cfg.lambda,cfg.q);if(!router)continue;
      const m=mixedEconomic(lib,val,all,router),d=deltaE(m,bm);
      const routes={BASE:0,FAST:0,BALANCED:0,RUNNER:0};
      val.forEach(s=>routes[route(router,s).profile.id]++);
      cfg.routed.push(...val.map(s=>({...s,__route:route(router,s).profile.id})));
      cfg.folds.push({round,signals:val.length,routes,delta:d,metrics:m,pass:passE(d,m,val.length)});
    }
    start=end;
  }
  const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=baseEconomic(lib,walk,walkAll);
  for(const cfg of configs){
    const byKey=new Map(cfg.routed.map(s=>[`${s.symbol||''}:${s.t}`,s.__route]));
    const ps=profiles(lib),pmap=Object.fromEntries(ps.map(p=>[p.id,p]));
    const m=lib.r.portfolio(walk,walkAll,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,(pmap[byKey.get(`${s.symbol||''}:${s.t}`)]||pmap.BASE).cfg),()=>lib.b.FIXED_SIZE);
    lib.r.withRecall(m,m._trades||[],walkAll);const em=lib.r.safeMetrics(m),d=deltaE(em,bm);
    cfg.aggregate={signals:walk.length,metrics:em,delta:d,objective:objective(d),pass_folds:cfg.folds.filter(x=>x.pass).length};
    cfg.viable=cfg.aggregate.pass_folds>=3&&passE(d,em,walk.length);
    delete cfg.routed;
  }
  configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
  const chosen=configs.find(x=>x.viable)||null;
  let confirmation=null,confirmationPass=false,attribution=null;
  if(chosen){
    const router=fitRouter(lib,ds,chosen.lambda,chosen.q),bm=baseEconomic(lib,hs,hold),m=mixedEconomic(lib,hs,hold,router),d=deltaE(m,bm);
    const routes={BASE:0,FAST:0,BALANCED:0,RUNNER:0};hs.forEach(s=>routes[route(router,s).profile.id]++);
    confirmation={signals:hs.length,routes,baseline:bm,metrics:m,delta:d,prediction_delta:{winner5_precision:0,winner10_precision:0}};
    confirmationPass=passE(d,m,hs.length);
    attribution={};
    for(const [id,x] of Object.entries(router.models))attribution[id]=FEATURES.map((n,i)=>({feature:n,coefficient:x.model.beta[i+1],abs:Math.abs(x.model.beta[i+1])})).sort((a,b)=>b.abs-a.abs).slice(0,12);
  }
  const report={version:'MONETIZATION_EDGE_V8_DYNAMIC_EXIT_ROUTER',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
    objective:'Keep every CORE entry unchanged so +5%/+10% precision cannot deteriorate. Learn only whether a pre-entry microstructure state predicts incremental net-return advantage from FAST, BALANCED or RUNNER exit behavior versus the unchanged BASE exit. Require stable positive economics on Apr-Jun walk-forward before opening July.',
    invariant:{entry_selection:'UNCHANGED_CORE',prediction_precision_delta_by_construction:0,holdout_opened:Boolean(chosen)},
    exit_profiles:profiles(lib).map(x=>({id:x.id,cfg:x.cfg})),features:FEATURES,candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
    selected:chosen?{lambda:chosen.lambda,q:chosen.q,aggregate:chosen.aggregate,folds:chosen.folds}:null,
    top_candidates:configs.slice(0,12).map(x=>({lambda:x.lambda,q:x.q,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
    confirmation,attribution,confirmation_pass:confirmationPass,
    decision:!chosen?{label:'DYNAMIC_EXIT_ROUTER_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'DYNAMIC_EXIT_ROUTER_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'DYNAMIC_EXIT_ROUTER_FAILED_FRESH_HOLDOUT',ready:false}};
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,selected:report.selected,top_candidates:report.top_candidates.slice(0,8),confirmation,confirmation_pass:confirmationPass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
