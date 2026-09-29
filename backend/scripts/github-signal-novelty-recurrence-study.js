'use strict';

/**
 * Historical causal study: signal novelty / recurrence.
 * Uses only information known at signal time:
 *  - minutes since prior signal for same symbol
 *  - count of same-symbol signals in prior 6h / 24h
 *  - whether this is first signal for symbol in prior 24h
 * Labels use public Binance future klines after the signal.
 * No trading credentials, no orders.
 */

const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}) {
  for(let i=0;i<5;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-SignalNovelty/1.0',...headers}});
    if(r.ok) return r.json();
    if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}
    throw Error(r.status+' '+url);
  }
  throw Error('fetch failed '+url);
}
function symbolOf(x){
  return ((x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null;
}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function median(a){
  if(!a.length)return null;
  const s=[...a].sort((x,y)=>x-y);
  return s[Math.floor(s.length/2)];
}
function summarize(a){
  return {
    n:a.length,
    continuator_rate:a.length?a.filter(x=>x.continuator).length/a.length:null,
    hit3:a.length?a.filter(x=>x.hit3).length/a.length:null,
    hit5:a.length?a.filter(x=>x.hit5).length/a.length:null,
    avg_net4h:avg(a.map(x=>x.net4h)),
    avg_mfe:avg(a.map(x=>x.mfe)),
    avg_mae:avg(a.map(x=>x.mae))
  };
}
async function outcome(symbol,t){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(k,v);
  const k=await json(u);
  if(!Array.isArray(k)||k.length<61)return null;
  const entry=+k[0][1]; if(!(entry>0))return null;
  let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
  for(let i=1;i<k.length;i++){
    const hi=+k[i][2]/entry-1,lo=+k[i][3]/entry-1;
    mfe=Math.max(mfe,hi); mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03)first3=i;
    if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
  }
  const close=+k[Math.min(H,k.length-1)][4];
  return {
    mfe,mae,net4h:close/entry-1-COST,
    hit3:mfe>=.03,hit5:mfe>=.05,
    continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)
  };
}

(async()=>{
  let issues=[];
  for(let p=1;p<=10;p++){
    const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=asc';
    const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
    issues.push(...a.filter(x=>!x.pull_request));
    if(a.length<100)break;
  }

  const sig=issues
    .filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||''))
    .map(x=>({issue:x.number,symbol:symbolOf(x),t:Date.parse(x.created_at)}))
    .filter(x=>x.symbol&&Number.isFinite(x.t))
    .sort((a,b)=>a.t-b.t)
    .slice(-600);

  const history=new Map(), enriched=[];
  for(const s of sig){
    const prev=history.get(s.symbol)||[];
    const prior6=prev.filter(t=>s.t-t<=6*3600000);
    const prior24=prev.filter(t=>s.t-t<=24*3600000);
    const gapMin=prev.length?(s.t-prev[prev.length-1])/60000:1e9;
    enriched.push({...s,gap_min:gapMin,prior6:prior6.length,prior24:prior24.length,first24:prior24.length===0});
    prev.push(s.t); history.set(s.symbol,prev);
  }

  const rows=[];
  for(const s of enriched){
    try{
      const o=await outcome(s.symbol,s.t);
      if(o)rows.push({...s,...o});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(20);
  }
  rows.sort((a,b)=>a.t-b.t);
  if(rows.length<180)throw new Error('insufficient rows '+rows.length);

  const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,a), validation=rows.slice(a,b), holdout=rows.slice(b);

  // Freeze thresholds from discovery only.
  const finiteGaps=discovery.filter(x=>Number.isFinite(x.gap_min)&&x.gap_min<1e8).map(x=>x.gap_min);
  const gapMedian=median(finiteGaps);
  const prior24Median=median(discovery.map(x=>x.prior24));

  const rules=[
    {id:'FIRST_24H', fn:x=>x.first24},
    {id:'LONG_GAP', fn:x=>x.gap_min>=gapMedian},
    {id:'LOW_RECURRENCE_24H', fn:x=>x.prior24<=prior24Median},
    {id:'FIRST24_AND_LONG_GAP', fn:x=>x.first24&&x.gap_min>=gapMedian},
    {id:'LOW_RECURRENCE_AND_LONG_GAP', fn:x=>x.prior24<=prior24Median&&x.gap_min>=gapMedian}
  ];

  const baseV=summarize(validation), baseH=summarize(holdout);
  const results=rules.map(r=>{
    const v=summarize(validation.filter(r.fn)), h=summarize(holdout.filter(r.fn));
    const stable=Boolean(
      v.n>=15&&h.n>=15 &&
      v.avg_net4h>baseV.avg_net4h &&
      h.avg_net4h>baseH.avg_net4h &&
      v.continuator_rate>=baseV.continuator_rate &&
      h.continuator_rate>=baseH.continuator_rate
    );
    const positiveBoth=Boolean(v.avg_net4h>0&&h.avg_net4h>0);
    return {
      id:r.id,validation:v,holdout:h,
      validation_delta:{continuator:v.continuator_rate-baseV.continuator_rate,net4h:v.avg_net4h-baseV.avg_net4h},
      holdout_delta:{continuator:h.continuator_rate-baseH.continuator_rate,net4h:h.avg_net4h-baseH.avg_net4h},
      stable,positive_both:positiveBoth
    };
  }).sort((x,y)=>
    Number(y.stable)-Number(x.stable) ||
    Number(y.positive_both)-Number(x.positive_both) ||
    Math.min(y.validation_delta.net4h,y.holdout_delta.net4h)-Math.min(x.validation_delta.net4h,x.holdout_delta.net4h)
  );

  const best=results[0]||null;
  const promote=Boolean(best&&best.stable&&best.positive_both);

  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'SIGNAL_NOVELTY_RECURRENCE',
    rows:rows.length,
    chronological_blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    frozen_from_discovery:{gap_median_minutes:gapMedian,prior24_median:prior24Median},
    baselines:{validation:baseV,holdout:baseH},
    rules:results,
    best,
    production_decision:promote?'PROMOTE_NOVELTY_RULE':'DO_NOT_PROMOTE',
    promote
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});