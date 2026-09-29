'use strict';

const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240, PRE=60;
const TH={flip:0.43103448275862066,pct:8.944,upper:0.01246334310850449,pullback:-0.015625};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function json(url,headers={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-FlipStabilizer/1.0',...headers}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function num(s,re){const m=String(s||'').match(re);return m?+m[1]:null}
function symbolOf(x){return ((x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)||[])[1]||null}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function summarize(a){return {n:a.length,continuator_rate:a.length?a.filter(x=>x.continuator).length/a.length:null,hit3:a.length?a.filter(x=>x.hit3).length/a.length:null,hit5:a.length?a.filter(x=>x.hit5).length/a.length:null,avg_net4h:avg(a.map(x=>x.net4h)),avg_mfe:avg(a.map(x=>x.mfe)),avg_mae:avg(a.map(x=>x.mae))}}
function geom(k){
 const c=k.map(x=>+x[4]),h=k.map(x=>+x[2]);
 let flips=0,prev=0,maxSeen=c[0],maxPullback=0;
 for(let i=1;i<c.length;i++){const d=c[i]-c[i-1],sgn=d>0?1:d<0?-1:0;if(sgn&&prev&&sgn!==prev)flips++;if(sgn)prev=sgn;maxSeen=Math.max(maxSeen,c[i]);if(maxSeen>0)maxPullback=Math.min(maxPullback,c[i]/maxSeen-1);}
 const hi=Math.max(...h),last=c[c.length-1];
 return {flip_rate:flips/Math.max(1,c.length-2),upper_tail:hi>0?(hi-last)/hi:0,max_pullback:maxPullback};
}
async function klines(symbol,start,end,limit=1000){const u=new URL(BIN+'/api/v3/klines');for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:start,endTime:end,limit}))u.searchParams.set(k,v);return json(u)}

(async()=>{
 let issues=[];
 for(let p=1;p<=10;p++){const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=asc';const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).map(x=>({issue:x.number,symbol:symbolOf(x),t:Date.parse(x.created_at),pct:num(x.body||'',/(?:pct|24h[^\d-]*|change[^\d-]*)[:=\s]+([+-]?\d+(?:\.\d+)?)/i)})).filter(x=>x.symbol&&Number.isFinite(x.t)&&Number.isFinite(x.pct)).sort((a,b)=>a.t-b.t).slice(-600);
 const rows=[];
 for(const s of sig){try{
   const pre=await klines(s.symbol,s.t-PRE*60000,s.t,PRE+5), post=await klines(s.symbol,s.t,s.t+(H+5)*60000,500);
   if(pre.length<45||post.length<61)continue;
   const g=geom(pre.slice(-PRE)),entry=+post[0][1];let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
   for(let i=1;i<post.length;i++){const hi=+post[i][2]/entry-1,lo=+post[i][3]/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(first3===null&&hi>=.03)first3=i;if(firstNeg1===null&&lo<=-.01)firstNeg1=i}
   const close=+post[Math.min(H,post.length-1)][4];
   rows.push({...s,...g,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05,continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1)});
 }catch(e){console.error('SKIP',s.issue,s.symbol,e.message)} await sleep(20)}
 rows.sort((a,b)=>a.t-b.t); if(rows.length<180)throw Error('insufficient rows '+rows.length);
 const a=Math.floor(rows.length*.60),b=Math.floor(rows.length*.80),validation=rows.slice(a,b),holdout=rows.slice(b);
 const rules=[
  {id:'FLIP_ONLY',fn:x=>x.flip_rate>=TH.flip},
  {id:'PCT_PLUS_FLIP',fn:x=>x.pct>=TH.pct&&x.flip_rate>=TH.flip},
  {id:'UPPER_TAIL_PLUS_FLIP',fn:x=>x.upper_tail>=TH.upper&&x.flip_rate>=TH.flip},
  {id:'PULLBACK_PLUS_FLIP',fn:x=>x.max_pullback<=TH.pullback&&x.flip_rate>=TH.flip},
  {id:'PCT_UPPER_FLIP',fn:x=>x.pct>=TH.pct&&x.upper_tail>=TH.upper&&x.flip_rate>=TH.flip}
 ];
 const bv=summarize(validation),bh=summarize(holdout);
 const out=rules.map(r=>{const v=summarize(validation.filter(r.fn)),h=summarize(holdout.filter(r.fn));const pass=Boolean(v.n>=15&&h.n>=15&&v.avg_net4h>0&&h.avg_net4h>0&&v.avg_net4h>bv.avg_net4h&&h.avg_net4h>bh.avg_net4h&&v.continuator_rate>=bv.continuator_rate&&h.continuator_rate>=bh.continuator_rate);return{id:r.id,validation:v,holdout:h,pass}}).sort((x,y)=>Number(y.pass)-Number(x.pass)||Math.min(y.validation.avg_net4h,y.holdout.avg_net4h)-Math.min(x.validation.avg_net4h,x.holdout.avg_net4h));
 const best=out[0]||null;
 console.log(JSON.stringify({ok:true,research_only:true,family:'FLIPRATE_STABILIZER_COMBO',rows:rows.length,frozen_thresholds:TH,baselines:{validation:bv,holdout:bh},rules:out,best,production_decision:best?.pass?'PROMOTE_FLIP_COMBO':'DO_NOT_PROMOTE',promote:Boolean(best?.pass)},null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});