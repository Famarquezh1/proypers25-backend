'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const INTERVAL = '15m';
const INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.TRAIN_LOOKBACK_DAYS || 90);
const MAX_SYMBOLS = Number(process.env.TRAIN_MAX_SYMBOLS || 32);
const RANDOM_TRIALS = Number(process.env.TRAIN_RANDOM_TRIALS || 1600);
const BOOTSTRAPS = Number(process.env.TRAIN_BOOTSTRAPS || 250);
const PURGE_HOURS = 48;
const FEE_PCT = 0.002;
const STRESS_SLIPPAGE_PCT = 0.002;
const HARD_STOP_PCT = 0.05;
const BREAK_EVEN_TRIGGER = 0.05;
const BREAK_EVEN_LOCK = 0.002;
const TRAILING_TRIGGER = 0.08;
const TRAILING_DISTANCE = 0.03;
const TIMEOUT_HOURS = 18;
const TIMEOUT_MAX_GAIN = 0.005;
const MAX_FORWARD_HOURS = 48;
const WARMUP_BARS = 96;
const FORWARD_BARS = Math.floor(MAX_FORWARD_HOURS * 60 / 15);
const TIMEOUT_BARS = Math.floor(TIMEOUT_HOURS * 60 / 15);

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
function avg(xs) { return xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0; }
function std(xs) { const m = avg(xs); return xs.length ? Math.sqrt(avg(xs.map(x=>(x-m)**2))) : 0; }
function ret(a,b) { return a > 0 ? b/a - 1 : 0; }
function maxDrawdown(returns) {
  let equity=1, peak=1, dd=0;
  for (const r of returns) { equity *= (1+r); peak = Math.max(peak,equity); dd = Math.min(dd, equity/peak - 1); }
  return dd;
}
function seeded(seed=123456789) { let x=seed>>>0; return ()=>{ x ^= x<<13; x ^= x>>>17; x ^= x<<5; return (x>>>0)/4294967296; }; }
const rng = seeded(0x25fab1);

async function fetchJson(url) {
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(),25000);
  try {
    const r = await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-advanced-trainer/2.0'}});
    if(!r.ok) throw new Error(`HTTP ${r.status} ${url}`);
    return r.json();
  } finally { clearTimeout(t); }
}

async function universe() {
  const rows = await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows
    .filter(r=>String(r.symbol).endsWith('USDT'))
    .filter(r=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter(r=>Number(r.quoteVolume)>=1_000_000)
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0,MAX_SYMBOLS)
    .map(r=>String(r.symbol));
}

async function klines(symbol) {
  const start = Date.now()-LOOKBACK_DAYS*86400000;
  let cursor=start; const out=[];
  for(let page=0;page<20 && cursor<Date.now();page++){
    const q=new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cursor),limit:'1000'});
    const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if(!Array.isArray(rows)||!rows.length) break;
    for(const r of rows) out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],v:+r[5],q:+r[7]});
    const next=+rows[rows.length-1][0]+INTERVAL_MS;
    if(next<=cursor) break; cursor=next; if(rows.length<1000) break;
  }
  return out;
}

function rsi(rows,i,period=14){
  let up=0,down=0;
  for(let j=i-period+1;j<=i;j++){
    const d=rows[j].c-rows[j-1].c; if(d>0) up+=d; else down-=d;
  }
  if(down===0) return 100;
  const rs=(up/period)/(down/period); return 100-(100/(1+rs));
}

function slope(vals){
  const n=vals.length; if(n<2) return 0;
  const mx=(n-1)/2, my=avg(vals); let num=0,den=0;
  for(let i=0;i<n;i++){ num+=(i-mx)*(vals[i]-my); den+=(i-mx)**2; }
  return den?num/den:0;
}

function features(rows,i,btcMap){
  const c=rows[i].c;
  const returns4h=[]; for(let j=i-15;j<=i;j++) if(j>0) returns4h.push(ret(rows[j-1].c,rows[j].c));
  const qShort=avg(rows.slice(i-3,i+1).map(x=>x.q));
  const qBase=avg(rows.slice(i-31,i-3).map(x=>x.q));
  const high4h=Math.max(...rows.slice(i-16,i).map(x=>x.h));
  const high12h=Math.max(...rows.slice(i-48,i).map(x=>x.h));
  const closes=rows.slice(i-16,i+1).map(x=>Math.log(x.c));
  const btc=btcMap.get(rows[i].t) || {};
  return {
    r15: ret(rows[i-1].c,c),
    r1h: ret(rows[i-4].c,c),
    r4h: ret(rows[i-16].c,c),
    r12h: ret(rows[i-48].c,c),
    r24h: ret(rows[i-96].c,c),
    volAccel: qBase>0?qShort/qBase:1,
    breakout4: high4h>0?c/high4h-1:0,
    breakout12: high12h>0?c/high12h-1:0,
    volatility: std(returns4h),
    candleRange: rows[i].l>0?rows[i].h/rows[i].l-1:0,
    trendSlope: slope(closes),
    rsi14: rsi(rows,i)/100,
    btc1h: btc.r1h||0,
    btc4h: btc.r4h||0,
    btc24h: btc.r24h||0,
    btcVol: btc.volatility||0
  };
}

function productionLikeOutcome(rows,i){
  const entry=rows[i].c;
  let high=entry, stop=entry*(1-HARD_STOP_PCT), reason='MAX_HORIZON', exit=rows[Math.min(rows.length-1,i+FORWARD_BARS)].c;
  for(let k=1;k<=FORWARD_BARS && i+k<rows.length;k++){
    const bar=rows[i+k];
    // Conservative intrabar ordering: existing stop can trigger before a new high raises it.
    if(bar.l<=stop){ exit=stop; reason='PROTECTIVE_STOP'; break; }
    high=Math.max(high,bar.h);
    const gain=high/entry-1;
    if(gain>=BREAK_EVEN_TRIGGER) stop=Math.max(stop,entry*(1+BREAK_EVEN_LOCK));
    if(gain>=TRAILING_TRIGGER) stop=Math.max(stop,high*(1-TRAILING_DISTANCE));
    if(k>=TIMEOUT_BARS && gain<=TIMEOUT_MAX_GAIN){ exit=bar.c; reason='STALE_TIMEOUT'; break; }
    exit=bar.c;
  }
  const gross=exit/entry-1;
  return {net:gross-FEE_PCT, stressNet:gross-FEE_PCT-STRESS_SLIPPAGE_PCT, reason, maxGain:high/entry-1};
}

function regime(f){
  if(f.btc24h>0.03 && f.btc4h>0) return 'BULL';
  if(f.btc24h<-0.03 && f.btc4h<0) return 'BEAR';
  if(f.btcVol>0.012) return 'VOLATILE';
  return 'RANGE';
}

const baseAgents={
  EARLY_MOMENTUM:f=>1.8*f.r1h+1.1*f.r4h+0.25*Math.log(Math.max(.2,f.volAccel)),
  BREAKOUT:f=>2.2*f.breakout4+.9*f.r4h+.2*Math.log(Math.max(.2,f.volAccel)),
  VOLUME_ACCEL:f=>.8*f.r1h+.65*Math.log(Math.max(.2,f.volAccel))-4*f.volatility,
  FRESHNESS:f=>1.2*f.r1h+.7*f.r4h-.9*Math.max(0,f.r24h-.12),
  TREND:f=>.6*f.r1h+1*f.r4h+.45*f.r24h,
  RISK_ADJUSTED:f=>1.1*f.r1h+.8*f.r4h-7*f.volatility-2*f.candleRange
};

const featureNames=['r15','r1h','r4h','r12h','r24h','volAccel','breakout4','breakout12','volatility','candleRange','trendSlope','rsi14','btc1h','btc4h','btc24h','btcVol'];
function vector(f){ return featureNames.map(n=>n==='volAccel'?Math.log(Math.max(.2,f[n])):Number(f[n]||0)); }
function linearScore(x,w,bias,regimeBoosts){
  let s=bias; const v=vector(x.f); for(let i=0;i<v.length;i++) s+=v[i]*w[i];
  s+=regimeBoosts[x.regime]||0; return s;
}

function metrics(items,key='net'){
  if(!items.length) return {n:0,win_rate:0,avg_net:0,profit_factor:0,max_drawdown:0,score:-999};
  const rs=items.map(x=>x.o[key]);
  const wins=rs.filter(x=>x>0), losses=rs.filter(x=>x<0);
  const gw=wins.reduce((a,b)=>a+b,0), gl=Math.abs(losses.reduce((a,b)=>a+b,0));
  const avgNet=avg(rs), wr=wins.length/rs.length, pf=gl>0?gw/gl:gw>0?99:0, dd=maxDrawdown(rs);
  const score=avgNet*Math.sqrt(items.length)+0.02*(wr-.5)+0.015*Math.log(Math.max(.2,pf))+0.18*dd;
  return {n:items.length,win_rate:wr,avg_net:avgNet,profit_factor:pf,max_drawdown:dd,score};
}

function chooseThreshold(scored){
  const sorted=[...scored].sort((a,b)=>b.s-a.s);
  let best={threshold:Infinity,m:{score:-999}};
  for(const frac of [.02,.03,.05,.08,.12,.18,.25]){
    const n=Math.max(16,Math.floor(sorted.length*frac)); if(n>sorted.length) continue;
    const selected=sorted.slice(0,n); const m=metrics(selected);
    if(m.score>best.m.score) best={threshold:selected[selected.length-1].s,m};
  }
  return best;
}

function randomCandidate(){
  const w=featureNames.map(()=> (rng()*2-1)*3);
  const bias=(rng()*2-1)*.3;
  const rb={BULL:(rng()*2-1)*.3,BEAR:(rng()*2-1)*.3,VOLATILE:(rng()*2-1)*.3,RANGE:(rng()*2-1)*.3};
  return {w,bias,rb};
}

function bootstrapP05(items){
  if(!items.length) return -1;
  const means=[];
  for(let b=0;b<BOOTSTRAPS;b++){
    let s=0; for(let i=0;i<items.length;i++) s+=items[Math.floor(rng()*items.length)].o.net;
    means.push(s/items.length);
  }
  means.sort((a,b)=>a-b); return means[Math.floor(means.length*.05)];
}

async function main(){
  const symbols=await universe();
  if(!symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT');
  console.log(`ADV_TRAINER symbols=${symbols.length} lookback=${LOOKBACK_DAYS}d trials=${RANDOM_TRIALS}`);

  const allRows=new Map();
  for(const symbol of symbols){
    try{ const rows=await klines(symbol); allRows.set(symbol,rows); console.log(`LOADED ${symbol} bars=${rows.length}`); }
    catch(e){ console.log(`SKIP ${symbol} ${e.message}`); }
  }
  const btcRows=allRows.get('BTCUSDT')||[]; const btcMap=new Map();
  for(let i=WARMUP_BARS;i<btcRows.length;i++){
    const rs=[]; for(let j=i-15;j<=i;j++) if(j>0) rs.push(ret(btcRows[j-1].c,btcRows[j].c));
    btcMap.set(btcRows[i].t,{r1h:ret(btcRows[i-4].c,btcRows[i].c),r4h:ret(btcRows[i-16].c,btcRows[i].c),r24h:ret(btcRows[i-96].c,btcRows[i].c),volatility:std(rs)});
  }

  const samples=[];
  for(const [symbol,rows] of allRows){
    if(symbol==='BTCUSDT') continue;
    for(let i=WARMUP_BARS;i<rows.length-FORWARD_BARS;i+=4){
      const f=features(rows,i,btcMap);
      if(f.r24h<.005 || f.r24h>=.18) continue;
      const o=productionLikeOutcome(rows,i);
      samples.push({symbol,t:rows[i].t,f,o,regime:regime(f)});
    }
  }
  samples.sort((a,b)=>a.t-b.t);
  if(samples.length<500) throw new Error(`Insufficient samples ${samples.length}`);

  const t0=samples[0].t,t1=samples[samples.length-1].t,span=t1-t0;
  const trainCut=t0+span*.60, valCut=t0+span*.80, purge=PURGE_HOURS*3600000;
  const train=samples.filter(x=>x.t<trainCut-purge);
  const val=samples.filter(x=>x.t>trainCut+purge && x.t<valCut-purge);
  const test=samples.filter(x=>x.t>valCut+purge);

  const agentResults=[];
  for(const [name,fn] of Object.entries(baseAgents)){
    const tr=train.map(x=>({...x,s:fn(x.f)})); const ch=chooseThreshold(tr);
    const va=val.map(x=>({...x,s:fn(x.f)})).filter(x=>x.s>=ch.threshold);
    const te=test.map(x=>({...x,s:fn(x.f)})).filter(x=>x.s>=ch.threshold);
    agentResults.push({agent:name,threshold:ch.threshold,train:ch.m,validation:metrics(va),test:metrics(te),stress:metrics(te,'stressNet'),bootstrap_p05:bootstrapP05(te)});
  }

  let best=null;
  for(let trial=0;trial<RANDOM_TRIALS;trial++){
    const c=randomCandidate();
    const tr=train.map(x=>({...x,s:linearScore(x,c.w,c.bias,c.rb)})); const ch=chooseThreshold(tr);
    const va=val.map(x=>({...x,s:linearScore(x,c.w,c.bias,c.rb)})).filter(x=>x.s>=ch.threshold);
    if(va.length<20) continue;
    const vm=metrics(va), vstress=metrics(va,'stressNet');
    const robust=vm.score+vstress.score*.5;
    if(!best||robust>best.robust) best={...c,threshold:ch.threshold,train:ch.m,validation:vm,validationStress:vstress,robust};
  }
  if(!best) throw new Error('No viable meta-agent candidate');
  const testSelected=test.map(x=>({...x,s:linearScore(x,best.w,best.bias,best.rb)})).filter(x=>x.s>=best.threshold);
  const meta={
    agent:'META_REGIME_LINEAR_V2',threshold:best.threshold,weights:Object.fromEntries(featureNames.map((n,i)=>[n,best.w[i]])),regime_boosts:best.rb,
    train:best.train,validation:best.validation,test:metrics(testSelected),stress:metrics(testSelected,'stressNet'),bootstrap_p05:bootstrapP05(testSelected)
  };

  const viable=[...agentResults,meta].filter(r=>r.validation.n>=20&&r.test.n>=20&&r.validation.avg_net>0&&r.test.avg_net>0&&r.stress.avg_net>0&&r.bootstrap_p05>0);
  viable.sort((a,b)=>(b.test.score+b.stress.score)-(a.test.score+a.stress.score));
  const champion=viable[0]||null;

  const report={
    generated_at:new Date().toISOString(),mode:'ADVANCED_PURGED_WALK_FORWARD_NO_FUTURE_LEAKAGE',source:'BINANCE_VISION',interval:INTERVAL,lookback_days:LOOKBACK_DAYS,
    samples:samples.length,split:{train:train.length,validation:val.length,test:test.length,purge_hours:PURGE_HOURS},
    production_like_exit:{hard_stop_pct:HARD_STOP_PCT,break_even_trigger:BREAK_EVEN_TRIGGER,break_even_lock:BREAK_EVEN_LOCK,trailing_trigger:TRAILING_TRIGGER,trailing_distance:TRAILING_DISTANCE,stale_timeout_hours:TIMEOUT_HOURS,fees:FEE_PCT,stress_slippage:STRESS_SLIPPAGE_PCT},
    caveat:'Historical universe is drawn from symbols tradable today; results may still contain survivorship bias.',
    agents:agentResults,meta_agent:meta,champion
  };
  const dir=path.resolve(process.cwd(),'training-output'); fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'spot-advanced-training-report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(dir,'spot-advanced-champion.json'),JSON.stringify({generated_at:report.generated_at,champion},null,2));
  console.log(JSON.stringify({ok:true,samples:report.samples,champion,meta_agent:meta},null,2));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
