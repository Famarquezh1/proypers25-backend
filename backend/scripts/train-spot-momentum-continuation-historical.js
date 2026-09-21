'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { momentumContinuationFactor } = require('../services/spotMomentumContinuation');

const R7_PATH = path.join(__dirname, 'github-spot-winner-precursor-trainer-r7.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-momentum-continuation-historical.json');
const THRESHOLDS = [-0.15,-0.10,-0.05,0,0.05,0.10,0.15,0.20,0.25];
const V42_THRESHOLDS = [
  { i: 0.904010256302157, c: 0.30262335308700017, e: 0.0333071863419859 },
  { i: 0.7912647052581232, c: 0.36672756172128707, e: 0.029510140018270917 },
  { i: 1.6626658194027173, c: 0.43305908219072103, e: 0.019614079751271593 }
];

function loadR7() {
  let src = fs.readFileSync(R7_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += ';globalThis.__mcf={r,b,breadthAt,futureOutcome,v42,predictionMetrics,economicMetrics,signalPolicy,iso,DEV_START,DEV_END,CONFIRM_START,CONFIRM_END,DAY,HOUR,STEP,WARM,MIN_QV,POOL_SIZE};';
  const c = vm.createContext({ require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout, __dirname, __filename:R7_PATH });
  vm.runInContext(src,c,{filename:R7_PATH});
  return c.__mcf;
}

function continuity(s) {
  return momentumContinuationFactor({
    r15:s.f.r15,
    r60:s.f.r60,
    r24:s.f.r24,
    vol15:s.f.vol15,
    vol30:s.f.vol30,
    breakout60:s.f.breakout60,
    rs60:s.f.rs60
  }).score;
}

function clamp01(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

function productionV42(f = {}) {
  const logSafe = (v) => Math.log(Math.max(0.2, Number(v) || 0.2));
  const ignition = 0.9 * logSafe(f.vol15) + 0.65 * logSafe(f.tradeAccel) + 0.65 * Number(f.r15 || 0) + 0.35 * Number(f.breakout60 || 0);
  const confirm = 1.2 * Number(f.breakout60 || 0) + 0.65 * Number(f.rs60 || 0) + 0.35 * logSafe(f.vol30)
    - 0.8 * Math.max(0, Number(f.r24 || 0) - 0.10)
    - 0.5 * Math.max(0, Number(f.r60 || 0) - 0.06);
  const extension = 1.15 * Number(f.rs60 || 0) + 0.75 * Number(f.rs240 || 0) + 0.35 * Number(f.r30 || 0) + 0.25 * Number(f.breakout240 || 0)
    - 0.45 * Math.max(0, Number(f.r24 || 0) - 0.12);
  const freshEnough = Number(f.r24 || 0) < 0.18 && Number(f.r60 || 0) < 0.10 && Number(f.r15 || 0) < 0.06;
  const pass = freshEnough ? V42_THRESHOLDS.filter(th=>ignition>=th.i&&confirm>=th.c&&extension>=th.e).length : 0;
  const mid = V42_THRESHOLDS[1];
  const ignitionMargin = clamp01(0.5 + (ignition - mid.i) / 2.0);
  const confirmMargin = clamp01(0.5 + (confirm - mid.c) / 0.8);
  const extensionMargin = clamp01(0.5 + (extension - mid.e) / 0.12);
  const norm = freshEnough ? clamp01((pass / 3) * 0.55 + ignitionMargin * 0.20 + confirmMargin * 0.15 + extensionMargin * 0.10) : 0;
  return { pass, norm, freshEnough, detail:{ignition,confirm,extension,r15:Number(f.r15||0),r60:Number(f.r60||0),r24:Number(f.r24||0)} };
}

function productionEligible(s) {
  const q=s.productionV42 || {};
  const d=q.detail || {};
  const pct=Number(d.r24||0)*100;
  const high=q.pass===3 && q.norm>=0.94;
  const early=
    q.pass===2 &&
    q.freshEnough===true &&
    q.norm>=0.82 &&
    pct>=1.5 && pct<8 &&
    Number(d.ignition)>=1.0 &&
    Number(d.confirm)>=0.28 &&
    Number(d.extension)>=0.015 &&
    Number(d.r15)>0 && Number(d.r15)<=0.04 &&
    Number(d.r60)>0 && Number(d.r60)<=0.08;
  return high || early;
}

function selectSignals(lib, rows, threshold) {
  const eligible = rows
    .filter(productionEligible)
    .filter(s=>s.continuationScore > threshold)
    .map(s=>({...s, v42Score:s.productionV42.norm}));
  return lib.signalPolicy(eligible, -Infinity, 'v42Score');
}

function evaluate(lib, rows, threshold) {
  const signals = selectSignals(lib, rows, threshold);
  return {
    threshold,
    prediction:lib.predictionMetrics(signals),
    economic:lib.economicMetrics(signals, rows)
  };
}

function objective(row) {
  const p=row.prediction,e=row.economic;
  if (p.signals < 8) return -Infinity;
  return e.netGrowth * 10 + e.avgNetRet * 5 + p.winner5Precision * 1.5 + p.winner10Precision * 2 - Math.max(0,-e.maxDrawdown);
}

async function buildRaw(lib) {
  const {r,b}=lib;
  const earliest=lib.DEV_START-16*lib.DAY-12*lib.HOUR;
  const loadStart=earliest-lib.DAY,loadEnd=lib.CONFIRM_END+lib.DAY;
  const universeMonth=r.prevCompleteMonth(lib.DEV_START);
  const allSymbols=await r.archiveSymbols();
  const targets=allSymbols.filter(s=>r.targetSymbol(s).ok);
  const liq=await r.mapLimit(targets,20,s=>r.priorMonthLiquidity(s,universeMonth));
  const ranked=liq.filter(x=>x&&!x.__error&&x.avgDailyQuoteVolume>=lib.MIN_QV).sort((a,z)=>z.avgDailyQuoteVolume-a.avgDailyQuoteVolume);
  const pool=ranked.slice(0,Number(process.env.HIST_POOL_SIZE||lib.POOL_SIZE||60)).map(x=>x.symbol);
  if(!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');

  const data=new Map();
  const loaded=await r.mapLimit(pool,8,async symbol=>({symbol,rows:await r.loadKlines(symbol,loadStart,loadEnd,loadEnd)}));
  for(const x of loaded) if(x&&!x.__error&&x.rows?.length) data.set(x.symbol,x.rows);
  const btc=data.get('BTCUSDT'); if(!btc?.length) throw new Error('BTCUSDT unavailable');

  const bm=b.v.btcMap(btc),featureRows=[],breadth=new Map();
  for(const [symbol,series] of data){
    if(symbol==='BTCUSDT'||series.length<lib.WARM+146) continue;
    for(let i=lib.WARM;i<series.length-145;i++){
      const t=series[i].t;
      if(t<earliest||t>=lib.CONFIRM_END||!r.contiguous(series,i)) continue;
      if((Math.floor(t/lib.STEP)%3)!==0) continue;
      let f; try{f=b.v.feat(series,i,bm);}catch{continue;}
      const baseQuote = series.slice(i-72,i-12).reduce((sum,row)=>sum+Number(row.q||0),0) / Math.max(1,series.slice(i-72,i-12).length) * 12;
      const q30 = series.slice(i-5,i+1).reduce((sum,row)=>sum+Number(row.q||0),0);
      const prior240 = Math.max(...series.slice(i-48,i).map(row=>Number(row.h||0)));
      f = {
        ...f,
        vol30: baseQuote > 0 ? q30 / (baseQuote / 2) : 1,
        breakout240: prior240 > 0 ? Number(series[i].c||0) / prior240 - 1 : 0
      };
      if(f.qv<lib.MIN_QV) continue;
      if(f.r24<.01||f.r24>=.18||f.r60>=.10||f.r15>=.06) continue;
      const z=breadth.get(t)||{n:0,up15:0,up60:0,breakout:0,ignite:0,sum60:0};
      z.n++; if(f.r15>0)z.up15++; if(f.r60>0)z.up60++; if(f.breakout60>0)z.breakout++; if(f.vol15>1.2)z.ignite++; z.sum60+=f.r60;
      breadth.set(t,z); featureRows.push({symbol,t,f,series,index:i});
    }
  }

  const raw=[];
  for(const s of featureRows){
    s.breadth=lib.breadthAt(breadth.get(s.t));
    s.regimeWeights=b.v.regimeWeights(s.f,s.breadth);
    s.outcome=lib.futureOutcome(s); if(!s.outcome)continue;
    s.v42=lib.v42(s);
    s.productionV42=productionV42(s.f);
    s.continuationScore=continuity(s);
    raw.push(s);
  }
  raw.sort((a,z)=>a.t-z.t||a.symbol.localeCompare(z.symbol));
  return {raw,poolSize:pool.length,loaded:data.size};
}

async function main(){
  const lib=loadR7();
  const {raw,poolSize,loaded}=await buildRaw(lib);
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END);
  const confirm=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);

  const eligibility = {
    development: {
      rows: dev.length,
      production_eligible: dev.filter(productionEligible).length,
      high_3of3: dev.filter(s=>s.productionV42.pass===3&&s.productionV42.norm>=0.94).length,
      early_2of3: dev.filter(s=>productionEligible(s)&&s.productionV42.pass===2).length,
      pass_distribution: [0,1,2,3].map(pass=>({pass,count:dev.filter(s=>s.productionV42.pass===pass).length}))
    },
    confirmation: {
      rows: confirm.length,
      production_eligible: confirm.filter(productionEligible).length,
      high_3of3: confirm.filter(s=>s.productionV42.pass===3&&s.productionV42.norm>=0.94).length,
      early_2of3: confirm.filter(s=>productionEligible(s)&&s.productionV42.pass===2).length,
      pass_distribution: [0,1,2,3].map(pass=>({pass,count:confirm.filter(s=>s.productionV42.pass===pass).length}))
    }
  };
  const baselineDev=evaluate(lib,dev,-Infinity);
  if (baselineDev.prediction.signals === 0) throw new Error(`production-like historical baseline produced zero signals: ${JSON.stringify(eligibility.development)}`);
  const candidates=THRESHOLDS.map(th=>evaluate(lib,dev,th)).map(row=>({...row,objective:objective(row)}));
  const viable=candidates.filter(x=>Number.isFinite(x.objective)&&x.prediction.signals>=Math.max(8,Math.floor(baselineDev.prediction.signals*.25)));
  viable.sort((a,z)=>z.objective-a.objective);
  const selected=viable[0]||null;

  const baselineConfirm=evaluate(lib,confirm,-Infinity);
  const selectedConfirm=selected?evaluate(lib,confirm,selected.threshold):null;
  const delta=selectedConfirm?{
    signals:selectedConfirm.prediction.signals-baselineConfirm.prediction.signals,
    winner5_precision:selectedConfirm.prediction.winner5Precision-baselineConfirm.prediction.winner5Precision,
    winner10_precision:selectedConfirm.prediction.winner10Precision-baselineConfirm.prediction.winner10Precision,
    avg_mfe12:selectedConfirm.prediction.avgMfe12-baselineConfirm.prediction.avgMfe12,
    net_growth:selectedConfirm.economic.netGrowth-baselineConfirm.economic.netGrowth,
    avg_net_ret:selectedConfirm.economic.avgNetRet-baselineConfirm.economic.avgNetRet,
    max_drawdown:selectedConfirm.economic.maxDrawdown-baselineConfirm.economic.maxDrawdown
  }:null;

  const confirmationPass=Boolean(selectedConfirm&&
    selectedConfirm.prediction.signals>=8&&
    delta.net_growth>0&&
    delta.avg_net_ret>=0&&
    delta.winner5_precision>=0&&
    selectedConfirm.economic.maxDrawdown>=baselineConfirm.economic.maxDrawdown-0.01
  );

  const report={
    version:'MOMENTUM_CONTINUATION_HISTORICAL_V3',
    generated_at:new Date().toISOString(),
    research_only:true,
    production_mutation:false,
    formula_source:'backend/services/spotMomentumContinuation.js',
    reconstructed_features:['vol30','breakout240'],
    universe:{pool:poolSize,loaded,candidate_rows:raw.length},
    eligibility,
    periods:{development:[new Date(lib.DEV_START).toISOString(),new Date(lib.DEV_END).toISOString()],confirmation:[new Date(lib.CONFIRM_START).toISOString(),new Date(lib.CONFIRM_END).toISOString()]},
    baseline:{development:baselineDev,confirmation:baselineConfirm},
    development_candidates:candidates,
    selected_development:selected,
    confirmation:selectedConfirm,
    confirmation_delta:delta,
    recommendation:!selected?'NO_THRESHOLD_SELECTED':confirmationPass?'ADJUST_PRODUCTION_TO_HISTORICAL_THRESHOLD':'KEEP_CURRENT_PRODUCTION_THRESHOLD',
    confirmation_pass:confirmationPass
  };
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});
  fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,selected:selected?.threshold??null,confirmation_pass:confirmationPass,recommendation:report.recommendation,delta},null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
