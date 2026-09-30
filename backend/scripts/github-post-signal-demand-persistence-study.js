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

  // Cohort 2: test interaction, not another momentum rank.
  // Thresholds are frozen from discovery. Candidate selection is performed ONLY
  // on validation; holdout is opened once for the selected rule.
  const predicates=[];
  for(const feature of features){
    for(const dir of ['hi','lo']){
      const threshold=thresholds[feature];
      predicates.push({
        label:feature+'_'+dir,
        terms:[{feature,dir,threshold}],
        fn:x=>dir==='hi'?x[feature]>=threshold:x[feature]<threshold
      });
    }
  }
  const basePredicates=[...predicates];
  for(let i=0;i<basePredicates.length;i++){
    for(let j=i+1;j<basePredicates.length;j++){
      const a=basePredicates[i], c=basePredicates[j];
      if(a.terms[0].feature===c.terms[0].feature)continue;
      predicates.push({
        label:a.label+'__AND__'+c.label,
        terms:[...a.terms,...c.terms],
        fn:x=>a.fn(x)&&c.fn(x)
      });
    }
  }

  const bv=summarize(validation), bh=summarize(holdout);
  const candidates=predicates.map(rule=>{
    const v=summarize(validation.filter(rule.fn));
    const validation_delta={
      continuator:v.continuator_rate-bv.continuator_rate,
      net4h:v.avg_net4h-bv.avg_net4h
    };
    const eligible=Boolean(
      v.n>=20 &&
      v.avg_net4h>0 &&
      v.avg_net4h>bv.avg_net4h &&
      v.continuator_rate>=bv.continuator_rate
    );
    const score=eligible
      ? validation_delta.net4h + Math.max(0,validation_delta.continuator)*0.05
      : -Infinity;
    return {label:rule.label,terms:rule.terms,validation:v,validation_delta,eligible,score,fn:rule.fn};
  });

  candidates.sort((x,y)=>y.score-x.score);
  const selected=candidates.find(x=>x.eligible)||null;
  let holdout_result=null, promote=false;
  if(selected){
    const h=summarize(holdout.filter(selected.fn));
    const holdout_delta={
      continuator:h.continuator_rate-bh.continuator_rate,
      net4h:h.avg_net4h-bh.avg_net4h
    };
    promote=Boolean(
      h.n>=20 &&
      h.avg_net4h>0 &&
      h.avg_net4h>bh.avg_net4h &&
      h.continuator_rate>=bh.continuator_rate
    );
    holdout_result={
      label:selected.label,
      terms:selected.terms,
      holdout:h,
      holdout_delta,
      pass:promote
    };
  }

  // Cohort 3: negative veto. Learn what to exclude in validation, then open holdout once.
  const vetoCandidates=predicates.map(rule=>{
    const kept=validation.filter(x=>!rule.fn(x));
    const removed=validation.filter(rule.fn);
    const keptSummary=summarize(kept), removedSummary=summarize(removed);
    const delta={
      continuator:keptSummary.continuator_rate-bv.continuator_rate,
      net4h:keptSummary.avg_net4h-bv.avg_net4h,
      hit3:keptSummary.hit3-bv.hit3
    };
    const removedShare=validation.length?removed.length/validation.length:0;
    const eligible=Boolean(
      keptSummary.n>=40 &&
      removed.length>=15 &&
      removedShare<=0.50 &&
      delta.continuator>0 &&
      delta.net4h>0
    );
    const score=eligible
      ? delta.net4h + delta.continuator*0.05 + Math.max(0,delta.hit3)*0.02
      : -Infinity;
    return {
      label:'VETO__'+rule.label,
      terms:rule.terms,
      removed_n:removed.length,
      removed_share:removedShare,
      removed:removedSummary,
      kept:keptSummary,
      validation_delta:delta,
      eligible,
      score,
      fn:rule.fn
    };
  });
  vetoCandidates.sort((x,y)=>y.score-x.score);
  const selectedVeto=vetoCandidates.find(x=>x.eligible)||null;
  let vetoHoldout=null, vetoPromote=false;
  if(selectedVeto){
    const kept=holdout.filter(x=>!selectedVeto.fn(x));
    const removed=holdout.filter(selectedVeto.fn);
    const keptSummary=summarize(kept), removedSummary=summarize(removed);
    const delta={
      continuator:keptSummary.continuator_rate-bh.continuator_rate,
      net4h:keptSummary.avg_net4h-bh.avg_net4h,
      hit3:keptSummary.hit3-bh.hit3
    };
    vetoPromote=Boolean(
      keptSummary.n>=40 &&
      removed.length>=15 &&
      delta.continuator>0 &&
      delta.net4h>0
    );
    vetoHoldout={
      label:selectedVeto.label,
      terms:selectedVeto.terms,
      removed_n:removed.length,
      removed_share:holdout.length?removed.length/holdout.length:0,
      removed:removedSummary,
      kept:keptSummary,
      holdout_delta:delta,
      pass:vetoPromote
    };
  }

  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'POST_SIGNAL_NEGATIVE_VETO_COHORT_3',
    hypothesis:'exclude early post-signal exhaustion states to improve the remaining universe',
    observation_minutes:OBS,
    rows:rows.length,
    chronological_blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    frozen_thresholds:thresholds,
    baselines:{validation:bv,holdout:bh},
    candidate_count:vetoCandidates.length,
    top_validation_vetoes:vetoCandidates.slice(0,10).map(({fn,...x})=>x),
    selected_veto:selectedVeto?(({fn,...x})=>x)(selectedVeto):null,
    holdout_result:vetoHoldout,
    production_decision:vetoPromote?'PROMOTE_NEGATIVE_VETO_RULE':'DO_NOT_PROMOTE',
    promote:vetoPromote
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});