'use strict';

const fs = require('fs');

const BASE = 'https://data-api.binance.vision';
const STEP_MS = 5 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TRAIN_DAYS = 7;
const EVAL_DAYS = Math.max(3, Math.min(7, Number(process.env.V8_EVAL_DAYS || 7)));
const MAX_SYMBOLS = Math.max(20, Math.min(60, Number(process.env.V8_MAX_SYMBOLS || 40)));
const MIN_QV = Math.max(100000, Number(process.env.V8_MIN_QV || 200000));
const COST = Math.max(0.0015, Number(process.env.V8_ROUNDTRIP_COST || 0.0025));
const TP = 0.03;
const SL = 0.012;
const HOLD_BARS = 36; // 3h on 5m bars
const WARM = 288;
const COOLDOWN_MS = 2 * 60 * 60 * 1000;
const THRESHOLDS = [0.52, 0.56, 0.60, 0.64, 0.68, 0.72];
const FEATURE_NAMES = ['r5','r15','r30','r60','r240','r24','logVol15','logVol30','logTradeAccel','breakout60','breakout240','rs60','rs240','compression','btc60','btc240'];

function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function std(a){const m=avg(a);return a.length?Math.sqrt(avg(a.map(x=>(x-m)**2))):0;}
function ret(a,b){return a>0?b/a-1:0;}
function clamp(v,a=-5,b=5){return Math.max(a,Math.min(b,Number(v)||0));}
function sigmoid(z){if(z>30)return 1;if(z<-30)return 0;return 1/(1+Math.exp(-z));}
function qsum(r,i,n){let s=0;for(let k=Math.max(0,i-n+1);k<=i;k++)s+=r[k].q;return s;}
function utcDay(t){return Math.floor(t/DAY_MS)*DAY_MS;}
function isoDay(t){return new Date(t).toISOString().slice(0,10);}

async function fetchJson(url){
  const c=new AbortController();const tm=setTimeout(()=>c.abort(),25000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-instant-v8/1.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}
  finally{clearTimeout(tm);}
}

async function universe(){
  const [ei,tickers]=await Promise.all([
    fetchJson(`${BASE}/api/v3/exchangeInfo`),
    fetchJson(`${BASE}/api/v3/ticker/24hr`)
  ]);
  const active=new Set((ei.symbols||[])
    .filter(s=>s.status==='TRADING'&&s.quoteAsset==='USDT'&&s.isSpotTradingAllowed!==false)
    .filter(s=>!Array.isArray(s.permissions)||!s.permissions.length||s.permissions.includes('SPOT'))
    .map(s=>s.symbol));
  const ranked=tickers
    .filter(x=>active.has(String(x.symbol||'')))
    .filter(x=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(x.symbol||'')))
    .filter(x=>Number(x.quoteVolume||0)>=MIN_QV)
    .sort((a,b)=>Number(b.quoteVolume||0)-Number(a.quoteVolume||0))
    .slice(0,MAX_SYMBOLS)
    .map(x=>String(x.symbol));
  if(!ranked.includes('BTCUSDT')) ranked.unshift('BTCUSDT');
  return ranked;
}

async function klines(symbol,start,end){
  let cursor=start;const out=[];
  for(let page=0;page<20&&cursor<end;page++){
    const q=new URLSearchParams({symbol,interval:'5m',startTime:String(cursor),endTime:String(end),limit:'1000'});
    const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if(!Array.isArray(rows)||!rows.length)break;
    for(const r of rows)out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]});
    const next=+rows.at(-1)[0]+STEP_MS;if(next<=cursor)break;cursor=next;if(rows.length<1000)break;
  }
  return out;
}

async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let p=0;
  async function w(){while(true){const i=p++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={__error:e.message,item:items[i]};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>w()));return out;
}

function btcMap(rows){
  const m=new Map();
  for(let i=WARM;i<rows.length;i++)m.set(rows[i].t,{r60:ret(rows[i-12].c,rows[i].c),r240:ret(rows[i-48].c,rows[i].c)});
  return m;
}

function feature(rows,i,bm){
  const c=rows[i].c,b=bm.get(rows[i].t)||{r60:0,r240:0};
  const r5=ret(rows[i-1].c,c),r15=ret(rows[i-3].c,c),r30=ret(rows[i-6].c,c),r60=ret(rows[i-12].c,c),r240=ret(rows[i-48].c,c),r24=ret(rows[i-288].c,c);
  const base=avg(rows.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...rows.slice(i-12,i).map(x=>x.h));
  const ph240=Math.max(...rows.slice(i-48,i).map(x=>x.h));
  const rr1=[];for(let j=i-11;j<=i;j++)rr1.push(ret(rows[j-1].c,rows[j].c));
  const rr4=[];for(let j=i-47;j<=i-12;j++)rr4.push(ret(rows[j-1].c,rows[j].c));
  const vol15=base>0?qsum(rows,i,3)/(base/4):1;
  const vol30=base>0?qsum(rows,i,6)/(base/2):1;
  const tradeAccel=rows[i].n/Math.max(1,avg(rows.slice(i-12,i).map(x=>x.n)));
  return {
    r5,r15,r30,r60,r240,r24,
    logVol15:Math.log(Math.max(.2,vol15)),
    logVol30:Math.log(Math.max(.2,vol30)),
    logTradeAccel:Math.log(Math.max(.2,tradeAccel)),
    breakout60:ph60>0?c/ph60-1:0,
    breakout240:ph240>0?c/ph240-1:0,
    rs60:r60-b.r60,rs240:r240-b.r240,
    compression:std(rr4)>0?std(rr1)/std(rr4):1,
    btc60:b.r60,btc240:b.r240,
    qv24:qsum(rows,i,288)
  };
}

function simulate(rows,i){
  const e=i+1;if(e>=rows.length)return null;const entry=rows[e].o;if(!(entry>0))return null;
  const stop=entry*(1-SL),tp=entry*(1+TP);let gross=0,reason='TIMEOUT',exitT=rows[Math.min(rows.length-1,e+HOLD_BARS)].t;
  for(let k=e;k<rows.length&&k<=e+HOLD_BARS;k++){
    // Conservative intrabar ordering: if both are touched, count the stop first.
    if(rows[k].l<=stop){gross=-SL;reason='STOP';exitT=rows[k].t;break;}
    if(rows[k].h>=tp){gross=TP;reason='TAKE_PROFIT';exitT=rows[k].t;break;}
    if(k===Math.min(rows.length-1,e+HOLD_BARS)){gross=rows[k].c/entry-1;exitT=rows[k].t;}
  }
  const net=gross-COST;
  return {net,gross,reason,exitT,win:net>0};
}

function candidate(f){
  if(f.qv24<MIN_QV)return false;
  if(f.r24<=-0.06||f.r24>=0.14||f.r60>=0.085||f.r15>=0.05)return false;
  // Event trigger: some fresh activity must exist; avoids training on every quiet bar.
  return f.r15>0.0015||f.breakout60>-0.001||f.logVol15>Math.log(1.15)||f.logTradeAccel>Math.log(1.12)||f.rs60>0.002;
}

function vector(f){return FEATURE_NAMES.map(k=>clamp(k==='compression'?Math.log(Math.max(.2,f[k])):f[k],-4,4));}

function standardizer(rows){
  const d=FEATURE_NAMES.length,mu=Array(d).fill(0),sd=Array(d).fill(1);
  for(let j=0;j<d;j++){mu[j]=avg(rows.map(r=>r.x[j]));const s=std(rows.map(r=>r.x[j]));sd[j]=s>1e-8?s:1;}
  return {mu,sd};
}
function norm(x,s){return x.map((v,j)=>clamp((v-s.mu[j])/s.sd[j],-5,5));}

function trainLogistic(rows){
  const s=standardizer(rows),d=FEATURE_NAMES.length,w=Array(d+1).fill(0);
  const pos=rows.filter(r=>r.y===1).length,neg=rows.length-pos;
  const wp=pos?rows.length/(2*pos):1,wn=neg?rows.length/(2*neg):1;
  const lr=.035,l2=.002;
  for(let epoch=0;epoch<65;epoch++){
    const g=Array(d+1).fill(0);
    for(const r of rows){const x=norm(r.x,s);let z=w[0];for(let j=0;j<d;j++)z+=w[j+1]*x[j];const p=sigmoid(z);const wt=r.y?wp:wn;const e=(p-r.y)*wt;g[0]+=e;for(let j=0;j<d;j++)g[j+1]+=e*x[j];}
    const n=Math.max(1,rows.length);w[0]-=lr*g[0]/n;for(let j=1;j<w.length;j++)w[j]-=lr*(g[j]/n+l2*w[j]);
  }
  return {w,s,predict(x){x=norm(x,s);let z=w[0];for(let j=0;j<d;j++)z+=w[j+1]*x[j];return sigmoid(z);}};
}

function dedupeSelect(scored,threshold,maxPerTime=2){
  const byT=new Map();for(const r of scored){if(r.p<threshold)continue;if(!byT.has(r.t))byT.set(r.t,[]);byT.get(r.t).push(r);}
  const until=new Map(),out=[];
  for(const t of [...byT.keys()].sort((a,b)=>a-b)){
    const group=byT.get(t).sort((a,b)=>b.p-a.p).slice(0,maxPerTime);
    for(const r of group){if(t<(until.get(r.symbol)||0))continue;out.push(r);until.set(r.symbol,t+COOLDOWN_MS);}
  }
  return out;
}

function metrics(rows){
  const n=rows.length,w=rows.filter(r=>r.o.win).length,avgNet=avg(rows.map(r=>r.o.net));
  let equity=1,peak=1,dd=0;for(const r of rows.sort((a,b)=>a.t-b.t)){equity*=1+0.10*r.o.net;peak=Math.max(peak,equity);dd=Math.max(dd,1-equity/peak);}
  return {trades:n,wins:w,winRate:n?w/n:0,avgNet,compoundedGrowth:equity-1,maxDrawdown:dd,tp:n?rows.filter(r=>r.o.reason==='TAKE_PROFIT').length/n:0,stops:n?rows.filter(r=>r.o.reason==='STOP').length/n:0};
}

function chooseThreshold(cal,model){
  const scored=cal.map(r=>({...r,p:model.predict(r.x)}));let best=null;
  for(const th of THRESHOLDS){const sel=dedupeSelect(scored,th);const m=metrics(sel);if(m.trades<8)continue;const score=m.avgNet-.35*m.maxDrawdown+Math.min(.003,m.compoundedGrowth*.2);if(!best||score>best.score)best={threshold:th,score,metrics:m};}
  return best;
}

async function main(){
  const now=Date.now();const evalEnd=utcDay(now);const evalStart=evalEnd-EVAL_DAYS*DAY_MS;const dataStart=evalStart-(TRAIN_DAYS+2)*DAY_MS-WARM*STEP_MS;
  const symbols=await universe();console.log(`V8_UNIVERSE symbols=${symbols.length} eval=${isoDay(evalStart)}..${isoDay(evalEnd)} trainDays=${TRAIN_DAYS}`);
  const loaded=await mapLimit(symbols,8,async symbol=>({symbol,rows:await klines(symbol,dataStart,evalEnd+HOLD_BARS*STEP_MS+STEP_MS)}));
  const data=new Map();for(const x of loaded)if(x&&!x.__error&&x.rows?.length)data.set(x.symbol,x.rows);
  const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTCUSDT unavailable');const bm=btcMap(btc);
  const all=[];
  for(const [symbol,rows] of data){if(symbol==='BTCUSDT'||rows.length<WARM+HOLD_BARS+10)continue;for(let i=WARM;i<rows.length-HOLD_BARS-2;i+=3){const f=feature(rows,i,bm);if(!candidate(f))continue;const o=simulate(rows,i);if(!o)continue;all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.win?1:0});}}
  all.sort((a,b)=>a.t-b.t);console.log(`V8_SAMPLES ${all.length}`);
  const days=[];
  for(let d=evalStart;d<evalEnd;d+=DAY_MS){
    const trainStart=d-TRAIN_DAYS*DAY_MS,purge=d-HOLD_BARS*STEP_MS;
    const tr=all.filter(r=>r.t>=trainStart&&r.t<purge);const calCut=d-2*DAY_MS;const fit=tr.filter(r=>r.t<calCut),cal=tr.filter(r=>r.t>=calCut);
    const test=all.filter(r=>r.t>=d&&r.t<d+DAY_MS);
    if(fit.length<300||cal.length<80||test.length<20){days.push({day:isoDay(d),ready:false,fit:fit.length,cal:cal.length,test:test.length});continue;}
    const model=trainLogistic(fit);const choice=chooseThreshold(cal,model);
    if(!choice){days.push({day:isoDay(d),ready:false,reason:'no profitable threshold with enough calibration trades',fit:fit.length,cal:cal.length,test:test.length});continue;}
    const scored=test.map(r=>({...r,p:model.predict(r.x)}));const selected=dedupeSelect(scored,choice.threshold);const m=metrics(selected);
    const baseline=metrics(dedupeSelect(scored.map(r=>({...r,p:.999})),.5));
    days.push({day:isoDay(d),ready:true,threshold:choice.threshold,calibration:choice.metrics,test:m,baseline});
    console.log(`V8_DAY ${isoDay(d)} th=${choice.threshold} trades=${m.trades} wr=${(m.winRate*100).toFixed(1)} avgNet=${(m.avgNet*100).toFixed(3)}% growth=${(m.compoundedGrowth*100).toFixed(3)}%`);
  }
  const valid=days.filter(x=>x.ready);const agg={
    evaluatedDays:days.length,readyDays:valid.length,
    positiveDays:valid.filter(x=>x.test.compoundedGrowth>0).length,
    economicBeatDays:valid.filter(x=>x.test.compoundedGrowth>x.baseline.compoundedGrowth).length,
    totalTrades:valid.reduce((s,x)=>s+x.test.trades,0),
    avgDailyGrowth:avg(valid.map(x=>x.test.compoundedGrowth)),
    avgNetPerTrade:avg(valid.map(x=>x.test.avgNet)),
    avgWinRate:avg(valid.map(x=>x.test.winRate)),
    maxObservedDD:valid.length?Math.max(...valid.map(x=>x.test.maxDrawdown)):0
  };
  const verdict=valid.length>=4&&agg.positiveDays>=Math.ceil(valid.length*.6)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';
  const report={version:'V8_INSTANT_DECISION_WALK_FORWARD',generatedAt:new Date().toISOString(),design:{trainDays:TRAIN_DAYS,evalDays:EVAL_DAYS,tp:TP,sl:SL,holdMinutes:HOLD_BARS*5,roundtripCost:COST,decisionCadenceMinutes:5,featureNames:FEATURE_NAMES,causal:true,productionMutation:false},universe:{requested:MAX_SYMBOLS,loaded:data.size},samples:all.length,days,aggregate:agg,verdict};
  fs.writeFileSync('spot-instant-decision-v8.json',JSON.stringify(report,null,2));
  console.log(`V8_RESULT ${JSON.stringify({aggregate:agg,verdict})}`);
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
