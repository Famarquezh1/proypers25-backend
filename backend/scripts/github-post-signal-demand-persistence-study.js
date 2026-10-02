'use strict';

/**
 * Cohort 4 — realized-trade continuation gate.
 *
 * Goal: after a real production signal but before a future entry, identify a
 * short early-path condition that preserves as many real winners as possible
 * while rejecting a material share of real losers.
 *
 * Labels come ONLY from real [SPOT EXIT] issues matched to the exact executed
 * entry orderId. Features use only the first 5 minutes after the signal.
 * Candidate selection uses discovery/validation; holdout is opened once.
 *
 * Research/shadow only. No credentials, no orders.
 */

const GH='https://api.github.com';
const BIN='https://api.binance.com';
const TOKEN=process.env.GITHUB_TOKEN;
const OBS=5;
const MAX_SIGNALS=350;
const COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}){
  for(let i=0;i<5;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-RealizedGate/1.0',...headers}});
    const text=await r.text();
    let body; try{body=text?JSON.parse(text):{}}catch{body={raw:text}}
    if(r.ok)return body;
    if(r.status===429||r.status>=500){await sleep(350*(i+1));continue;}
    throw Error(r.status+' '+url+' '+String(body.message||body.raw||''));
  }
  throw Error('fetch failed '+url);
}
const ghHeaders=()=>({Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
function n(v,d=NaN){const x=Number(v);return Number.isFinite(x)?x:d}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function median(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
function symbolOf(x){return ((String(x.title||'')+'\n'+String(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null}
function orderIdFromComments(comments){
  const text=(comments||[]).map(x=>String(x.body||'')).join('\n');
  if(!/ejecut[oó] la compra Spot|compra Spot.*orderId|protecci[oó]n nativa fue armada/i.test(text))return null;
  return (text.match(/orderId:\s*([0-9]+)/i)||[])[1]||null;
}
function parseExit(issue){
  const b=String(issue.body||'');
  const symbol=(b.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi)||[])[1]||null;
  const entryOrderId=(b.match(/^- entryOrderId=([0-9]+)\s*$/mi)||[])[1]||null;
  const pnl=n((b.match(/^- PnL aprox\.:\s*([+-]?[0-9.]+)%/mi)||[])[1]);
  const entry=n((b.match(/^- Entrada aprox\.:\s*([0-9.eE+-]+)/mi)||[])[1]);
  const exit=n((b.match(/^- Salida aprox\.:\s*([0-9.eE+-]+)/mi)||[])[1]);
  const reason=(b.match(/^- Motivo:\s*(.+)$/mi)||[])[1]||'UNKNOWN';
  if(!symbol||!entryOrderId||!Number.isFinite(pnl))return null;
  return {issue:issue.number,created_at:issue.created_at,symbol,entry_order_id:String(entryOrderId),pnl_pct:pnl,entry_price:entry,exit_price:exit,reason};
}
async function loadExitMap(){
  const all=[];
  const q=encodeURIComponent('repo:Famarquezh1/proypers25-backend is:issue in:title "[SPOT EXIT]"');
  for(let page=1;page<=4;page++){
    const d=await json(GH+'/search/issues?q='+q+'&sort=created&order=desc&per_page=100&page='+page,ghHeaders());
    all.push(...(d.items||[]));
    if((d.items||[]).length<100)break;
  }
  const map=new Map();
  for(const issue of all){
    const x=parseExit(issue); if(!x)continue;
    if(!map.has(x.entry_order_id)||Date.parse(x.created_at)>Date.parse(map.get(x.entry_order_id).created_at))map.set(x.entry_order_id,x);
  }
  return map;
}
async function loadSignals(){
  let issues=[];
  for(let p=1;p<=12;p++){
    const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',ghHeaders());
    issues.push(...a.filter(x=>!x.pull_request));
    if(a.length<100)break;
  }
  return issues
    .filter(x=>/\[SPOT SIGNAL\]/i.test(String(x.title||''))||/SPOT SIGNAL/i.test(String(x.body||'')))
    .map(x=>({issue:x.number,symbol:symbolOf(x),t:Date.parse(x.created_at),created_at:x.created_at,title:x.title}))
    .filter(x=>x.symbol&&Number.isFinite(x.t))
    .sort((a,b)=>b.t-a.t)
    .slice(0,MAX_SIGNALS)
    .sort((a,b)=>a.t-b.t);
}
async function comments(issue){return json(GH+'/repos/Famarquezh1/proypers25-backend/issues/'+issue+'/comments?per_page=100',ghHeaders())}
async function klines(symbol,start,end){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit:30}))u.searchParams.set(k,v);
  return json(u);
}
function obsFeatures(k){
  const open=+k[0][1], closes=k.map(r=>+r[4]), highs=k.map(r=>+r[2]), lows=k.map(r=>+r[3]);
  const last=closes.at(-1), hi=Math.max(...highs), lo=Math.min(...lows);
  let maxSeen=open,worstPullback=0,recoveryEvents=0,downEvents=0;
  for(let i=0;i<closes.length;i++){
    maxSeen=Math.max(maxSeen,highs[i]);
    if(maxSeen>0)worstPullback=Math.min(worstPullback,lows[i]/maxSeen-1);
    if(i>0&&closes[i]<closes[i-1]){
      downEvents++;
      if(i+1<closes.length&&closes[i+1]>closes[i])recoveryEvents++;
    }
  }
  const range=hi-lo;
  return {
    retention:hi>open?(last-open)/(hi-open):0,
    close_location:range>0?(last-lo)/range:.5,
    drawdown_from_peak:hi>0?last/hi-1:0,
    worst_pullback:worstPullback,
    recovery_ratio:downEvents?recoveryEvents/downEvents:1,
    low_breach:open>0?lo/open-1:0,
    obs_return:open>0?last/open-1:0
  };
}
function summarize(rows){
  const wins=rows.filter(x=>x.actual_pnl_pct>0);
  const losses=rows.filter(x=>x.actual_pnl_pct<0);
  return {
    n:rows.length,wins:wins.length,losses:losses.length,
    win_rate:rows.length?wins.length/rows.length:null,
    avg_actual_pnl_pct:avg(rows.map(x=>x.actual_pnl_pct)),
    median_actual_pnl_pct:median(rows.map(x=>x.actual_pnl_pct)),
    avg_delayed_entry_return_pct:avg(rows.map(x=>x.delayed_entry_return_pct).filter(Number.isFinite))
  };
}
function evalKeep(base,kept){
  const b=summarize(base), k=summarize(kept);
  const totalWins=b.wins,totalLosses=b.losses;
  const winnerRetention=totalWins?kept.filter(x=>x.actual_pnl_pct>0).length/totalWins:0;
  const lossRejection=totalLosses?(totalLosses-kept.filter(x=>x.actual_pnl_pct<0).length)/totalLosses:0;
  return {
    summary:k,
    winner_retention:winnerRetention,
    loss_rejection:lossRejection,
    delta_win_rate:k.win_rate-b.win_rate,
    delta_avg_pnl_pct:k.avg_actual_pnl_pct-b.avg_actual_pnl_pct,
    delta_delayed_return_pct:k.avg_delayed_entry_return_pct-b.avg_delayed_entry_return_pct
  };
}

(async()=>{
  if(!TOKEN)throw Error('GITHUB_TOKEN required');
  const [signals,exitMap]=await Promise.all([loadSignals(),loadExitMap()]);
  const matched=[];
  for(const s of signals){
    try{
      const cs=await comments(s.issue);
      const oid=orderIdFromComments(cs);
      if(!oid)continue;
      const exit=exitMap.get(String(oid));
      if(!exit||exit.symbol!==s.symbol)continue;
      const k=await klines(s.symbol,s.t,s.t+(OBS+3)*60000);
      if(!Array.isArray(k)||k.length<OBS+1)continue;
      const f=obsFeatures(k.slice(0,OBS));
      const delayedEntry=+k[OBS][1];
      const delayedReturn=Number.isFinite(exit.exit_price)&&delayedEntry>0?(exit.exit_price/delayedEntry-1-COST)*100:null;
      matched.push({...s,...f,entry_order_id:String(oid),actual_pnl_pct:exit.pnl_pct,exit_reason:exit.reason,exit_at:exit.created_at,delayed_entry_price:delayedEntry,delayed_entry_return_pct:delayedReturn});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(15);
  }
  matched.sort((a,b)=>a.t-b.t);
  if(matched.length<35)throw Error('insufficient realized trades '+matched.length);

  const a=Math.floor(matched.length*.60), b=Math.floor(matched.length*.80);
  const discovery=matched.slice(0,a),validation=matched.slice(a,b),holdout=matched.slice(b);
  const features=['retention','close_location','drawdown_from_peak','worst_pullback','recovery_ratio','low_breach','obs_return'];
  const thresholds=Object.fromEntries(features.map(feature=>[feature,median(discovery.map(x=>x[feature]).filter(Number.isFinite))]));

  const singles=[];
  for(const feature of features){
    for(const dir of ['hi','lo']){
      const threshold=thresholds[feature];
      singles.push({label:feature+'_'+dir,terms:[{feature,dir,threshold}],fn:x=>dir==='hi'?x[feature]>=threshold:x[feature]<threshold});
    }
  }
  const rules=[...singles];
  for(let i=0;i<singles.length;i++){
    for(let j=i+1;j<singles.length;j++){
      const x=singles[i],y=singles[j];
      if(x.terms[0].feature===y.terms[0].feature)continue;
      rules.push({label:x.label+'__AND__'+y.label,terms:[...x.terms,...y.terms],fn:r=>x.fn(r)&&y.fn(r)});
    }
  }

  const vb=summarize(validation), hb=summarize(holdout);
  const candidates=rules.map(rule=>{
    const kept=validation.filter(rule.fn);
    const ev=evalKeep(validation,kept);
    const eligible=Boolean(
      kept.length>=Math.max(6,Math.floor(validation.length*.30)) &&
      ev.winner_retention>=.50 &&
      ev.loss_rejection>=.20 &&
      ev.delta_win_rate>0 &&
      ev.delta_avg_pnl_pct>0
    );
    const score=eligible
      ? ev.delta_avg_pnl_pct + ev.delta_win_rate*2 + ev.loss_rejection*.5 + ev.winner_retention*.25
      : -Infinity;
    return {label:rule.label,terms:rule.terms,validation:ev,eligible,score,fn:rule.fn};
  }).sort((x,y)=>y.score-x.score);

  const selected=candidates.find(x=>x.eligible)||null;
  let holdoutResult=null,promote=false;
  if(selected){
    const kept=holdout.filter(selected.fn);
    const ev=evalKeep(holdout,kept);
    promote=Boolean(
      kept.length>=Math.max(4,Math.floor(holdout.length*.25)) &&
      ev.winner_retention>=.50 &&
      ev.loss_rejection>0 &&
      ev.delta_win_rate>0 &&
      ev.delta_avg_pnl_pct>0
    );
    holdoutResult={label:selected.label,terms:selected.terms,holdout:ev,pass:promote};
  }

  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'REALIZED_TRADE_CONTINUATION_GATE_COHORT_4',
    objective:'preserve real winners while rejecting real losers before a future entry',
    observation_minutes:OBS,
    realized_trades:matched.length,
    blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    baselines:{validation:vb,holdout:hb},
    frozen_thresholds:thresholds,
    candidate_count:candidates.length,
    top_validation_candidates:candidates.slice(0,10).map(({fn,...x})=>x),
    selected_rule:selected?(({fn,...x})=>x)(selected):null,
    holdout_result:holdoutResult,
    production_decision:promote?'PROMOTE_TO_SHADOW':'DO_NOT_PROMOTE',
    promote_to_shadow:promote,
    note:'A passing rule remains shadow-only; production entry logic is unchanged.'
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});