'use strict';

/**
 * V21 shadow-live router.
 * Observation only: public Binance market data + isolated Firestore shadow collections.
 * Never imports or calls any real/paper order executor.
 */
const crypto = require('crypto');

const DECISIONS='spot_v21_shadow_decisions';
const POSITIONS='spot_v21_shadow_positions';
const RESULTS='spot_v21_shadow_results';
const STATE='spot_v21_shadow_state/runtime';

const COST=.004;
const MEMORY_DAYS=45;
const TAU_DAYS=15;
const EMBARGO_MS=24*60*60*1000;
const MIN_WEIGHT=2;
const SKIP_THRESHOLD=-.012;
const BASE_EXIT={hardStop:.05,beTrigger:.05,beLock:.002,trailTrigger:.08,trailGap:.03,timeoutMinutes:18*60};
const OVERLAY_EXIT={hardStop:.04,takeProfit:.06,timeoutMinutes:8*60};
const CONFIRM={extCut:.07,lowRet:.003,highRet:.008,maxDraw:-.04,lowClose:.35,highClose:.50,minVol:.70};

function n(v,f=0){const x=Number(v);return Number.isFinite(x)?x:f}
function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0}
function pct(a,b){return a>0?b/a-1:0}
function iso(v=Date.now()){return new Date(v).toISOString()}
function ms(v){if(!v)return 0;if(typeof v.toDate==='function')return v.toDate().getTime();const x=new Date(v).getTime();return Number.isFinite(x)?x:0}
function round(v,d=8){if(!Number.isFinite(v))return null;const p=10**d;return Math.round(v*p)/p}
function keyOf(input){return crypto.createHash('sha1').update(String(input)).digest('hex').slice(0,20)}
function context(parts){const e=n(parts.extension),c=n(parts.confirm);return `${e<.055?'E0':e<.085?'E1':'E2'}_${c<.42?'C0':'C1'}`}

async function fetchJson(url){
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),12000);
  try{const r=await fetch(url,{signal:controller.signal,headers:{'user-agent':'proypers25-v21-shadow/1.0'}});if(!r.ok)throw new Error(`HTTP_${r.status}`);return await r.json()}
  finally{clearTimeout(timer)}
}
async function klines(symbol,limit=290,startTime=null,endTime=null){
  const q=new URLSearchParams({symbol:String(symbol||'').toUpperCase(),interval:'5m',limit:String(limit)});
  if(startTime)q.set('startTime',String(startTime));if(endTime)q.set('endTime',String(endTime));
  const rows=await fetchJson(`https://data-api.binance.vision/api/v3/klines?${q}`);
  if(!Array.isArray(rows))throw new Error('INVALID_KLINES');
  return rows.map(r=>({t:n(r[0]),o:n(r[1]),h:n(r[2]),l:n(r[3]),c:n(r[4]),q:n(r[7]),n:n(r[8]),closeTime:n(r[6])}));
}
async function price(symbol){
  const d=await fetchJson(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(String(symbol||'').toUpperCase())}`);
  return n(d.price);
}

function sumQuote(bars,i,count){let s=0;for(let k=Math.max(0,i-count+1);k<=i;k++)s+=n(bars[k]?.q);return s}
function v42Features(bars,btc){
  const i=bars.length-2;if(i<288)throw new Error('INSUFFICIENT_V42_BARS');const c=bars[i].c;
  const r15=pct(bars[i-3].c,c),r30=pct(bars[i-6].c,c),r60=pct(bars[i-12].c,c),r240=pct(bars[i-48].c,c),r24=pct(bars[i-288].c,c);
  const base=avg(bars.slice(i-72,i-12).map(x=>x.q))*12,ph60=Math.max(...bars.slice(i-12,i).map(x=>x.h)),ph240=Math.max(...bars.slice(i-48,i).map(x=>x.h));
  return {r15,r30,r60,r240,r24,vol15:base>0?sumQuote(bars,i,3)/(base/4):1,vol30:base>0?sumQuote(bars,i,6)/(base/2):1,
    tradeAccel:bars[i].n/Math.max(1,avg(bars.slice(i-12,i).map(x=>x.n))),breakout60:ph60>0?c/ph60-1:0,breakout240:ph240>0?c/ph240-1:0,
    rs60:r60-btc.r60,rs240:r240-btc.r240,signal_close:c,bar_time:bars[i].t};
}
function parts(f){
  return {ignition:.9*Math.log(Math.max(.2,f.vol15))+.65*Math.log(Math.max(.2,f.tradeAccel))+.65*f.r15+.35*f.breakout60,
    confirm:1.2*f.breakout60+.65*f.rs60+.35*Math.log(Math.max(.2,f.vol30))-.8*Math.max(0,f.r24-.10)-.5*Math.max(0,f.r60-.06),
    extension:1.15*f.rs60+.75*f.rs240+.35*f.r30+.25*f.breakout240-.45*Math.max(0,f.r24-.12)};
}
async function liveV42(symbol){
  const [bars,btcBars]=await Promise.all([klines(symbol,290),klines('BTCUSDT',290)]);
  const bi=btcBars.length-2;if(bi<48)throw new Error('INSUFFICIENT_BTC_CONTEXT');
  const btc={r60:pct(btcBars[bi-12].c,btcBars[bi].c),r240:pct(btcBars[bi-48].c,btcBars[bi].c)};
  const f=v42Features(bars,btc),p=parts(f);return {features:f,parts:p,context:context(p)};
}

async function historyStats(db,ctx,arm,now=Date.now()){
  const snap=await db.collection(RESULTS).orderBy('closed_at','desc').limit(500).get();
  let sw=0,sr=0,ww=0,count=0;const from=now-MEMORY_DAYS*86400000;
  for(const doc of snap.docs){const h=doc.data()||{},t=ms(h.signal_at||h.created_at),closed=ms(h.closed_at);
    if(h.arm!==arm||!closed||closed>now-EMBARGO||t<from)continue;
    const w=Math.exp(-((now-t)/86400000)/TAU_DAYS)*(h.context===ctx?1:.20);
    sw+=w;sr+=w*n(h.net_return);if(n(h.net_return)>0)ww+=w;count++;
  }
  return {count,weight:sw,mean:sw?sr/sw:0,win_rate:sw?ww/sw:0};
}
async function chooseArm(db,ctx,now){
  const [b,o]=await Promise.all([historyStats(db,ctx,'BASE',now),historyStats(db,ctx,'OVERLAY',now)]);
  if(b.weight<MIN_WEIGHT&&o.weight<MIN_WEIGHT)return {arm:'OVERLAY',reason:'LOW_EVIDENCE_OVERLAY_PRIOR',base:b,overlay:o,score_base:b.mean,score_overlay:o.mean};
  const sb=b.mean,so=o.mean,best=Math.max(sb,so);
  if(best<SKIP_THRESHOLD)return {arm:'SKIP',reason:'NEGATIVE_RECENT_EDGE',base:b,overlay:o,score_base:sb,score_overlay:so};
  return {arm:so>sb?'OVERLAY':'BASE',reason:'V21_CONTEXT_EDGE',base:b,overlay:o,score_base:sb,score_overlay:so};
}

function evaluateConfirmation(bars,signalPrice,extension){
  if(!bars.length||!(signalPrice>0))return {ready:false,passed:false,reason:'CONFIRMATION_DATA_PENDING'};
  const bar=bars.find(x=>x.closeTime>Date.now()-60*1000)||bars[bars.length-1];
  const rg=Math.max(1e-12,bar.h-bar.l),ret=bar.c/signalPrice-1,draw=bar.l/signalPrice-1,close=(bar.c-bar.l)/rg;
  const previous=bars.slice(0,Math.max(0,bars.indexOf(bar))),baseVol=avg(previous.slice(-6).map(x=>x.q)),vol=baseVol>0?bar.q/baseVol:1;
  const threshold=extension<=CONFIRM.extCut?CONFIRM.lowRet:CONFIRM.highRet,closeMin=extension<=CONFIRM.extCut?CONFIRM.lowClose:CONFIRM.highClose;
  const passed=ret>=threshold&&draw>=CONFIRM.maxDraw&&close>=closeMin&&vol>=CONFIRM.minVol;
  return {ready:true,passed,ret,draw,close_location:close,volume_ratio:vol,ret_threshold:threshold,close_threshold:closeMin};
}

function evaluateExit(position,bars,nowPrice,nowMs){
  const entry=n(position.entry_price),opened=ms(position.opened_at),arm=position.arm,timeout=arm==='OVERLAY'?OVERLAY_EXIT.timeoutMinutes:BASE_EXIT.timeoutMinutes;
  let highest=n(position.highest_price,entry),stop=arm==='OVERLAY'?entry*(1-OVERLAY_EXIT.hardStop):entry*(1-BASE_EXIT.hardStop);
  for(const b of bars){
    highest=Math.max(highest,b.h);
    if(arm==='OVERLAY'){
      const sl=b.l<=stop,tp=b.h>=entry*(1+OVERLAY_EXIT.takeProfit);
      if(sl&&tp)return {reason:'AMBIGUOUS_STOP_FIRST',price:stop,highest};
      if(sl)return {reason:'HARD_STOP',price:stop,highest};
      if(tp)return {reason:'TAKE_PROFIT',price:entry*(1+OVERLAY_EXIT.takeProfit),highest};
    }else{
      if(highest>=entry*(1+BASE_EXIT.beTrigger))stop=Math.max(stop,entry*(1+BASE_EXIT.beLock));
      if(highest>=entry*(1+BASE_EXIT.trailTrigger))stop=Math.max(stop,highest*(1-BASE_EXIT.trailGap));
      if(b.l<=stop)return {reason:stop>entry?'TRAIL_OR_BE':'HARD_STOP',price:stop,highest};
    }
  }
  if(opened&&nowMs-opened>=timeout*60000&&nowPrice>0)return {reason:'TIMEOUT',price:nowPrice,highest};
  return {reason:null,price:null,highest,stop};
}

async function closeOpenPositions(db,nowMs){
  const snap=await db.collection(POSITIONS).where('status','==','SHADOW_OPEN').get();const closed=[];
  for(const doc of snap.docs){const p={id:doc.id,...doc.data()};try{
    const [bars,last]=await Promise.all([klines(p.symbol,240,ms(p.opened_at),nowMs),price(p.symbol)]),ev=evaluateExit(p,bars,last,nowMs);
    await db.collection(POSITIONS).doc(p.id).set({updated_at:iso(nowMs),highest_price:round(ev.highest),active_stop_price:round(ev.stop||0)||null,latest_price:round(last),shadow_only:true},{merge:true});
    if(!ev.reason)continue;
    const gross=ev.price/n(p.entry_price)-1,net=gross-COST,result={id:`result_${p.id}`,position_id:p.id,decision_id:p.decision_id,symbol:p.symbol,arm:p.arm,context:p.context,signal_at:p.signal_at,opened_at:p.opened_at,closed_at:iso(nowMs),exit_reason:ev.reason,entry_price:p.entry_price,exit_price:round(ev.price),gross_return:gross,net_return:net,shadow_only:true,no_order_created:true};
    await Promise.all([db.collection(POSITIONS).doc(p.id).set({status:'SHADOW_CLOSED',closed_at:iso(nowMs),exit_reason:ev.reason,exit_price:round(ev.price),net_return:net,shadow_only:true,no_order_created:true},{merge:true}),db.collection(RESULTS).doc(result.id).set(result,{merge:true})]);closed.push(result);
  }catch(error){closed.push({position_id:p.id,symbol:p.symbol,error:error.message})}}
  return closed;
}

async function resolvePending(db,nowMs){
  const snap=await db.collection(DECISIONS).where('status','==','PENDING_CONFIRMATION').get();const resolved=[];
  for(const doc of snap.docs){const d={id:doc.id,...doc.data()},t=ms(d.signal_at);if(!t||nowMs-t<5*60000)continue;
    try{const bars=await klines(d.symbol,12,t-30*60000,nowMs),cf=evaluateConfirmation(bars,n(d.signal_price),n(d.v42?.extension));
      if(!cf.ready)continue;
      if(!cf.passed){await db.collection(DECISIONS).doc(d.id).set({status:'SHADOW_REJECTED',confirmation:cf,resolved_at:iso(nowMs),shadow_only:true,no_order_created:true},{merge:true});resolved.push({decision_id:d.id,status:'SHADOW_REJECTED'});continue}
      const entry=bars[bars.length-1]?.c||await price(d.symbol),pid=`v21_shadow_${d.id}`;
      await db.collection(POSITIONS).doc(pid).set({id:pid,decision_id:d.id,symbol:d.symbol,arm:'OVERLAY',context:d.context,signal_at:d.signal_at,opened_at:iso(nowMs),entry_price:round(entry),highest_price:round(entry),status:'SHADOW_OPEN',shadow_only:true,no_order_created:true},{merge:true});
      await db.collection(DECISIONS).doc(d.id).set({status:'SHADOW_OPEN',position_id:pid,confirmation:cf,resolved_at:iso(nowMs),shadow_only:true,no_order_created:true},{merge:true});resolved.push({decision_id:d.id,status:'SHADOW_OPEN',position_id:pid});
    }catch(error){resolved.push({decision_id:d.id,error:error.message})}
  }
  return resolved;
}

async function runV21ShadowCycle(db,options={}){
  const nowMs=Date.now(),closed=await closeOpenPositions(db,nowMs),resolved=await resolvePending(db,nowMs),candidate=options.candidate||null;
  if(!candidate?.symbol){await db.doc(STATE).set({updated_at:iso(nowMs),last_cycle:{candidate:false,closed:closed.length,resolved:resolved.length},shadow_only:true,no_order_created:true},{merge:true});return {ok:true,shadow_only:true,no_order_created:true,candidate:false,closed,resolved}}
  const symbol=String(candidate.symbol).toUpperCase(),sourceId=String(candidate.id||candidate.candidate_id||candidate.scan_id||'live'),bucket=Math.floor(nowMs/(5*60000)),id=`v21_${keyOf(`${sourceId}:${symbol}:${bucket}`)}`;
  const existing=await db.collection(DECISIONS).doc(id).get();if(existing.exists)return {ok:true,shadow_only:true,no_order_created:true,deduplicated:true,decision:existing.data(),closed,resolved};
  const live=await liveV42(symbol),choice=await chooseArm(db,live.context,nowMs),signalPrice=n(candidate.price)||await price(symbol);
  const decision={id,symbol,source_candidate_id:sourceId,source_scan_id:candidate.scan_id||null,signal_at:iso(nowMs),signal_price:round(signalPrice),context:live.context,arm:choice.arm,reason:choice.reason,v42:{...live.parts,r15:live.features.r15,r60:live.features.r60,r24:live.features.r24},memory:{base:choice.base,overlay:choice.overlay,score_base:choice.score_base,score_overlay:choice.score_overlay},status:choice.arm==='SKIP'?'SHADOW_SKIPPED':choice.arm==='OVERLAY'?'PENDING_CONFIRMATION':'SHADOW_OPEN',shadow_only:true,no_order_created:true,version:'V21_SHADOW_LIVE_1'};
  if(choice.arm==='BASE'){const pid=`v21_shadow_${id}`;decision.position_id=pid;await db.collection(POSITIONS).doc(pid).set({id:pid,decision_id:id,symbol,arm:'BASE',context:live.context,signal_at:decision.signal_at,opened_at:decision.signal_at,entry_price:round(signalPrice),highest_price:round(signalPrice),status:'SHADOW_OPEN',shadow_only:true,no_order_created:true},{merge:true})}
  await db.collection(DECISIONS).doc(id).set(decision,{merge:true});
  await db.doc(STATE).set({updated_at:iso(nowMs),version:'V21_SHADOW_LIVE_1',last_decision_id:id,last_symbol:symbol,last_arm:choice.arm,shadow_only:true,no_order_created:true},{merge:true});
  return {ok:true,shadow_only:true,no_order_created:true,decision,closed,resolved};
}

async function getV21ShadowStatus(db){
 const [state,open,pending,results]=await Promise.all([db.doc(STATE).get(),db.collection(POSITIONS).where('status','==','SHADOW_OPEN').get(),db.collection(DECISIONS).where('status','==','PENDING_CONFIRMATION').get(),db.collection(RESULTS).orderBy('closed_at','desc').limit(50).get()]);
 const rows=results.docs.map(d=>d.data()),net=rows.reduce((s,x)=>s+n(x.net_return),0);
 return {ok:true,shadow_only:true,no_order_created:true,version:'V21_SHADOW_LIVE_1',state:state.exists?state.data():null,open_positions:open.size,pending_confirmations:pending.size,recent_results:rows.length,recent_win_rate:rows.length?rows.filter(x=>n(x.net_return)>0).length/rows.length:0,recent_avg_net_return:rows.length?net/rows.length:0};
}

module.exports={runV21ShadowCycle,getV21ShadowStatus,context,evaluateConfirmation,evaluateExit,BASE_EXIT,OVERLAY_EXIT,CONFIRM};
