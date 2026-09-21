'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const SOURCE = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-phase-transition-edge.json');
const KEEP_GRID = [0.15,0.20,0.25,0.30,0.40,0.50,0.60];

function loadBase() {
  let src = fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__pt={loadR7,buildRaw,selectSignals};';
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename:SOURCE
  });
  vm.runInContext(src,c,{filename:SOURCE});
  return c.__pt;
}

function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0;}
function sd(xs){const m=avg(xs);return Math.sqrt(avg(xs.map(x=>(x-m)**2)))||1;}
function ret(a,b){return a>0&&b>0?b/a-1:0;}
function logSafe(x){return Math.log(Math.max(.05,Number(x)||.05));}
function quantile(xs,q){
  if(!xs.length)return 0;
  const a=[...xs].sort((x,y)=>x-y),p=(a.length-1)*q,i=Math.floor(p),f=p-i;
  return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f;
}
function sum(rows,key){return rows.reduce((s,r)=>s+Number(r?.[key]||0),0);}

const FEATURE_NAMES = [
  'price_accel_15m',
  'trade_accel_jump',
  'volume_accel_jump',
  'breakout_delta_60m',
  'breakout_level_60m',
  'compression_30m',
  'release_ratio',
  'current_r15',
  'current_r60'
];

function transitionVector(s){
  const rows=s.series||[],i=Number(s.index||0);
  if(i<20)return Array(FEATURE_NAMES.length).fill(0);

  const c=(k)=>Number(rows[k]?.c||0);
  const h=(k)=>Number(rows[k]?.h||0);
  const l=(k)=>Number(rows[k]?.l||0);

  const curR15=ret(c(i-3),c(i));
  const prevR15=ret(c(i-6),c(i-3));
  const priceAccel=curR15-prevR15;

  const tradeNow=sum(rows.slice(i-2,i+1),'n');
  const tradeBaseNow=sum(rows.slice(i-14,i-2),'n')/12*3;
  const tradePrev=sum(rows.slice(i-5,i-2),'n');
  const tradeBasePrev=sum(rows.slice(i-17,i-5),'n')/12*3;
  const tradeRatioNow=tradeBaseNow>0?tradeNow/tradeBaseNow:1;
  const tradeRatioPrev=tradeBasePrev>0?tradePrev/tradeBasePrev:1;
  const tradeJump=logSafe(tradeRatioNow)-logSafe(tradeRatioPrev);

  const volNow=sum(rows.slice(i-2,i+1),'q');
  const volBaseNow=sum(rows.slice(i-14,i-2),'q')/12*3;
  const volPrev=sum(rows.slice(i-5,i-2),'q');
  const volBasePrev=sum(rows.slice(i-17,i-5),'q')/12*3;
  const volRatioNow=volBaseNow>0?volNow/volBaseNow:1;
  const volRatioPrev=volBasePrev>0?volPrev/volBasePrev:1;
  const volJump=logSafe(volRatioNow)-logSafe(volRatioPrev);

  const highNow=Math.max(...rows.slice(i-12,i).map(r=>Number(r.h||0)));
  const highPrev=Math.max(...rows.slice(i-15,i-3).map(r=>Number(r.h||0)));
  const breakoutNow=highNow>0?c(i)/highNow-1:0;
  const breakoutPrev=highPrev>0?c(i-3)/highPrev-1:0;
  const breakoutDelta=breakoutNow-breakoutPrev;

  const calm=rows.slice(i-9,i-3);
  const calmHigh=Math.max(...calm.map(r=>Number(r.h||0)));
  const calmLow=Math.min(...calm.map(r=>Number(r.l||0)));
  const compression=c(i-3)>0?(calmHigh-calmLow)/c(i-3):0;

  const release=rows.slice(i-2,i+1);
  const releaseHigh=Math.max(...release.map(r=>Number(r.h||0)));
  const releaseLow=Math.min(...release.map(r=>Number(r.l||0)));
  const releaseRange=c(i)>0?(releaseHigh-releaseLow)/c(i):0;
  const releaseRatio=compression>0?releaseRange/compression:1;

  return [
    priceAccel,
    tradeJump,
    volJump,
    breakoutDelta,
    breakoutNow,
    compression,
    releaseRatio,
    curR15,
    Number(s.f?.r60||0)
  ];
}

function tradeNet(lib,s){
  const o=lib.r.simulateExit(s,lib.b.BASE_EXIT);
  return Number(o?.net||0);
}

function fit(rows){
  const pos=rows.filter(x=>x.net>0),neg=rows.filter(x=>x.net<=0);
  if(pos.length<12||neg.length<20)return null;
  const weights=[],center=[],scale=[],effects=[];
  for(let i=0;i<FEATURE_NAMES.length;i++){
    const p=pos.map(x=>transitionVector(x.s)[i]),n=neg.map(x=>transitionVector(x.s)[i]);
    const pooled=Math.sqrt((sd(p)**2+sd(n)**2)/2)||1;
    const effect=(avg(p)-avg(n))/pooled;
    effects.push(effect);
    weights.push(effect);
    const all=rows.map(x=>transitionVector(x.s)[i]);
    center.push(avg(all)); scale.push(sd(all));
  }
  const norm=Math.sqrt(weights.reduce((a,x)=>a+x*x,0))||1;
  return {weights:weights.map(x=>x/norm),center,scale,effects,pos:pos.length,neg:neg.length};
}

function score(model,s){
  const x=transitionVector(s); let z=0;
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

function allNonNegative(d){
  return d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0&&
    d.winner5_precision>=0&&d.winner10_precision>=0;
}

function objective(m,b){
  const d=delta(m,b);
  return d.net_growth*18+d.avg_net_ret*10+d.max_drawdown*3+
    d.winner5_precision*2+d.winner10_precision*3;
}

async function main(){
  const base=loadBase(),lib=base.loadR7();
  const {raw,poolSize,loaded}=await base.buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const devSignals=base.selectSignals(lib,dev,0,0);
  const confirmSignals=base.selectSignals(lib,confirm,0,0);

  if(devSignals.length<50||confirmSignals.length<12)throw new Error(`insufficient signals dev=${devSignals.length} confirm=${confirmSignals.length}`);

  const cut=Math.floor(devSignals.length*.58);
  const train=devSignals.slice(0,cut);
  const cal=devSignals.slice(cut);
  const model=fit(train.map(s=>({s,net:tradeNet(lib,s)})));
  if(!model)throw new Error('phase transition model unavailable');

  const calAll=dev.filter(s=>s.t>=cal[0].t);
  const baselineCal=metrics(lib,cal,calAll);
  const scoredCal=cal.map(s=>({...s,phaseScore:score(model,s)}));
  const trials=[];

  for(const keep of KEEP_GRID){
    const threshold=quantile(scoredCal.map(s=>s.phaseScore),1-keep);
    const selected=scoredCal.filter(s=>s.phaseScore>=threshold);
    const m=metrics(lib,selected,calAll),d=delta(m,baselineCal);
    const pass=
      selected.length>=6 &&
      m.economic.netGrowth>0 &&
      m.economic.avgNetRet>0 &&
      allNonNegative(d);
    trials.push({keep,threshold,selected_signals:selected.length,metrics:m,delta:d,objective:objective(m,baselineCal),pass});
  }

  const chosen=trials.filter(x=>x.pass).sort((a,b)=>b.objective-a.objective)[0]||null;
  const baselineConfirm=metrics(lib,confirmSignals,confirm);

  let confirmation=null,confirmationDelta=null,confirmationPass=false,selectedConfirm=[];
  if(chosen){
    selectedConfirm=confirmSignals
      .map(s=>({...s,phaseScore:score(model,s)}))
      .filter(s=>s.phaseScore>=chosen.threshold);
    confirmation=metrics(lib,selectedConfirm,confirm);
    confirmationDelta=delta(confirmation,baselineConfirm);
    confirmationPass=
      selectedConfirm.length>=6 &&
      confirmation.economic.netGrowth>0 &&
      confirmation.economic.avgNetRet>0 &&
      allNonNegative(confirmationDelta);
  }

  const attribution=FEATURE_NAMES.map((name,i)=>({
    feature:name,
    weight:model.weights[i],
    train_effect_size:model.effects[i]
  })).sort((a,b)=>Math.abs(b.weight)-Math.abs(a.weight));

  const report={
    version:'PHASE_TRANSITION_EDGE_V1',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    hypothesis:'The edge is a transition from calm to expansion: accelerating trades/volume, breakout crossing and range release before momentum becomes extended.',
    universe:{pool:poolSize,loaded,candidate_rows:raw.length,dev_signals:devSignals.length,confirm_signals:confirmSignals.length},
    split:{train:train.length,calibration:cal.length,confirmation:confirmSignals.length},
    model:{features:FEATURE_NAMES,attribution,train_positive:model.pos,train_negative:model.neg},
    calibration:{baseline:baselineCal,trials,selected:chosen},
    confirmation:{baseline:baselineConfirm,selected:confirmation,selected_signals:selectedConfirm.length,delta:confirmationDelta},
    confirmation_pass:confirmationPass,
    decision:!chosen
      ? {label:'PHASE_TRANSITION_NOT_CALIBRATED',ready:false}
      : confirmationPass
        ? {label:'PHASE_TRANSITION_CONFIRMED_RESEARCH_ONLY',ready:false}
        : {label:'PHASE_TRANSITION_FAILED_CONFIRMATION',ready:false}
  };

  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({
    version:report.version,
    attribution:attribution.slice(0,8),
    selected:chosen?{keep:chosen.keep,threshold:chosen.threshold}:null,
    confirmation_selected_signals:selectedConfirm.length,
    confirmation_pass:confirmationPass,
    confirmation_delta:confirmationDelta,
    decision:report.decision
  },null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
