'use strict';

/**
 * Liquidity Resilience Shadow Collector
 * Research only: public Binance Spot streams, no credentials, no orders.
 *
 * Captures depth@100ms + trade for a fixed preselected USDT universe and
 * measures net visible-book replenishment after small aggressive perturbations.
 */
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const REST_BASES = ['https://api.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com'];

const SYMBOLS = String(process.env.LR_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,LTCUSDT,FETUSDT,HBARUSDT,SEIUSDT,WIFUSDT,PEPEUSDT,RAYUSDT,CRVUSDT,LDOUSDT,RENDERUSDT,ARUSDT')
  .split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);
const RUN_MS = Math.max(60000, Number(process.env.LR_RUN_MS || 240000));
const BAND = 0.0025;                 // fixed +/-25bp
const PERTURB_MS = 1000;
const RESPONSE_MS = 5000;
// Preserve the original "strict" research definition, but also retain a broader
// observational tier so volatile/thin books are not silently discarded.
const STRICT_MIN_FRAC = 0.05, STRICT_MAX_FRAC = 0.20;
const STRICT_MAX_EPISODE_MOVE = 0.0005; // 5bp
const USABLE_MIN_FRAC = 0.02, USABLE_MAX_FRAC = 1.50;
const USABLE_MAX_EPISODE_MOVE = 0.0025; // 25bp
const OUT = process.env.LR_OUT || path.join(process.cwd(),'liquidity-resilience-shadow.ndjson');

const books = new Map(), episodes = new Map(), recent = new Map(), pendingDepth = new Map();
let out = fs.createWriteStream(OUT,{flags:'a'});

function now(){return Date.now()}
function sideDepth(book, side, lo, hi){
  let q=0;
  for(const [p,v] of book[side]){const x=+p;if(x>=lo&&x<=hi)q+=+v;}
  return q;
}
function snapshot(sym){
  const b=books.get(sym); if(!b||!b.bids||!b.asks) return null;
  const bid=Math.max(...[...b.bids.keys()].map(Number)), ask=Math.min(...[...b.asks.keys()].map(Number));
  if(!Number.isFinite(bid)||!Number.isFinite(ask))return null;
  const mid=(bid+ask)/2, lo=mid*(1-BAND), hi=mid*(1+BAND);
  return {mid,spread:(ask-bid)/mid,lo,hi,bidDepth:sideDepth(b,'bids',lo,mid),askDepth:sideDepth(b,'asks',mid,hi)};
}
function emit(x){out.write(JSON.stringify(x)+'\n')}
function complete(sym,e){
  const s=snapshot(sym); if(!s)return;
  const b=books.get(sym);
  const final=e.side==='ASK'?sideDepth(b,'asks',e.mid,e.hi):sideDepth(b,'bids',e.lo,e.mid);
  const R=(final-e.initialDepth+e.executed)/Math.max(e.executed,1e-12);
  const move=(s.mid-e.mid)/e.mid;
  const perturbationFraction=e.executed/e.initialDepth;
  const strictValid=perturbationFraction>=STRICT_MIN_FRAC&&perturbationFraction<=STRICT_MAX_FRAC&&Math.abs(move)<=STRICT_MAX_EPISODE_MOVE;
  const usable=perturbationFraction>=USABLE_MIN_FRAC&&perturbationFraction<=USABLE_MAX_FRAC&&Math.abs(move)<=USABLE_MAX_EPISODE_MOVE;
  const invalidReasons=[];
  if(perturbationFraction<USABLE_MIN_FRAC) invalidReasons.push('PERTURBATION_TOO_SMALL');
  if(perturbationFraction>USABLE_MAX_FRAC) invalidReasons.push('PERTURBATION_TOO_LARGE');
  if(Math.abs(move)>USABLE_MAX_EPISODE_MOVE) invalidReasons.push('MID_MOVE_TOO_LARGE');
  const row={type:'resilience_episode',shadow_only:true,no_order_created:true,symbol:sym,side:e.side,
    started_at:e.start,available_at:now(),mid:e.mid,spread:e.spread,initial_depth:e.initialDepth,
    executed:e.executed,perturbation_fraction:perturbationFraction,final_depth:final,R,mid_move:move,
    valid:usable,usable,strict_valid:strictValid,quality:strictValid?'STRICT':usable?'OBSERVATIONAL':'REJECTED',
    invalid_reasons:invalidReasons};
  emit(row);
  const arr=recent.get(sym)||[]; arr.push(row); while(arr.length&&arr[0].available_at<now()-120000)arr.shift(); recent.set(sym,arr);
  const asks=arr.filter(x=>x.usable&&x.side==='ASK').slice(-3), bids=arr.filter(x=>x.usable&&x.side==='BID').slice(-3);
  if(asks.length>=1&&bids.length>=1){
    const med=a=>a.map(x=>x.R).sort((x,y)=>x-y)[Math.floor(a.length/2)];
    const rA=med(asks),rB=med(bids),S=rB-rA;
    const paired=Math.min(asks.length,bids.length);
    const strictAsks=asks.filter(x=>x.strict_valid).length, strictBids=bids.filter(x=>x.strict_valid).length;
    const strictPaired=Math.min(strictAsks,strictBids);
    const confidence=strictPaired>=3?'HIGH':(strictPaired>=1&&paired>=2)?'MEDIUM':'LOW';
    emit({type:'resilience_state',shadow_only:true,no_order_created:true,symbol:sym,at:now(),ask_R_median:rA,bid_R_median:rB,S,
      directional_candidate:rA<0&&rB>=0,episodes_120s:arr.length,ask_valid_count:asks.length,bid_valid_count:bids.length,
      paired_valid_count:paired,ask_strict_count:strictAsks,bid_strict_count:strictBids,strict_paired_count:strictPaired,
      confidence,quality_basis:'USABLE_WITH_STRICT_CONFIDENCE'});
  }
}
function onTrade(sym,t){
  const s=snapshot(sym); if(!s)return;
  const side=t.m?'BID':'ASK'; // m=true buyer was maker => aggressive sell hits bids
  const qty=+t.q, price=+t.p;
  if(!(qty>0)||price<s.lo||price>s.hi)return;
  const key=sym+':'+side; let e=episodes.get(key);
  if(!e){
    const initial=side==='ASK'?s.askDepth:s.bidDepth; if(!(initial>0))return;
    e={side,start:now(),mid:s.mid,lo:s.lo,hi:s.hi,spread:s.spread,initialDepth:initial,executed:0,armed:false}; episodes.set(key,e);
  }
  if(now()-e.start<=PERTURB_MS){
    e.executed+=qty; const frac=e.executed/e.initialDepth;
    if(frac>=USABLE_MIN_FRAC&&frac<=USABLE_MAX_FRAC&&!e.armed){e.armed=true;setTimeout(()=>{episodes.delete(key);complete(sym,e)},RESPONSE_MS);}
    else if(frac>USABLE_MAX_FRAC&&!e.armed) episodes.delete(key);
  }
}
async function initBook(sym){
  let lastError=null;
  for(const base of REST_BASES){
    try{
      const r=await fetch(base+'/api/v3/depth?symbol='+sym+'&limit=1000',{headers:{'User-Agent':'Proypers25-Research/1.0'}});
      if(!r.ok){lastError=new Error(sym+' snapshot '+r.status+' via '+base);continue;}
      const j=await r.json();
      const b={last:+j.lastUpdateId,bids:new Map(j.bids),asks:new Map(j.asks),ready:false};
      books.set(sym,b);
      const queued=pendingDepth.get(sym)||[];
      pendingDepth.set(sym,[]);
      for(const d of queued) depth(sym,d);
      return true;
    }catch(e){lastError=e;}
  }
  emit({type:'snapshot_unavailable',shadow_only:true,no_order_created:true,symbol:sym,at:now(),error:String(lastError?.message||lastError||'unavailable')});
  return false;
}
function applyDepth(b,d){
  for(const [p,q] of d.b){if(+q===0)b.bids.delete(p);else b.bids.set(p,q)}
  for(const [p,q] of d.a){if(+q===0)b.asks.delete(p);else b.asks.set(p,q)}
  b.last=d.u;
}
function depth(sym,d){
  const b=books.get(sym);
  if(!b){
    const q=pendingDepth.get(sym)||[]; q.push(d); if(q.length>5000)q.shift(); pendingDepth.set(sym,q); return;
  }
  if(d.u<=b.last)return;
  if(!b.ready){
    if(d.U<=b.last+1&&d.u>=b.last+1){applyDepth(b,d);b.ready=true;emit({type:'book_synced',shadow_only:true,no_order_created:true,symbol:sym,at:now(),last:b.last});}
    return;
  }
  if(d.U>b.last+1){
    b.ready=false; pendingDepth.set(sym,[d]);
    emit({type:'sequence_gap',shadow_only:true,no_order_created:true,symbol:sym,at:now(),expected:b.last+1,U:d.U,u:d.u});
    initBook(sym).catch(()=>{}); return;
  }
  applyDepth(b,d);
}
(async()=>{
  emit({type:'collector_start',shadow_only:true,no_order_created:true,at:now(),symbols:SYMBOLS,band:BAND,
    strict_perturbation:[STRICT_MIN_FRAC,STRICT_MAX_FRAC],usable_perturbation:[USABLE_MIN_FRAC,USABLE_MAX_FRAC],
    strict_max_mid_move:STRICT_MAX_EPISODE_MOVE,usable_max_mid_move:USABLE_MAX_EPISODE_MOVE,run_ms:RUN_MS});
  const streams=SYMBOLS.flatMap(s=>[s.toLowerCase()+'@depth@100ms',s.toLowerCase()+'@trade']).join('/');
  const ws=new WebSocket('wss://stream.binance.com:9443/stream?streams='+streams);
  ws.on('message',buf=>{try{const x=JSON.parse(buf),sym=String(x.data?.s||'').toUpperCase();if(x.stream?.includes('@depth'))depth(sym,x.data);else if(x.stream?.includes('@trade'))onTrade(sym,x.data);}catch(e){emit({type:'parse_error',at:now(),error:String(e.message||e)})}});
  ws.on('error',e=>emit({type:'ws_error',at:now(),error:String(e.message||e)}));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket open timeout')),15000);ws.once('open',()=>{clearTimeout(timer);resolve();});ws.once('error',reject);});
  await new Promise(resolve=>setTimeout(resolve,750));
  const initialized=(await Promise.all(SYMBOLS.map(initBook))).filter(Boolean).length;
  if(!initialized) throw new Error('No Binance depth snapshots available from REST endpoints');
  await new Promise(resolve=>setTimeout(resolve,RUN_MS));
  emit({type:'collector_end',shadow_only:true,no_order_created:true,at:now()});
  ws.close();
  await new Promise(resolve=>out.end(resolve));
})().catch(e=>{console.error(e);process.exitCode=1});
