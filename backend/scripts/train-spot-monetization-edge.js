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

const FEATURES=['net5','net10','net20','win5','win10','win20','stop5','stop10','stop20','mfe5','mfe10','mfe20','capture5','capture10','capture20','net_accel','stop_accel'];
function outcomeRow(lib,s){const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);return o?{net:Number(o.net||0),win:Number(o.net||0)>0?1:0,stop:o.stopBefore10?1:0,mfe:Number(o.mfeDuringTrade||0),capture:Number(o.captureRatioDuringTrade||0)}:null}
function annotateEdgeState(lib,signals){
  const DAY=86400000,rows=[];
  for(const s of signals){
    const eligible=rows.filter(x=>x.t<=s.t-DAY),take=n=>eligible.slice(-n).map(x=>x.o),stats=n=>{const z=take(n);return z.length?{net:avg(z.map(x=>x.net)),win:avg(z.map(x=>x.win)),stop:avg(z.map(x=>x.stop)),mfe:avg(z.map(x=>x.mfe)),capture:avg(z.map(x=>x.capture))}:{net:0,win:.5,stop:.5,mfe:0,capture:0}};
    const a=stats(5),b=stats(10),d=stats(20);
    s.edgeState=[a.net,b.net,d.net,a.win,b.win,d.win,a.stop,b.stop,d.stop,a.mfe,b.mfe,d.mfe,a.capture,b.capture,d.capture,a.net-d.net,a.stop-d.stop];
    const o=outcomeRow(lib,s);if(o)rows.push({t:s.t,o});
  }
  return signals;
}
function vec(s){return (s.edgeState||Array(FEATURES.length).fill(0)).map(x=>Number.isFinite(x)?x:0)}
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

const SIZE_POLICIES=[
  {id:'balanced',mult:[.50,1.00,1.50]},
  {id:'conviction',mult:[.25,1.00,1.75]},
  {id:'barbell',mult:[.40,.60,2.00]}
];
const BANDS=[[.33,.67],[.25,.75]];

function outcome(lib,s){return lib.r.simulateExit(s,lib.b.BASE_EXIT)}
function qualityTarget(lib,s){const o=outcome(lib,s);if(!o)return -.05;return Number(o.net||0)+.12*Math.min(.08,Math.max(0,Number(o.mfeDuringTrade||0)))-(o.stopBefore10?.025:0)}
function fitSizer(lib,train,lambda,bands,policy){
  const model=fit(train.map(s=>({s,y:qualityTarget(lib,s)})),lambda);if(!model)return null;
  const scores=train.map(s=>pred(model,s)),lo=qtl(scores,bands[0]),hi=qtl(scores,bands[1]);
  return {model,lo,hi,policy};
}
function mult(sz,s){const z=pred(sz.model,s);return z<sz.lo?sz.policy.mult[0]:z<sz.hi?sz.policy.mult[1]:sz.policy.mult[2]}
function sizedEconomic(lib,signals,all,sz){
  const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,lib.b.BASE_EXIT),s=>lib.b.FIXED_SIZE*mult(sz,s));
  lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m);
}
function baseEconomic(lib,signals,all){
  const m=lib.r.portfolio(signals,all,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,lib.b.BASE_EXIT),()=>lib.b.FIXED_SIZE);
  lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m);
}
function deltaE(a,b){return {net_growth:a.netGrowth-b.netGrowth,avg_net_ret:a.avgNetRet-b.avgNetRet,max_drawdown:a.maxDrawdown-b.maxDrawdown}}
function passE(d,m,n){return n>=8&&d.net_growth>=0&&d.avg_net_ret>=-1e-12&&d.max_drawdown>=0&&m.netGrowth>0}
function objective(d){return d.net_growth*18+d.max_drawdown*5+d.avg_net_ret*4}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);annotateEdgeState(lib,[...ds,...hs].sort((a,b)=>a.t-b.t));
  const configs=[];for(const lambda of LAMBDAS)for(const policy of SIZE_POLICIES)for(const bands of BANDS)configs.push({lambda,policy,bands,folds:[],weighted:[]});
  const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
  for(let round=1;round<=4&&start<ds.length;round++){
    const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t),bm=baseEconomic(lib,val,all);
    for(const cfg of configs){
      const sz=fitSizer(lib,train,cfg.lambda,cfg.bands,cfg.policy);if(!sz)continue;
      const m=sizedEconomic(lib,val,all,sz),d=deltaE(m,bm),counts={low:0,mid:0,high:0};
      val.forEach(s=>{const x=mult(sz,s);if(x===cfg.policy.mult[0])counts.low++;else if(x===cfg.policy.mult[2])counts.high++;else counts.mid++;cfg.weighted.push({...s,__mult:x})});
      cfg.folds.push({round,signals:val.length,counts,avg_multiplier:(counts.low*cfg.policy.mult[0]+counts.mid*cfg.policy.mult[1]+counts.high*cfg.policy.mult[2])/val.length,delta:d,metrics:m,pass:passE(d,m,val.length)});
    }
    start=end;
  }
  const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=baseEconomic(lib,walk,walkAll);
  for(const cfg of configs){
    const mm=new Map(cfg.weighted.map(s=>[`${s.symbol||''}:${s.t}`,s.__mult]));
    const m=lib.r.portfolio(walk,walkAll,lib.b.META_FALLBACK,s=>lib.r.simulateExit(s,lib.b.BASE_EXIT),s=>lib.b.FIXED_SIZE*(mm.get(`${s.symbol||''}:${s.t}`)||1));
    lib.r.withRecall(m,m._trades||[],walkAll);const em=lib.r.safeMetrics(m),d=deltaE(em,bm);
    cfg.aggregate={signals:walk.length,metrics:em,delta:d,objective:objective(d),pass_folds:cfg.folds.filter(x=>x.pass).length,avg_multiplier:avg([...mm.values()])};
    cfg.viable=cfg.aggregate.pass_folds>=3&&passE(d,em,walk.length);
    delete cfg.weighted;
  }
  configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);const chosen=configs.find(x=>x.viable)||null;
  let confirmation=null,confirmationPass=false,attribution=null;
  if(chosen){
    const sz=fitSizer(lib,ds,chosen.lambda,chosen.bands,chosen.policy),bm=baseEconomic(lib,hs,hold),m=sizedEconomic(lib,hs,hold,sz),d=deltaE(m,bm),counts={low:0,mid:0,high:0};
    hs.forEach(s=>{const x=mult(sz,s);if(x===chosen.policy.mult[0])counts.low++;else if(x===chosen.policy.mult[2])counts.high++;else counts.mid++});
    confirmation={signals:hs.length,counts,avg_multiplier:(counts.low*chosen.policy.mult[0]+counts.mid*chosen.policy.mult[1]+counts.high*chosen.policy.mult[2])/hs.length,baseline:bm,metrics:m,delta:d,prediction_delta:{winner5_precision:0,winner10_precision:0}};
    confirmationPass=passE(d,m,hs.length);
    attribution=FEATURES.map((n,i)=>({feature:n,coefficient:sz.model.beta[i+1],abs:Math.abs(sz.model.beta[i+1])})).sort((a,b)=>b.abs-a.abs).slice(0,15);
  }
  const report={version:'MONETIZATION_EDGE_V10_CAUSAL_EDGE_MEMORY',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
    objective:'Keep CORE entry selection and BASE_EXIT unchanged. Learn whether the system edge itself is currently healthy from only fully closed prior CORE signals (24h embargo): trailing net return, win rate, early-stop rate, MFE and capture over 5/10/20 signals. Redistribute equal-average historical exposure by this causal edge state. July remains unopened unless Apr-Jun walk-forward is stable and positive.',
    invariant:{entry_selection:'UNCHANGED_CORE',exit:'UNCHANGED_BASE_EXIT',prediction_precision_delta_by_construction:0,holdout_opened:Boolean(chosen)},
    size_policies:SIZE_POLICIES,bands:BANDS,features:FEATURES,candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
    selected:chosen?{lambda:chosen.lambda,policy:chosen.policy,bands:chosen.bands,aggregate:chosen.aggregate,folds:chosen.folds}:null,
    top_candidates:configs.slice(0,12).map(x=>({lambda:x.lambda,policy:x.policy.id,bands:x.bands,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
    confirmation,attribution,confirmation_pass:confirmationPass,
    decision:!chosen?{label:'CAUSAL_EDGE_MEMORY_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'CAUSAL_EDGE_MEMORY_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'CAUSAL_EDGE_MEMORY_FAILED_FRESH_HOLDOUT',ready:false}};
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,selected:report.selected,top_candidates:report.top_candidates.slice(0,8),confirmation,top_attribution:attribution,confirmation_pass:confirmationPass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
