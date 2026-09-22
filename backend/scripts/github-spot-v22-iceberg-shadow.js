'use strict';

const fs=require('fs');

const SCAN_PATH=process.argv[2]||'spot-radar-scan.json';
const PREV_PATH=process.argv[3]||'';
const STATE_OUT=process.argv[4]||'spot-v22-iceberg-state.json';
const EVIDENCE_OUT=process.argv[5]||'spot-v22-iceberg-evidence.json';

const COST=.004;
const EXIT={hardStop:.04,takeProfit:.06,timeoutMinutes:8*60};
const LANES={
  CORE_ALL:{mode:'IMMEDIATE'},
  STRICT_V21:{mode:'CONFIRM',retScale:1,closeDelta:0,minVol:.70},
  BALANCED:{mode:'CONFIRM',retScale:.75,closeDelta:-.05,minVol:.55},
  EXPLORATORY:{mode:'CONFIRM',retScale:.25,closeDelta:-.15,minVol:.35},
  RESCUE_V23:{mode:'RESCUE',retScale:.75,closeDelta:-.05,minVol:.55,ignitionMax:1.38}
};
const BASE_CONFIRM={extCut:.07,lowRet:.003,highRet:.008,maxDraw:-.04,lowClose:.35,highClose:.50};

function n(v,f=0){const x=Number(v);return Number.isFinite(x)?x:f}
function avg(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:0}
function iso(v=Date.now()){return new Date(v).toISOString()}
function ms(v){const x=new Date(v||0).getTime();return Number.isFinite(x)?x:0}
function round(v,d=8){if(!Number.isFinite(v))return null;const p=10**d;return Math.round(v*p)/p}
function loadJson(file,fallback){if(!file||!fs.existsSync(file))return fallback;try{return JSON.parse(fs.readFileSync(file,'utf8'))}catch{return fallback}}
function context(parts){const e=n(parts?.extension),c=n(parts?.confirm);return `${e<.055?'E0':e<.085?'E1':'E2'}_${c<.42?'C0':'C1'}`}

async function fetchJson(url){
  const ctrl=new AbortController();const timer=setTimeout(()=>ctrl.abort(),12000);
  try{const r=await fetch(url,{signal:ctrl.signal,headers:{'user-agent':'proypers25-v22-iceberg-shadow/1.0'}});if(!r.ok)throw new Error(`HTTP_${r.status}`);return await r.json()}
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
function emptyLane(){return {pending:[],positions:[],results:[],decisions:[]}}
function normalizeState(prev){
  const lanes={};
  for(const name of Object.keys(LANES)){
    const p=prev?.lanes?.[name]||{};
    lanes[name]={pending:Array.isArray(p.pending)?p.pending:[],positions:Array.isArray(p.positions)?p.positions:[],results:Array.isArray(p.results)?p.results:[],decisions:Array.isArray(p.decisions)?p.decisions:[]};
  }
  return {version:'V22_ICEBERG_DEPTH_SHADOW_1',updated_at:iso(),lanes};
}
function confirmationThresholds(extension,lane){
  const high=extension>BASE_CONFIRM.extCut;
  return {
    ret:(high?BASE_CONFIRM.highRet:BASE_CONFIRM.lowRet)*lane.retScale,
    close:Math.max(0,(high?BASE_CONFIRM.highClose:BASE_CONFIRM.lowClose)+lane.closeDelta),
    minVol:lane.minVol,
    maxDraw:BASE_CONFIRM.maxDraw
  };
}
function evaluateConfirmation(bars,signalPrice,extension,now,lane){
  const closed=bars.filter(b=>b.closeTime<=now-15000);
  if(!closed.length||!(signalPrice>0))return {ready:false,passed:false,reason:'CONFIRMATION_DATA_PENDING'};
  const bar=closed[closed.length-1],idx=bars.indexOf(bar),prev=bars.slice(Math.max(0,idx-6),idx);
  const rg=Math.max(1e-12,bar.h-bar.l),ret=bar.c/signalPrice-1,draw=bar.l/signalPrice-1,close=(bar.c-bar.l)/rg,baseVol=avg(prev.map(x=>x.q)),vol=baseVol>0?bar.q/baseVol:1;
  const th=confirmationThresholds(extension,lane);
  const passed=ret>=th.ret&&draw>=th.maxDraw&&close>=th.close&&vol>=th.minVol;
  return {ready:true,passed,ret,draw,close_location:close,volume_ratio:vol,thresholds:th,bar_close_time:iso(bar.closeTime),entry_price:bar.c};
}
function evaluateExit(position,bars,lastPrice,now){
  const entry=n(position.entry_price),opened=ms(position.opened_at),stop=entry*(1-EXIT.hardStop);
  let highest=n(position.highest_price,entry);
  for(const b of bars){
    highest=Math.max(highest,b.h);
    const sl=b.l<=stop,tp=b.h>=entry*(1+EXIT.takeProfit);
    if(sl&&tp)return {reason:'AMBIGUOUS_STOP_FIRST',price:stop,highest,stop};
    if(sl)return {reason:'HARD_STOP',price:stop,highest,stop};
    if(tp)return {reason:'TAKE_PROFIT',price:entry*(1+EXIT.takeProfit),highest,stop};
  }
  if(opened&&now-opened>=EXIT.timeoutMinutes*60000&&lastPrice>0)return {reason:'TIMEOUT',price:lastPrice,highest,stop};
  return {reason:null,price:null,highest,stop};
}
async function updatePositions(laneName,laneState,now,evidence){
  const keep=[];
  for(const p of laneState.positions){
    try{
      const [bars,last]=await Promise.all([klines(p.symbol,240,ms(p.opened_at),now),tickerPrice(p.symbol)]);
      const ev=evaluateExit(p,bars,last,now);
      p.highest_price=round(ev.highest);p.latest_price=round(last);p.updated_at=iso(now);
      if(!ev.reason){keep.push(p);continue}
      const gross=ev.price/n(p.entry_price)-1,net=gross-COST;
      const r={id:`result_${p.id}`,lane:laneName,source:p.source||null,position_id:p.id,signal_id:p.signal_id,symbol:p.symbol,context:p.context,signal_at:p.signal_at,opened_at:p.opened_at,closed_at:iso(now),exit_reason:ev.reason,entry_price:p.entry_price,exit_price:round(ev.price),gross_return:gross,net_return:net,shadow_only:true,no_order_created:true};
      laneState.results.push(r);evidence.closed.push(r);
    }catch(error){keep.push(p);evidence.errors.push({stage:'UPDATE_POSITION',lane:laneName,symbol:p.symbol,error:error.message})}
  }
  laneState.positions=keep;
}
async function resolvePending(laneName,laneState,laneCfg,now,evidence){
  const keep=[];
  for(const d of laneState.pending){
    if(now-ms(d.signal_at)<5*60000){keep.push(d);continue}
    try{
      const bars=await klines(d.symbol,12,ms(d.signal_at)-30*60000,now);
      const cf=evaluateConfirmation(bars,n(d.signal_price),n(d.v42?.extension),now,laneCfg);
      if(!cf.ready){keep.push(d);continue}
      if(laneCfg.mode==='RESCUE'){
        const strict=evaluateConfirmation(bars,n(d.signal_price),n(d.v42?.extension),now,LANES.STRICT_V21);
        d.strict_counterfactual=strict;
        if(strict.ready&&strict.passed){d.status='RESCUE_SKIPPED_STRICT_ACCEPTED';d.confirmation=cf;d.resolved_at=iso(now);laneState.decisions.push(d);evidence.resolved.push({lane:laneName,signal_id:d.id,symbol:d.symbol,status:d.status,strict_counterfactual:strict});continue}
      }
      d.confirmation=cf;d.resolved_at=iso(now);
      if(!cf.passed){d.status='SHADOW_REJECTED';laneState.decisions.push(d);evidence.resolved.push({lane:laneName,signal_id:d.id,symbol:d.symbol,status:d.status,confirmation:cf});continue}
      const entry=n(cf.entry_price)||await tickerPrice(d.symbol);
      const p={id:`position_${laneName}_${d.id}`,signal_id:d.id,lane:laneName,source:d.source||null,symbol:d.symbol,context:d.context,signal_at:d.signal_at,opened_at:iso(now),entry_price:round(entry),highest_price:round(entry),shadow_only:true,no_order_created:true};
      laneState.positions.push(p);d.status='SHADOW_OPEN';d.position_id=p.id;laneState.decisions.push(d);evidence.resolved.push({lane:laneName,signal_id:d.id,symbol:d.symbol,status:d.status,position_id:p.id,confirmation:cf});
    }catch(error){keep.push(d);evidence.errors.push({stage:'RESOLVE_PENDING',lane:laneName,symbol:d.symbol,error:error.message})}
  }
  laneState.pending=keep;
}
function laneSummary(s,now){
  const recent=s.results.filter(x=>now-ms(x.closed_at)<30*86400000);
  const avgNet=recent.length?recent.reduce((a,x)=>a+n(x.net_return),0)/recent.length:0;
  return {pending:s.pending.length,open:s.positions.length,closed:recent.length,win_rate:recent.length?recent.filter(x=>n(x.net_return)>0).length/recent.length:0,avg_net_return:avgNet};
}
function pruneLane(s,now){
  s.results=s.results.filter(x=>now-ms(x.closed_at)<70*86400000).slice(-1000);
  s.decisions=s.decisions.filter(x=>now-ms(x.signal_at)<30*86400000).slice(-2000);
}
async function addCandidateToLanes(candidate,source,state,now,evidence){
  if(!candidate||!candidate.symbol||!(n(candidate.price)>0)||!candidate.v42_detail)return null;
  const symbol=String(candidate.symbol).toUpperCase(),bucket=Math.floor(now/(5*60000)),ctx=context(candidate.v42_detail);
  const matrix={source,stage:candidate.stage||null,reasons:Array.isArray(candidate.reasons)?candidate.reasons:[],symbol,signal_price:n(candidate.price),context:ctx,lanes:{}};
  for(const [name,cfg] of Object.entries(LANES)){
    const s=state.lanes[name],id=`v22_${name}_${source}_${symbol}_${bucket}`;
    const active=s.pending.concat(s.positions).some(x=>String(x.symbol||'').toUpperCase()===symbol);
    const seen=s.pending.concat(s.positions,s.decisions).some(x=>x.id===id||x.signal_id===id);
    if(active){matrix.lanes[name]={status:'DEDUPED_ACTIVE_SYMBOL'};continue}
    if(seen){matrix.lanes[name]={status:'SEEN_BUCKET'};continue}
    const d={id,lane:name,source,source_stage:candidate.stage||null,source_reasons:Array.isArray(candidate.reasons)?candidate.reasons:[],symbol,signal_at:iso(now),signal_price:n(candidate.price),context:ctx,v42:{ignition:n(candidate.v42_detail.ignition),confirm:n(candidate.v42_detail.confirm),extension:n(candidate.v42_detail.extension),r15:n(candidate.v42_detail.r15),r60:n(candidate.v42_detail.r60),r24:n(candidate.v42_detail.r24)},shadow_only:true,no_order_created:true};
    if(cfg.mode==='RESCUE'){
      const ignition=d.v42.ignition;
      if(!(ignition<=cfg.ignitionMax)){d.status='RESCUE_FILTERED_IGNITION';s.decisions.push(d);matrix.lanes[name]={status:d.status,ignition,ignition_max:cfg.ignitionMax};continue}
      d.rescue_rule={frozen:true,ignition_max:cfg.ignitionMax,requires_strict_reject:true};
    }
    if(cfg.mode==='IMMEDIATE'){
      const p={id:`position_${name}_${id}`,signal_id:id,lane:name,source,symbol,context:ctx,signal_at:d.signal_at,opened_at:d.signal_at,entry_price:round(d.signal_price),highest_price:round(d.signal_price),shadow_only:true,no_order_created:true};
      d.status='SHADOW_OPEN';d.position_id=p.id;s.positions.push(p);s.decisions.push(d);evidence.opened.push({lane:name,source,symbol,position_id:p.id,entry_price:p.entry_price});matrix.lanes[name]={status:d.status};
    }else{
      d.status='PENDING_CONFIRMATION';d.thresholds=confirmationThresholds(n(candidate.v42_detail.extension),cfg);s.pending.push(d);matrix.lanes[name]={status:d.status,thresholds:d.thresholds};
    }
  }
  return matrix;
}

async function main(){
  const now=Date.now(),scan=loadJson(SCAN_PATH,{}),prev=loadJson(PREV_PATH,{});
  const state=normalizeState(prev);state.updated_at=iso(now);
  const evidence={version:state.version,generated_at:iso(now),shadow_only:true,no_order_created:true,production_action:'NONE',scan_notify:scan.notify===true,scan_symbol:scan.symbol||null,resolved:[],closed:[],opened:[],decision_matrix:null,errors:[]};

  for(const [name,cfg] of Object.entries(LANES)){
    await updatePositions(name,state.lanes[name],now,evidence);
    if(cfg.mode==='CONFIRM'||cfg.mode==='RESCUE')await resolvePending(name,state.lanes[name],cfg,now,evidence);
  }

  const matrices=[];
  if(scan.notify===true&&scan.symbol&&n(scan.price)>0&&scan.v42_detail){
    const m=await addCandidateToLanes({symbol:scan.symbol,price:scan.price,v42_detail:scan.v42_detail,stage:'PRODUCTION_SELECTED',reasons:[]},'VISIBLE_SELECTED',state,now,evidence);
    if(m)matrices.push(m);
  }
  const deep=(Array.isArray(scan.learning_rejections)?scan.learning_rejections:[])
    .filter(x=>x&&x.symbol&&n(x.price)>0&&x.v42_detail&&['V42_PRE_APPROVAL','PRODUCTION_QUALITY_GATE','QUBO_SELECTION'].includes(String(x.stage||'')))
    .sort((a,b)=>n(b.utility)-n(a.utility))
    .slice(0,2);
  for(const candidate of deep){
    const m=await addCandidateToLanes(candidate,'DEEP_REJECTION',state,now,evidence);
    if(m)matrices.push(m);
  }
  evidence.decision_matrices=matrices;
  evidence.decision_matrix=matrices[0]||null;

  const summary={};
  for(const [name,s] of Object.entries(state.lanes)){pruneLane(s,now);summary[name]=laneSummary(s,now)}
  evidence.summary=summary;
  fs.writeFileSync(STATE_OUT,JSON.stringify(state,null,2));
  fs.writeFileSync(EVIDENCE_OUT,JSON.stringify(evidence,null,2));
  console.log(JSON.stringify({ok:true,summary,decision_matrix:evidence.decision_matrix,shadow_only:true,no_order_created:true}));
}
main().catch(error=>{console.error(error.stack||error.message||String(error));process.exit(1)});
