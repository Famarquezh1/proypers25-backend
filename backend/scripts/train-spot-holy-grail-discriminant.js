'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-holy-grail-discriminant.json');
const LAMBDAS = [0.1,0.3,1,3];
const KEEP_QUANTILES = [0.30,0.40,0.50,0.60,0.70,0.80];

function loadBase() {
  let src = fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__hg={loadR7,buildRaw,productionEligible,selectSignals};';
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename:SOURCE
  });
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__hg;
}

function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function sd(xs){const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)))||1;}
function clamp(x,a=-4,b=4){return Math.max(a,Math.min(b,Number(x)||0));}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2));}
function quantile(xs,q){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),f=p-i;
  return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f;
}

const FEATURE_NAMES = [
  'r15','r30','r60','r240','r24','log_vol15','log_vol30','log_trade_accel',
  'breakout60','breakout240','rs60','rs240',
  'breadth_up15','breadth_up60','breadth_breakout','breadth_ignite','breadth_mean60',
  'v42_norm','ignition','confirm','extension','continuation',
  'accel','vol_slope','chase',
  'breakout_x_volume','rs_x_breadth','continuation_x_confirm'
];

function features(s){
  const f=s.f||{},bd=s.breadth||{},q=s.productionV42||{},d=q.detail||{};
  const accel=Number(f.r15||0)-.25*Number(f.r60||0);
  const volSlope=logSafe(f.vol15)-logSafe(f.vol30);
  const chase=Math.max(0,Number(f.r24||0)-.08)+Math.max(0,Number(f.r60||0)-.045)+Math.max(0,Number(f.r15||0)-.025);
  return [
    f.r15,f.r30,f.r60,f.r240,f.r24,logSafe(f.vol15),logSafe(f.vol30),logSafe(f.tradeAccel),
    f.breakout60,f.breakout240,f.rs60,f.rs240,
    Number(bd.up15||0)-.5,Number(bd.up60||0)-.5,Number(bd.breakout||0)-.5,Number(bd.ignite||0)-.5,Number(bd.mean60||0),
    q.norm,d.ignition,d.confirm,d.extension,s.continuationScore,
    accel,volSlope,chase,
    Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),
    Math.max(0,Number(f.rs60||0))*(Number(bd.up60||0)-.5),
    Number(s.continuationScore||0)*Number(d.confirm||0)
  ].map(x=>Number.isFinite(Number(x))?Number(x):0);
}

function solveLinear(A,y){
  const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
  for(let col=0;col<n;col++){
    let p=col;
    for(let i=col+1;i<n;i++)if(Math.abs(M[i][col])>Math.abs(M[p][col]))p=i;
    if(Math.abs(M[p][col])<1e-12)return null;
    [M[col],M[p]]=[M[p],M[col]];
    const d=M[col][col];
    for(let j=col;j<=n;j++)M[col][j]/=d;
    for(let i=0;i<n;i++){
      if(i===col)continue;
      const f=M[i][col];
      for(let j=col;j<=n;j++)M[i][j]-=f*M[col][j];
    }
  }
  return M.map(r=>r[n]);
}

function fitRidge(rows,lambda){
  if(rows.length<30)return null;
  const X=rows.map(x=>features(x.s)),p=X[0].length,mean=Array(p).fill(0),stdev=Array(p).fill(1);
  for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);stdev[j]=sd(col);}
  const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
  rows.forEach((row,k)=>{
    const x=[1,...X[k].map((v,j)=>(v-mean[j])/stdev[j])];
    const y=row.net;
    for(let i=0;i<d;i++){Y[i]+=x[i]*y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j];}
  });
  for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
  const beta=solveLinear(A,Y);
  return beta?{lambda,beta,mean,stdev,n:rows.length}:null;
}

function score(model,s){
  const x=features(s);let z=model.beta[0];
  for(let j=0;j<x.length;j++)z+=model.beta[j+1]*((x[j]-model.mean[j])/model.stdev[j]);
  return z;
}

function tradeNet(lib,s){
  const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);
  return Number(o?.net||0);
}

function metrics(lib,signals,all){
  return {
    prediction:lib.predictionMetrics(signals),
    economic:lib.economicMetrics(signals,all)
  };
}

function delta(a,b){
  return {
    signals:a.prediction.signals-b.prediction.signals,
    winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
    winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
    avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
    net_growth:a.economic.netGrowth-b.economic.netGrowth,
    avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
    max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
  };
}

function nonNegative(d){
  return d.net_growth>=0 && d.avg_net_ret>=0 && d.max_drawdown>=0 &&
    d.winner5_precision>=0 && d.winner10_precision>=0;
}

function objective(m,b){
  const d=delta(m,b);
  return d.net_growth*12+d.avg_net_ret*8+d.max_drawdown*2+
    d.winner5_precision*1.5+d.winner10_precision*2;
}

async function main(){
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);

  const devSignals=base.selectSignals(lib,dev,0,0);
  const confirmSignals=base.selectSignals(lib,confirm,0,0);
  if(devSignals.length<30||confirmSignals.length<8)throw new Error(`insufficient baseline signals dev=${devSignals.length} confirm=${confirmSignals.length}`);

  const cut=Math.floor(devSignals.length*.65);
  const trainSignals=devSignals.slice(0,cut),calSignals=devSignals.slice(cut);
  const train=trainSignals.map(s=>({s,net:tradeNet(lib,s)}));
  const calAll=dev.filter(s=>s.t>=calSignals[0].t);
  const calBase=metrics(lib,calSignals,calAll);

  const trials=[];
  for(const lambda of LAMBDAS){
    const model=fitRidge(train,lambda); if(!model)continue;
    const scored=calSignals.map(s=>({...s,hgScore:score(model,s)}));
    for(const keep of KEEP_QUANTILES){
      const threshold=quantile(scored.map(s=>s.hgScore),1-keep);
      const selected=scored.filter(s=>s.hgScore>=threshold);
      const m=metrics(lib,selected,calAll),d=delta(m,calBase);
      trials.push({lambda,keep,threshold,metrics:m,delta:d,objective:objective(m,calBase),pass:nonNegative(d)&&selected.length>=8});
    }
  }
  const viable=trials.filter(x=>x.pass).sort((a,b)=>b.objective-a.objective);
  const chosen=viable[0]||null;

  let confirmation=null,confirmationDelta=null,confirmationPass=false,model=null,attribution=[];
  if(chosen){
    model=fitRidge(devSignals.map(s=>({s,net:tradeNet(lib,s)})),chosen.lambda);
    const scored=confirmSignals.map(s=>({...s,hgScore:score(model,s)}));
    const threshold=quantile(devSignals.map(s=>score(model,s)),1-chosen.keep);
    const selected=scored.filter(s=>s.hgScore>=threshold);
    const baseline=metrics(lib,confirmSignals,confirm);
    confirmation=metrics(lib,selected,confirm);
    confirmationDelta=delta(confirmation,baseline);
    confirmationPass=selected.length>=8&&nonNegative(confirmationDelta)&&confirmation.economic.netGrowth>0&&confirmation.economic.avgNetRet>0;
    attribution=FEATURE_NAMES.map((name,i)=>({
      feature:name,
      coefficient:model.beta[i+1],
      standardized_abs:Math.abs(model.beta[i+1])
    })).sort((a,b)=>b.standardized_abs-a.standardized_abs).slice(0,12);
  }

  const winners=devSignals.filter(s=>tradeNet(lib,s)>0);
  const losers=devSignals.filter(s=>tradeNet(lib,s)<=0);
  const separation=FEATURE_NAMES.map((name,i)=>{
    const w=winners.map(s=>features(s)[i]),l=losers.map(s=>features(s)[i]);
    const pooled=Math.sqrt((sd(w)**2+sd(l)**2)/2)||1;
    return {feature:name,winner_mean:avg(w),loser_mean:avg(l),effect_size:(avg(w)-avg(l))/pooled};
  }).sort((a,b)=>Math.abs(b.effect_size)-Math.abs(a.effect_size)).slice(0,12);

  const report={
    version:'HOLY_GRAIL_DISCRIMINANT_V1',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    objective:'Find a causal pre-entry discriminator between economically positive and negative CORE entries, then require untouched chronological confirmation.',
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:devSignals.length,confirm_signals:confirmSignals.length},
    labels:{development_positive:winners.length,development_negative:losers.length,target:'simulated CORE net return > 0 under existing historical exit policy'},
    split:{train_signals:trainSignals.length,calibration_signals:calSignals.length,confirmation_signals:confirmSignals.length},
    top_univariate_separation:separation,
    calibration_trials:trials,
    selected_calibration:chosen,
    top_model_attribution:attribution,
    confirmation,
    confirmation_delta:confirmationDelta,
    confirmation_pass:confirmationPass,
    decision:!chosen
      ? {label:'NO_DISCRIMINANT_CLEARED_CALIBRATION',ready:false}
      : confirmationPass
        ? {label:'CAUSAL_DISCRIMINANT_CONFIRMED_RESEARCH_ONLY',ready:false}
        : {label:'DISCRIMINANT_FAILED_CHRONOLOGICAL_CONFIRMATION',ready:false}
  };
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,
    labels:report.labels,
    selected:chosen?{lambda:chosen.lambda,keep:chosen.keep,threshold:chosen.threshold}:null,
    top_separation:separation.slice(0,6),
    top_model_attribution:attribution.slice(0,6),
    confirmation_pass:confirmationPass,
    confirmation_delta:confirmationDelta,
    decision:report.decision
  },null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
