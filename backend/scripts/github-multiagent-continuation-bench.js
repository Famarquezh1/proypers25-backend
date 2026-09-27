'use strict';

/*
 * Research-only multi-agent continuation bench.
 * No exchange credentials, no order endpoints, no production writes.
 * Outcome: +3% before -1% after a production Spot signal.
 */
const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const H=240, COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-MultiAgent-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(250*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),last=z[z.length-1],cl=+last[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}return {ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev)}}
function outcome(k,p0){let hit3=Infinity,hitm1=Infinity,mfe=-Infinity,mae=Infinity;for(let i=1;i<=Math.min(H,k.length-1);i++){const hi=+k[i][2]/p0-1,lo=+k[i][3]/p0-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(hit3===Infinity&&hi>=.03)hit3=i;if(hitm1===Infinity&&lo<=-.01)hitm1=i}return {cont:hit3<hitm1,mfe,mae,net4h:+k[Math.min(H,k.length-1)][4]/p0-1-COST}}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
function auc(rows,key='score'){let p=rows.filter(x=>x.y.cont),n=rows.filter(x=>!x.y.cont),w=0,t=0;for(const a of p)for(const b of n){t++;w+=a[key]>b[key]?1:a[key]===b[key]?.5:0}return t?w/t:null}
function metrics(rows,key='score'){if(!rows.length)return {n:0};const buy=rows.filter(x=>x.action==='BUY'),wait=rows.filter(x=>x.action==='WAIT'),discard=rows.filter(x=>x.action==='DISCARD');const s=a=>({n:a.length,cont_rate:a.length?mean(a.map(x=>x.y.cont?1:0)):null,net4h:a.length?mean(a.map(x=>x.y.net4h)):null,mfe:a.length?mean(a.map(x=>x.y.mfe)):null});return {n:rows.length,base_rate:mean(rows.map(x=>x.y.cont?1:0)),auc:auc(rows,key),BUY:s(buy),WAIT:s(wait),DISCARD:s(discard)}}
function zstats(train,get){const a=train.map(get).filter(Number.isFinite),mu=mean(a),sd=Math.sqrt(mean(a.map(x=>(x-mu)**2)))||1;return x=>(get(x)-mu)/sd}
function buildAgents(train){
 const zRet=zstats(train,r=>r.f[5].ret), zAdv=zstats(train,r=>r.f[5].adverse), zClose=zstats(train,r=>r.f[5].closePos), zUp=zstats(train,r=>r.f[5].upFrac), zRange=zstats(train,r=>r.f[5].range), zVol=zstats(train,r=>Math.log(Math.max(.01,r.f[5].volRatio)));
 const zEarly=zstats(train,r=>r.f[2].ret), zAccel=zstats(train,r=>r.f[5].ret-r.f[2].ret);
 return {
  trajectory:r=>.35*zRet(r)+.25*zClose(r)+.25*zUp(r)+.15*zAccel(r),
  survival:r=>.55*zAdv(r)+.25*zClose(r)+.20*zEarly(r),
  efficiency:r=>.45*zRet(r)-.35*zRange(r)+.20*zClose(r),
  participation:r=>.50*zVol(r)+.25*zUp(r)+.25*zRet(r)
 };
}
function calibrate(train,val,agents){
 const names=Object.keys(agents),weights={};
 for(const name of names){const tr=train.map(r=>({...r,score:agents[name](r)})),va=val.map(r=>({...r,score:agents[name](r)}));const a=(auc(tr)||.5),b=(auc(va)||.5);weights[name]=Math.max(0,Math.min(a-.5,b-.5));}
 if(Object.values(weights).every(x=>x===0))for(const n of names)weights[n]=1;
 const meta=r=>{let s=0,w=0;for(const n of names){s+=weights[n]*agents[n](r);w+=weights[n]}return s/Math.max(1e-12,w)};
 const valScores=val.map(meta),lo=quant(valScores,.35),hi=quant(valScores,.70);
 return {weights,lo,hi,meta};
}
function apply(rows,c){return rows.map(r=>{const score=c.meta(r);return {...r,score,action:score>=c.hi?'BUY':score<=c.lo?'DISCARD':'WAIT'}})}
function agentReport(rows,agents){const out={};for(const [n,f] of Object.entries(agents))out[n]={auc:auc(rows.map(r=>({...r,score:f(r)}))),top30_cont_rate:(()=>{const z=[...rows].sort((a,b)=>f(b)-f(a)).slice(0,Math.max(1,Math.floor(rows.length*.3)));return mean(z.map(x=>x.y.cont?1:0))})()};return out}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const rows=[];
 for(const x of issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300)){
  const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);
  try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,f:{1:feat(k,p0,1),2:feat(k,p0,2),3:feat(k,p0,3),5:feat(k,p0,5)},y:outcome(k,p0)});}catch{}await sleep(15)
 }
 rows.sort((a,b)=>a.t-b.t);const n=rows.length,a=Math.floor(n*.55),b=Math.floor(n*.75),train=rows.slice(0,a),val=rows.slice(a,b),test=rows.slice(b);
 const agents=buildAgents(train),cal=calibrate(train,val,agents);
 const sets={train:apply(train,cal),val:apply(val,cal),test:apply(test,cal),all:apply(rows,cal)};
 const report={ok:true,research_only:true,n,split:{train:train.length,val:val.length,test:test.length},meta:{weights:cal.weights,buy_threshold:cal.hi,discard_threshold:cal.lo},agents:{train:agentReport(train,agents),val:agentReport(val,agents),test:agentReport(test,agents)},decision:{train:metrics(sets.train),val:metrics(sets.val),test:metrics(sets.test),all:metrics(sets.all)},guard:'NO ORDERS / NO PRODUCTION WRITES'};
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
