'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const INTERVAL = '5m';
const STEP_MS = 5 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.TRAIN_LOOKBACK_DAYS || 30);
const MAX_SYMBOLS = Number(process.env.TRAIN_MAX_SYMBOLS || 20);
const MIN_HIST_QUOTE_VOL_24H = Number(process.env.MIN_HIST_QUOTE_VOL_24H || 500000);
const FEE_PCT = 0.002;
const STRESS_SLIPPAGE_PCT = 0.002;
const FORWARD_HOURS = 24;
const FORWARD_BARS = FORWARD_HOURS * 12;
const WARMUP_BARS = 288; // 24h
const SAMPLE_EVERY_BARS = 3; // every 15m
const PURGE_HOURS = 24;
const COOLDOWN_HOURS = 6;
const TARGETS = [0.10, 0.20, 0.40, 0.80];

function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function std(a){const m=avg(a);return a.length?Math.sqrt(avg(a.map(x=>(x-m)**2))):0;}
function ret(a,b){return a>0?b/a-1:0;}
function clamp(x,a=0,b=1){return Math.max(a,Math.min(b,Number(x)||0));}
function safeDiv(a,b){return b? a/b : 0;}
function percentile(xs,p){if(!xs.length)return 0; const a=[...xs].sort((x,y)=>x-y); return a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))];}

async function fetchJson(url){
  const c=new AbortController(); const t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-explosion-v4/1.0'}}); if(!r.ok)throw new Error(`HTTP ${r.status}`); return r.json();}
  finally{clearTimeout(t);}
}

async function universe(){
  const rows=await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows.filter(r=>String(r.symbol).endsWith('USDT'))
    .filter(r=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter(r=>Number(r.quoteVolume)>=2_000_000)
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0,MAX_SYMBOLS)
    .map(r=>String(r.symbol));
}

async function klines(symbol){
  const start=Date.now()-LOOKBACK_DAYS*86400000;
  let cursor=start; const out=[];
  for(let page=0;page<90 && cursor<Date.now();page++){
    const q=new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cursor),limit:'1000'});
    const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if(!Array.isArray(rows)||!rows.length)break;
    for(const r of rows)out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]});
    const next=+rows[rows.length-1][0]+STEP_MS;
    if(next<=cursor)break; cursor=next; if(rows.length<1000)break;
  }
  return out;
}

function rollingQuote(rows,i,bars){return rows.slice(i-bars+1,i+1).reduce((s,x)=>s+x.q,0);}
function btcMapFrom(rows){
  const m=new Map();
  for(let i=WARMUP_BARS;i<rows.length;i++){
    const rs=[]; for(let j=i-11;j<=i;j++) if(j>0) rs.push(ret(rows[j-1].c,rows[j].c));
    m.set(rows[i].t,{r15:ret(rows[i-3].c,rows[i].c),r60:ret(rows[i-12].c,rows[i].c),r240:ret(rows[i-48].c,rows[i].c),vol60:std(rs)});
  }
  return m;
}

function features(rows,i,btcMap){
  const c=rows[i].c;
  const q5=rows[i].q;
  const q15=rollingQuote(rows,i,3);
  const q30=rollingQuote(rows,i,6);
  const q60=rollingQuote(rows,i,12);
  const qBase=avg(rows.slice(i-72,i-12).map(x=>x.q))*12;
  const prevHigh60=Math.max(...rows.slice(i-12,i).map(x=>x.h));
  const prevHigh240=Math.max(...rows.slice(i-48,i).map(x=>x.h));
  const r5=ret(rows[i-1].c,c), r15=ret(rows[i-3].c,c), r30=ret(rows[i-6].c,c), r60=ret(rows[i-12].c,c), r120=ret(rows[i-24].c,c), r240=ret(rows[i-48].c,c), r24h=ret(rows[i-288].c,c);
  const recentR=[]; for(let j=i-11;j<=i;j++) if(j>0)recentR.push(ret(rows[j-1].c,rows[j].c));
  const prevR=[]; for(let j=i-47;j<=i-12;j++) if(j>0)prevR.push(ret(rows[j-1].c,rows[j].c));
  const range5=rows[i].l>0?rows[i].h/rows[i].l-1:0;
  const rangeAvg60=avg(rows.slice(i-11,i+1).map(x=>x.l>0?x.h/x.l-1:0));
  const b=btcMap.get(rows[i].t)||{};
  const d=new Date(rows[i].t); const minute=d.getUTCHours()*60+d.getUTCMinutes(); const dow=d.getUTCDay();
  return {
    r5,r15,r30,r60,r120,r240,r24h,
    volAccel5:safeDiv(q5,qBase/12), volAccel15:safeDiv(q15,qBase/4), volAccel30:safeDiv(q30,qBase/2), volAccel60:safeDiv(q60,qBase),
    breakout60:prevHigh60>0?c/prevHigh60-1:0,
    breakout240:prevHigh240>0?c/prevHigh240-1:0,
    volCompression:safeDiv(std(recentR),Math.max(1e-9,std(prevR))),
    rangeExpansion:safeDiv(range5,Math.max(1e-9,rangeAvg60)),
    tradeCountAccel:safeDiv(rows[i].n,Math.max(1,avg(rows.slice(i-12,i).map(x=>x.n)))),
    rsBtc60:r60-(b.r60||0), rsBtc240:r240-(b.r240||0), btc60:b.r60||0, btc240:b.r240||0,
    minuteSin:Math.sin(2*Math.PI*minute/1440), minuteCos:Math.cos(2*Math.PI*minute/1440),
    dowSin:Math.sin(2*Math.PI*dow/7), dowCos:Math.cos(2*Math.PI*dow/7)
  };
}

function label(rows,i){
  const entry=rows[i].c; let maxGain=-1, maxAt=null, minGain=1;
  const hit={}; for(const t of TARGETS)hit[t]=null;
  for(let k=1;k<=FORWARD_BARS && i+k<rows.length;k++){
    const g=rows[i+k].h/entry-1; const dn=rows[i+k].l/entry-1;
    if(g>maxGain){maxGain=g;maxAt=k;}
    minGain=Math.min(minGain,dn);
    for(const t of TARGETS) if(hit[t]===null && g>=t) hit[t]=k*5;
  }
  return {maxGain,maxAtMinutes:maxAt===null?null:maxAt*5,minGain,hit10:hit[0.10],hit20:hit[0.20],hit40:hit[0.40],hit80:hit[0.80]};
}

const agents={
  EARLY_VELOCITY:f=>1.5*f.r15+1.2*f.r30+.8*f.r60+.25*Math.log(Math.max(.2,f.volAccel15)),
  VOLUME_IGNITION:f=>.5*f.r15+.8*Math.log(Math.max(.2,f.volAccel15))+.5*Math.log(Math.max(.2,f.tradeCountAccel)),
  SQUEEZE_BREAKOUT:f=>1.5*f.breakout60+.8*f.breakout240+.7*Math.log(Math.max(.2,f.volAccel30))-.5*Math.max(0,f.volCompression-1),
  RELATIVE_STRENGTH_BTC:f=>1.2*f.rsBtc60+.8*f.rsBtc240+.35*f.r30,
  FRESH_BREAKOUT:f=>1.4*f.breakout60+.8*f.r15+.4*f.r30-.8*Math.max(0,f.r24h-.12),
  RANGE_EXPANSION:f=>.6*f.r15+.55*Math.log(Math.max(.2,f.rangeExpansion))+.5*Math.log(Math.max(.2,f.volAccel15)),
  PRE_EXPLOSION:f=>1.1*f.r15+.9*f.r30+.55*f.breakout60+.45*Math.log(Math.max(.2,f.volAccel15))+.4*f.rsBtc60-.5*Math.max(0,f.r24h-.10),
  MICRO_PULLBACK:f=>.7*f.r60-.9*Math.max(0,f.r15)+.35*Math.log(Math.max(.2,f.volAccel30))+.4*f.breakout240,
  TIME_VOLUME_EDGE:f=>.7*Math.log(Math.max(.2,f.volAccel15))+.45*f.r30+.20*f.minuteSin+.12*f.minuteCos+.08*f.dowSin,
  EXHAUSTION_AVOID:f=>.7*f.r30+.45*f.breakout60+.35*Math.log(Math.max(.2,f.volAccel15))-1.1*Math.max(0,f.r24h-.10)-.7*Math.max(0,f.rangeExpansion-2)
};

function evaluateAgent(samples,name,fn){
  const scored=samples.map(s=>({...s,score:fn(s.f)})).sort((a,b)=>b.score-a.score);
  const fracs=[.01,.02,.03,.05,.08,.12]; let best=null;
  for(const frac of fracs){
    const n=Math.max(20,Math.floor(scored.length*frac)); if(n>scored.length)continue;
    const sel=scored.slice(0,n);
    const rates={}; for(const t of TARGETS) rates[`hit${Math.round(t*100)}`]=sel.filter(x=>x.l.maxGain>=t).length/sel.length;
    const avgMax=avg(sel.map(x=>x.l.maxGain));
    const medTime20=percentile(sel.filter(x=>x.l.hit20!==null).map(x=>x.l.hit20),.5);
    const monthlySignals=sel.length/Math.max(1,LOOKBACK_DAYS)*30;
    const precision20=rates.hit20;
    const precision40=rates.hit40;
    const objective=precision20*2.2+precision40*3.2+rates.hit10*.6+Math.min(1,monthlySignals/20)*.45+avgMax*1.5-Math.max(0,monthlySignals-80)*.002;
    const r={threshold:sel[sel.length-1].score,n:sel.length,monthly_signals:monthlySignals,avg_future_max:avgMax,median_minutes_to_20:medTime20,...rates,objective};
    if(!best||r.objective>best.objective)best=r;
  }
  return {agent:name,...best};
}

function simulateRotation(samples,agent,fn,threshold){
  const ordered=[...samples].sort((a,b)=>a.t-b.t); let capital=1, trades=0, wins=0, occupiedUntil=0; const symUntil=new Map(); const rets=[];
  for(const s of ordered){
    if(s.t<occupiedUntil)continue;
    if(s.t<(symUntil.get(s.symbol)||0))continue;
    const score=fn(s.f); if(score<threshold)continue;
    let gross;
    if(s.l.hit20!==null) gross=.20;
    else if(s.l.hit10!==null) gross=.10;
    else gross=Math.max(-.05,Math.min(.08,s.l.maxGain*.35));
    const net=gross-FEE_PCT; const stress=net-STRESS_SLIPPAGE_PCT;
    capital*=1+stress; rets.push(stress); trades++; if(stress>0)wins++;
    const holdMin=s.l.hit20!==null?s.l.hit20:(s.l.hit10!==null?s.l.hit10:180);
    occupiedUntil=s.t+Math.max(15,Math.min(360,holdMin))*60000;
    symUntil.set(s.symbol,s.t+COOLDOWN_HOURS*3600000);
  }
  let eq=1,peak=1,dd=0; for(const r of rets){eq*=1+r;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1);}
  return {trades,win_rate:trades?wins/trades:0,capital_end:capital,net_growth:capital-1,max_drawdown:dd,trades_per_30d:trades/Math.max(1,LOOKBACK_DAYS)*30};
}

async function main(){
  const symbols=await universe(); if(!symbols.includes('BTCUSDT'))symbols.unshift('BTCUSDT');
  console.log(`EXPLOSION_V4 lookback=${LOOKBACK_DAYS}d symbols=${symbols.length}`);
  const data=new Map();
  for(const s of symbols){try{const r=await klines(s);data.set(s,r);console.log(`LOADED ${s} ${r.length}`);}catch(e){console.log(`SKIP ${s} ${e.message}`);}}
  const btcMap=btcMapFrom(data.get('BTCUSDT')||[]);
  const samples=[];
  for(const [symbol,rows] of data){if(symbol==='BTCUSDT')continue;
    for(let i=WARMUP_BARS;i<rows.length-FORWARD_BARS;i+=SAMPLE_EVERY_BARS){
      const hist24=rollingQuote(rows,i,288); if(hist24<MIN_HIST_QUOTE_VOL_24H)continue;
      const f=features(rows,i,btcMap); if(f.r24h>=.18)continue; // never learn from already-exploded entries
      samples.push({symbol,t:rows[i].t,f,l:label(rows,i)});
    }
  }
  samples.sort((a,b)=>a.t-b.t); if(samples.length<500)throw new Error(`insufficient samples ${samples.length}`);
  const t0=samples[0].t,t1=samples[samples.length-1].t,span=t1-t0,purge=PURGE_HOURS*3600000;
  const cut=t0+span*.70;
  const train=samples.filter(x=>x.t<cut-purge), test=samples.filter(x=>x.t>cut+purge);
  const results=[];
  for(const [name,fn] of Object.entries(agents)){
    const tr=evaluateAgent(train,name,fn);
    const teSel=test.map(s=>({...s,score:fn(s.f)})).filter(s=>s.score>=tr.threshold);
    const testMetrics=evaluateAgent(teSel.length?teSel:test,name,()=>1);
    const rot=simulateRotation(test,name,fn,tr.threshold);
    results.push({...tr,test:{n:teSel.length,monthly_signals:teSel.length/Math.max(1,LOOKBACK_DAYS*.30)*30,hit10:teSel.length?teSel.filter(x=>x.l.maxGain>=.10).length/teSel.length:0,hit20:teSel.length?teSel.filter(x=>x.l.maxGain>=.20).length/teSel.length:0,hit40:teSel.length?teSel.filter(x=>x.l.maxGain>=.40).length/teSel.length:0,hit80:teSel.length?teSel.filter(x=>x.l.maxGain>=.80).length/teSel.length:0,avg_future_max:teSel.length?avg(teSel.map(x=>x.l.maxGain)):0},rotation:rot});
  }
  results.sort((a,b)=>{const sa=a.rotation.net_growth+2*a.test.hit20+3*a.test.hit40+.3*Math.min(1,a.rotation.trades_per_30d/8); const sb=b.rotation.net_growth+2*b.test.hit20+3*b.test.hit40+.3*Math.min(1,b.rotation.trades_per_30d/8); return sb-sa;});
  const champion=results.find(r=>r.rotation.trades_per_30d>=4&&r.rotation.net_growth>0&&r.rotation.max_drawdown>-0.25&&r.test.hit20>0)||null;
  const report={mode:'SPOT_EXPLOSION_PRECURSOR_V4',generated_at:new Date().toISOString(),lookback_days:LOOKBACK_DAYS,interval:INTERVAL,samples:samples.length,train_samples:train.length,test_samples:test.length,target_horizons_pct:[10,20,40,80],forward_hours:FORWARD_HOURS,anti_chase_r24h_max_pct:18,primary_goal:'monthly capital rotation + early detection before explosive moves',results,champion,production_gate:{pass:!!champion,reason:champion?'positive monthly rotation with >=4 trades/30d, DD > -25%, and nonzero +20% precursor precision':'no agent met monthly rotation + precursor robustness gate'},caveats:['5m timing; not second-level order-book replay','current top-volume universe is used for data retrieval, but each sample requires historical 24h quote volume','simulation is research-only and does not imply guaranteed profits']};
  const out=path.resolve(__dirname,'../training-output'); fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'spot-explosion-v4-report.json'),JSON.stringify(report,null,2));
  fs.writeFileSync(path.join(out,'spot-explosion-v4-champion.json'),JSON.stringify(champion||{},null,2));
  console.log(JSON.stringify({ok:true,lookback_days:LOOKBACK_DAYS,samples:samples.length,champion:champion?.agent||null,gate:report.production_gate,top:results.slice(0,5).map(r=>({agent:r.agent,test20:r.test.hit20,test40:r.test.hit40,rotation:r.rotation.net_growth,trades30:r.rotation.trades_per_30d,dd:r.rotation.max_drawdown}))},null,2));
}

main().catch(e=>{console.error(e);process.exit(1);});
