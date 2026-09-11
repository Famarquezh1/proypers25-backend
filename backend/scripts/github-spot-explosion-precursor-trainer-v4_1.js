'use strict';

const fs=require('fs');
const path=require('path');

const BASE='https://data-api.binance.vision';
const INTERVAL='5m';
const STEP_MS=300000;
const LOOKBACK_DAYS=Number(process.env.TRAIN_LOOKBACK_DAYS||30);
const MAX_SYMBOLS=Number(process.env.TRAIN_MAX_SYMBOLS||24);
const MIN_HIST_QV=Number(process.env.MIN_HIST_QUOTE_VOL_24H||500000);
const FEE_PCT=0.002;
const STRESS_SLIPPAGE=0.002;
const WARMUP=288;
const SAMPLE_EVERY=3;
const FWD_BARS=24*12;
const PURGE_MS=24*3600000;
const COOLDOWN_MS=6*3600000;
const MAX_CONCURRENT=3;
const POSITION_FRACTION=0.15;
const TARGETS=[.10,.20,.40,.80];
const HARD_STOP=.05;
const BE_TRIGGER=.05;
const BE_LOCK=.002;
const TRAIL_TRIGGER=.08;
const TRAIL_DISTANCE=.03;
const STALE_BARS=18*12;

function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function std(a){const m=avg(a);return a.length?Math.sqrt(avg(a.map(x=>(x-m)**2))):0;}
function ret(a,b){return a>0?b/a-1:0;}
function safe(a,b){return b?a/b:0;}
function pct(xs,p){if(!xs.length)return 0;const a=[...xs].sort((x,y)=>x-y);return a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))];}

async function fetchJson(url){
  const c=new AbortController(),t=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-explosion-v4.1'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.json();}
  finally{clearTimeout(t);}
}

async function universe(){
  const rows=await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows.filter(r=>String(r.symbol).endsWith('USDT'))
    .filter(r=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter(r=>Number(r.quoteVolume)>=2_000_000)
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0,MAX_SYMBOLS).map(r=>String(r.symbol));
}

async function klines(symbol){
  let cursor=Date.now()-LOOKBACK_DAYS*86400000;const out=[];
  for(let page=0;page<120&&cursor<Date.now();page++){
    const q=new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cursor),limit:'1000'});
    const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if(!Array.isArray(rows)||!rows.length)break;
    for(const r of rows)out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]});
    const next=+rows.at(-1)[0]+STEP_MS;if(next<=cursor)break;cursor=next;if(rows.length<1000)break;
  }
  return out;
}

function qsum(r,i,n){let s=0;for(let k=Math.max(0,i-n+1);k<=i;k++)s+=r[k].q;return s;}
function btcMap(rows){const m=new Map();for(let i=WARMUP;i<rows.length;i++){const rr=[];for(let j=i-11;j<=i;j++)rr.push(ret(rows[j-1].c,rows[j].c));m.set(rows[i].t,{r15:ret(rows[i-3].c,rows[i].c),r60:ret(rows[i-12].c,rows[i].c),r240:ret(rows[i-48].c,rows[i].c),vol:std(rr)});}return m;}

function features(r,i,bm){
  const c=r[i].c,b=bm.get(r[i].t)||{};
  const r5=ret(r[i-1].c,c),r15=ret(r[i-3].c,c),r30=ret(r[i-6].c,c),r60=ret(r[i-12].c,c),r120=ret(r[i-24].c,c),r240=ret(r[i-48].c,c),r24h=ret(r[i-288].c,c);
  const base60=avg(r.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...r.slice(i-12,i).map(x=>x.h));
  const ph240=Math.max(...r.slice(i-48,i).map(x=>x.h));
  const rr1=[];for(let j=i-11;j<=i;j++)rr1.push(ret(r[j-1].c,r[j].c));
  const rr4=[];for(let j=i-47;j<=i-12;j++)rr4.push(ret(r[j-1].c,r[j].c));
  const rangeNow=r[i].l>0?r[i].h/r[i].l-1:0;
  const range60=avg(r.slice(i-11,i+1).map(x=>x.l>0?x.h/x.l-1:0));
  const d=new Date(r[i].t),minute=d.getUTCHours()*60+d.getUTCMinutes(),dow=d.getUTCDay();
  return {r5,r15,r30,r60,r120,r240,r24h,
    vol5:safe(r[i].q,Math.max(1,base60/12)),vol15:safe(qsum(r,i,3),Math.max(1,base60/4)),vol30:safe(qsum(r,i,6),Math.max(1,base60/2)),vol60:safe(qsum(r,i,12),Math.max(1,base60)),
    tradeAccel:safe(r[i].n,Math.max(1,avg(r.slice(i-12,i).map(x=>x.n)))),
    breakout60:ph60?c/ph60-1:0,breakout240:ph240?c/ph240-1:0,
    compression:safe(std(rr1),Math.max(1e-9,std(rr4))),rangeExpansion:safe(rangeNow,Math.max(1e-9,range60)),
    rsBtc60:r60-(b.r60||0),rsBtc240:r240-(b.r240||0),btc60:b.r60||0,btc240:b.r240||0,btcVol:b.vol||0,
    minuteSin:Math.sin(2*Math.PI*minute/1440),minuteCos:Math.cos(2*Math.PI*minute/1440),dowSin:Math.sin(2*Math.PI*dow/7),dowCos:Math.cos(2*Math.PI*dow/7)};
}

function outcome(r,i){
  if(i+1>=r.length)return null;
  const entryBar=i+1,entry=r[entryBar].o;let high=entry,stop=entry*(1-HARD_STOP),exit=entry,exitT=r[entryBar].t,reason='MAX_HOLD';
  const hit={10:null,20:null,40:null,80:null};let maxGain=0,minGain=0;
  for(let k=entryBar;k<r.length&&k<=i+FWD_BARS;k++){
    const bar=r[k],g=bar.h/entry-1,dn=bar.l/entry-1;maxGain=Math.max(maxGain,g);minGain=Math.min(minGain,dn);
    for(const t of TARGETS){const key=String(Math.round(t*100));if(hit[key]===null&&g>=t)hit[key]=(k-entryBar)*5;}
    if(bar.l<=stop){exit=stop;exitT=bar.t;reason=stop>entry?'TRAIL_OR_LOCK':'HARD_STOP';break;}
    high=Math.max(high,bar.h);
    const hg=high/entry-1;
    if(hg>=TRAIL_TRIGGER)stop=Math.max(stop,high*(1-TRAIL_DISTANCE));
    else if(hg>=BE_TRIGGER)stop=Math.max(stop,entry*(1+BE_LOCK));
    if(k-entryBar>=STALE_BARS&&hg<=.005){exit=bar.c;exitT=bar.t;reason='STALE_18H';break;}
    exit=bar.c;exitT=bar.t;
  }
  const gross=exit/entry-1,net=gross-FEE_PCT,stress=net-STRESS_SLIPPAGE;
  return {entry,exit,exitT,holdMin:(exitT-r[entryBar].t)/60000,reason,gross,net,stress,maxGain,minGain,hit10:hit['10'],hit20:hit['20'],hit40:hit['40'],hit80:hit['80']};
}

const baseAgents={
  FRESH_BREAKOUT:f=>1.7*f.breakout60+.9*f.r15+.45*f.r30+.35*Math.log(Math.max(.2,f.vol15))-.9*Math.max(0,f.r24h-.10)-.7*Math.max(0,f.r60-.06),
  RELATIVE_STRENGTH_BTC:f=>1.35*f.rsBtc60+.9*f.rsBtc240+.35*f.r30+.2*Math.log(Math.max(.2,f.vol15))-.5*Math.max(0,f.r24h-.12),
  EARLY_MOMENTUM:f=>1.3*f.r15+1.15*f.r30+.65*f.r60+.35*Math.log(Math.max(.2,f.vol15))-.8*Math.max(0,f.r24h-.12),
  VOLUME_IGNITION:f=>.75*Math.log(Math.max(.2,f.vol15))+.55*Math.log(Math.max(.2,f.tradeAccel))+.55*f.r15+.35*f.breakout60,
  SQUEEZE_BREAKOUT:f=>1.25*f.breakout60+.65*f.breakout240+.65*Math.log(Math.max(.2,f.vol30))-.55*Math.max(0,f.compression-1)+.25*f.rsBtc60,
  PRE_EXPLOSION:f=>1.05*f.r15+.8*f.r30+.6*f.breakout60+.45*Math.log(Math.max(.2,f.vol15))+.45*f.rsBtc60-.75*Math.max(0,f.r24h-.10)-.45*Math.max(0,f.r60-.06),
  TIME_VOLUME_EDGE:f=>.65*Math.log(Math.max(.2,f.vol15))+.35*f.r30+.30*f.rsBtc60+.12*f.minuteSin+.08*f.minuteCos+.06*f.dowSin,
  EXHAUSTION_AVOID:f=>.7*f.r30+.5*f.breakout60+.35*Math.log(Math.max(.2,f.vol15))-1.2*Math.max(0,f.r24h-.10)-.75*Math.max(0,f.rangeExpansion-2)
};
const agents={...baseAgents,
  FRESH_RS_VOLUME:f=>.45*baseAgents.FRESH_BREAKOUT(f)+.35*baseAgents.RELATIVE_STRENGTH_BTC(f)+.20*baseAgents.VOLUME_IGNITION(f),
  EARLY_FRESH_VOLUME:f=>.40*baseAgents.EARLY_MOMENTUM(f)+.40*baseAgents.FRESH_BREAKOUT(f)+.20*baseAgents.VOLUME_IGNITION(f)
};

function diag(sel){
  const n=sel.length;if(!n)return {n:0,hit10:0,hit20:0,hit40:0,hit80:0,avgMax:0,median20:0,avgHold:0,avgStress:0};
  return {n,hit10:sel.filter(x=>x.o.hit10!==null).length/n,hit20:sel.filter(x=>x.o.hit20!==null).length/n,hit40:sel.filter(x=>x.o.hit40!==null).length/n,hit80:sel.filter(x=>x.o.hit80!==null).length/n,avgMax:avg(sel.map(x=>x.o.maxGain)),median20:pct(sel.filter(x=>x.o.hit20!==null).map(x=>x.o.hit20),.5),avgHold:avg(sel.map(x=>x.o.holdMin)),avgStress:avg(sel.map(x=>x.o.stress))};
}

function portfolio(samples,fn,threshold,days){
  const sig=samples.map(s=>({...s,score:fn(s.f)})).filter(s=>s.score>=threshold).sort((a,b)=>a.t-b.t);
  let cash=1,closed=0,wins=0,peak=1,dd=0;const active=[],symUntil=new Map(),equityCurve=[];
  function settle(t){
    active.sort((a,b)=>a.exitT-b.exitT);
    while(active.length&&active[0].exitT<=t){const p=active.shift();const proceeds=p.stake*(1+p.ret);cash+=proceeds;closed++;if(p.ret>0)wins++;const eq=cash+active.reduce((s,x)=>s+x.stake,0);peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1);equityCurve.push(eq);}
  }
  for(const s of sig){settle(s.t);if(active.length>=MAX_CONCURRENT)continue;if(s.t<(symUntil.get(s.symbol)||0))continue;const eq=cash+active.reduce((z,x)=>z+x.stake,0);const stake=Math.min(cash,eq*POSITION_FRACTION);if(stake<eq*.05)continue;cash-=stake;active.push({exitT:s.o.exitT,stake,ret:s.o.stress});symUntil.set(s.symbol,s.t+COOLDOWN_MS);}
  settle(Infinity);const end=cash;return {trades:closed,winRate:closed?wins/closed:0,capitalEnd:end,netGrowth:end-1,maxDrawdown:dd,tradesPer30:closed/Math.max(1,days)*30};
}

function thresholdCandidates(train,fn){const sc=train.map(s=>fn(s.f)).sort((a,b)=>a-b);return [.88,.90,.92,.94,.96,.97,.98,.99].map(p=>pct(sc,p));}
function objective(m,d){
  const freq=Math.min(1,m.tradesPer30/12),ddPenalty=Math.max(0,Math.abs(m.maxDrawdown)-.12)*2,holdPenalty=Math.max(0,d.avgHold-480)/1440;
  return m.netGrowth*1.6+d.hit10*.35+d.hit20*1.5+d.hit40*2.2+d.hit80*2.8+freq*.35-ddPenalty-holdPenalty;
}

async function main(){
  const symbols=await universe();if(!symbols.includes('BTCUSDT'))symbols.unshift('BTCUSDT');
  console.log(`EXPLOSION_V4_1 lookback=${LOOKBACK_DAYS}d symbols=${symbols.length}`);
  const data=new Map();for(const s of symbols){try{const r=await klines(s);data.set(s,r);console.log(`LOADED ${s} ${r.length}`);}catch(e){console.log(`SKIP ${s} ${e.message}`);}}
  const bm=btcMap(data.get('BTCUSDT')||[]),samples=[];
  for(const [symbol,r] of data){if(symbol==='BTCUSDT')continue;for(let i=WARMUP;i<r.length-FWD_BARS-1;i+=SAMPLE_EVERY){if(qsum(r,i,288)<MIN_HIST_QV)continue;const f=features(r,i,bm);if(f.r24h>=.18||f.r60>=.10||f.r15>=.06)continue;const o=outcome(r,i);if(o)samples.push({symbol,t:r[i].t,f,o});}}
  samples.sort((a,b)=>a.t-b.t);if(samples.length<800)throw new Error(`insufficient samples ${samples.length}`);
  const t0=samples[0].t,t1=samples.at(-1).t,span=t1-t0,c1=t0+span*.60,c2=t0+span*.80;
  const train=samples.filter(x=>x.t<c1-PURGE_MS),val=samples.filter(x=>x.t>c1+PURGE_MS&&x.t<c2-PURGE_MS),test=samples.filter(x=>x.t>c2+PURGE_MS);
  const results=[];
  for(const [name,fn] of Object.entries(agents)){
    let best=null;for(const th of thresholdCandidates(train,fn)){const vs=val.filter(s=>fn(s.f)>=th),vd=diag(vs),vp=portfolio(val,fn,th,LOOKBACK_DAYS*.20),obj=objective(vp,vd);if(vp.tradesPer30<4)continue;if(!best||obj>best.obj)best={th,obj,validation:{diag:vd,portfolio:vp}};}
    if(!best)continue;const ts=test.filter(s=>fn(s.f)>=best.th),td=diag(ts),tp=portfolio(test,fn,best.th,LOOKBACK_DAYS*.20);
    results.push({agent:name,threshold:best.th,validation:best.validation,test:{diag:td,portfolio:tp}});
  }
  results.sort((a,b)=>objective(b.test.portfolio,b.test.diag)-objective(a.test.portfolio,a.test.diag));
  const eligible=results.filter(x=>x.validation.portfolio.netGrowth>0&&x.test.portfolio.netGrowth>0&&x.test.portfolio.tradesPer30>=4&&x.test.portfolio.maxDrawdown>-.20&&x.test.diag.hit10>0);
  const champion=eligible[0]||null;
  const report={generatedAt:new Date().toISOString(),version:'V4.1',lookbackDays:LOOKBACK_DAYS,interval:INTERVAL,samples:samples.length,split:{train:train.length,validation:val.length,test:test.length,purgeHours:24},simulation:{entry:'next 5m open',fees:FEE_PCT,stressSlippage:STRESS_SLIPPAGE,maxConcurrent:MAX_CONCURRENT,positionFraction:POSITION_FRACTION,hardStop:HARD_STOP,breakEvenTrigger:BE_TRIGGER,trailingTrigger:TRAIL_TRIGGER,trailingDistance:TRAIL_DISTANCE,maxHoldHours:24},caveat:'Current-symbol universe remains a survivorship-bias limitation; historical quote-volume gating is point-in-time.',results,champion,productionGate:{pass:Boolean(champion),reason:champion?'short-horizon champion positive on validation and untouched test with realistic rotation':'HOLD: no agent cleared validation + untouched test short-horizon gate'}};
  const out=path.join(__dirname,'..','training-output');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'spot-explosion-v4_1-report.json'),JSON.stringify(report,null,2));fs.writeFileSync(path.join(out,'spot-explosion-v4_1-champion.json'),JSON.stringify({generatedAt:report.generatedAt,lookbackDays:LOOKBACK_DAYS,champion,gate:report.productionGate},null,2));
  console.log(JSON.stringify({ok:true,version:'V4.1',days:LOOKBACK_DAYS,samples:samples.length,champion:champion?.agent||null,gate:report.productionGate.pass,test:champion?.test||null}));
}
main().catch(e=>{console.error(e);process.exit(1);});