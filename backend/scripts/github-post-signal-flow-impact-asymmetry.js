'use strict';

/**
 * Post-signal aggressive-flow impact asymmetry study.
 *
 * This is NOT raw buy/sell imbalance ranking. It measures whether aggressive
 * flow actually produces price response, and whether that response deteriorates
 * between the first and second half of the observation window.
 *
 * Observation: first 5 minutes after signal using public Binance aggTrades.
 * Outcome starts after observation window using public Binance 1m klines.
 * No trading credentials, no orders.
 */

const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const OBS_MS=5*60*1000, HALF_MS=OBS_MS/2, H=240, COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}) {
  for(let i=0;i<6;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-FlowImpact/1.0',...headers}});
    if(r.ok)return r.json();
    if(r.status===429||r.status>=500){await sleep(400*(i+1));continue;}
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
async function aggTrades(symbol,start,end){
  let out=[], fromId=null, cursor=start;
  for(let page=0;page<8;page++){
    const u=new URL(BIN+'/api/v3/aggTrades');
    u.searchParams.set('symbol',symbol);
    u.searchParams.set('limit','1000');
    if(fromId!==null) u.searchParams.set('fromId',String(fromId));
    else {u.searchParams.set('startTime',String(cursor));u.searchParams.set('endTime',String(end));}
    const a=await json(u);
    if(!Array.isArray(a)||!a.length)break;
    const filtered=a.filter(x=>+x.T>=start&&+x.T<end);
    out.push(...filtered);
    const last=a[a.length-1];
    if(+last.T>=end || a.length<1000)break;
    fromId=Number(last.a)+1;
    await sleep(15);
  }
  return out;
}
async function klines(symbol,start,end){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit:500}))u.searchParams.set(k,v);
  return json(u);
}
function flowFeatures(a,start){
  if(!a.length)return null;
  const calc=(rows)=>{
    if(rows.length<3)return null;
    let buyQ=0,sellQ=0,buyN=0,sellN=0;
    for(const x of rows){
      const q=+x.q*+x.p;
      // m=true => buyer is maker => seller is aggressor
      if(x.m){sellQ+=q;sellN++;} else {buyQ+=q;buyN++;}
    }
    const total=buyQ+sellQ;
    const imb=total>0?(buyQ-sellQ)/total:0;
    const p0=+rows[0].p, p1=+rows[rows.length-1].p;
    const ret=p0>0?p1/p0-1:0;
    return {buyQ,sellQ,total,imb,ret,n:rows.length,buyN,sellN};
  };
  const h1=calc(a.filter(x=>+x.T<start+HALF_MS));
  const h2=calc(a.filter(x=>+x.T>=start+HALF_MS));
  const all=calc(a);
  if(!h1||!h2||!all)return null;

  const eps=.02;
  const impact_efficiency=all.ret/(Math.abs(all.imb)+eps);
  const flow_price_alignment=all.ret*all.imb;
  const absorption_pressure=Math.abs(all.imb)/(Math.abs(all.ret)+0.001);
  const impact_decay=(h2.ret/(Math.abs(h2.imb)+eps))-(h1.ret/(Math.abs(h1.imb)+eps));
  const alignment_decay=(h2.ret*h2.imb)-(h1.ret*h1.imb);
  const buy_flow_persistence=h2.imb-h1.imb;

  return {
    impact_efficiency,
    flow_price_alignment,
    absorption_pressure,
    impact_decay,
    alignment_decay,
    buy_flow_persistence,
    trade_count:all.n
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
    .slice(-420);

  const rows=[];
  for(const s of sig){
    try{
      const [tr,post]=await Promise.all([
        aggTrades(s.symbol,s.t,s.t+OBS_MS),
        klines(s.symbol,s.t+OBS_MS,s.t+OBS_MS+(H+5)*60000)
      ]);
      if(tr.length<20||post.length<61)continue;
      const f=flowFeatures(tr,s.t); if(!f)continue;
      const entry=+post[0][1]; if(!(entry>0))continue;
      let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
      for(let i=1;i<post.length;i++){
        const hi=+post[i][2]/entry-1,lo=+post[i][3]/entry-1;
        mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
        if(first3===null&&hi>=.03)first3=i;
        if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
      }
      const close=+post[Math.min(H,post.length-1)][4];
      rows.push({...s,...f,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05,continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(35);
  }

  rows.sort((a,b)=>a.t-b.t);
  if(rows.length<180)throw Error('insufficient rows '+rows.length);

  const a=Math.floor(rows.length*.60),b=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,a),validation=rows.slice(a,b),holdout=rows.slice(b);
  const features=['impact_efficiency','flow_price_alignment','absorption_pressure','impact_decay','alignment_decay','buy_flow_persistence'];
  const thresholds={};
  for(const f of features)thresholds[f]=median(discovery.map(x=>x[f]).filter(Number.isFinite));

  const bv=summarize(validation),bh=summarize(holdout),rules=[];
  for(const f of features){
    for(const dir of ['hi','lo']){
      const th=thresholds[f],fn=x=>dir==='hi'?x[f]>=th:x[f]<th;
      const v=summarize(validation.filter(fn)),h=summarize(holdout.filter(fn));
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
    family:'POST_SIGNAL_FLOW_IMPACT_ASYMMETRY',
    rows:rows.length,
    chronological_blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    frozen_thresholds:thresholds,
    baselines:{validation:bv,holdout:bh},
    rules,
    best,
    production_decision:best?.pass?'PROMOTE_FLOW_IMPACT_RULE':'DO_NOT_PROMOTE',
    promote:Boolean(best?.pass)
  },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});