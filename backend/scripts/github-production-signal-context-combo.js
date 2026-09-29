'use strict';
/**
 * Context-combination study for the frozen pct>=8.944 rule.
 * Goal: explain regime dependence without retuning the frozen pct threshold.
 * Research only: GitHub issues + public Binance 1m klines.
 */
const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240, PCT_TH=8.944;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,headers={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-ContextCombo/1.0',...headers}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(350*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function num(s,re){const m=String(s||'').match(re);return m?+m[1]:null}
function symbolOf(x){const s=(x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/);return s?.[1]||null}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null}
function median(a){if(!a.length)return null;const s=[...a].sort((a,b)=>a-b);return s[Math.floor(s.length/2)]}
function summarize(a){return {n:a.length,hit3:a.length?a.filter(x=>x.hit3).length/a.length:null,hit5:a.length?a.filter(x=>x.hit5).length/a.length:null,avg_net4h:avg(a.map(x=>x.net4h)),avg_mfe:avg(a.map(x=>x.mfe)),avg_mae:avg(a.map(x=>x.mae))}}
(async()=>{
 let issues=[];
 for(let p=1;p<=8;p++){
  const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc';
  const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
  issues.push(...a.filter(x=>!x.pull_request)); if(a.length<100)break;
 }
 const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,500);
 const rows=[];
 for(const x of sig){
  const symbol=symbolOf(x); if(!symbol)continue;
  const body=x.body||'';
  const pct=num(body,/(?:pct|24h[^\d-]*|change[^\d-]*)[:=\s]+([+-]?\d+(?:\.\d+)?)/i);
  if(!Number.isFinite(pct))continue;
  const feats={
    utility:num(body,/utility[:=\s]+([+-]?[\d.]+)/i),
    ignition:num(body,/ignition[:=\s]+([+-]?[\d.]+)/i),
    confirm:num(body,/confirm(?:ation)?[:=\s]+([+-]?[\d.]+)/i),
    extension:num(body,/extension[:=\s]+([+-]?[\d.]+)/i),
    r15:num(body,/r15[:=\s]+([+-]?[\d.]+)/i),
    r60:num(body,/r60[:=\s]+([+-]?[\d.]+)/i)
  };
  const t=Date.parse(x.created_at);
  try{
   const u=new URL(BIN+'/api/v3/klines');
   for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(k,v);
   const k=await json(u); if(k.length<61)continue;
   const entry=+k[0][1]; let mfe=-Infinity,mae=Infinity;
   for(let i=1;i<k.length;i++){const hi=+k[i][2]/entry-1,lo=+k[i][3]/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo)}
   const close=+k[Math.min(H,k.length-1)][4];
   rows.push({issue:x.number,symbol,t,pct,...feats,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05});
  }catch(e){console.error('SKIP',x.number,symbol,e.message)}
  await sleep(20);
 }
 rows.sort((a,b)=>a.t-b.t);
 const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
 const validation=rows.slice(a,b), holdout=rows.slice(b);
 const hiVal=validation.filter(x=>x.pct>=PCT_TH), hiHold=holdout.filter(x=>x.pct>=PCT_TH);
 const feats=['utility','ignition','confirm','extension','r15','r60'];
 const comparisons=[];
 for(const f of feats){
   const v=hiVal.filter(x=>Number.isFinite(x[f])), h=hiHold.filter(x=>Number.isFinite(x[f]));
   if(v.length<10||h.length<10)continue;
   const combined=[...v,...h], th=median(combined.map(x=>x[f]));
   for(const dir of ['hi','lo']){
     const sv=v.filter(x=>dir==='hi'?x[f]>=th:x[f]<th);
     const sh=h.filter(x=>dir==='hi'?x[f]>=th:x[f]<th);
     if(sv.length<8||sh.length<8)continue;
     const vv=summarize(sv), hh=summarize(sh);
     comparisons.push({feature:f,dir,threshold:th,validation:vv,holdout:hh,
       stable_positive:vv.avg_net4h>0&&hh.avg_net4h>0,
       min_net:Math.min(vv.avg_net4h,hh.avg_net4h),
       mean_hit3:(vv.hit3+hh.hit3)/2,
       support:sv.length+sh.length});
   }
 }
 comparisons.sort((x,y)=>(Number(y.stable_positive)-Number(x.stable_positive))||(y.min_net-x.min_net)||(y.mean_hit3-x.mean_hit3)||(y.support-x.support));
 const best=comparisons[0]||null;
 console.log(JSON.stringify({
   ok:true,research_only:true,no_order_created:true,
   frozen_pct_threshold:PCT_TH,
   rows:rows.length,
   high_pct_validation:summarize(hiVal),
   high_pct_holdout:summarize(hiHold),
   context_candidates:comparisons.slice(0,12),
   best,
   interpretation:best&&best.stable_positive&&best.validation.n>=8&&best.holdout.n>=8?'CONTEXT_STABILIZER_FOUND':'NO_STABLE_CONTEXT_COMBINATION'
 },null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});