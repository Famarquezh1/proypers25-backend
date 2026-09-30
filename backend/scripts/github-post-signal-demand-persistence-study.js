'use strict';

/**
 * Post-signal demand persistence study.
 * Research question: after a production signal but before entry, does early path
 * retention / absorption distinguish continuators from exhausted moves?
 *
 * Uses public Binance 1m candles only. No trading credentials, no orders.
 * Features are computed from first 5 minutes after signal; outcomes start AFTER
 * that observation window to avoid leakage.
 */

const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, OBS=5, H=240;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}) {
  for(let i=0;i<5;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-DemandPersistence/1.0',...headers}});
    if(r.ok)return r.json();
    if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}
    throw Error(r.status+' '+url);
  }
  throw Error('fetch failed '+url);
}
function symbolOf(x){
  return ((x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null;
}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function median(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
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
async function klines(symbol,start,end,limit=500){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit}))u.searchParams.set(k,v);
  return json(u);
}
function obsFeatures(k){
  const open=+k[0][1], closes=k.map(r=>+r[4]), highs=k.map(r=>+r[2]), lows=k.map(r=>+r[3]);
  const last=closes[closes.length-1], hi=Math.max(...highs), lo=Math.min(...lows);
  let maxSeen=open, worstPullback=0, recoveryEvents=0, downEvents=0;
  for(let i=0;i<closes.length;i++){
    maxSeen=Math.max(maxSeen,highs[i]);
    if(maxSeen>0)worstPullback=Math.min(worstPullback,lows[i]/maxSeen-1);
    if(i>0 && closes[i]<closes[i-1]){
      downEvents++;
      if(i+1<closes.length && closes[i+1]>closes[i]) recoveryEvents++;
    }
  }
  const range=hi-lo;
  return {
    retention: hi>open ? (last-open)/(hi-open) : 0,
    close_location: range>0 ? (last-lo)/range : .5,
    drawdown_from_peak: hi>0 ? last/hi-1 : 0,
    worst_pullback: worstPullback,
    recovery_ratio: downEvents?recoveryEvents/downEvents:1,
    low_breach: open>0 ? lo/open-1 : 0
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

  const rows=[];
  for(const s of sig){
    try{
      const all=await klines(s.symbol,s.t,s.t+(H+OBS+5)*60000,500);
      if(!Array.isArray(all)||all.length<OBS+61)continue;
      const obs=all.slice(0,OBS);
      const f=obsFeatures(obs);
      const entry=+all[OBS][1];
      if(!(entry>0))continue;
      let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
      for(let i=OBS+1;i<all.length;i++){
        const hi=+all[i][2]/entry-1, lo=+all[i][3]/entry-1;
        mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
        const rel=i-OBS;
        if(first3===null&&hi>=.03)first3=rel;
        if(firstNeg1===null&&lo<=-.01)firstNeg1=rel;
      }
      const close=+all[Math.min(OBS+H,all.length-1)][4];
      rows.push({...s,...f,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05,continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(20);
  }

  rows.sort((a,b)=>a.t-b.t);
  if(rows.length<180)throw Error('insufficient rows '+rows.length);
  const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,a), validation=rows.slice(a,b), holdout=rows.slice(b);
  const features=['retention','close_location','drawdown_from_peak','worst_pullback','recovery_ratio','low_breach'];
  const thresholds={};
  for(const f of features)thresholds[f]=median(discovery.map(x=>x[f]).filter(Number.isFinite));

  const bv=summarize(validation), bh=summarize(holdout), rules=[];
  for(const f of features){
    for(const dir of ['hi','lo']){
      const th=thresholds[f], fn=x=>dir==='hi'?x[f]>=th:x[f]<th;
      const v=summarize(validation.filter(fn)), h=summarize(holdout.filter(fn));
      const pass=Boolean(
        v.n>=20&&h.n>=20 &&
        v.avg_net4h>0&&h.avg_net4h>0 &&
        v.avg_net4h>bv.avg_net4h&&h.avg_net4h>bh.avg_net4h &&
        v.continuator_rate>=bv.continuator_rate&&h.continuator_rate>=bh.continuator_rate
      );
      rules.push({feature:f,dir,threshold:th,validation:v,holdout:h,
        validation_delta:{continuator:v.continuator_rate-bv.continuator_rate,net4h:v.avg_net4h-bv.avg_net4h},
        holdout_delta:{continuator:h.continuator_rate-bh.continuator_rate,net4h:h.avg_net4h-bh.avg_net4h},
        pass});
    }
  }
  rules.sort((x,y)=>Number(y.pass)-Number(x.pass)||Math.min(y.validation.avg_net4h,y.holdout.avg_net4h)-Math.min(x.validation.avg_net4h,x.holdout.avg_net4h));
  const best=rules[0]||null;
  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'POST_SIGNAL_DEMAND_PERSISTENCE',
    observation_minutes:OBS,
    rows:rows.length,
    chronological_blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    frozen_thresholds:thresholds,
    baselines:{validation:bv,holdout:bh},
    rules,
    best,
    production_decision:best?.pass?'PROMOTE_DEMAND_PERSISTENCE_RULE':'DO_NOT_PROMOTE',
    promote:Boolean(best?.pass)
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});