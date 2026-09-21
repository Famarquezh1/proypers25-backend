'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-holy-grail-evolution.json');
const KEEP_GRID = [0.30,0.40,0.50,0.60,0.70,0.80,0.90];
const LAMBDAS = [0.1,0.3,1,3,10];
const MAX_ACTIVE_INTERACTIONS = 4;

function loadBase() {
  let src = fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__hg={loadR7,buildRaw,selectSignals};';
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename:SOURCE
  });
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__hg;
}

function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function sd(xs){const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)))||1;}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2));}
function quantile(xs,q){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),f=p-i;
  return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f;
}
function corr(a,b){
  if(a.length<3||b.length!==a.length)return 0;
  const am=avg(a),bm=avg(b),as=sd(a),bs=sd(b);
  return avg(a.map((x,i)=>((x-am)/as)*((b[i]-bm)/bs)));
}

const BASE_NAMES = [
  'log_trade_accel','breakout60','breakout240','breakout_x_volume',
  'r15','r60','r240','rs60','extension','vol_slope','continuation','confirm'
];

const INTERACTION_SEEDS = [
  'log_trade_accel','vol_slope','breakout60','breakout240','r15','r60','r240',
  'extension','continuation','confirm','ignition','rs60'
];

function baseMap(s){
  const f=s.f||{},bd=s.breadth||{},q=s.productionV42||{},d=q.detail||{};
  const accel=Number(f.r15||0)-.25*Number(f.r60||0);
  const volSlope=logSafe(f.vol15)-logSafe(f.vol30);
  const chase=Math.max(0,Number(f.r24||0)-.08)+Math.max(0,Number(f.r60||0)-.045)+Math.max(0,Number(f.r15||0)-.025);
  return {
    r15:Number(f.r15||0), r30:Number(f.r30||0), r60:Number(f.r60||0), r240:Number(f.r240||0), r24:Number(f.r24||0),
    log_vol15:logSafe(f.vol15), log_vol30:logSafe(f.vol30), log_trade_accel:logSafe(f.tradeAccel),
    breakout60:Number(f.breakout60||0), breakout240:Number(f.breakout240||0),
    rs60:Number(f.rs60||0), rs240:Number(f.rs240||0),
    breadth_up15:Number(bd.up15||0)-.5, breadth_up60:Number(bd.up60||0)-.5,
    breadth_breakout:Number(bd.breakout||0)-.5, breadth_ignite:Number(bd.ignite||0)-.5,
    breadth_mean60:Number(bd.mean60||0),
    v42_norm:Number(q.norm||0), ignition:Number(d.ignition||0), confirm:Number(d.confirm||0),
    extension:Number(d.extension||0), continuation:Number(s.continuationScore||0),
    accel, vol_slope:volSlope, chase,
    breakout_x_volume:Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),
    rs_x_breadth:Math.max(0,Number(f.rs60||0))*(Number(bd.up60||0)-.5),
    continuation_x_confirm:Number(s.continuationScore||0)*Number(d.confirm||0)
  };
}

function interactionValue(spec,m){
  const a=Number(m[spec.a]||0),b=Number(m[spec.b]||0);
  if(spec.kind==='product')return a*b;
  if(spec.kind==='contrast')return a-b;
  if(spec.kind==='gate')return a*Math.max(0,b);
  return 0;
}

function vector(s, interactions=[]){
  const m=baseMap(s);
  const out=BASE_NAMES.map(n=>m[n]);
  for(const spec of interactions) out.push(interactionValue(spec,m));
  return out.map(x=>Number.isFinite(Number(x))?Number(x):0);
}
function names(interactions=[]){
  return [...BASE_NAMES,...interactions.map(x=>x.name)];
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

function fitRidge(rows,lambda,interactions=[]){
  if(rows.length<24)return null;
  const X=rows.map(x=>vector(x.s,interactions)),p=X[0].length;
  const mean=Array(p).fill(0),stdev=Array(p).fill(1);
  for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);stdev[j]=sd(col);}
  const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
  rows.forEach((row,k)=>{
    const x=[1,...X[k].map((v,j)=>(v-mean[j])/stdev[j])],y=row.net;
    for(let i=0;i<d;i++){Y[i]+=x[i]*y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j];}
  });
  for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
  const beta=solveLinear(A,Y);
  return beta?{lambda,beta,mean,stdev,interactions:[...interactions]}:null;
}

function predict(model,s){
  const x=vector(s,model.interactions);let z=model.beta[0];
  for(let j=0;j<x.length;j++)z+=model.beta[j+1]*((x[j]-model.mean[j])/model.stdev[j]);
  return z;
}

function tradeNet(lib,s){
  const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);
  return Number(o?.net||0);
}
function learningTarget(lib,s){
  const o=s.outcome||{};
  const net=tradeNet(lib,s);
  const opportunity=
    .10*Number(o.mfe12||0) +
    .004*(o.winner5?1:0) +
    .008*(o.winner10?1:0) -
    .04*Math.max(0,-Number(o.maeToPeak||0));
  return net+opportunity;
}
function metrics(lib,signals,all){
  return {prediction:lib.predictionMetrics(signals),economic:lib.economicMetrics(signals,all)};
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
  return d.net_growth*14+d.avg_net_ret*8+d.max_drawdown*3+
    d.winner5_precision*2+d.winner10_precision*3;
}

function fitPolicy(lib,trainSignals,all,interactions=[]){
  if(trainSignals.length<30)return null;
  const cut=Math.max(20,Math.floor(trainSignals.length*.72));
  const fitS=trainSignals.slice(0,cut),calS=trainSignals.slice(cut);
  if(calS.length<8)return null;
  const fitRows=fitS.map(s=>({s,net:learningTarget(lib,s)}));
  const calStart=calS[0].t;
  const calAll=all.filter(s=>s.t>=calStart&&s.t<=calS[calS.length-1].t);
  const base=metrics(lib,calS,calAll);
  const trials=[];
  for(const lambda of LAMBDAS){
    const model=fitRidge(fitRows,lambda,interactions); if(!model)continue;
    const scored=calS.map(s=>({s,score:predict(model,s)}));
    for(const keep of KEEP_GRID){
      const threshold=quantile(scored.map(x=>x.score),1-keep);
      const selected=scored.filter(x=>x.score>=threshold).map(x=>x.s);
      if(selected.length<5)continue;
      const m=metrics(lib,selected,calAll),d=delta(m,base);
      trials.push({lambda,keep,threshold,metrics:m,delta:d,objective:objective(m,base),strict:nonNegative(d)&&m.economic.avgNetRet>0});
    }
  }
  if(!trials.length)return null;
  const chosen=(trials.filter(x=>x.strict).sort((a,b)=>b.objective-a.objective)[0]||
    trials.sort((a,b)=>b.objective-a.objective)[0]);
  const finalModel=fitRidge(trainSignals.map(s=>({s,net:learningTarget(lib,s)})),chosen.lambda,interactions);
  const trainScores=trainSignals.map(s=>predict(finalModel,s));
  return {...chosen,model:finalModel,threshold:quantile(trainScores,1-chosen.keep)};
}

function evaluatePolicy(lib,policy,signals,all){
  const selected=signals.filter(s=>predict(policy.model,s)>=policy.threshold);
  const base=metrics(lib,signals,all),m=metrics(lib,selected,all),d=delta(m,base);
  return {selected,metrics:m,baseline:base,delta:d,objective:objective(m,base)};
}

function mineCorrection(rows,model,active){
  const used=new Set(active.map(x=>x.name));
  const residual=rows.map(x=>x.net-predict(model,x.s));
  const candidates=[];
  for(let i=0;i<INTERACTION_SEEDS.length;i++){
    for(let j=i+1;j<INTERACTION_SEEDS.length;j++){
      for(const kind of ['product','contrast','gate']){
        const a=INTERACTION_SEEDS[i],b=INTERACTION_SEEDS[j];
        const name=`${kind}(${a},${b})`;
        if(used.has(name))continue;
        const vals=rows.map(x=>interactionValue({a,b,kind},baseMap(x.s)));
        const c=corr(vals,residual);
        if(Number.isFinite(c))candidates.push({name,a,b,kind,residual_corr:c,abs_corr:Math.abs(c)});
      }
    }
  }
  return candidates.sort((a,b)=>b.abs_corr-a.abs_corr)[0]||null;
}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';
  process.env.DEV_END='2026-06-01T00:00:00Z';
  process.env.CONFIRM_START='2026-06-01T00:00:00Z';
  process.env.CONFIRM_END='2026-07-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const devSignals=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t);
  const confirmSignals=base.selectSignals(lib,confirm,0,0).sort((a,b)=>a.t-b.t);
  if(devSignals.length<50||confirmSignals.length<10)throw new Error(`insufficient signals dev=${devSignals.length} confirm=${confirmSignals.length}`);

  const initial=Math.max(30,Math.floor(devSignals.length*.40));
  const remaining=devSignals.length-initial;
  const foldSize=Math.max(8,Math.floor(remaining/4));
  let trainEnd=initial,active=[],pending=null;
  const rounds=[];

  for(let round=1;round<=4 && trainEnd<devSignals.length;round++){
    const valEnd=round===4?devSignals.length:Math.min(devSignals.length,trainEnd+foldSize);
    const trainS=devSignals.slice(0,trainEnd),valS=devSignals.slice(trainEnd,valEnd);
    const valAll=dev.filter(s=>s.t>=valS[0].t&&s.t<=valS[valS.length-1].t);

    let basePolicy=fitPolicy(lib,trainS,dev,active);
    if(!basePolicy)throw new Error(`policy unavailable round=${round}`);
    let baseEval=evaluatePolicy(lib,basePolicy,valS,valAll);
    let accepted=false,trialEval=null,trialPolicy=null;

    if(pending && active.length<MAX_ACTIVE_INTERACTIONS){
      trialPolicy=fitPolicy(lib,trainS,dev,[...active,pending]);
      if(trialPolicy){
        trialEval=evaluatePolicy(lib,trialPolicy,valS,valAll);
        const versus=delta(trialEval.metrics,baseEval.metrics);
        accepted=
          trialEval.selected.length>=Math.max(4,Math.floor(valS.length*.20)) &&
          nonNegative(trialEval.delta) &&
          nonNegative(versus) &&
          trialEval.metrics.economic.netGrowth>0 &&
          trialEval.metrics.economic.avgNetRet>0 &&
          trialEval.objective>=baseEval.objective;
        if(accepted){
          active=[...active,pending];
          basePolicy=trialPolicy;
          baseEval=trialEval;
        }
      }
    }

    const rows=valS.map(s=>({s,net:learningTarget(lib,s)}));
    const next=mineCorrection(rows,basePolicy.model,active);
    rounds.push({
      round,train_signals:trainS.length,validation_signals:valS.length,
      tested_interaction:pending,interaction_accepted:accepted,
      active_interactions:[...active],
      validation_selected:baseEval.selected.length,
      validation_delta:baseEval.delta,
      validation_objective:baseEval.objective,
      next_candidate:next
    });
    pending=next;
    trainEnd=valEnd;
  }

  const finalPolicy=fitPolicy(lib,devSignals,dev,active);
  if(!finalPolicy)throw new Error('final policy unavailable');
  const finalDev=evaluatePolicy(lib,finalPolicy,devSignals,dev);
  const confirmation=evaluatePolicy(lib,finalPolicy,confirmSignals,confirm);
  const confirmationPass=
    finalPolicy.strict &&
    confirmation.selected.length>=8 &&
    nonNegative(confirmation.delta) &&
    confirmation.metrics.economic.netGrowth>0 &&
    confirmation.metrics.economic.avgNetRet>0;

  const featureNames=names(active);
  const attribution=featureNames.map((name,i)=>({
    feature:name,
    coefficient:finalPolicy.model.beta[i+1],
    abs:Math.abs(finalPolicy.model.beta[i+1])
  })).sort((a,b)=>b.abs-a.abs).slice(0,15);

  const winners=devSignals.filter(s=>tradeNet(lib,s)>0),losers=devSignals.filter(s=>tradeNet(lib,s)<=0);
  const separation=featureNames.map((name,i)=>{
    const w=winners.map(s=>vector(s,active)[i]),l=losers.map(s=>vector(s,active)[i]);
    const pooled=Math.sqrt((sd(w)**2+sd(l)**2)/2)||1;
    return {feature:name,winner_mean:avg(w),loser_mean:avg(l),effect_size:(avg(w)-avg(l))/pooled};
  }).sort((a,b)=>Math.abs(b.effect_size)-Math.abs(a.effect_size)).slice(0,15);

  const report={
    version:'HOLY_GRAIL_EVOLUTION_V4_FRESH_HOLDOUT',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    objective:'Iterative dual-target discovery using all previously inspected history through 2026-06-01 as development, with a newly reserved untouched 2026-06-01..2026-07-01 holdout.',
    mechanism:{
      initial_training_fraction:.40,
      walk_forward_rounds:rounds.length,
      error_feedback:'Each validation fold mines residual interactions against a dual learning target (realized net plus future opportunity labels); retention still requires the next unseen fold to improve without worsening the five required CORE-relative metrics.',
      untouched_confirmation:true
    },
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:devSignals.length,confirm_signals:confirmSignals.length},
    rounds,
    active_interactions:active,
    final_policy:{lambda:finalPolicy.lambda,keep:finalPolicy.keep,threshold:finalPolicy.threshold,strict_calibration:finalPolicy.strict},
    development:{selected:finalDev.selected.length,baseline:finalDev.baseline,metrics:finalDev.metrics,delta:finalDev.delta},
    confirmation:{selected:confirmation.selected.length,baseline:confirmation.baseline,metrics:confirmation.metrics,delta:confirmation.delta},
    top_separation:separation,
    top_model_attribution:attribution,
    confirmation_pass:confirmationPass,
    decision:confirmationPass
      ? {label:'HOLY_GRAIL_EVOLUTION_CONFIRMED_RESEARCH_ONLY',ready:false}
      : {label:'HOLY_GRAIL_EVOLUTION_NOT_CONFIRMED',ready:false}
  };
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,
    rounds:rounds.map(r=>({round:r.round,tested:r.tested_interaction?.name||null,accepted:r.interaction_accepted,next:r.next_candidate?.name||null,delta:r.validation_delta})),
    active_interactions:active.map(x=>x.name),
    final_policy:report.final_policy,
    confirmation_selected:confirmation.selected.length,
    confirmation_delta:confirmation.delta,
    top_separation:separation.slice(0,8),
    top_model_attribution:attribution.slice(0,8),
    confirmation_pass:confirmationPass,
    decision:report.decision
  },null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
