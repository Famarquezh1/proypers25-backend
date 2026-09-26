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

const SYMBOLS = String(process.env.LR_SYMBOLS || 'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,LTCUSDT,FETUSDT,HBARUSDT,SEIUSDT,WIFUSDT,PEPEUSDT,RAYUSDT,CRVUSDT,LDOUSDT,RENDERUSDT,ARUSDT')
  .split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);
const RUN_MS = Math.max(60000, Number(process.env.LR_RUN_MS || 240000));
const BAND = 0.0025;                 // fixed +/-25bp
const PERTURB_MS = 1000;
const RESPONSE_MS = 5000;
const MIN_FRAC = 0.05, MAX_FRAC = 0.20;
const MAX_EPISODE_MOVE = 0.0005;     // 5bp
const OUT = process.env.LR_OUT || path.join(process.cwd(),'liquidity-resilience-shadow.ndjson');

const books = new Map(), episodes = new Map(), recent = new Map();
let out = fs.createWriteStream(OUT,{flags:'a'});

function now(){return Date.now()}
function sideDepth(book, side, lo, hi){
  let q=0;
  for(const [p,v] of book[side]){const x=+p;if(x>=lo&&x<=hi)q+=+v;}
  return q;
}
function snapshot(sym){
  const b=books.get(sym); if(!b||!b.bid||!b.ask) return null;
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
  const valid=Math.abs(move)<=MAX_EPISODE_MOVE;
  const row={type:'resilience_episode',shadow_only:true,no_order_created:true,symbol:sym,side:e.side,
    started_at:e.start,available_at:now(),mid:e.mid,spread:e.spread,initial_depth:e.initialDepth,
    executed:e.executed,perturbation_fraction:e.executed/e.initialDepth,final_depth:final,R,mid_move:move,valid};
  emit(row);
  const arr=recent.get(sym)||[]; arr.push(row); while(arr.length&&arr[0].available_at<now()-120000)arr.shift(); recent.set(sym,arr);
  const asks=arr.filter(x=>x.valid&&x.side==='ASK').slice(-3), bids=arr.filter(x=>x.valid&&x.side==='BID').slice(-3);
  if(asks.length>=3&&bids.length>=3){
    const med=a=>a.map(x=>x.R).sort((x,y)=>x-y)[Math.floor(a.length/2)];
    const rA=med(asks),rB=med(bids),S=rB-rA;
    emit({type:'resilience_state',shadow_only:true,no_order_created:true,symbol:sym,at:now(),ask_R_median:rA,bid_R_median:rB,S,
      directional_candidate:rA<0&&rB>=0,episodes_120s:arr.length});
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
    if(frac>=MIN_FRAC&&frac<=MAX_FRAC&&!e.armed){e.armed=true;setTimeout(()=>{episodes.delete(key);complete(sym,e)},RESPONSE_MS);}
    else if(frac>MAX_FRAC&&!e.armed) episodes.delete(key);
  }
}
async function initBook(sym){
  const r=await fetch('https://api.binance.com/api/v3/depth?symbol='+sym+'&limit=1000'); if(!r.ok)throw new Error(sym+' snapshot '+r.status);
  const j=await r.json(), b={last:+j.lastUpdateId,bids:new Map(j.bids),asks:new Map(j.asks),ready:true}; books.set(sym,b);
}
function depth(sym,d){
  const b=books.get(sym); if(!b||!b.ready)return;
  if(d.u<=b.last)return;
  if(d.U>b.last+1){b.ready=false;emit({type:'sequence_gap',symbol:sym,at:now(),expected:b.last+1,U:d.U,u:d.u});initBook(sym).catch(()=>{});return;}
  for(const [p,q] of d.b){if(+q===0)b.bids.delete(p);else b.bids.set(p,q)}
  for(const [p,q] of d.a){if(+q===0)b.asks.delete(p);else b.asks.set(p,q)}
  b.last=d.u;
}
(async()=>{
  await Promise.all(SYMBOLS.map(initBook));
  emit({type:'collector_start',shadow_only:true,no_order_created:true,at:now(),symbols:SYMBOLS,band:BAND,perturbation:[MIN_FRAC,MAX_FRAC],run_ms:RUN_MS});
  const streams=SYMBOLS.flatMap(s=>[s.toLowerCase()+'@depth@100ms',s.toLowerCase()+'@trade']).join('/');
  const ws=new WebSocket('wss://stream.binance.com:9443/stream?streams='+streams);
  ws.on('message',buf=>{try{const x=JSON.parse(buf),sym=String(x.data.s||'').toUpperCase();if(x.stream.includes('@depth'))depth(sym,x.data);else if(x.stream.includes('@trade'))onTrade(sym,x.data);}catch(e){emit({type:'parse_error',at:now(),error:String(e.message||e)})}});
  ws.on('error',e=>emit({type:'ws_error',at:now(),error:String(e.message||e)}));
  setTimeout(()=>{emit({type:'collector_end',shadow_only:true,no_order_created:true,at:now()});ws.close();out.end();},RUN_MS);
})().catch(e=>{console.error(e);process.exitCode=1});
