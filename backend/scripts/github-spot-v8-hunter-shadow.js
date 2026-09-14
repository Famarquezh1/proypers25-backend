'use strict';

const fs = require('fs');
const BASE = 'https://data-api.binance.vision';
const STEP_MS = 5 * 60 * 1000;
const WARM = 288;
const MIN_QV = 200000;
const DETAIL_LIMIT = 60;
const MAX_SIGNALS = 2;
const MAX_MODEL_AGE_MS = 48 * 60 * 60 * 1000;

function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:0;}
function std(a){const m=avg(a);return a.length?Math.sqrt(avg(a.map(x=>(x-m)**2))):0;}
function ret(a,b){return a>0?b/a-1:0;}
function clamp(v,a=-5,b=5){return Math.max(a,Math.min(b,Number(v)||0));}
function sigmoid(z){if(z>30)return 1;if(z<-30)return 0;return 1/(1+Math.exp(-z));}
function qsum(r,i,n){let s=0;for(let k=Math.max(0,i-n+1);k<=i;k++)s+=r[k].q;return s;}

async function fetchJson(url){
  const c=new AbortController();const tm=setTimeout(()=>c.abort(),18000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-v8-hunter-shadow/1.0'}});if(!r.ok)throw new Error(`HTTP ${r.status}`);return await r.json();}
  finally{clearTimeout(tm);}
}

async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let p=0;
  async function worker(){while(true){const i=p++;if(i>=items.length)return;try{out[i]=await fn(items[i],i);}catch(e){out[i]={__error:e.message,item:items[i]};}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},()=>worker()));return out;
}

async function recentKlines(symbol,endTime){
  const q=new URLSearchParams({symbol,interval:'5m',endTime:String(endTime),limit:'320'});
  const rows=await fetchJson(`${BASE}/api/v3/klines?${q}`);
  return (rows||[]).map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]}));
}

function activeUniverse(exchangeInfo,tickers){
  const active=new Set((exchangeInfo.symbols||[])
    .filter(s=>s.status==='TRADING'&&s.quoteAsset==='USDT'&&s.isSpotTradingAllowed!==false)
    .filter(s=>!Array.isArray(s.permissions)||!s.permissions.length||s.permissions.includes('SPOT'))
    .map(s=>s.symbol));
  const pool=tickers
    .filter(x=>active.has(String(x.symbol||'')))
    .filter(x=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(x.symbol||'')))
    .filter(x=>Number(x.quoteVolume||0)>=MIN_QV)
    .filter(x=>Number(x.priceChangePercent||0)>-6&&Number(x.priceChangePercent||0)<14);
  const selected=[];const seen=new Set();
  function take(rows,n){for(const x of rows.slice(0,n)){const s=String(x.symbol);if(seen.has(s))continue;seen.add(s);selected.push(s);if(selected.length>=DETAIL_LIMIT)break;}}
  take([...pool].sort((a,b)=>Number(b.quoteVolume||0)-Number(a.quoteVolume||0)),25);
  take([...pool].sort((a,b)=>Number(b.priceChangePercent||0)-Number(a.priceChangePercent||0)),20);
  take([...pool].sort((a,b)=>Number(b.count||0)-Number(a.count||0)),20);
  if(!seen.has('BTCUSDT'))selected.push('BTCUSDT');
  return {activeCount:active.size,poolCount:pool.length,symbols:selected.slice(0,DETAIL_LIMIT+(selected.includes('BTCUSDT')?1:0))};
}

function btcMap(rows){
  const m=new Map();
  for(let i=48;i<rows.length;i++)m.set(rows[i].t,{r60:ret(rows[i-12].c,rows[i].c),r240:ret(rows[i-48].c,rows[i].c)});
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
  return {r5,r15,r30,r60,r240,r24,
    logVol15:Math.log(Math.max(.2,vol15)),logVol30:Math.log(Math.max(.2,vol30)),logTradeAccel:Math.log(Math.max(.2,tradeAccel)),
    breakout60:ph60>0?c/ph60-1:0,breakout240:ph240>0?c/ph240-1:0,
    rs60:r60-b.r60,rs240:r240-b.r240,compression:std(rr4)>0?std(rr1)/std(rr4):1,
    btc60:b.r60,btc240:b.r240,qv24:qsum(rows,i,288)};
}

function candidate(f){
  if(f.qv24<MIN_QV)return false;
  if(f.r24<=-0.06||f.r24>=0.14||f.r60>=0.085||f.r15>=0.05)return false;
  return f.r15>0.0015||f.breakout60>-0.001||f.logVol15>Math.log(1.15)||f.logTradeAccel>Math.log(1.12)||f.rs60>0.002;
}

function loadModel(path){
  const x=JSON.parse(fs.readFileSync(path,'utf8'));
  if(x.version!=='V8_HUNTER_SHADOW_MODEL_V1')throw new Error(`unexpected model ${x.version||'unknown'}`);
  if(Date.now()-Date.parse(x.generatedAt)>MAX_MODEL_AGE_MS)throw new Error(`stale V8 hunter model ${x.generatedAt}`);
  if(!Array.isArray(x.model?.featureNames)||!Array.isArray(x.model?.mu)||!Array.isArray(x.model?.sd)||!Array.isArray(x.model?.w))throw new Error('invalid V8 hunter model');
  return x;
}

function predict(f,m){
  const x=m.featureNames.map(k=>clamp(k==='compression'?Math.log(Math.max(.2,f[k])):f[k],-4,4));
  const z=x.reduce((s,v,j)=>s+m.w[j+1]*clamp((v-m.mu[j])/(m.sd[j]||1),-5,5),m.w[0]);
  return sigmoid(z);
}

async function main(){
  const modelPath=process.argv[2]||'spot-v8-hunter-shadow-model.json';
  const outputPath=process.argv[3]||'spot-v8-hunter-shadow-evidence.json';
  const model=loadModel(modelPath);
  const [ei,tickers]=await Promise.all([fetchJson(`${BASE}/api/v3/exchangeInfo`),fetchJson(`${BASE}/api/v3/ticker/24hr`)]);
  const u=activeUniverse(ei,tickers);
  const bucketStart=Math.floor(Date.now()/STEP_MS)*STEP_MS;
  const endTime=bucketStart-1;
  const loaded=await mapLimit(u.symbols,10,async symbol=>({symbol,rows:await recentKlines(symbol,endTime)}));
  const data=new Map();const errors=[];
  for(const x of loaded){if(x?.__error)errors.push({symbol:x.item,error:x.__error});else if(x?.rows?.length>=WARM+1)data.set(x.symbol,x.rows);}
  const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTCUSDT recent context unavailable');const bm=btcMap(btc);
  const scored=[];
  for(const [symbol,rows] of data){
    if(symbol==='BTCUSDT')continue;
    const i=rows.length-1;if(i<WARM)continue;
    const f=feature(rows,i,bm);if(!candidate(f))continue;
    const p=predict(f,model.model);
    scored.push({symbol,p,f,bar:rows[i]});
  }
  const qualified=scored.filter(x=>x.p>=model.threshold).sort((a,b)=>b.p-a.p).slice(0,MAX_SIGNALS);
  const v42Notify=String(process.env.V42_NOTIFY||'false')==='true';
  const v42Symbol=String(process.env.V42_SYMBOL||'').toUpperCase();
  const signals=qualified.map(x=>({
    symbol:x.symbol,cohort:v42Notify&&x.symbol===v42Symbol?'BOTH':'V8_ONLY',
    decisionBarTime:new Date(x.bar.t).toISOString(),referenceClose:x.bar.c,
    probability:Number(x.p.toFixed(6)),threshold:model.threshold,
    features:{r5:Number(x.f.r5.toFixed(6)),r15:Number(x.f.r15.toFixed(6)),r30:Number(x.f.r30.toFixed(6)),r60:Number(x.f.r60.toFixed(6)),r24:Number(x.f.r24.toFixed(6)),vol15:Number(Math.exp(x.f.logVol15).toFixed(4)),tradeAccel:Number(Math.exp(x.f.logTradeAccel).toFixed(4)),breakout60:Number(x.f.breakout60.toFixed(6)),rs60:Number(x.f.rs60.toFixed(6)),qv24:Number(x.f.qv24.toFixed(2))},
    evaluationPlan:{entry:'NEXT_5M_OPEN',takeProfit:0.03,stopLoss:0.012,horizonMinutes:180,roundtripCost:0.0025}
  }));
  const evidence={
    ok:true,mode:'V8_HUNTER_INDEPENDENT_SHADOW',decisionInfluence:false,productionAction:'NONE',generatedAt:new Date().toISOString(),
    model:{generatedAt:model.generatedAt,threshold:model.threshold,calibration:model.calibration},
    universe:{activeSpotUsdt:u.activeCount,stage1Pool:u.poolCount,detailedRequested:u.symbols.length,detailedLoaded:data.size,errors:errors.length},
    v42AtSameRun:{notify:v42Notify,symbol:v42Symbol||null},eligibleInstant:scored.length,signalCount:signals.length,signals
  };
  fs.writeFileSync(outputPath,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify(evidence));
}

main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
