'use strict';

/**
 * QPU Liquidity Resilience v2
 * Research only. Public Binance Spot depth/trades. No credentials. No orders.
 * Measures the temporal recovery of visible liquidity after small aggressive flow.
 */
const fs=require('fs');
const path=require('path');
const WebSocket=require('ws');

const REST_BASES=['https://api.binance.com','https://api1.binance.com','https://api2.binance.com','https://api3.binance.com','https://api4.binance.com'];
const DEFAULT='BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,LTCUSDT,FETUSDT,HBARUSDT,SEIUSDT,WIFUSDT,PEPEUSDT,RAYUSDT,CRVUSDT,LDOUSDT,RENDERUSDT,ARUSDT';
const SYMBOLS=String(process.env.LR_SYMBOLS||DEFAULT).split(',').map(s=>s.trim().toUpperCase()).filter(Boolean).slice(0,20);
const RADAR_SYMBOLS=new Set(String(process.env.LR_RADAR_SYMBOLS||'').split(',').map(s=>s.trim().toUpperCase()).filter(Boolean));
const RUN_MS=Math.max(120000,Number(process.env.LR_RUN_MS||3000000));
const BAND=0.0025;
const PERTURB_MS=1000;
const SAMPLE_MS=[1000,2000,5000];
const MIN_FRAC=0.02,MAX_FRAC=0.20;
const MAX_MOVE=0.00075;
const OUT=process.env.LR_OUT||path.join(process.cwd(),'qpu-realtime-shadow.ndjson');

const books=new Map(),episodes=new Map(),pendingDepth=new Map(),recent=new Map();
let msgCount=0,depthMsgCount=0,tradeMsgCount=0,lastMsgAt=null;
const out=fs.createWriteStream(OUT,{flags:'a'});
const now=()=>Date.now();
const emit=x=>out.write(JSON.stringify(x)+'\n');

function sideDepth(book,side,lo,hi){
  let q=0;
  for(const [p,v] of book[side]){
    const x=+p;
    if(x>=lo&&x<=hi)q+=+v;
  }
  return q;
}
function snapshot(sym){
  const b=books.get(sym);if(!b?.bids||!b?.asks)return null;
  const bid=Math.max(...[...b.bids.keys()].map(Number)),ask=Math.min(...[...b.asks.keys()].map(Number));
  if(!Number.isFinite(bid)||!Number.isFinite(ask))return null;
  const mid=(bid+ask)/2,lo=mid*(1-BAND),hi=mid*(1+BAND);
  return {mid,spread:(ask-bid)/mid,lo,hi,bidDepth:sideDepth(b,'bids',lo,mid),askDepth:sideDepth(b,'asks',mid,hi)};
}
function currentDepth(sym,e){
  const b=books.get(sym);if(!b)return null;
  return e.side==='ASK'?sideDepth(b,'asks',e.mid,e.hi):sideDepth(b,'bids',e.lo,e.mid);
}
function sampleEpisode(sym,key,e,ms){
  if(episodes.get(key)!==e)return;
  const s=snapshot(sym),depth=currentDepth(sym,e);
  if(!s||!(depth>=0))return;
  const R=(depth-e.initialDepth+e.executed)/Math.max(e.executed,1e-12);
  const move=(s.mid-e.mid)/e.mid;
  e.samples[String(ms)]={at:now(),depth,R,mid_move:move,valid:Math.abs(move)<=MAX_MOVE};
  if(ms===5000)complete(sym,key,e);
}
function median(xs){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]}
function complete(sym,key,e){
  if(episodes.get(key)!==e)return;
  episodes.delete(key);
  const s1=e.samples['1000'],s2=e.samples['2000'],s5=e.samples['5000'];
  if(!s5)return;
  const valid=Boolean(s1?.valid&&s2?.valid&&s5.valid);
  const curve=[s1?.R??null,s2?.R??null,s5.R];
  const recovery_slope=(s1&&s5)?(s5.R-s1.R)/4:null;
  const row={type:'resilience_curve',shadow_only:true,no_order_created:true,symbol:sym,side:e.side,
    started_at:e.start,armed_at:e.armedAt,available_at:now(),mid:e.mid,spread:e.spread,
    initial_depth:e.initialDepth,executed:e.executed,perturbation_fraction:e.executed/e.initialDepth,
    R_1s:s1?.R??null,R_2s:s2?.R??null,R_5s:s5.R,recovery_slope,
    mid_move_1s:s1?.mid_move??null,mid_move_2s:s2?.mid_move??null,mid_move_5s:s5.mid_move,
    radar_candidate:RADAR_SYMBOLS.has(sym),
    persistent_failure:Boolean(valid&&s1.R<0&&s2.R<0&&s5.R<0),
    recovery:Boolean(valid&&s5.R>0&&s5.R>s1.R),valid};
  emit(row);

  if(!valid)return;
  const arr=recent.get(sym)||[];
  arr.push(row);
  while(arr.length&&arr[0].available_at<now()-180000)arr.shift();
  recent.set(sym,arr);

  const asks=arr.filter(x=>x.side==='ASK').slice(-5),bids=arr.filter(x=>x.side==='BID').slice(-5);
  const askR=median(asks.map(x=>x.R_5s)),bidR=median(bids.map(x=>x.R_5s));
  const askFail=asks.length?asks.filter(x=>x.persistent_failure).length/asks.length:null;
  const bidFail=bids.length?bids.filter(x=>x.persistent_failure).length/bids.length:null;

  // State is useful even with one side; completeness is explicit.
  emit({type:'resilience_state_v2',shadow_only:true,no_order_created:true,symbol:sym,radar_candidate:RADAR_SYMBOLS.has(sym),at:now(),
    ask_R5_median:askR,bid_R5_median:bidR,
    ask_failure_rate:askFail,bid_failure_rate:bidFail,
    S:(askR!==null&&bidR!==null)?bidR-askR:null,
    directional_candidate:Boolean(askR!==null&&askR<0&&(bidR===null||bidR>=askR)),
    ask_episodes:asks.length,bid_episodes:bids.length,episodes_180s:arr.length,
    complete_both_sides:Boolean(asks.length&&bids.length)});
}
function onTrade(sym,t){
  const s=snapshot(sym);if(!s)return;
  const side=t.m?'BID':'ASK';
  const qty=+t.q,price=+t.p;
  if(!(qty>0)||price<s.lo||price>s.hi)return;
  const key=sym+':'+side;
  let e=episodes.get(key);
  if(!e){
    const initial=side==='ASK'?s.askDepth:s.bidDepth;
    if(!(initial>0))return;
    e={side,start:now(),mid:s.mid,lo:s.lo,hi:s.hi,spread:s.spread,initialDepth:initial,executed:0,armed:false,samples:{}};
    episodes.set(key,e);
  }
  if(e.armed||now()-e.start>PERTURB_MS)return;
  e.executed+=qty;
  const frac=e.executed/e.initialDepth;
  if(frac>MAX_FRAC){episodes.delete(key);return}
  if(frac>=MIN_FRAC){
    e.armed=true;e.armedAt=now();
    for(const ms of SAMPLE_MS)setTimeout(()=>sampleEpisode(sym,key,e,ms),ms);
  }
}
async function initBook(sym){
  let lastError;
  for(const base of REST_BASES){
    try{
      const r=await fetch(base+'/api/v3/depth?symbol='+sym+'&limit=1000',{headers:{'User-Agent':'Proypers25-QPU-Research/2.0'}});
      if(!r.ok){lastError=new Error(sym+' snapshot '+r.status);continue}
      const j=await r.json();
      const b={last:+j.lastUpdateId,bids:new Map(j.bids),asks:new Map(j.asks),ready:false};
      books.set(sym,b);
      const queued=pendingDepth.get(sym)||[];pendingDepth.set(sym,[]);
      for(const d of queued)depth(sym,d);
      return true;
    }catch(e){lastError=e}
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
  if(!b){const q=pendingDepth.get(sym)||[];q.push(d);if(q.length>5000)q.shift();pendingDepth.set(sym,q);return}
  if(d.u<=b.last)return;
  if(!b.ready){
    if(d.U<=b.last+1&&d.u>=b.last+1){applyDepth(b,d);b.ready=true;emit({type:'book_synced',shadow_only:true,no_order_created:true,symbol:sym,at:now(),last:b.last})}
    return;
  }
  if(d.U>b.last+1){
    b.ready=false;pendingDepth.set(sym,[d]);
    emit({type:'sequence_gap',shadow_only:true,no_order_created:true,symbol:sym,at:now(),expected:b.last+1,U:d.U,u:d.u});
    initBook(sym).catch(()=>{});return;
  }
  applyDepth(b,d);
}

(async()=>{
  emit({type:'qpu_realtime_start',shadow_only:true,no_order_created:true,at:now(),symbols:SYMBOLS,radar_symbols:[...RADAR_SYMBOLS],band:BAND,perturbation:[MIN_FRAC,MAX_FRAC],samples_ms:SAMPLE_MS,run_ms:RUN_MS});
  const streams=SYMBOLS.flatMap(s=>[s.toLowerCase()+'@depth@100ms',s.toLowerCase()+'@trade']).join('/');
  const ws=new WebSocket('wss://stream.binance.com:9443/stream?streams='+streams);
  ws.on('message',buf=>{try{
    msgCount++;lastMsgAt=now();
    const x=JSON.parse(buf),sym=String(x.data?.s||'').toUpperCase();
    if(x.stream?.includes('@depth')){depthMsgCount++;depth(sym,x.data);}
    else if(x.stream?.includes('@trade')){tradeMsgCount++;onTrade(sym,x.data);}
  }catch(e){emit({type:'parse_error',at:now(),error:String(e.message||e)})}});
  ws.on('error',e=>emit({type:'ws_error',at:now(),error:String(e.message||e)}));
  await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('WebSocket open timeout')),15000);ws.once('open',()=>{clearTimeout(timer);emit({type:'ws_open',shadow_only:true,no_order_created:true,at:now(),streams:SYMBOLS.length*2});resolve()});ws.once('error',reject)});
  await new Promise(r=>setTimeout(r,750));
  const initialized=(await Promise.all(SYMBOLS.map(initBook))).filter(Boolean).length;
  if(!initialized)throw new Error('No Binance depth snapshots available');
  const heartbeat=setInterval(()=>{
    emit({type:'heartbeat',shadow_only:true,no_order_created:true,at:now(),messages:msgCount,depth_messages:depthMsgCount,trade_messages:tradeMsgCount,last_message_at:lastMsgAt,synced_books:[...books.values()].filter(b=>b.ready).length,total_books:books.size});
  },10000);
  setTimeout(()=>{clearInterval(heartbeat);emit({type:'qpu_realtime_end',shadow_only:true,no_order_created:true,at:now(),messages:msgCount,depth_messages:depthMsgCount,trade_messages:tradeMsgCount,synced_books:[...books.values()].filter(b=>b.ready).length});ws.close();out.end()},RUN_MS);
})().catch(e=>{console.error(e);process.exitCode=1});
