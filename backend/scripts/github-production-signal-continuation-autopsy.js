'use strict';
/**
 * Production-signal continuation autopsy. Research only: reads GitHub signal issues
 * and public Binance Spot klines. No credentials for Binance and no orders.
 */
const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240; // 4h, 1m bars
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,headers={}){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Research/1.0',...headers}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function num(s,re){const m=String(s||'').match(re);return m?+m[1]:null}
function symbolOf(x){const s=(x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/);return s?.[1]||null}
function median(a){if(!a.length)return null;const s=[...a].sort((x,y)=>x-y);return s[Math.floor(s.length/2)]}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null}
function summarize(a){return {n:a.length,hit3:a.filter(x=>x.hit3).length/a.length,hit5:a.filter(x=>x.hit5).length/a.length,hit10:a.filter(x=>x.hit10).length/a.length,avg_mfe:avg(a.map(x=>x.mfe)),avg_mae:avg(a.map(x=>x.mae)),avg_net4h:avg(a.map(x=>x.r4h-COST))}}
(async()=>{
 let issues=[];
 for(let p=1;p<=5;p++){const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc';const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300);
 const rows=[];
 for(const x of sig){const symbol=symbolOf(x);if(!symbol)continue;const t=Date.parse(x.created_at);
  try{const u=new URL(BIN+'/api/v3/klines');for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(k,v);
   const k=await json(u);if(k.length<61)continue;const entry=+k[0][1];let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
   for(let i=1;i<k.length;i++){const hi=+k[i][2]/entry-1,lo=+k[i][3]/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(first3===null&&hi>=.03)first3=i;if(firstNeg1===null&&lo<=-.01)firstNeg1=i}
   const body=x.body||'';rows.push({issue:x.number,symbol,t,entry,mfe,mae,r4h:+k[Math.min(H,k.length-1)][4]/entry-1,hit3:mfe>=.03,hit5:mfe>=.05,hit10:mfe>=.10,first3,firstNeg1,
    pct:num(body,/(?:pct|24h[^\d-]*|change[^\d-]*)[:=\s]+([+-]?\d+(?:\.\d+)?)/i),utility:num(body,/utility[:=\s]+([\d.]+)/i),ignition:num(body,/ignition[:=\s]+([\d.]+)/i),confirm:num(body,/confirm(?:ation)?[:=\s]+([\d.]+)/i),extension:num(body,/extension[:=\s]+([\d.]+)/i),r15:num(body,/r15[:=\s]+([+-]?[\d.]+)/i),r60:num(body,/r60[:=\s]+([+-]?[\d.]+)/i)});
  }catch(e){console.error('SKIP',x.number,symbol,e.message)} await sleep(25)
 }
 rows.sort((a,b)=>a.t-b.t);
 const cut=Math.floor(rows.length*.7), train=rows.slice(0,cut),test=rows.slice(cut);
 // derive only from older 70%: single-variable median contrasts, no parameter sweep.
 const feats=['utility','ignition','confirm','extension','r15','r60','pct'], contrasts={};let best=null;
 for(const f of feats){const valid=train.filter(x=>Number.isFinite(x[f]));if(valid.length<30)continue;const m=median(valid.map(x=>x[f]));for(const dir of ['hi','lo']){const sel=valid.filter(x=>dir==='hi'?x[f]>=m:x[f]<m);const base=summarize(valid),sm=summarize(sel);const gain=sm.hit3-base.hit3;const c={feature:f,dir,threshold:m,n:sel.length,train_hit3:sm.hit3,train_gain:gain};contrasts[f+'_'+dir]=c;if(!best||gain>best.train_gain)best=c}}
 let candidate=null;if(best){const sel=test.filter(x=>Number.isFinite(x[best.feature])&&(best.dir==='hi'?x[best.feature]>=best.threshold:x[best.feature]<best.threshold));candidate={rule:best,test:summarize(sel),baseline:summarize(test),n:sel.length,hit3_gain:summarize(sel).hit3-summarize(test).hit3}}
 const continuers=rows.filter(x=>x.hit3&&(x.firstNeg1===null||x.first3<x.firstNeg1)), failures=rows.filter(x=>!x.hit3||(x.firstNeg1!==null&&x.firstNeg1<x.first3));
 console.log(JSON.stringify({ok:true,research_only:true,no_order_created:true,signals_scanned:sig.length,rows:rows.length,chronological_split:{train:train.length,test:test.length},all:summarize(rows),continuers:summarize(continuers),failures:summarize(failures),candidate,interpretation:candidate&&candidate.n>=20&&candidate.hit3_gain>.05&&candidate.test.avg_net4h>candidate.baseline.avg_net4h?'SURVIVES_FIRST_OOS':'NO_ROBUST_SEPARATOR_FOUND'},null,2));
})().catch(e=>{console.error(e);process.exit(1)});
