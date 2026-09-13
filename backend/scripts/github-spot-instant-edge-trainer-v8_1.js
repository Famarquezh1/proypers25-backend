'use strict';

const fs = require('fs');
const vm = require('vm');
const path = require('path');

const BASE_FILE = path.join(__dirname, 'github-spot-instant-decision-trainer-v8.js');
let src = fs.readFileSync(BASE_FILE, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '\n');
src += ';globalThis.__v8={universe,klines,mapLimit,btcMap,feature,vector,simulate,candidate,metrics,avg,std,clamp,utcDay,isoDay,DAY_MS,STEP_MS,WARM,HOLD_BARS,FEATURE_NAMES};';
const ctx = vm.createContext({ require, console, process, fetch, URLSearchParams, AbortController, setTimeout, clearTimeout, Date, Math, Map, Set, Array, Number, String, JSON });
vm.runInContext(src, ctx, { filename: 'v8-base.js' });
const v = ctx.__v8;

const TRAIN_DAYS = 7;
const EVAL_DAYS = Math.max(3, Math.min(7, Number(process.env.V81_EVAL_DAYS || 7)));
const TOP_FRACTIONS = [0.01, 0.02, 0.04, 0.06, 0.10, 0.15];
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MIN_CAL_TRADES = 6;
const MAX_FIT = 12000;

const EXTRA_NAMES = ['accel15_60','accel30_240','volSurge','breakoutIgnition','rsIgnition','freshPenalty','btcAlignment','compressionRelease','tradeBreakout','microAccel','rsAccel'];
const NAMES = [...v.FEATURE_NAMES, ...EXTRA_NAMES];

function expand(x) {
  const m = Object.fromEntries(v.FEATURE_NAMES.map((n,i)=>[n,x[i]]));
  const pos = z => Math.max(0, z || 0);
  const extras = [
    m.r15 - m.r60/4,
    m.r30 - m.r240/8,
    m.logVol15 - m.logVol30,
    m.breakout60 * pos(m.logVol15),
    m.rs60 * pos(m.logVol15),
    -pos(m.r24 - 0.08),
    m.r60 * m.btc60,
    -m.compression * pos(m.breakout60),
    m.logTradeAccel * m.breakout60,
    m.r5 - m.r15/3,
    m.rs60 - m.rs240/4
  ];
  return [...x, ...extras].map(z=>v.clamp(z,-5,5));
}

function standardizer(rows){
  const d=NAMES.length,mu=Array(d).fill(0),sd=Array(d).fill(1);
  for(let j=0;j<d;j++){mu[j]=v.avg(rows.map(r=>r.z[j]));const s=v.std(rows.map(r=>r.z[j]));sd[j]=s>1e-9?s:1;}
  return {mu,sd};
}
function norm(z,s){return z.map((x,j)=>v.clamp((x-s.mu[j])/s.sd[j],-5,5));}

function trainExpectedNet(rows){
  rows=rows.slice(-MAX_FIT);
  const s=standardizer(rows),d=NAMES.length,w=Array(d+1).fill(0);
  w[0]=v.avg(rows.map(r=>r.yNet));
  const lr=.045,l2=.004,delta=.010;
  for(let epoch=0;epoch<55;epoch++){
    const g=Array(d+1).fill(0);
    for(const r of rows){const x=norm(r.z,s);let pred=w[0];for(let j=0;j<d;j++)pred+=w[j+1]*x[j];const raw=pred-r.yNet;const e=Math.max(-delta,Math.min(delta,raw));g[0]+=e;for(let j=0;j<d;j++)g[j+1]+=e*x[j];}
    const n=Math.max(1,rows.length);w[0]-=lr*g[0]/n;for(let j=1;j<w.length;j++)w[j]-=lr*(g[j]/n+l2*w[j]);
  }
  return {w,s,predict(z){const x=norm(z,s);let y=w[0];for(let j=0;j<d;j++)y+=w[j+1]*x[j];return y;}};
}

function percentile(values,p){if(!values.length)return 0;const a=[...values].sort((x,y)=>x-y);return a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))];}

function select(scored,cutoff,maxPerTime=1){
  const byT=new Map();for(const r of scored){if(r.edge<cutoff)continue;if(!byT.has(r.t))byT.set(r.t,[]);byT.get(r.t).push(r);}
  const until=new Map(),out=[];
  for(const t of [...byT.keys()].sort((a,b)=>a-b)){
    const group=byT.get(t).sort((a,b)=>b.edge-a.edge).slice(0,maxPerTime);
    for(const r of group){if(t<(until.get(r.symbol)||0))continue;out.push(r);until.set(r.symbol,t+COOLDOWN_MS);}
  }
  return out;
}

function choosePolicy(cal,model){
  const scored=cal.map(r=>({...r,edge:model.predict(r.z)}));const preds=scored.map(r=>r.edge);let best=null;
  for(const frac of TOP_FRACTIONS){const cutoff=percentile(preds,1-frac);const sel=select(scored,cutoff);const m=v.metrics(sel);
    if(m.trades<MIN_CAL_TRADES)continue;
    if(!(m.avgNet>0.001&&m.compoundedGrowth>0&&m.maxDrawdown<0.02&&m.stops<0.62))continue;
    const score=m.avgNet + .5*m.compoundedGrowth - .30*m.maxDrawdown;
    if(!best||score>best.score)best={fraction:frac,cutoff,score,metrics:m};
  }
  return best;
}

async function main(){
  const now=Date.now(),evalEnd=v.utcDay(now),evalStart=evalEnd-EVAL_DAYS*v.DAY_MS;
  const dataStart=evalStart-(TRAIN_DAYS+2)*v.DAY_MS-v.WARM*v.STEP_MS;
  const symbols=await v.universe();console.log(`V81_UNIVERSE symbols=${symbols.length} eval=${v.isoDay(evalStart)}..${v.isoDay(evalEnd)}`);
  const loaded=await v.mapLimit(symbols,8,async symbol=>({symbol,rows:await v.klines(symbol,dataStart,evalEnd+v.HOLD_BARS*v.STEP_MS+v.STEP_MS)}));
  const data=new Map();for(const x of loaded)if(x&&!x.__error&&x.rows?.length)data.set(x.symbol,x.rows);
  const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTCUSDT unavailable');const bm=v.btcMap(btc);
  const all=[];
  for(const [symbol,rows] of data){if(symbol==='BTCUSDT'||rows.length<v.WARM+v.HOLD_BARS+10)continue;for(let i=v.WARM;i<rows.length-v.HOLD_BARS-2;i+=3){const f=v.feature(rows,i,bm);if(!v.candidate(f))continue;const o=v.simulate(rows,i);if(!o)continue;const x=v.vector(f);all.push({symbol,t:rows[i].t,z:expand(x),o,yNet:o.net});}}
  all.sort((a,b)=>a.t-b.t);console.log(`V81_SAMPLES ${all.length}`);

  const days=[];
  for(let d=evalStart;d<evalEnd;d+=v.DAY_MS){
    const trainStart=d-TRAIN_DAYS*v.DAY_MS,purge=d-v.HOLD_BARS*v.STEP_MS,calCut=d-2*v.DAY_MS;
    const tr=all.filter(r=>r.t>=trainStart&&r.t<purge),fit=tr.filter(r=>r.t<calCut),cal=tr.filter(r=>r.t>=calCut),test=all.filter(r=>r.t>=d&&r.t<d+v.DAY_MS);
    if(fit.length<300||cal.length<80||test.length<20){days.push({day:v.isoDay(d),active:false,reason:'insufficient samples',fit:fit.length,cal:cal.length,test:test.length});continue;}
    const model=trainExpectedNet(fit),policy=choosePolicy(cal,model);
    if(!policy){days.push({day:v.isoDay(d),active:false,reason:'recent calibration has no positive net edge',fit:fit.length,cal:cal.length,test:test.length});console.log(`V81_DAY ${v.isoDay(d)} ABSTAIN no_positive_calibration`);continue;}
    const scored=test.map(r=>({...r,edge:model.predict(r.z)}));const chosen=select(scored,policy.cutoff);const m=v.metrics(chosen);
    days.push({day:v.isoDay(d),active:true,policy,test:m});
    console.log(`V81_DAY ${v.isoDay(d)} top=${(policy.fraction*100).toFixed(1)}% trades=${m.trades} wr=${(m.winRate*100).toFixed(1)} avgNet=${(m.avgNet*100).toFixed(3)}% growth=${(m.compoundedGrowth*100).toFixed(3)}%`);
  }

  const active=days.filter(x=>x.active),agg={evaluatedDays:days.length,activeDays:active.length,abstainDays:days.length-active.length,positiveActiveDays:active.filter(x=>x.test.compoundedGrowth>0).length,totalTrades:active.reduce((s,x)=>s+x.test.trades,0),avgDailyGrowth:v.avg(active.map(x=>x.test.compoundedGrowth)),avgNetPerTrade:v.avg(active.map(x=>x.test.avgNet)),avgWinRate:v.avg(active.map(x=>x.test.winRate)),maxObservedDD:active.length?Math.max(...active.map(x=>x.test.maxDrawdown)):0};
  const verdict=active.length>=2&&agg.positiveActiveDays>=Math.ceil(active.length*.67)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';

  // Fit a latest causal model and policy for evidence only; never used for orders here.
  const latestTrainStart=evalEnd-TRAIN_DAYS*v.DAY_MS,latestPurge=evalEnd-v.HOLD_BARS*v.STEP_MS,latestCalCut=evalEnd-2*v.DAY_MS;
  const latestRows=all.filter(r=>r.t>=latestTrainStart&&r.t<latestPurge),latestFit=latestRows.filter(r=>r.t<latestCalCut),latestCal=latestRows.filter(r=>r.t>=latestCalCut);
  let latest=null;if(latestFit.length>=300&&latestCal.length>=80){const lm=trainExpectedNet(latestFit),lp=choosePolicy(latestCal,lm);if(lp)latest={policy:lp,weights:lm.w,standardizer:lm.s,featureNames:NAMES};}

  const report={version:'V8_1_REALIZED_NET_EDGE',generatedAt:new Date().toISOString(),design:{trainDays:TRAIN_DAYS,calibrationDays:2,decisionCadenceMinutes:5,target:'realized net return from next-bar entry',exit:{tp:0.03,sl:0.012,holdMinutes:180},strictCalibration:true,causal:true,productionMutation:false},universe:{loaded:data.size},samples:all.length,days,aggregate:agg,latestModelAvailable:!!latest,latest,verdict};
  fs.writeFileSync('spot-instant-edge-v8_1.json',JSON.stringify(report,null,2));
  console.log(`V81_RESULT ${JSON.stringify({aggregate:agg,latestModelAvailable:!!latest,verdict})}`);
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
