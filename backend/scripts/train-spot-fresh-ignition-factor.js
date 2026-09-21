'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-fresh-ignition-factor.json');
const KEEP_GRID = [0.35,0.45,0.55,0.65,0.75,0.85];

function loadBase() {
  let src = fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__fi={loadR7,buildRaw,selectSignals};';
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename:SOURCE
  });
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__fi;
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
  'log_trade_accel',
  'vol_slope',
  'breakout60',
  'breakout240',
  'r15',
  'r60',
  'r240',
  'extension'
];

function featureVector(s){
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

function tradeNet(lib,s){
  const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);
  return Number(o?.net||0);
}

function fitEffectDiscriminant(rows){
  const winners=rows.filter(x=>x.net>0),losers=rows.filter(x=>x.net<=0);
  if(winners.length<12||losers.length<20)return null;
  const weights=[],center=[],scale=[];
  for(let i=0;i<FEATURE_NAMES.length;i++){
    const w=winners.map(x=>featureVector(x.s)[i]),l=losers.map(x=>featureVector(x.s)[i]);
    const wm=avg(w),lm=avg(l),pooled=Math.sqrt((sd(w)**2+sd(l)**2)/2)||1;
    weights.push((wm-lm)/pooled);
    center.push(avg(rows.map(x=>featureVector(x.s)[i])));
    scale.push(sd(rows.map(x=>featureVector(x.s)[i])));
  }
  const norm=Math.sqrt(weights.reduce((a,x)=>a+x*x,0))||1;
  return {
    weights:weights.map(x=>x/norm),
    center,
    scale,
    winners:winners.length,
    losers:losers.length
  };
}

function score(model,s){
  const x=featureVector(s);
  let z=0;
  for(let i=0;i<x.length;i++)z+=model.weights[i]*((x[i]-model.center[i])/model.scale[i]);
  return z;
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
  return d.net_growth>=0 &&
    d.avg_net_ret>=0 &&
    d.max_drawdown>=0 &&
    d.winner5_precision>=0 &&
    d.winner10_precision>=0;
}

function objective(m,b){
  const d=delta(m,b);
  return d.net_growth*14 +
    d.avg_net_ret*8 +
    d.max_drawdown*3 +
    d.winner5_precision*2 +
    d.winner10_precision*2.5;
}

async function main(){
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);

  const devSignals=base.selectSignals(lib,dev,0,0);
  const confirmSignals=base.selectSignals(lib,confirm,0,0);
  if(devSignals.length<40||confirmSignals.length<12)throw new Error(`insufficient signals dev=${devSignals.length} confirm=${confirmSignals.length}`);

  const cut=Math.floor(devSignals.length*.60);
  const trainSignals=devSignals.slice(0,cut);
  const calSignals=devSignals.slice(cut);
  const model=fitEffectDiscriminant(trainSignals.map(s=>({s,net:tradeNet(lib,s)})));
  if(!model)throw new Error('fresh ignition model unavailable');

  const calStart=calSignals[0].t;
  const calAll=dev.filter(s=>s.t>=calStart);
  const calBaseline=metrics(lib,calSignals,calAll);
  const scoredCal=calSignals.map(s=>({...s,freshIgnitionScore:score(model,s)}));

  const trials=[];
  for(const keep of KEEP_GRID){
    const threshold=quantile(scoredCal.map(s=>s.freshIgnitionScore),1-keep);
    const selected=scoredCal.filter(s=>s.freshIgnitionScore>=threshold);
    const m=metrics(lib,selected,calAll),d=delta(m,calBaseline);
    const pass=
      selected.length>=10 &&
      nonNegative(d) &&
      m.economic.netGrowth>0 &&
      m.economic.avgNetRet>0;
    trials.push({keep,threshold,metrics:m,delta:d,objective:objective(m,calBaseline),pass});
  }

  const chosen=trials.filter(x=>x.pass).sort((a,b)=>b.objective-a.objective)[0]||null;

  const baselineConfirm=metrics(lib,confirmSignals,confirm);
  let confirmation=null,confirmationDelta=null,confirmationPass=false,selectedCount=0;
  if(chosen){
    const selected=confirmSignals
      .map(s=>({...s,freshIgnitionScore:score(model,s)}))
      .filter(s=>s.freshIgnitionScore>=chosen.threshold);
    selectedCount=selected.length;
    confirmation=metrics(lib,selected,confirm);
    confirmationDelta=delta(confirmation,baselineConfirm);
    confirmationPass=
      selected.length>=8 &&
      nonNegative(confirmationDelta) &&
      confirmation.economic.netGrowth>0 &&
      confirmation.economic.avgNetRet>0;
  }

  const attribution=FEATURE_NAMES.map((name,i)=>({
    feature:name,
    weight:model.weights[i]
  })).sort((a,b)=>Math.abs(b.weight)-Math.abs(a.weight));

  const trainRows=trainSignals.map(s=>({s,net:tradeNet(lib,s)}));
  const winners=trainRows.filter(x=>x.net>0),losers=trainRows.filter(x=>x.net<=0);
  const separation=FEATURE_NAMES.map((name,i)=>{
    const w=winners.map(x=>featureVector(x.s)[i]),l=losers.map(x=>featureVector(x.s)[i]);
    const pooled=Math.sqrt((sd(w)**2+sd(l)**2)/2)||1;
    return {
      feature:name,
      winner_mean:avg(w),
      loser_mean:avg(l),
      effect_size:(avg(w)-avg(l))/pooled
    };
  }).sort((a,b)=>Math.abs(b.effect_size)-Math.abs(a.effect_size));

  const report={
    version:'FRESH_IGNITION_FACTOR_V1',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    hypothesis:'Winners are more likely when trade/volume ignition appears while price momentum is still relatively unextended.',
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:devSignals.length,confirm_signals:confirmSignals.length},
    split:{train:trainSignals.length,calibration:calSignals.length,confirmation:confirmSignals.length},
    model:{features:FEATURE_NAMES,weights:model.weights,center:model.center,scale:model.scale,train_winners:model.winners,train_losers:model.losers},
    top_separation:separation,
    attribution,
    calibration_baseline:calBaseline,
    calibration_trials:trials,
    selected_calibration:chosen,
    confirmation_baseline:baselineConfirm,
    confirmation,
    confirmation_selected_signals:selectedCount,
    confirmation_delta:confirmationDelta,
    confirmation_pass:confirmationPass,
    decision:!chosen
      ? {label:'FRESH_IGNITION_NOT_CALIBRATED',ready:false}
      : confirmationPass
        ? {label:'FRESH_IGNITION_CONFIRMED_RESEARCH_ONLY',ready:false}
        : {label:'FRESH_IGNITION_FAILED_CHRONOLOGICAL_CONFIRMATION',ready:false}
  };

  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,
    model_weights:attribution,
    selected:chosen?{keep:chosen.keep,threshold:chosen.threshold}:null,
    confirmation_selected_signals:selectedCount,
    confirmation_pass:confirmationPass,
    confirmation_delta:confirmationDelta,
    decision:report.decision
  },null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
