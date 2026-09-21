'use strict';

const fs=require('fs');
const path=require('path');
const vm=require('vm');

const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const LAMBDAS=[0.1,0.3,1,3];
const MIXES=[0,0.25,0.5,0.75,1,1.5];
const KEEPS=[0.30,0.40,0.50,0.60,0.70,0.80];

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__me;
}
function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function sd(xs){const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)))||1;}
function quantile(xs,q){if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),f=p-i;return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f;}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2));}

const FEATURES=['log_trade_accel','breakout60','breakout240','breakout_x_volume','r15','r60','r240','rs60','extension','vol_slope','continuation','confirm'];
function fmap(s){
  const f=s.f||{},q=s.productionV42||{},d=q.detail||{};
  return {
    log_trade_accel:logSafe(f.tradeAccel),
    breakout60:Number(f.breakout60||0),
    breakout240:Number(f.breakout240||0),
    breakout_x_volume:Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),
    r15:Number(f.r15||0),r60:Number(f.r60||0),r240:Number(f.r240||0),
    rs60:Number(f.rs60||0),
    extension:Number(d.extension||0),
    vol_slope:logSafe(f.vol15)-logSafe(f.vol30),
    continuation:Number(s.continuationScore||0),
    confirm:Number(d.confirm||0)
  };
}
function vec(s){const m=fmap(s);return FEATURES.map(n=>Number.isFinite(m[n])?m[n]:0);}

function solve(A,y){
  const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
  for(let c=0;c<n;c++){
    let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;
    if(Math.abs(M[p][c])<1e-12)return null;
    [M[c],M[p]]=[M[p],M[c]];
    const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;
    for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j];}
  }
  return M.map(r=>r[n]);
}
function fitRidge(rows,lambda){
  if(rows.length<25)return null;
  const X=rows.map(x=>vec(x.s)),p=X[0].length,mean=Array(p).fill(0),scale=Array(p).fill(1);
  for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);scale[j]=sd(col);}
  const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
  rows.forEach((row,k)=>{
    const x=[1,...X[k].map((v,j)=>(v-mean[j])/scale[j])],y=row.y;
    for(let i=0;i<d;i++){Y[i]+=x[i]*y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j];}
  });
  for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
  const beta=solve(A,Y);return beta?{beta,mean,scale,lambda}:null;
}
function pred(model,s){
  const x=vec(s);let z=model.beta[0];
  for(let j=0;j<x.length;j++)z+=model.beta[j+1]*((x[j]-model.mean[j])/model.scale[j]);
  return z;
}
function tradeNet(lib,s){const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);return Number(o?.net||0);}
function oppTarget(s){
  const o=s.outcome||{};
  return .35*Number(o.mfe12||0)+.006*(o.winner5?1:0)+.014*(o.winner10?1:0)-.05*Math.max(0,-Number(o.maeToPeak||0));
}
function fitMfeNet(rows){
  const xs=rows.map(x=>Number(x.s.outcome?.mfe12||0)),ys=rows.map(x=>x.net),xm=avg(xs),ym=avg(ys);
  const den=xs.reduce((a,x)=>a+(x-xm)**2,0)||1;
  const b=xs.reduce((a,x,i)=>a+(x-xm)*(ys[i]-ym),0)/den;
  return {a:ym-b*xm,b};
}
function monetizationRows(lib,signals){
  const base=signals.map(s=>({s,net:tradeNet(lib,s)}));
  const line=fitMfeNet(base);
  return {line,rows:base.map(x=>({s:x.s,y:x.net-(line.a+line.b*Number(x.s.outcome?.mfe12||0))}))};
}
function metrics(lib,signals,all){return {prediction:lib.predictionMetrics(signals),economic:lib.economicMetrics(signals,all)};}
function delta(a,b){return {
  winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
  winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
  avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
  net_growth:a.economic.netGrowth-b.economic.netGrowth,
  avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
  max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
};}
function nonNegative(d){return d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0&&d.winner5_precision>=0&&d.winner10_precision>=0;}
function objective(d){return d.net_growth*14+d.avg_net_ret*10+d.max_drawdown*3+d.winner5_precision*2+d.winner10_precision*3;}

function fitPair(lib,signals,lo,lm){
  const opp=fitRidge(signals.map(s=>({s,y:oppTarget(s)})),lo);
  const mr=monetizationRows(lib,signals);
  const mon=fitRidge(mr.rows,lm);
  return opp&&mon?{opp,mon,line:mr.line}:null;
}
function scorePair(pair,s,mix,stats){
  const o=pred(pair.opp,s),m=pred(pair.mon,s);
  return ((o-stats.om)/stats.os)+mix*((m-stats.mm)/stats.ms);
}
function scoreStats(pair,signals){
  const os=signals.map(s=>pred(pair.opp,s)),ms=signals.map(s=>pred(pair.mon,s));
  return {om:avg(os),os:sd(os),mm:avg(ms),ms:sd(ms)};
}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';
  process.env.DEV_END='2026-07-01T00:00:00Z';
  process.env.CONFIRM_START='2026-07-01T00:00:00Z';
  process.env.CONFIRM_END='2026-08-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t);
  const hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
  if(ds.length<80||hs.length<12)throw new Error(`insufficient signals dev=${ds.length} hold=${hs.length}`);

  const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));
  const keys=[];
  for(const lo of LAMBDAS)for(const lm of LAMBDAS)for(const mix of MIXES)for(const keep of KEEPS)keys.push({lo,lm,mix,keep,key:`${lo}|${lm}|${mix}|${keep}`,folds:[],selected:[]});

  let start=initial;
  for(let round=1;round<=4&&start<ds.length;round++){
    const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end);
    const all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
    const baseM=metrics(lib,val,all);
    for(const lo of LAMBDAS)for(const lm of LAMBDAS){
      const pair=fitPair(lib,train,lo,lm);if(!pair)continue;
      const st=scoreStats(pair,train);
      for(const mix of MIXES){
        const trainScores=train.map(s=>scorePair(pair,s,mix,st));
        for(const keep of KEEPS){
          const row=keys.find(x=>x.lo===lo&&x.lm===lm&&x.mix===mix&&x.keep===keep);
          const th=quantile(trainScores,1-keep);
          const selected=val.filter(s=>scorePair(pair,s,mix,st)>=th);
          const m=metrics(lib,selected,all),d=delta(m,baseM);
          row.folds.push({round,selected:selected.length,delta:d,objective:objective(d),pass:selected.length>=5&&nonNegative(d)});
          row.selected.push(...selected);
        }
      }
    }
    start=end;
  }

  const evalStart=ds[initial].t,walkAll=dev.filter(s=>s.t>=evalStart);
  const walkBase=metrics(lib,ds.slice(initial),walkAll);
  for(const k of keys){
    const m=metrics(lib,k.selected,walkAll),d=delta(m,walkBase);
    k.aggregate={selected:k.selected.length,metrics:m,delta:d,objective:objective(d),pass_folds:k.folds.filter(f=>f.pass).length};
    k.viable=k.aggregate.selected>=20&&k.aggregate.pass_folds>=3&&nonNegative(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
    delete k.selected;
  }
  const chosen=keys.filter(x=>x.viable).sort((a,b)=>b.aggregate.objective-a.aggregate.objective)[0]||null;

  let confirmation=null,confirmationPass=false,attribution=null;
  if(chosen){
    const pair=fitPair(lib,ds,chosen.lo,chosen.lm),st=scoreStats(pair,ds);
    const th=quantile(ds.map(s=>scorePair(pair,s,chosen.mix,st)),1-chosen.keep);
    const selected=hs.filter(s=>scorePair(pair,s,chosen.mix,st)>=th);
    const bm=metrics(lib,hs,hold),m=metrics(lib,selected,hold),d=delta(m,bm);
    confirmation={selected:selected.length,threshold:th,baseline:bm,metrics:m,delta:d};
    confirmationPass=selected.length>=8&&nonNegative(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
    attribution={
      opportunity:FEATURES.map((f,i)=>({feature:f,coefficient:pair.opp.beta[i+1],abs:Math.abs(pair.opp.beta[i+1])})).sort((a,b)=>b.abs-a.abs),
      monetization:FEATURES.map((f,i)=>({feature:f,coefficient:pair.mon.beta[i+1],abs:Math.abs(pair.mon.beta[i+1])})).sort((a,b)=>b.abs-a.abs),
      mfe_to_net_line:pair.line
    };
  }

  const report={
    version:'MONETIZATION_EDGE_V1',
    generated_at:new Date().toISOString(),
    research_only:true,production_mutation:false,
    objective:'Separate pre-entry movement potential from pre-entry monetization efficiency under the unchanged BASE_EXIT, select only configurations that survive expanding chronological walk-forward folds, then test once on a fresh July holdout.',
    periods:{development:['2026-04-01','2026-07-01'],fresh_holdout:['2026-07-01','2026-08-01']},
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
    candidate_count:keys.length,
    viable_count:keys.filter(x=>x.viable).length,
    selected:chosen?{lambda_opportunity:chosen.lo,lambda_monetization:chosen.lm,mix:chosen.mix,keep:chosen.keep,aggregate:chosen.aggregate,folds:chosen.folds}:null,
    top_candidates:keys.sort((a,b)=>b.aggregate.objective-a.aggregate.objective).slice(0,10).map(x=>({lambda_opportunity:x.lo,lambda_monetization:x.lm,mix:x.mix,keep:x.keep,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
    confirmation,confirmation_pass:confirmationPass,attribution,
    decision:!chosen?{label:'MONETIZATION_EDGE_NOT_FOUND_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'MONETIZATION_EDGE_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'MONETIZATION_EDGE_FAILED_FRESH_HOLDOUT',ready:false}
  };
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,candidate_count:report.candidate_count,viable_count:report.viable_count,
    selected:report.selected?{lambda_opportunity:report.selected.lambda_opportunity,lambda_monetization:report.selected.lambda_monetization,mix:report.selected.mix,keep:report.selected.keep,aggregate:report.selected.aggregate}:null,
    confirmation:report.confirmation?{selected:report.confirmation.selected,delta:report.confirmation.delta,metrics:report.confirmation.metrics}:null,
    confirmation_pass:report.confirmation_pass,
    top_opportunity:report.attribution?.opportunity.slice(0,6)||null,
    top_monetization:report.attribution?.monetization.slice(0,6)||null,
    decision:report.decision
  },null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
