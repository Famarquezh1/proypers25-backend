'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-regime-conditioned-edge.json');
const KEEP_GRID = [0.35,0.50,0.65,0.80,1.00];
const REGIMES = ['TREND_UP','RANGE','VOLATILE','RISK_OFF'];

function loadBase() {
  let src = fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__rc={loadR7,buildRaw,selectSignals};';
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename:SOURCE
  });
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__rc;
}

function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function sd(xs){const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)))||1;}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2));}
function quantile(xs,q){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),f=p-i;
  return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f;
}

const FEATURE_NAMES = [
  'log_trade_accel','vol_slope','breakout60','breakout240','r15','r60','r240','extension'
];

function vector(s){
  const f=s.f||{},d=s.productionV42?.detail||{};
  return [
    logSafe(f.tradeAccel),
    logSafe(f.vol15)-logSafe(f.vol30),
    Number(f.breakout60||0),
    Number(f.breakout240||0),
    Number(f.r15||0),
    Number(f.r60||0),
    Number(f.r240||0),
    Number(d.extension||0)
  ];
}

function primaryRegime(s){
  const rw=s.regimeWeights||{};
  const entries=Object.entries(rw);
  return entries.length ? entries.sort((a,b)=>Number(b[1]||0)-Number(a[1]||0))[0][0] : 'UNKNOWN';
}

function tradeNet(lib,s){
  const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);
  return Number(o?.net||0);
}

function fit(rows){
  const pos=rows.filter(x=>x.net>0),neg=rows.filter(x=>x.net<=0);
  if(pos.length<6||neg.length<10)return null;
  const weights=[],center=[],scale=[];
  for(let i=0;i<FEATURE_NAMES.length;i++){
    const p=pos.map(x=>vector(x.s)[i]),n=neg.map(x=>vector(x.s)[i]);
    const pooled=Math.sqrt((sd(p)**2+sd(n)**2)/2)||1;
    weights.push((avg(p)-avg(n))/pooled);
    const all=rows.map(x=>vector(x.s)[i]);
    center.push(avg(all));
    scale.push(sd(all));
  }
  const norm=Math.sqrt(weights.reduce((a,x)=>a+x*x,0))||1;
  return {weights:weights.map(x=>x/norm),center,scale,pos:pos.length,neg:neg.length};
}

function score(model,s){
  const x=vector(s);let z=0;
  for(let i=0;i<x.length;i++)z+=model.weights[i]*((x[i]-model.center[i])/model.scale[i]);
  return z;
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
  return d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0&&
    d.winner5_precision>=0&&d.winner10_precision>=0;
}

function objective(m,b){
  const d=delta(m,b);
  return d.net_growth*14+d.avg_net_ret*8+d.max_drawdown*3+
    d.winner5_precision*2+d.winner10_precision*2.5;
}

function chooseRegimePolicy(lib,signals,all){
  if(signals.length<14)return {action:'BASELINE',reason:'insufficient_samples',signals:signals.length};
  const cut=Math.floor(signals.length*.60);
  const train=signals.slice(0,cut),cal=signals.slice(cut);
  if(cal.length<6)return {action:'BASELINE',reason:'insufficient_calibration',signals:signals.length};

  const model=fit(train.map(s=>({s,net:tradeNet(lib,s)})));
  if(!model)return {action:'BASELINE',reason:'model_unavailable',signals:signals.length};

  const calAll=all.filter(s=>s.t>=cal[0].t);
  const baseline=metrics(lib,cal,calAll);
  const scored=cal.map(s=>({...s,regimeScore:score(model,s)}));
  const trials=[];

  for(const keep of KEEP_GRID){
    const threshold=keep===1 ? -Infinity : quantile(scored.map(s=>s.regimeScore),1-keep);
    const selected=scored.filter(s=>s.regimeScore>=threshold);
    const m=metrics(lib,selected,calAll),d=delta(m,baseline);
    trials.push({keep,threshold,metrics:m,delta:d,objective:objective(m,baseline)});
  }

  const positive=trials
    .filter(x=>x.metrics.economic.netGrowth>0&&x.metrics.economic.avgNetRet>0&&x.metrics.prediction.signals>=5)
    .sort((a,b)=>b.objective-a.objective);

  if(positive.length){
    const best=positive[0];
    if(best.keep===1)return {action:'BASELINE',model,selected:best,trials,baseline};
    return {action:'FILTER',model,selected:best,trials,baseline};
  }

  if(baseline.economic.netGrowth<=0||baseline.economic.avgNetRet<=0){
    return {action:'SKIP',model,trials,baseline,reason:'negative_calibration_economics'};
  }

  return {action:'BASELINE',model,trials,baseline,reason:'baseline_positive'};
}

function applyPolicies(lib,signals,policies){
  const out=[];
  for(const s of signals){
    const regime=primaryRegime(s);
    const p=policies[regime];
    if(!p||p.action==='BASELINE'){out.push(s);continue;}
    if(p.action==='SKIP')continue;
    const sc=score(p.model,s);
    if(sc>=p.selected.threshold)out.push({...s,regimeScore:sc});
  }
  return out;
}

async function main(){
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const devSignals=base.selectSignals(lib,dev,0,0);
  const confirmSignals=base.selectSignals(lib,confirm,0,0);

  const policies={};
  for(const regime of REGIMES){
    const sig=devSignals.filter(s=>primaryRegime(s)===regime);
    const all=dev.filter(s=>primaryRegime(s)===regime);
    policies[regime]=chooseRegimePolicy(lib,sig,all);
  }

  const baselineDev=metrics(lib,devSignals,dev);
  const selectedDev=applyPolicies(lib,devSignals,policies);
  const devMetrics=metrics(lib,selectedDev,dev);
  const devDelta=delta(devMetrics,baselineDev);

  const baselineConfirm=metrics(lib,confirmSignals,confirm);
  const selectedConfirm=applyPolicies(lib,confirmSignals,policies);
  const confirmation=metrics(lib,selectedConfirm,confirm);
  const confirmationDelta=delta(confirmation,baselineConfirm);

  const confirmationPass=
    selectedConfirm.length>=8&&
    confirmation.economic.netGrowth>0&&
    confirmation.economic.avgNetRet>0&&
    nonNegative(confirmationDelta);

  const compactPolicies=Object.fromEntries(Object.entries(policies).map(([k,p])=>[k,{
    action:p.action,
    reason:p.reason||null,
    signals:p.signals||null,
    selected:p.selected?{keep:p.selected.keep,threshold:p.selected.threshold}:null,
    train_pos:p.model?.pos||null,
    train_neg:p.model?.neg||null,
    weights:p.model?Object.fromEntries(FEATURE_NAMES.map((n,i)=>[n,p.model.weights[i]])):null
  }]));

  const report={
    version:'REGIME_CONDITIONED_EDGE_V1',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    hypothesis:'The missing edge is regime-dependent: some market regimes should use filtered fresh ignition, some baseline behavior, and some should be skipped.',
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:devSignals.length,confirm_signals:confirmSignals.length},
    policies:compactPolicies,
    development:{baseline:baselineDev,selected:devMetrics,delta:devDelta,selected_signals:selectedDev.length},
    confirmation:{baseline:baselineConfirm,selected:confirmation,delta:confirmationDelta,selected_signals:selectedConfirm.length},
    confirmation_pass:confirmationPass,
    decision:confirmationPass
      ? {label:'REGIME_EDGE_CONFIRMED_RESEARCH_ONLY',ready:false}
      : {label:'REGIME_EDGE_NOT_CONFIRMED',ready:false}
  };

  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,
    policies:compactPolicies,
    dev_delta:devDelta,
    confirmation_selected_signals:selectedConfirm.length,
    confirmation_pass:confirmationPass,
    confirmation_delta:confirmationDelta,
    decision:report.decision
  },null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
