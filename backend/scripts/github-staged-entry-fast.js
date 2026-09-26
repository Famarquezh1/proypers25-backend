'use strict';
const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004,H=240,sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<4;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function symbolOf(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]||null}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null}
function sum(a){return a.reduce((x,y)=>x+y,0)}
function stats(a){return {n:a.length,win_rate:a.filter(x=>x.net>0).length/a.length,avg_net:avg(a.map(x=>x.net)),median_net:[...a].sort((x,y)=>x.net-y.net)[Math.floor(a.length/2)]?.net,total_net_sum:sum(a.map(x=>x.net))}}
(async()=>{let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),rows=[];
for(const x of sig){const symbol=symbolOf(x);if(!symbol)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+10)*60000,limit:500}))u.searchParams.set(k,v);const k=await json(u);if(k.length<H+2)continue;
const p0=+k[0][1],p1=+k[1][4],p2=+k[2][4],p3=+k[3][4];
const baseline={net:+k[H][4]/p0-1-COST};
const variants=[];
for(const m of [1,2,3]){const c=+k[m][4],hi=+k[m][2],lo=+k[m][3],op=+k[m][1];const ret=c/p0-1,closePos=(c-lo)/Math.max(1e-12,hi-lo),adverse=lo/p0-1;const accept=ret>0&&closePos>=.7&&adverse>-.01;const entry=+k[m+1][1];variants.push({m,accept,net:accept?(+k[Math.min(m+1+H,k.length-1)][4]/entry-1-COST):0,ret,closePos,adverse})}
rows.push({t,baseline,variants});}catch(e){console.error('skip',x.number,symbol,e.message)}await sleep(20)}
rows.sort((a,b)=>a.t-b.t);const cut=Math.floor(rows.length*.7),train=rows.slice(0,cut),test=rows.slice(cut);
function evalV(data,m){return stats(data.map(r=>({net:r.variants.find(v=>v.m===m).net})))}
const out={ok:true,research_only:true,rows:rows.length,rule:'accept after completed minute if return>0, close position>=70%, adverse>-1%; enter next minute open; rejected=0 exposure',cost:COST,baseline:{train:stats(train.map(r=>r.baseline)),test:stats(test.map(r=>r.baseline))},variants:{}};
for(const m of [1,2,3])out.variants[m+'m']={train:evalV(train,m),test:evalV(test,m),accepted_train:train.filter(r=>r.variants.find(v=>v.m===m).accept).length,accepted_test:test.filter(r=>r.variants.find(v=>v.m===m).accept).length};
console.log(JSON.stringify(out,null,2));})().catch(e=>{console.error(e);process.exit(1)});