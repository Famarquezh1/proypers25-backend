'use strict';

const fs=require('fs');
const path=require('path');
const vm=require('vm');
const {predict}=require('./qpu-v04-bidirectional-frozen-predict');

const BASE_PATH=path.join(__dirname,'github-spot-causal-opportunity-v7_2-robust.js');
const OUT=process.env.QPU_V04_LIVE_OUT||'qpu-v04-bidirectional-live-shadow.ndjson';
const DEFAULT='BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,LTCUSDT,FETUSDT,HBARUSDT,SEIUSDT,WIFUSDT,PEPEUSDT,RAYUSDT,CRVUSDT,LDOUSDT,RENDERUSDT,ARUSDT';
const SYMBOLS=String(process.env.QPU_V04_SYMBOLS||DEFAULT).split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,40);
const REST=['https://api.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com'];

function loadFeatureLib(){
  let src=fs.readFileSync(BASE_PATH,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__qpuLive={v,WARM,STEP,MIN_QV,contiguous};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:BASE_PATH});
  vm.runInContext(src,c,{filename:BASE_PATH});
  return c.__qpuLive;
}

function productionV42(f={}){
  const clamp01=v=>Math.max(0,Math.min(1,Number(v)||0));
  const logSafe=v=>Math.log(Math.max(.2,Number(v)||.2));
  const ignition=.9*logSafe(f.vol15)+.65*logSafe(f.tradeAccel)+.65*Number(f.r15||0)+.35*Number(f.breakout60||0);
  const confirm=1.2*Number(f.breakout60||0)+.65*Number(f.rs60||0)+.35*logSafe(f.vol30)-.8*Math.max(0,Number(f.r24||0)-.10)-.5*Math.max(0,Number(f.r60||0)-.06);
  const extension=1.15*Number(f.rs60||0)+.75*Number(f.rs240||0)+.35*Number(f.r30||0)+.25*Number(f.breakout240||0)-.45*Math.max(0,Number(f.r24||0)-.12);
  const freshEnough=Number(f.r24||0)<.18&&Number(f.r60||0)<.10&&Number(f.r15||0)<.06;
  const th=[
    {i:.904010256302157,c:.30262335308700017,e:.0333071863419859},
    {i:.7912647052581232,c:.36672756172128707,e:.029510140018270917},
    {i:1.6626658194027173,c:.43305908219072103,e:.019614079751271593}
  ];
  const pass=freshEnough?th.filter(x=>ignition>=x.i&&confirm>=x.c&&extension>=x.e).length:0;
  const mid=th[1];
  const ignitionMargin=clamp01(.5+(ignition-mid.i)/2);
  const confirmMargin=clamp01(.5+(confirm-mid.c)/.8);
  const extensionMargin=clamp01(.5+(extension-mid.e)/.12);
  const norm=freshEnough?clamp01((pass/3)*.55+ignitionMargin*.20+confirmMargin*.15+extensionMargin*.10):0;
  return {pass,norm,freshEnough,detail:{ignition,confirm,extension}};
}

function productionEligible(f,p){
  const d=p.detail||{},pct=Number(f.r24||0)*100;
  const high=p.pass===3&&p.norm>=.94;
  const early=p.pass===2&&p.freshEnough===true&&p.norm>=.82&&pct>=1.5&&pct<8&&d.ignition>=1&&d.confirm>=.28&&d.extension>=.015&&Number(f.r15)>0&&Number(f.r15)<=.04&&Number(f.r60)>0&&Number(f.r60)<=.08;
  return high||early;
}

async function getKlines(symbol){
  let last;
  for(const base of REST){
    try{
      const u=new URL(base+'/api/v3/klines');u.searchParams.set('symbol',symbol);u.searchParams.set('interval','5m');u.searchParams.set('limit','400');
      const r=await fetch(u,{headers:{'User-Agent':'Proypers25-QPU-v04-Shadow/1.0'}});
      if(!r.ok){last=new Error(symbol+' HTTP_'+r.status);continue}
      const a=await r.json();if(!Array.isArray(a)||!a.length)throw new Error(symbol+' empty');
      const now=Date.now();
      return a.filter(x=>Number(x[6])<now).map(x=>({t:Number(x[0]),o:Number(x[1]),h:Number(x[2]),l:Number(x[3]),c:Number(x[4]),q:Number(x[7]),n:Number(x[8])}));
    }catch(e){last=e}
  }
  throw last||new Error(symbol+' unavailable');
}

function stateRow(symbol,t,f,bd,rw,p){
  return {
    timestamp:new Date(t).toISOString(),symbol,
    r5:Number(f.r5||0),r15:Number(f.r15||0),r30:Number(f.r30||0),r60:Number(f.r60||0),r240:Number(f.r240||0),r24:Number(f.r24||0),
    vol15:Number(f.vol15||0),vol30:Number(f.vol30||0),trade_accel:Number(f.tradeAccel||0),
    breakout60:Number(f.breakout60||0),breakout240:Number(f.breakout240||0),rs60:Number(f.rs60||0),rs240:Number(f.rs240||0),
    ignition:Number(p.detail?.ignition||0),confirm:Number(p.detail?.confirm||0),extension:Number(p.detail?.extension||0),
    fresh_enough:p.freshEnough===true,v42_pass:Number(p.pass||0),v42_norm:Number(p.norm||0),
    breadth_up15:Number(bd.up15||0),breadth_up60:Number(bd.up60||0),breadth_breakout:Number(bd.breakout||0),breadth_ignite:Number(bd.ignite||0),breadth_mean60:Number(bd.mean60||0),
    regime_trend_up:Number(rw.TREND_UP||0),regime_volatile:Number(rw.VOLATILE||0),regime_risk_off:Number(rw.RISK_OFF||0)
  };
}

(async()=>{
  const lib=loadFeatureLib(),{v,WARM,STEP,contiguous}=lib;
  const data=new Map(),errors=[];
  for(const s of SYMBOLS){try{data.set(s,await getKlines(s))}catch(e){errors.push({symbol:s,error:String(e.message||e)})}}
  if(!data.has('BTCUSDT'))throw new Error('BTCUSDT unavailable');
  const target=Math.floor(Date.now()/STEP)*STEP-STEP;
  const btc=data.get('BTCUSDT'),bm=v.btcMap(btc);
  const feats=[];
  for(const [symbol,series] of data){
    if(symbol==='BTCUSDT')continue;
    const i=series.findIndex(x=>x.t===target);
    if(i<WARM||!contiguous(series,i))continue;
    try{const f=v.feat(series,i,bm);if(Number.isFinite(f.qv))feats.push({symbol,t:target,f})}catch{}
  }
  if(!feats.length)throw new Error('No compatible current feature rows');
  const bd={
    up15:feats.filter(s=>s.f.r15>0).length/feats.length,
    up60:feats.filter(s=>s.f.r60>0).length/feats.length,
    breakout:feats.filter(s=>s.f.breakout60>0).length/feats.length,
    ignite:feats.filter(s=>s.f.vol15>1.2).length/feats.length,
    mean60:feats.reduce((a,s)=>a+Number(s.f.r60||0),0)/feats.length
  };
  const rows=[];
  for(const s of feats){
    const p=productionV42(s.f),rw=v.regimeWeights(s.f,bd),state=stateRow(s.symbol,s.t,s.f,bd,rw,p);
    const pred=predict(state);
    rows.push({type:'qpu_v04_bidirectional_shadow',shadow_only:true,no_order_created:true,at:Date.now(),eligible_v42:productionEligible(s.f,p),...state,...pred});
  }
  rows.sort((a,b)=>b.continuation_probability-a.continuation_probability);
  fs.writeFileSync(OUT,rows.map(x=>JSON.stringify(x)).join('\n')+'\n','utf8');
  console.log(JSON.stringify({ok:true,shadow_only:true,no_order_created:true,target:new Date(target).toISOString(),symbols_requested:SYMBOLS.length,symbols_loaded:data.size,scored:rows.length,errors,top:rows.slice(0,5).map(x=>({symbol:x.symbol,eligible_v42:x.eligible_v42,qpu_decision:x.qpu_decision,continuation_probability:x.continuation_probability,plus10_probability:x.plus10_probability,prediction_elapsed_ms:x.prediction_elapsed_ms}))},null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
