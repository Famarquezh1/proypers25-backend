'use strict';

const fs=require('fs');
const path=require('path');

const SCAN_PATH=process.argv[2]||'spot-radar-scan.json';
const PREV_PATH=process.argv[3]||'';
const STATE_OUT=process.argv[4]||'spot-v21-shadow-state.json';
const EVIDENCE_OUT=process.argv[5]||'spot-v21-shadow-evidence.json';

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
function ms(v){const x=new Date(v||0).getTime();return Number.isFinite(x)?x:0}
function round(v,d=8){if(!Number.isFinite(v))return null;const p=10**d;return Math.round(v*p)/p}
function context(parts){const e=n(parts?.extension),c=n(parts?.confirm);return `${e<.055?'E0':e<.085?'E1':'E2'}_${c<.42?'C0':'C1'}`}

async function fetchJson(url){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),12000);
  try{const r=await fetch(url,{signal:ctrl.signal,headers:{'user-agent':'proypers25-v21-github-shadow/1.0'}});if(!r.ok)throw new Error(`HTTP_${r.status}`);return await r.json()}
  finally{clearTimeout(timer)}
}
async function klines(symbol,limit=240,startTime=null,endTime=null){
  const q=new URLSearchParams({symbol:String(symbol||'').toUpperCase(),interval:'5m',limit:String(limit)});
  if(startTime)q.set('startTime',String(startTime));if(endTime)q.set('endTime',String(endTime));
  const rows=await fetchJson(`https://data-api.binance.vision/api/v3/klines?${q}`);
  if(!Array.isArray(rows))throw new Error('INVALID_KLINES');
  return rows.map(r=>({t:n(r[0]),o:n(r[1]),h:n(r[2]),l:n(r[3]),c:n(r[4]),q:n(r[7]),closeTime:n(r[6])}));
}
async function tickerPrice(symbol){
  const d=await fetchJson(`https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(String(symbol||'').toUpperCase())}`);
  return n(d.price);
}

function loadJson(file,fallback){
  if(!file||!fs.existsSync(file))return fallback;
  try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}
}

function stats(results,ctx,arm,now){
  const from=now-MEMORY_DAYS*86400000;let sw=0,sr=0,ww=0,count=0;
  for(const r of results||[]){const t=ms(r.signal_at),closed=ms(r.closed_at);if(r.arm!==arm||!closed||closed>now-EMBARGO||t<from)continue;
    const w=Math.exp(-((now-t)/86400000)/TAU_DAYS)*(r.context===ctx?1:.20);
    sw+=w;sr+=w*n(r.net_return);if(n(r.net_return)>0)ww+=w;count++;
  }
  return {count,weight:sw,mean:sw?sr/sw:0,win_rate:sw?ww/sw:0};
}
function chooseArm(results,ctx,now){
  const b=stats(results,ctx,'BASE',now),o=stats(results,ctx,'OVERLAY',now);
  if(b.weight<MIN_WEIGHT&&o.weight<MIN_WEIGHT)return {arm:'OVERLAY',reason:'LOW_EVIDENCE_OVERLAY_PRIOR',base:b,overlay:o};
  const best=Math.max(b.mean,o.mean);
  if(best<SKIP_THRESHOLD)return {arm:'SKIP',reason:'NEGATIVE_RECENT_EDGE',base:b,overlay:o};
  return {arm:o.mean>b.mean?'OVERLAY':'BASE',reason:'V21_CONTEXT_EDGE',base:b,overlay:o};
}

function evaluateConfirmation(bars,signalPrice,extension,now){
  const closed=bars.filter(b=>b.closeTime<=now-15000);
  if(!closed.length||!(signalPrice>0))return {ready:false,passed:false,reason:'CONFIRMATION_DATA_PENDING'};
  const bar=closed[closed.length-1],idx=bars.indexOf(bar),prev=bars.slice(Math.max(0,idx-6),idx);
  const rg=Math.max(1e-12,bar.h-bar.l),ret=bar.c/signalPrice-1,draw=bar.l/signalPrice-1,close=(bar.c-bar.l)/rg,baseVol=avg(prev.map(x=>x.q)),vol=baseVol>0?bar.q/baseVol:1;
  const retTh=extension<=CONFIRM.extCut?CONFIRM.lowRet:CONFIRM.highRet,closeTh=extension<=CONFIRM.extCut?CONFIRM.lowClose:CONFIRM.highClose;
  return {ready:true,passed:ret>=retTh&&draw>=CONFIRM.maxDraw&&close>=closeTh&&vol>=CONFIRM.minVol,ret,draw,close_location:close,volume_ratio:vol,ret_threshold:retTh,close_threshold:closeTh,bar_close_time:iso(bar.closeTime),entry_price:bar.c};
}

function evaluateExit(position,bars,lastPrice,now){
  const entry=n(position.entry_price),opened=ms(position.opened_at),arm=position.arm,timeout=arm==='OVERLAY'?OVERLAY_EXIT.timeoutMinutes:BASE_EXIT.timeoutMinutes;
  let highest=n(position.highest_price,entry),stop=arm==='OVERLAY'?entry*(1-OVERLAY_EXIT.hardStop):entry*(1-BASE_EXIT.hardStop);
  for(const b of bars){
    highest=Math.max(highest,b.h);
    if(arm==='OVERLAY'){
      const sl=b.l<=stop,tp=b.h>=entry*(1+OVERLAY_EXIT.takeProfit);
      if(sl&&tp)return {reason:'AMBIGUOUS_STOP_FIRST',price:stop,highest,stop};
      if(sl)return {reason:'HARD_STOP',price:stop,highest,stop};
      if(tp)return {reason:'TAKE_PROFIT',price:entry*(1+OVERLAY_EXIT.takeProfit),highest,stop};
    }else{
      if(highest>=entry*(1+BASE_EXIT.beTrigger))stop=Math.max(stop,entry*(1+BASE_EXIT.beLock));
      if(highest>=entry*(1+BASE_EXIT.trailTrigger))stop=Math.max(stop,highest*(1-BASE_EXIT.trailGap));
      if(b.l<=stop)return {reason:stop>entry?'TRAIL_OR_BE':'HARD_STOP',price:stop,highest,stop};
    }
  }
  if(opened&&now-opened>=timeout*60000&&lastPrice>0)return {reason:'TIMEOUT',price:lastPrice,highest,stop};
  return {reason:null,price:null,highest,stop};
}

async function updatePositions(state,now,evidence){
  const keep=[];
  for(const p of state.positions||[]){
    try{
      const [bars,last]=await Promise.all([klines(p.symbol,240,ms(p.opened_at),now),tickerPrice(p.symbol)]);
      const ev=evaluateExit(p,bars,last,now);
      p.highest_price=round(ev.highest);p.active_stop_price=round(ev.stop);p.latest_price=round(last);p.updated_at=iso(now);
      if(!ev.reason){keep.push(p);continue}
      const gross=ev.price/n(p.entry_price)-1,net=gross-COST;
      const result={id:`result_${p.id}`,position_id:p.id,decision_id:p.decision_id,symbol:p.symbol,arm:p.arm,context:p.context,signal_at:p.signal_at,opened_at:p.opened_at,closed_at:iso(now),exit_reason:ev.reason,entry_price:p.entry_price,exit_price:round(ev.price),gross_return:gross,net_return:net,shadow_only:true,no_order_created:true};
      state.results.push(result);evidence.closed.push(result);
    }catch(error){keep.push(p);evidence.errors.push({stage:'UPDATE_POSITION',symbol:p.symbol,error:error.message})}
  }
  state.positions=keep;
}

async function resolvePending(state,now,evidence){
  const keep=[];
  for(const d of state.pending||[]){
    if(now-ms(d.signal_at)<5*60000){keep.push(d);continue}
    try{
      const bars=await klines(d.symbol,12,ms(d.signal_at)-30*60000,now),cf=evaluateConfirmation(bars,n(d.signal_price),n(d.v42?.extension),now);
      if(!cf.ready){keep.push(d);continue}
      if(!cf.passed){d.status='SHADOW_REJECTED';d.confirmation=cf;d.resolved_at=iso(now);state.decisions.push(d);evidence.resolved.push({decision_id:d.id,status:d.status});continue}
      const entry=n(cf.entry_price)||await tickerPrice(d.symbol),p={id:`position_${d.id}`,decision_id:d.id,symbol:d.symbol,arm:'OVERLAY',context:d.context,signal_at:d.signal_at,opened_at:iso(now),entry_price:round(entry),highest_price:round(entry),shadow_only:true,no_order_created:true};
      state.positions.push(p);d.status='SHADOW_OPEN';d.confirmation=cf;d.position_id=p.id;d.resolved_at=iso(now);state.decisions.push(d);evidence.resolved.push({decision_id:d.id,status:d.status,position_id:p.id});
    }catch(error){keep.push(d);evidence.errors.push({stage:'RESOLVE_PENDING',symbol:d.symbol,error:error.message})}
  }
  state.pending=keep;
}

function prune(state,now){
  state.results=(state.results||[]).filter(x=>now-ms(x.closed_at)<70*86400000).slice(-1000);
  state.decisions=(state.decisions||[]).filter(x=>now-ms(x.signal_at)<30*86400000).slice(-1000);
}

async function main(){
  const now=Date.now(),scan=loadJson(SCAN_PATH,{}),prev=loadJson(PREV_PATH,{});
  const state={version:'V21_GITHUB_SHADOW_1',updated_at:iso(now),pending:Array.isArray(prev.pending)?prev.pending:[],positions:Array.isArray(prev.positions)?prev.positions:[],results:Array.isArray(prev.results)?prev.results:[],decisions:Array.isArray(prev.decisions)?prev.decisions:[]};
  const evidence={version:state.version,generated_at:iso(now),shadow_only:true,no_order_created:true,production_action:'NONE',scan_notify:scan.notify===true,scan_symbol:scan.symbol||null,closed:[],resolved:[],decision:null,errors:[]};

  await updatePositions(state,now,evidence);
  await resolvePending(state,now,evidence);

  if(scan.notify===true&&scan.symbol&&n(scan.price)>0&&scan.v42_detail){
    const bucket=Math.floor(now/(5*60000)),id=`v21_${scan.symbol}_${bucket}`;
    const symbol=String(scan.symbol).toUpperCase();
    const activeSameSymbol=[...state.pending,...state.positions].some(x=>String(x.symbol||'').toUpperCase()===symbol);
    const seen=[...state.pending,...state.positions,...state.decisions].some(x=>x.id===id||x.decision_id===id);
    if(!seen&&!activeSameSymbol){
      const ctx=context(scan.v42_detail),choice=chooseArm(state.results,ctx,now),decision={id,symbol:String(scan.symbol).toUpperCase(),signal_at:iso(now),signal_price:n(scan.price),context:ctx,arm:choice.arm,reason:choice.reason,v42:{ignition:n(scan.v42_detail.ignition),confirm:n(scan.v42_detail.confirm),extension:n(scan.v42_detail.extension),r15:n(scan.v42_detail.r15),r60:n(scan.v42_detail.r60),r24:n(scan.v42_detail.r24)},memory:{base:choice.base,overlay:choice.overlay},shadow_only:true,no_order_created:true};
      if(choice.arm==='OVERLAY'){decision.status='PENDING_CONFIRMATION';state.pending.push(decision)}
      else if(choice.arm==='BASE'){decision.status='SHADOW_OPEN';const p={id:`position_${id}`,decision_id:id,symbol:decision.symbol,arm:'BASE',context:ctx,signal_at:decision.signal_at,opened_at:decision.signal_at,entry_price:round(decision.signal_price),highest_price:round(decision.signal_price),shadow_only:true,no_order_created:true};decision.position_id=p.id;state.positions.push(p);state.decisions.push(decision)}
      else{decision.status='SHADOW_SKIPPED';state.decisions.push(decision)}
      evidence.decision=decision;
    } else if(activeSameSymbol) {
      evidence.decision={symbol,arm:'NONE',status:'DEDUPED_ACTIVE_SYMBOL',context:null,shadow_only:true,no_order_created:true};
    }
  }

  prune(state,now);
  const recent=state.results.filter(x=>now-ms(x.closed_at)<30*86400000),sum=recent.reduce((s,x)=>s+n(x.net_return),0);
  evidence.summary={pending:state.pending.length,open_positions:state.positions.length,total_results:state.results.length,recent_30d_results:recent.length,recent_30d_win_rate:recent.length?recent.filter(x=>n(x.net_return)>0).length/recent.length:0,recent_30d_avg_net_return:recent.length?sum/recent.length:0};
  fs.writeFileSync(STATE_OUT,JSON.stringify(state,null,2));
  fs.writeFileSync(EVIDENCE_OUT,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({ok:true,...evidence.summary,decision:evidence.decision?{symbol:evidence.decision.symbol,arm:evidence.decision.arm,status:evidence.decision.status,context:evidence.decision.context}:null,shadow_only:true,no_order_created:true}));
}
main().catch(error=>{console.error(error.stack||error.message||String(error));process.exit(1)});
