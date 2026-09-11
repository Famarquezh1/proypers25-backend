'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const INTERVAL = '15m';
const INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.TRAIN_LOOKBACK_DAYS || 120);
const MAX_SYMBOLS = Number(process.env.TRAIN_MAX_SYMBOLS || 40);
const PURGE_HOURS = Number(process.env.TRAIN_PURGE_HOURS || 48);
const MIN_POINT_IN_TIME_QV = Number(process.env.TRAIN_MIN_POINT_IN_TIME_QV || 1_000_000);
const FEE_PCT = 0.002;
const STRESS_SLIPPAGE_PCT = 0.0025;
const HARD_STOP_PCT = 0.05;
const BREAK_EVEN_TRIGGER = 0.05;
const BREAK_EVEN_LOCK = 0.002;
const TRAILING_TRIGGER = 0.08;
const TRAILING_DISTANCE = 0.03;
const TIMEOUT_HOURS = 18;
const TIMEOUT_MAX_GAIN = 0.005;
const MAX_FORWARD_HOURS = 48;
const FORWARD_BARS = MAX_FORWARD_HOURS * 4;
const TIMEOUT_BARS = TIMEOUT_HOURS * 4;
const WARMUP_BARS = 96;
const COOLDOWN_HOURS = 6;
const MAX_CONCURRENT = 1;
const BOOTSTRAPS = Number(process.env.TRAIN_BOOTSTRAPS || 400);
const MIN_TRADES = 14;

function avg(xs){ return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function std(xs){ if(xs.length<2) return 0; const m=avg(xs); return Math.sqrt(xs.reduce((s,x)=>s+(x-m)**2,0)/(xs.length-1)); }
function ret(a,b){ return a>0 ? b/a-1 : 0; }
function clamp(x,a,b){ return Math.max(a,Math.min(b,x)); }
function logitSafe(x){ x=clamp(x,1e-6,1-1e-6); return Math.log(x/(1-x)); }
function seeded(seed=0x25fab125){ let x=seed>>>0; return ()=>{ x^=x<<13; x^=x>>>17; x^=x<<5; return (x>>>0)/4294967296; }; }
const rng=seeded();

async function fetchJson(url){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),25000);
  try{
    const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-robust-trainer-v3/1.0'}});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  } finally { clearTimeout(t); }
}

async function currentFetchUniverse(){
  const rows=await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows
    .filter(r=>String(r.symbol).endsWith('USDT'))
    .filter(r=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter(r=>Number(r.quoteVolume)>=500_000)
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0,MAX_SYMBOLS)
    .map(r=>String(r.symbol));
}

async function klines(symbol){
  const start=Date.now()-LOOKBACK_DAYS*86400000;
  let cursor=start; const out=[];
  for(let page=0;page<28 && cursor<Date.now();page++){
    const q=new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cursor),limit:'1000'});
    const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if(!Array.isArray(rows)||!rows.length) break;
    for(const r of rows) out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7]});
    const next=+rows[rows.length-1][0]+INTERVAL_MS;
    if(next<=cursor) break;
    cursor=next;
    if(rows.length<1000) break;
  }
  return out;
}

function rsi(rows,i,p=14){
  let up=0,down=0;
  for(let j=i-p+1;j<=i;j++){
    const d=rows[j].c-rows[j-1].c;
    if(d>0) up+=d; else down-=d;
  }
  if(down===0) return 100;
  const rs=(up/p)/(down/p);
  return 100-100/(1+rs);
}

function slope(vals){
  const n=vals.length;if(n<2)return 0;
  const mx=(n-1)/2,my=avg(vals);let num=0,den=0;
  for(let i=0;i<n;i++){num+=(i-mx)*(vals[i]-my);den+=(i-mx)**2;}
  return den?num/den:0;
}

function features(rows,i,btcMap){
  const c=rows[i].c;
  const returns=[]; for(let j=i-15;j<=i;j++) if(j>0) returns.push(ret(rows[j-1].c,rows[j].c));
  const q4=avg(rows.slice(i-3,i+1).map(x=>x.q));
  const q28=avg(rows.slice(i-31,i-3).map(x=>x.q));
  const q24=rows.slice(i-95,i+1).reduce((s,x)=>s+x.q,0);
  const high4=Math.max(...rows.slice(i-16,i).map(x=>x.h));
  const high12=Math.max(...rows.slice(i-48,i).map(x=>x.h));
  const low4=Math.min(...rows.slice(i-16,i).map(x=>x.l));
  const logCloses=rows.slice(i-16,i+1).map(x=>Math.log(x.c));
  const b=btcMap.get(rows[i].t)||{};
  const r15=ret(rows[i-1].c,c), r1h=ret(rows[i-4].c,c), r4h=ret(rows[i-16].c,c), r12h=ret(rows[i-48].c,c), r24h=ret(rows[i-96].c,c);
  const breakout4=high4>0?c/high4-1:0, breakout12=high12>0?c/high12-1:0;
  const pullback4=high4>0?c/high4-1:0;
  const rebound4=low4>0?c/low4-1:0;
  const vol=std(returns);
  const range=rows[i].l>0?rows[i].h/rows[i].l-1:0;
  const volAccel=q28>0?q4/q28:1;
  const rs=(r4h-(b.r4h||0));
  return {r15,r1h,r4h,r12h,r24h,volAccel,breakout4,breakout12,pullback4,rebound4,volatility:vol,candleRange:range,trendSlope:slope(logCloses),rsi14:rsi(rows,i)/100,btc1h:b.r1h||0,btc4h:b.r4h||0,btc24h:b.r24h||0,btcVol:b.volatility||0,relativeStrengthBTC:rs,pointInTimeQV:q24};
}

function regime(f){
  if(f.btc24h>0.03 && f.btc4h>0) return 'BULL';
  if(f.btc24h<-0.03 && f.btc4h<0) return 'BEAR';
  if(f.btcVol>0.012) return 'VOLATILE';
  return 'RANGE';
}

const agents={
  EARLY_MOMENTUM:f=>1.9*f.r1h+1.05*f.r4h+.28*Math.log(Math.max(.2,f.volAccel))-.5*Math.max(0,f.r24h-.14),
  BREAKOUT:f=>2.4*f.breakout4+1.0*f.r4h+.22*Math.log(Math.max(.2,f.volAccel)),
  VOLUME_ACCEL:f=>.75*f.r1h+.75*Math.log(Math.max(.2,f.volAccel))-4.5*f.volatility,
  FRESHNESS:f=>1.25*f.r1h+.7*f.r4h-1.1*Math.max(0,f.r24h-.11),
  TREND_CONTINUATION:f=>.45*f.r1h+.95*f.r4h+.55*f.r12h+.25*f.trendSlope,
  RISK_ADJUSTED:f=>1.15*f.r1h+.8*f.r4h-8*f.volatility-2.5*f.candleRange,
  RELATIVE_STRENGTH_BTC:f=>1.15*f.relativeStrengthBTC+.55*f.r1h+.2*Math.log(Math.max(.2,f.volAccel)),
  VOLATILITY_EXPANSION:f=>.9*f.r1h+.35*Math.log(Math.max(.2,f.volAccel))+2.2*f.candleRange-2.5*f.volatility,
  PULLBACK_CONTINUATION:f=>.65*f.r4h+.5*f.r12h-1.1*Math.abs(Math.min(0,f.pullback4))+.22*Math.log(Math.max(.2,f.volAccel)),
  EXHAUSTION_FILTER:f=>1.0*f.r1h+.45*f.r4h-.8*Math.max(0,f.rsi14-.78)-1.3*Math.max(0,f.r24h-.15),
  MEAN_REVERSION:f=>-1.0*f.r1h-.35*f.r4h+.8*f.rebound4-4*f.volatility,
  REGIME_MOMENTUM:f=>1.0*f.r1h+.75*f.r4h+.4*f.relativeStrengthBTC+(f.btc24h>0?.25:-.2)*f.r4h
};

function productionLikeOutcome(rows,i){
  const entry=rows[i].c; let high=entry,stop=entry*(1-HARD_STOP_PCT),exit=entry,exitT=rows[i].t,reason='MAX_HORIZON';
  for(let k=1;k<=FORWARD_BARS && i+k<rows.length;k++){
    const bar=rows[i+k];
    if(bar.l<=stop){exit=stop;exitT=bar.t;reason='PROTECTIVE_STOP';break;}
    high=Math.max(high,bar.h);
    const gain=high/entry-1;
    if(gain>=BREAK_EVEN_TRIGGER) stop=Math.max(stop,entry*(1+BREAK_EVEN_LOCK));
    if(gain>=TRAILING_TRIGGER) stop=Math.max(stop,high*(1-TRAILING_DISTANCE));
    exit=bar.c;exitT=bar.t;
    if(k>=TIMEOUT_BARS && gain<=TIMEOUT_MAX_GAIN){reason='STALE_TIMEOUT';break;}
  }
  const gross=exit/entry-1;
  return {net:gross-FEE_PCT,stressNet:gross-FEE_PCT-STRESS_SLIPPAGE_PCT,entry,exit,exitT,reason,maxGain:high/entry-1};
}

function portfolioSelect(items,key='net'){
  const sorted=[...items].sort((a,b)=>a.t-b.t || b.s-a.s);
  const trades=[]; let busyUntil=-Infinity; const lastBySymbol=new Map();
  for(const x of sorted){
    if(MAX_CONCURRENT===1 && x.t<busyUntil) continue;
    const last=lastBySymbol.get(x.symbol)||-Infinity;
    if(x.t-last<COOLDOWN_HOURS*3600000) continue;
    trades.push(x);
    busyUntil=x.o.exitT;
    lastBySymbol.set(x.symbol,x.o.exitT);
  }
  return trades;
}

function maxDrawdown(rs){let eq=1,peak=1,worst=0;for(const r of rs){eq*=1+r;peak=Math.max(peak,eq);worst=Math.min(worst,eq/peak-1);}return worst;}
function sharpe(rs){if(rs.length<2)return 0;const s=std(rs);return s?avg(rs)/s*Math.sqrt(rs.length):0;}
function metrics(items,key='net'){
  const tr=portfolioSelect(items,key); if(!tr.length)return {n:0,win_rate:0,avg_net:0,profit_factor:0,max_drawdown:0,sharpe:0,total_return:0,score:-999};
  const rs=tr.map(x=>x.o[key]); const wins=rs.filter(x=>x>0),losses=rs.filter(x=>x<0);
  const gw=wins.reduce((a,b)=>a+b,0),gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const total=rs.reduce((eq,r)=>eq*(1+r),1)-1;
  const m={n:tr.length,win_rate:wins.length/tr.length,avg_net:avg(rs),profit_factor:gl?gw/gl:(gw>0?99:0),max_drawdown:maxDrawdown(rs),sharpe:sharpe(rs),total_return:total};
  m.score=m.avg_net*Math.sqrt(m.n)+.02*(m.win_rate-.5)+.012*Math.log(Math.max(.2,m.profit_factor))+.14*m.max_drawdown;
  return m;
}

function chooseThreshold(trainScored){
  const sorted=[...trainScored].sort((a,b)=>b.s-a.s); let best={threshold:Infinity,m:{score:-999}};
  for(const frac of [.015,.02,.03,.05,.08,.12,.18,.25]){
    const n=Math.max(20,Math.floor(sorted.length*frac)); if(n>sorted.length)continue;
    const threshold=sorted[n-1].s; const selected=sorted.filter(x=>x.s>=threshold); const m=metrics(selected);
    if(m.n>=MIN_TRADES && m.score>best.m.score) best={threshold,m};
  }
  return best;
}

function bootstrapP05(items,key='net'){
  const tr=portfolioSelect(items,key); if(tr.length<MIN_TRADES)return -1;
  const vals=tr.map(x=>x.o[key]);const means=[];
  for(let b=0;b<BOOTSTRAPS;b++){let s=0;for(let i=0;i<vals.length;i++)s+=vals[Math.floor(rng()*vals.length)];means.push(s/vals.length);}
  means.sort((a,b)=>a-b);return means[Math.floor(.05*means.length)];
}

function normalCdf(x){return .5*(1+erf(x/Math.SQRT2));}
function erf(x){const sign=x<0?-1:1; x=Math.abs(x);const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;const t=1/(1+p*x);const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);return sign*y;}
function invNorm(p){
  p=clamp(p,1e-9,1-1e-9);
  const a=[-39.6968302866538,220.946098424521,-275.928510446969,138.357751867269,-30.6647980661472,2.50662827745924];
  const b=[-54.4760987982241,161.585836858041,-155.698979859887,66.8013118877197,-13.2806815528857];
  const c=[-.00778489400243029,-.322396458041136,-2.40075827716184,-2.54973253934373,4.37466414146497,2.93816398269878];
  const d=[.00778469570904146,.32246712907004,2.445134137143,3.75440866190742];
  const pl=.02425,ph=1-pl;let q,r;
  if(p<pl){q=Math.sqrt(-2*Math.log(p));return (((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p>ph){q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  q=p-.5;r=q*q;return (((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);
}
function deflatedSharpeConfidence(m,trials){
  if(m.n<MIN_TRADES)return 0;
  const sr=m.sharpe, expectedMax=invNorm(1-1/Math.max(2,trials));
  const srStd=Math.sqrt(Math.max(1e-9,(1+.5*sr*sr)/Math.max(2,m.n-1)));
  return normalCdf((sr-expectedMax*srStd)/srStd);
}

function buildPaths(samples){
  const t0=samples[0].t,t1=samples[samples.length-1].t,span=t1-t0,block=span/8,purge=PURGE_HOURS*3600000;
  const blocks=Array.from({length:8},(_,i)=>({start:t0+i*block,end:i===7?t1+1:t0+(i+1)*block}));
  const paths=[];
  for(let k=0;k<4;k++){
    const trainEnd=blocks[3+k].end;
    const valBlock=blocks[4+k];
    const testBlock=blocks[Math.min(7,5+k)];
    if(!valBlock||!testBlock||valBlock===testBlock)continue;
    const train=samples.filter(x=>x.t<trainEnd-purge);
    const val=samples.filter(x=>x.t>valBlock.start+purge&&x.t<valBlock.end-purge);
    const test=samples.filter(x=>x.t>testBlock.start+purge&&x.t<testBlock.end-purge);
    if(train.length&&val.length&&test.length)paths.push({name:`P${k+1}`,train,val,test});
  }
  return paths;
}

function pboFromRanks(pathRows){
  if(!pathRows.length)return 1;
  let inversions=0,total=0;
  for(const p of pathRows){
    const byVal=[...p.agents].sort((a,b)=>b.validation.score-a.validation.score);
    const winner=byVal[0];
    const testRanks=[...p.agents].sort((a,b)=>b.test.score-a.test.score);
    const rank=testRanks.findIndex(x=>x.agent===winner.agent);
    if(rank>=Math.ceil(testRanks.length/2))inversions++;
    total++;
  }
  return total?inversions/total:1;
}

async function main(){
  const symbols=await currentFetchUniverse(); if(!symbols.includes('BTCUSDT'))symbols.unshift('BTCUSDT');
  console.log(`ROBUST_V3 symbols=${symbols.length} lookback=${LOOKBACK_DAYS}d`);
  const rowsBySymbol=new Map();
  for(const s of symbols){try{const r=await klines(s);rowsBySymbol.set(s,r);console.log(`LOADED ${s} bars=${r.length}`);}catch(e){console.log(`SKIP ${s} ${e.message}`);}}
  const btc=rowsBySymbol.get('BTCUSDT')||[];const btcMap=new Map();
  for(let i=WARMUP_BARS;i<btc.length;i++){
    const rs=[];for(let j=i-15;j<=i;j++)if(j>0)rs.push(ret(btc[j-1].c,btc[j].c));
    btcMap.set(btc[i].t,{r1h:ret(btc[i-4].c,btc[i].c),r4h:ret(btc[i-16].c,btc[i].c),r24h:ret(btc[i-96].c,btc[i].c),volatility:std(rs)});
  }
  const samples=[];
  for(const [symbol,rows] of rowsBySymbol){
    if(symbol==='BTCUSDT')continue;
    for(let i=WARMUP_BARS;i<rows.length-FORWARD_BARS;i+=4){
      const f=features(rows,i,btcMap);
      if(f.pointInTimeQV<MIN_POINT_IN_TIME_QV)continue;
      if(f.r24h<.003||f.r24h>=.18)continue;
      samples.push({symbol,t:rows[i].t,f,regime:regime(f),o:productionLikeOutcome(rows,i)});
    }
  }
  samples.sort((a,b)=>a.t-b.t);
  if(samples.length<1000)throw new Error(`Insufficient samples ${samples.length}`);
  const paths=buildPaths(samples); if(paths.length<3)throw new Error(`Insufficient robust paths ${paths.length}`);
  const pathRows=[];
  for(const p of paths){
    const agentRows=[];
    for(const [name,fn] of Object.entries(agents)){
      const tr=p.train.map(x=>({...x,s:fn(x.f)}));const ch=chooseThreshold(tr);
      const va=p.val.map(x=>({...x,s:fn(x.f)})).filter(x=>x.s>=ch.threshold);
      const te=p.test.map(x=>({...x,s:fn(x.f)})).filter(x=>x.s>=ch.threshold);
      agentRows.push({agent:name,threshold:ch.threshold,train:ch.m,validation:metrics(va),test:metrics(te),stress:metrics(te,'stressNet'),bootstrap_p05:bootstrapP05(te),dsr_confidence:deflatedSharpeConfidence(metrics(te),Object.keys(agents).length*paths.length)});
    }
    const frozen=[...agentRows].filter(x=>x.validation.n>=MIN_TRADES&&x.validation.avg_net>0&&x.validation.profit_factor>1&&x.bootstrap_p05>-0.01).sort((a,b)=>b.validation.score-a.validation.score)[0]||null;
    pathRows.push({path:p.name,frozen_winner:frozen?.agent||null,agents:agentRows});
  }
  const stability={};
  for(const p of pathRows){for(const a of p.agents){if(!stability[a.agent])stability[a.agent]={agent:a.agent,paths:0,positive_test:0,positive_stress:0,p05_positive:0,dsr70:0,testNet:[],pf:[],dd:[]};const s=stability[a.agent];s.paths++;if(a.test.avg_net>0)s.positive_test++;if(a.stress.avg_net>0)s.positive_stress++;if(a.bootstrap_p05>0)s.p05_positive++;if(a.dsr_confidence>=.70)s.dsr70++;s.testNet.push(a.test.avg_net);s.pf.push(a.test.profit_factor);s.dd.push(a.test.max_drawdown);}}
  const ranking=Object.values(stability).map(s=>({...s,avg_test_net:avg(s.testNet),avg_pf:avg(s.pf),worst_dd:Math.min(...s.dd)})).sort((a,b)=>b.positive_stress-a.positive_stress||b.p05_positive-a.p05_positive||b.avg_test_net-a.avg_test_net);
  const pbo=pboFromRanks(pathRows);
  const stable=ranking.filter(x=>x.paths>=3&&x.positive_test===x.paths&&x.positive_stress>=x.paths-1&&x.p05_positive>=Math.ceil(x.paths/2)&&x.avg_pf>1&&x.worst_dd>-0.35).slice(0,3);
  const frozenTests=pathRows.map(p=>{const a=p.agents.find(x=>x.agent===p.frozen_winner);return a?{path:p.path,agent:a.agent,test:a.test,stress:a.stress,p05:a.bootstrap_p05,dsr:a.dsr_confidence}:null;}).filter(Boolean);
  const productionGate={pass:stable.length>0&&pbo<=.35&&frozenTests.filter(x=>x.test.avg_net>0&&x.stress.avg_net>0).length>=Math.max(2,Math.ceil(frozenTests.length*.67)),reason:'',pbo};
  productionGate.reason=productionGate.pass?'robust across purged paths with stress and overfit controls':'insufficient robustness after purged multi-path, stress, bootstrap and PBO controls';
  const report={generated_at:new Date().toISOString(),mode:'ROBUSTNESS_FIRST_PURGED_MULTI_PATH_V3',source:'BINANCE_VISION',lookback_days:LOOKBACK_DAYS,samples:samples.length,agents:Object.keys(agents),settings:{purge_hours:PURGE_HOURS,point_in_time_qv_min:MIN_POINT_IN_TIME_QV,max_concurrent:MAX_CONCURRENT,cooldown_hours:COOLDOWN_HOURS,fee_pct:FEE_PCT,stress_slippage_pct:STRESS_SLIPPAGE_PCT},paths:pathRows,ranking,stable_champions:stable,frozen_path_tests:frozenTests,production_gate:productionGate,caveats:['Fetch universe is seeded from symbols tradable today; point-in-time rolling volume eligibility reduces but does not fully eliminate survivorship bias.','15m replay approximates the production 5m exit engine.','Deflated Sharpe confidence is a deterministic multiple-testing proxy, not a full research-library implementation of DSR.']};
  const dir=path.resolve(process.cwd(),'training-output');fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'spot-robust-v3-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(dir,'spot-robust-v3-champions.json'),JSON.stringify({generated_at:report.generated_at,stable_champions:stable,production_gate:productionGate},null,2));
  console.log(JSON.stringify({ok:true,samples:report.samples,stable_champions:stable,production_gate:productionGate,top:ranking.slice(0,5)},null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
