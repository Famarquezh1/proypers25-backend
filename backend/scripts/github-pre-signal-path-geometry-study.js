'use strict';

/**
 * Historical study: pre-signal path geometry.
 * Features are known at signal time and use only public Binance 1m candles before the signal.
 * No trading credentials and no order endpoints.
 */

const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240, PRE=60;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}) {
  for(let i=0;i<5;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-PathGeometry/1.0',...headers}});
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
function preFeatures(k){
  const c=k.map(x=>+x[4]), h=k.map(x=>+x[2]), l=k.map(x=>+x[3]);
  const first=c[0], last=c[c.length-1];
  let path=0, flips=0, prevSign=0, maxSeen=c[0], maxPullback=0;
  for(let i=1;i<c.length;i++){
    const d=c[i]-c[i-1];
    path+=Math.abs(d);
    const sign=d>0?1:d<0?-1:0;
    if(sign&&prevSign&&sign!==prevSign)flips++;
    if(sign)prevSign=sign;
    maxSeen=Math.max(maxSeen,c[i]);
    if(maxSeen>0)maxPullback=Math.min(maxPullback,c[i]/maxSeen-1);
  }
  const net=Math.abs(last-first);
  const efficiency=path>0?net/path:0;
  const flipRate=(c.length>2)?flips/(c.length-2):0;
  const hi=Math.max(...h), lo=Math.min(...l);
  const range=hi-lo;
  const closeLocation=range>0?(last-lo)/range:0.5;
  const upperTail=hi>0?(hi-last)/hi:0;
  const lowerLift=lo>0?(last-lo)/lo:0;
  return {efficiency,flip_rate:flipRate,max_pullback:maxPullback,close_location:closeLocation,upper_tail:upperTail,lower_lift:lowerLift};
}
async function fetchKlines(symbol,start,end,limit=1000){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit}))u.searchParams.set(k,v);
  return json(u);
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
      const pre=await fetchKlines(s.symbol,s.t-PRE*60000,s.t,PRE+5);
      const post=await fetchKlines(s.symbol,s.t,s.t+(H+5)*60000,500);
      if(pre.length<45||post.length<61)continue;

      const f=preFeatures(pre.slice(-PRE));
      const entry=+post[0][1]; if(!(entry>0))continue;
      let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
      for(let i=1;i<post.length;i++){
        const hi=+post[i][2]/entry-1,lo=+post[i][3]/entry-1;
        mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
        if(first3===null&&hi>=.03)first3=i;
        if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
      }
      const close=+post[Math.min(H,post.length-1)][4];
      rows.push({
        ...s,...f,mfe,mae,net4h:close/entry-1-COST,
        hit3:mfe>=.03,hit5:mfe>=.05,
        continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)
      });
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(20);
  }
  rows.sort((a,b)=>a.t-b.t);
  if(rows.length<180)throw new Error('insufficient rows '+rows.length);

  const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,a), validation=rows.slice(a,b), holdout=rows.slice(b);
  const features=['efficiency','flip_rate','max_pullback','close_location','upper_tail','lower_lift'];

  const thresholds={};
  for(const f of features)thresholds[f]=median(discovery.map(x=>x[f]).filter(Number.isFinite));

  const baseV=summarize(validation), baseH=summarize(holdout);
  const rules=[];
  for(const f of features){
    for(const dir of ['hi','lo']){
      const th=thresholds[f];
      const fn=x=>dir==='hi'?x[f]>=th:x[f]<th;
      const v=summarize(validation.filter(fn)), h=summarize(holdout.filter(fn));
      const stable=Boolean(
        v.n>=20&&h.n>=20 &&
        v.avg_net4h>baseV.avg_net4h &&
        h.avg_net4h>baseH.avg_net4h &&
        v.continuator_rate>=baseV.continuator_rate &&
        h.continuator_rate>=baseH.continuator_rate
      );
      const positiveBoth=Boolean(v.avg_net4h>0&&h.avg_net4h>0);
      rules.push({
        feature:f,dir,threshold:th,validation:v,holdout:h,
        validation_delta:{continuator:v.continuator_rate-baseV.continuator_rate,net4h:v.avg_net4h-baseV.avg_net4h},
        holdout_delta:{continuator:h.continuator_rate-baseH.continuator_rate,net4h:h.avg_net4h-baseH.avg_net4h},
        stable,positive_both:positiveBoth
      });
    }
  }
  rules.sort((x,y)=>
    Number(y.stable)-Number(x.stable) ||
    Number(y.positive_both)-Number(x.positive_both) ||
    Math.min(y.validation_delta.net4h,y.holdout_delta.net4h)-Math.min(x.validation_delta.net4h,x.holdout_delta.net4h)
  );

  const best=rules[0]||null;
  const promote=Boolean(best&&best.stable&&best.positive_both);

  console.log(JSON.stringify({
    ok:true,research_only:true,no_order_created:true,
    family:'PRE_SIGNAL_PATH_GEOMETRY',
    rows:rows.length,
    chronological_blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    frozen_thresholds:thresholds,
    baselines:{validation:baseV,holdout:baseH},
    rules:rules.slice(0,12),
    best,
    production_decision:promote?'PROMOTE_PATH_GEOMETRY_RULE':'DO_NOT_PROMOTE',
    promote
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});