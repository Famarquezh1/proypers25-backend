'use strict';

const BASE='https://data-api.binance.vision';
const BUDGET_USDT=100;
const SLOT_USDT=5;
const MAX_SLOTS=Math.floor(BUDGET_USDT/SLOT_USDT);
const PROBE=120;
const CONCURRENCY=10;
const HORIZON_BARS=36; // 3h on 5m bars
const COST=0.002; // conservative round-trip research friction
const MIN_ANALOGS=12;
const MIN_EXPECTED_NET=0.002;
const MIN_RR=1.35;
const MIN_CONTINUATION=0.45;

const V42_THRESHOLDS=[
  {i:0.904010256302157,c:0.30262335308700017,e:0.0333071863419859},
  {i:0.7912647052581232,c:0.36672756172128707,e:0.029510140018270917},
  {i:1.6626658194027173,c:0.43305908219072103,e:0.019614079751271593}
];

function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0}
function ret(a,b){return a>0?b/a-1:0}
function clamp(x,a,b){return Math.max(a,Math.min(b,x))}
function quantile(a,q){
  const x=a.filter(Number.isFinite).slice().sort((m,n)=>m-n);
  if(!x.length)return NaN;
  const p=(x.length-1)*q,lo=Math.floor(p),hi=Math.ceil(p);
  return lo===hi?x[lo]:x[lo]+(x[hi]-x[lo])*(p-lo);
}
function qsum(rows,i,n){let s=0;for(let k=Math.max(0,i-n+1);k<=i;k++)s+=rows[k].q;return s}
function firstHit(rows,i,entry,tp=.03,sl=.01){
  for(let k=i+1;k<=Math.min(rows.length-1,i+HORIZON_BARS);k++){
    const up=rows[k].h/entry-1,dn=rows[k].l/entry-1;
    if(up>=tp&&dn<=-sl)return null;
    if(up>=tp)return true;
    if(dn<=-sl)return false;
  }
  return false;
}
async function get(url){
  const c=new AbortController();const t=setTimeout(()=>c.abort(),25000);
  try{
    const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-batch-planner/1.0'}});
    if(!r.ok)throw new Error('HTTP '+r.status);
    return await r.json();
  }finally{clearTimeout(t)}
}
async function klines(symbol,limit=1000){
  const rows=await get(`${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=${limit}`);
  return rows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]}));
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let p=0;
  async function worker(){while(true){const i=p++;if(i>=items.length)return;try{out[i]=await fn(items[i])}catch(e){out[i]={error:String(e.message||e),symbol:items[i]?.symbol}}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
}
function features(sb,bb,i,bi){
  if(i<288||bi<48)return null;
  const c=sb[i].c;
  const r15=ret(sb[i-3].c,c),r30=ret(sb[i-6].c,c),r60=ret(sb[i-12].c,c),r240=ret(sb[i-48].c,c),r24=ret(sb[i-288].c,c);
  const base=avg(sb.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...sb.slice(i-12,i).map(x=>x.h)),ph240=Math.max(...sb.slice(i-48,i).map(x=>x.h));
  const vol15=base>0?qsum(sb,i,3)/(base/4):1,vol30=base>0?qsum(sb,i,6)/(base/2):1;
  const ta=sb[i].n/Math.max(1,avg(sb.slice(i-12,i).map(x=>x.n)));
  const br60=ph60>0?c/ph60-1:0,br240=ph240>0?c/ph240-1:0;
  const btc60=ret(bb[bi-12].c,bb[bi].c),btc240=ret(bb[bi-48].c,bb[bi].c);
  const rs60=r60-btc60,rs240=r240-btc240;
  const ignition=.9*Math.log(Math.max(.2,vol15))+.65*Math.log(Math.max(.2,ta))+.65*r15+.35*br60;
  const confirm=1.2*br60+.65*rs60+.35*Math.log(Math.max(.2,vol30))-.8*Math.max(0,r24-.10)-.5*Math.max(0,r60-.06);
  const extension=1.15*rs60+.75*rs240+.35*r30+.25*br240-.45*Math.max(0,r24-.12);
  const fresh=r24<.10&&r60<.10&&r15<.06;
  const passCount=fresh?V42_THRESHOLDS.filter(th=>ignition>=th.i&&confirm>=th.c&&extension>=th.e).length:0;
  const allPositive=fresh&&ignition>0&&confirm>0&&extension>0;
  let stage='NONE';
  if(allPositive)stage='PRECURSOR_BUILDING';
  if(passCount>=1)stage='PASS1_EARLY';
  if(passCount>=2)stage='PASS2_ESCALATED';
  if(passCount>=3)stage='CORE_FORMING';
  const score=(passCount*2)+(allPositive?1:0)+clamp(ignition/2,0,1)+clamp(confirm/.8,0,1)+clamp(extension/.12,0,1);
  return {price:c,r15,r30,r60,r24,ignition,confirm,extension,fresh,passCount,allPositive,stage,score};
}
function analogStats(sb,bb,current){
  const outcomes=[];
  const exact=[];
  const last=Math.min(sb.length-2,bb.length-2);
  for(let i=288;i<=last-HORIZON_BARS;i++){
    const f=features(sb,bb,i,i);
    if(!f||!f.allPositive)continue;
    const entry=sb[i].c;
    const future=sb.slice(i+1,i+HORIZON_BARS+1);
    if(future.length<HORIZON_BARS)continue;
    const mfe=Math.max(...future.map(x=>x.h))/entry-1;
    const mae=Math.min(...future.map(x=>x.l))/entry-1;
    const terminal=future[future.length-1].c/entry-1-COST;
    const row={mfe,mae,terminal,cont:firstHit(sb,i,entry)};
    outcomes.push(row);
    if(f.passCount===current.passCount)exact.push(row);
  }
  const rows=exact.length>=MIN_ANALOGS?exact:outcomes;
  if(rows.length<MIN_ANALOGS)return {n:rows.length,usable:false};
  const vals=k=>rows.map(x=>x[k]);
  const wins=rows.filter(x=>x.terminal>0).map(x=>x.terminal);
  const losses=rows.filter(x=>x.terminal<0).map(x=>x.terminal);
  return {
    n:rows.length,usable:true,exact_stage:exact.length>=MIN_ANALOGS,
    expected_net:avg(vals('terminal')),
    win_rate:rows.filter(x=>x.terminal>0).length/rows.length,
    continuation_rate:rows.filter(x=>x.cont===true).length/rows.length,
    mfe_q50:quantile(vals('mfe'),.50),
    mfe_q65:quantile(vals('mfe'),.65),
    mfe_q80:quantile(vals('mfe'),.80),
    mae_q25:quantile(vals('mae'),.25),
    mae_q50:quantile(vals('mae'),.50),
    profit_factor:losses.length?wins.reduce((a,b)=>a+b,0)/Math.abs(losses.reduce((a,b)=>a+b,0)):(wins.length?999:0)
  };
}
function exitPlan(current,stats,spreadPct){
  if(!stats.usable)return {eligible:false,reason:'INSUFFICIENT_ANALOGS'};
  const tp=clamp((stats.mfe_q65-COST/2)*100,1.5,current.passCount>=2?8:6);
  const stop=clamp(Math.abs(stats.mae_q25)*100*.75,.8,3.0);
  const rr=stop>0?tp/stop:0;
  const maxEntrySlippagePct=clamp(Math.max(.10,(spreadPct||0)*100*3),.10,.35);
  const tp2=current.passCount>=2?clamp((stats.mfe_q80-COST/2)*100,Math.max(tp+1,3),12):null;
  const eligible=stats.expected_net>=MIN_EXPECTED_NET&&stats.continuation_rate>=MIN_CONTINUATION&&rr>=MIN_RR&&stats.profit_factor>1;
  const confidence=clamp(
    .25*Math.min(1,stats.n/40)+
    .25*Math.min(1,Math.max(0,stats.expected_net)/.02)+
    .20*Math.min(1,stats.continuation_rate/.7)+
    .15*Math.min(1,stats.win_rate/.7)+
    .15*Math.min(1,rr/3),0,1);
  return {
    eligible,
    reason:eligible?'EMPIRICAL_EDGE_ACCEPTED':'EDGE_GATE_REJECTED',
    entry_usdt:SLOT_USDT,
    max_entry_slippage_pct:+maxEntrySlippagePct.toFixed(3),
    take_profit_pct:+tp.toFixed(3),
    take_profit_2_pct:Number.isFinite(tp2)?+tp2.toFixed(3):null,
    stop_loss_pct:+(-stop).toFixed(3),
    timeout_minutes:180,
    reward_risk:+rr.toFixed(3),
    confidence:+confidence.toFixed(4),
    invalidation:'cancel before batch if stage becomes NONE or price exceeds max-entry slippage; after entry obey frozen TP/SL/timeout'
  };
}
async function main(){
  const [ticks,info,btc,books]=await Promise.all([
    get(`${BASE}/api/v3/ticker/24hr`),
    get(`${BASE}/api/v3/exchangeInfo`),
    klines('BTCUSDT',1000),
    get(`${BASE}/api/v3/ticker/bookTicker`)
  ]);
  const bookMap=new Map((books||[]).map(x=>[x.symbol,x]));
  const active=new Set((info.symbols||[]).filter(x=>x.status==='TRADING'&&x.isSpotTradingAllowed!==false).map(x=>x.symbol));
  const eligible=(ticks||[]).map(x=>({symbol:String(x.symbol||''),pct:+x.priceChangePercent||0,qv:+x.quoteVolume||0,price:+x.lastPrice||0}))
    .filter(x=>active.has(x.symbol)&&x.symbol.endsWith('USDT')&&!/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol)&&x.price>0&&x.pct>=.25&&x.pct<50&&x.qv>=200000)
    .sort((a,b)=>(b.qv*(1+Math.max(0,b.pct)/12))-(a.qv*(1+Math.max(0,a.pct)/12))).slice(0,PROBE);

  const scanned=await mapLimit(eligible,CONCURRENCY,async x=>{
    const sb=await klines(x.symbol,1000);
    const i=sb.length-2,bi=Math.min(btc.length-2,i);
    const f=features(sb,btc,i,bi);
    if(!f)return null;
    const continuationLane = f.stage==='NONE' && x.pct>=5 && x.pct<50 && f.r15>0 && f.r60>0;
    if(f.stage==='NONE' && !continuationLane)return null;
    const observedStage = continuationLane ? 'WINNER_CONTINUATION' : f.stage;
    const observed = {...f,stage:observedStage,allPositive: continuationLane ? true : f.allPositive};
    const stats=analogStats(sb,btc,observed);
    const b=bookMap.get(x.symbol)||{};
    const bid=+b.bidPrice||0,ask=+b.askPrice||0,mid=bid>0&&ask>0?(bid+ask)/2:0;
    const spread=mid>0?(ask-bid)/mid:0;
    const plan=exitPlan(observed,stats,spread);
    return {...x,...observed,lane:continuationLane?'WINNER_CONTINUATION':'PRE_CORE',stats,plan,spreadPct:spread};
  });

  const observed=scanned.filter(x=>x);
  const candidates=observed.filter(x=>x.plan?.eligible)
    .sort((a,b)=>(b.plan.confidence-a.plan.confidence)||(b.score-a.score))
    .slice(0,MAX_SLOTS);

  const rejected=observed.filter(x=>!x.plan?.eligible)
    .map(x=>({
      symbol:x.symbol,lane:x.lane,stage:x.stage,passCount:x.passCount,pct24h:+x.pct.toFixed(3),score:+x.score.toFixed(4),
      analogs:x.stats?.n||0,usable:x.stats?.usable===true,
      expected_net_pct:x.stats?.usable?+(x.stats.expected_net*100).toFixed(3):null,
      continuation_rate_pct:x.stats?.usable?+(x.stats.continuation_rate*100).toFixed(2):null,
      profit_factor:x.stats?.usable?+Number(x.stats.profit_factor).toFixed(3):null,
      reward_risk:x.plan?.reward_risk??null,
      reason:x.plan?.reason||'NO_PLAN'
    }))
    .sort((a,b)=>(b.score-a.score));

  const generatedAt=new Date().toISOString();
  const batchId='precore-batch-'+generatedAt.replace(/[:.]/g,'-');
  const slots=candidates.map((x,idx)=>({
    slot:idx+1,symbol:x.symbol,lane:x.lane,stage:x.stage,passCount:x.passCount,
    planned_entry_usdt:SLOT_USDT,reference_price:x.price,
    max_entry_price:+(x.price*(1+x.plan.max_entry_slippage_pct/100)).toPrecision(10),
    tp1_price:+(x.price*(1+x.plan.take_profit_pct/100)).toPrecision(10),
    tp2_price:x.plan.take_profit_2_pct===null?null:+(x.price*(1+x.plan.take_profit_2_pct/100)).toPrecision(10),
    stop_price:+(x.price*(1+x.plan.stop_loss_pct/100)).toPrecision(10),
    ...x.plan,
    analogs:x.stats.n,analog_exact_stage:x.stats.exact_stage,
    expected_net_pct:+(x.stats.expected_net*100).toFixed(3),
    win_rate_pct:+(x.stats.win_rate*100).toFixed(2),
    continuation_rate_pct:+(x.stats.continuation_rate*100).toFixed(2),
    profit_factor:+Number(x.stats.profit_factor).toFixed(3),
    observed_pct24h:+x.pct.toFixed(3),
    score:+x.score.toFixed(4)
  }));

  const result={
    ok:true,mode:'PRE_CORE_BATCH_PLANNER_V1',research_only:true,shadow_only:true,no_order_created:true,production_action:'NONE',
    generated_at:generatedAt,batch_id:batchId,
    budget_usdt:BUDGET_USDT,slot_usdt:SLOT_USDT,max_slots:MAX_SLOTS,
    observed_candidates:observed.length,observed_precursors:observed.filter(x=>x.lane==='PRE_CORE').length,observed_live_winners:observed.filter(x=>x.lane==='WINNER_CONTINUATION').length,planned_slots:slots.length,planned_capital_usdt:slots.length*SLOT_USDT,cash_unallocated_usdt:BUDGET_USDT-slots.length*SLOT_USDT,
    batch_rule:'observe both pre-CORE and already-rising winner-continuation lanes; freeze candidate set and individual exits before any execution; do not fill weak slots merely to reach 20',
    decision_gate:{min_analogs:MIN_ANALOGS,min_expected_net_pct:MIN_EXPECTED_NET*100,min_reward_risk:MIN_RR,min_continuation_rate_pct:MIN_CONTINUATION*100,cost_pct:COST*100},
    rejection_summary:rejected.reduce((o,x)=>(o[x.reason]=(o[x.reason]||0)+1,o),{}),
    top_rejected:rejected.slice(0,30),
    slots
  };
  console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
