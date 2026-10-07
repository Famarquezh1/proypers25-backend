'use strict';

const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const OBS_MS=5*60*1000, HALF_MS=OBS_MS/2, H=240, COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}) {
  for(let i=0;i<6;i++){
    const r=await fetch(url,{headers:{'User-Agent':'Proypers25-FlowRefine/1.0',...headers}});
    if(r.ok)return r.json();
    if(r.status===429||r.status>=500){await sleep(350*(i+1));continue;}
    throw Error(r.status+' '+url);
  }
  throw Error('fetch failed '+url);
}
function symbolOf(x){return ((x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function q(a,p){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.max(0,Math.floor((s.length-1)*p)))]}
function summarize(a){
  const wins=a.filter(x=>x.net4h>0), losses=a.filter(x=>x.net4h<0);
  const gp=wins.reduce((s,x)=>s+x.net4h,0), gl=Math.abs(losses.reduce((s,x)=>s+x.net4h,0));
  return {n:a.length,continuator_rate:a.length?a.filter(x=>x.continuator).length/a.length:null,
    hit3:a.length?a.filter(x=>x.hit3).length/a.length:null,hit5:a.length?a.filter(x=>x.hit5).length/a.length:null,
    win_rate:a.length?wins.length/a.length:null,avg_net4h:avg(a.map(x=>x.net4h)),
    avg_mfe:avg(a.map(x=>x.mfe)),avg_mae:avg(a.map(x=>x.mae)),profit_factor:gl>0?gp/gl:null};
}
async function aggTrades(symbol,start,end){
  let out=[],fromId=null;
  for(let page=0;page<8;page++){
    const u=new URL(BIN+'/api/v3/aggTrades');u.searchParams.set('symbol',symbol);u.searchParams.set('limit','1000');
    if(fromId!==null)u.searchParams.set('fromId',String(fromId)); else {u.searchParams.set('startTime',String(start));u.searchParams.set('endTime',String(end));}
    const a=await json(u); if(!Array.isArray(a)||!a.length)break;
    out.push(...a.filter(x=>+x.T>=start&&+x.T<end));
    const last=a[a.length-1]; if(+last.T>=end||a.length<1000)break;
    fromId=Number(last.a)+1; await sleep(10);
  } return out;
}
async function klines(symbol,start,end){
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit:500}))u.searchParams.set(k,v);
  return json(u);
}
function flowFeatures(a,start){
  const calc=rows=>{if(rows.length<3)return null;let buyQ=0,sellQ=0;
    for(const x of rows){const qq=+x.q*+x.p;if(x.m)sellQ+=qq;else buyQ+=qq}
    const total=buyQ+sellQ,imb=total>0?(buyQ-sellQ)/total:0,p0=+rows[0].p,p1=+rows[rows.length-1].p,ret=p0>0?p1/p0-1:0;
    return {total,imb,ret,n:rows.length};};
  const h1=calc(a.filter(x=>+x.T<start+HALF_MS)),h2=calc(a.filter(x=>+x.T>=start+HALF_MS)),all=calc(a);
  if(!h1||!h2||!all)return null;
  const eps=.02;
  return {
    impact_efficiency:all.ret/(Math.abs(all.imb)+eps),
    flow_price_alignment:all.ret*all.imb,
    absorption_pressure:Math.abs(all.imb)/(Math.abs(all.ret)+.001),
    impact_decay:(h2.ret/(Math.abs(h2.imb)+eps))-(h1.ret/(Math.abs(h1.imb)+eps)),
    alignment_decay:(h2.ret*h2.imb)-(h1.ret*h1.imb),
    buy_flow_persistence:h2.imb-h1.imb,
    trade_count:all.n
  };
}
function rulePass(x,r){
  if(!(x.alignment_decay<0))return false;
  const v=x[r.feature];
  return r.dir==='hi'?v>=r.threshold:v<r.threshold;
}

(async()=>{
  let issues=[];
  for(let p=1;p<=12;p++){
    const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=asc';
    const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
    issues.push(...a.filter(x=>!x.pull_request)); if(a.length<100)break;
  }
  const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||''))
    .map(x=>({issue:x.number,symbol:symbolOf(x),t:Date.parse(x.created_at)}))
    .filter(x=>x.symbol&&Number.isFinite(x.t)).sort((a,b)=>a.t-b.t).slice(-320);

  const rows=[];
  for(const s of sig){
    try{
      const [tr,post]=await Promise.all([aggTrades(s.symbol,s.t,s.t+OBS_MS),klines(s.symbol,s.t+OBS_MS,s.t+OBS_MS+(H+5)*60000)]);
      if(tr.length<20||post.length<61)continue;
      const f=flowFeatures(tr,s.t); if(!f)continue;
      const entry=+post[0][1]; if(!(entry>0))continue;
      let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null,first5=null;
      for(let i=1;i<post.length;i++){const hi=+post[i][2]/entry-1,lo=+post[i][3]/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
        if(first3===null&&hi>=.03)first3=i;if(first5===null&&hi>=.05)first5=i;if(firstNeg1===null&&lo<=-.01)firstNeg1=i;}
      const close=+post[Math.min(H,post.length-1)][4];
      rows.push({...s,...f,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05,
        continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)});
    }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)}
    await sleep(25);
  }
  rows.sort((a,b)=>a.t-b.t);
  if(rows.length<180)throw Error('insufficient rows '+rows.length);

  const dEnd=Math.floor(rows.length*.55), vEnd=Math.floor(rows.length*.80);
  const discovery=rows.slice(0,dEnd), validation=rows.slice(dEnd,vEnd), holdout=rows.slice(vEnd);
  const baseD=summarize(discovery),baseV=summarize(validation),baseH=summarize(holdout);
  const anchorD=discovery.filter(x=>x.alignment_decay<0),anchorV=validation.filter(x=>x.alignment_decay<0),anchorH=holdout.filter(x=>x.alignment_decay<0);
  const anchor={discovery:summarize(anchorD),validation:summarize(anchorV),holdout:summarize(anchorH)};

  const features=['impact_efficiency','flow_price_alignment','absorption_pressure','impact_decay','buy_flow_persistence','trade_count'];
  const candidates=[];
  for(const feature of features){
    const vals=anchorD.map(x=>x[feature]).filter(Number.isFinite);
    for(const p of [.25,.5,.75]){
      const threshold=q(vals,p);
      for(const dir of ['hi','lo']){
        const rule={feature,dir,threshold,quantile:p};
        const d=summarize(discovery.filter(x=>rulePass(x,rule)));
        const v=summarize(validation.filter(x=>rulePass(x,rule)));
        const eligible=d.n>=20&&v.n>=12&&d.avg_net4h>anchor.discovery.avg_net4h&&v.avg_net4h>anchor.validation.avg_net4h&&
          d.continuator_rate>=anchor.discovery.continuator_rate&&v.continuator_rate>anchor.validation.continuator_rate;
        const score=eligible?(v.avg_net4h-anchor.validation.avg_net4h)*4+(v.continuator_rate-anchor.validation.continuator_rate)+(v.win_rate-anchor.validation.win_rate)*.25:-Infinity;
        candidates.push({rule,discovery:d,validation:v,eligible,score});
      }
    }
  }
  candidates.sort((a,b)=>b.score-a.score);
  const selected=candidates.find(x=>x.eligible)||null;
  let final=null;
  if(selected){
    const h=summarize(holdout.filter(x=>rulePass(x,selected.rule)));
    const pass=h.n>=10&&h.avg_net4h>0&&h.avg_net4h>=anchor.holdout.avg_net4h&&h.continuator_rate>anchor.holdout.continuator_rate&&h.win_rate>=anchor.holdout.win_rate;
    final={rule:selected.rule,holdout:h,anchor_holdout:anchor.holdout,
      delta:{avg_net4h:h.avg_net4h-anchor.holdout.avg_net4h,continuator_rate:h.continuator_rate-anchor.holdout.continuator_rate,win_rate:h.win_rate-anchor.holdout.win_rate},
      pass};
  }
  const out={ok:true,research_only:true,no_order_created:true,family:'ALIGNMENT_DECAY_REFINEMENT',
    rows:rows.length,blocks:{discovery:discovery.length,validation:validation.length,holdout:holdout.length},
    baseline:{discovery:baseD,validation:baseV,holdout:baseH},anchor_rule:{alignment_decay:'<0'},anchor,
    candidate_count:candidates.length,top_candidates:candidates.slice(0,12),selected,final,
    decision:final?.pass?'PROMOTE_TO_PROSPECTIVE_SHADOW':'DO_NOT_PROMOTE',promote_to_prospective_shadow:Boolean(final?.pass),
    caveat:'Historical holdout is not pristine because alignment_decay was previously inspected; any pass requires prospective shadow confirmation.'};
  console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});