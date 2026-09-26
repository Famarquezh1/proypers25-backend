'use strict';
const GH='https://api.github.com',BIN='https://api.binance.com',TOKEN=process.env.GITHUB_TOKEN,COST=.004,MIN=60000,H=240;
const sleep=x=>new Promise(r=>setTimeout(r,x));
async function js(u,h={}){for(let i=0;i<4;i++){const r=await fetch(u,{headers:{'User-Agent':'Proypers25-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(200*(i+1));continue}throw Error(r.status+' '+u)}throw Error('fetch')}
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function sum(a){const n=a.length;if(!n)return{n:0};const av=f=>a.reduce((s,x)=>s+f(x),0)/n;return{n,hit3:av(x=>x.hit3?1:0),hit5:av(x=>x.hit5?1:0),hit10:av(x=>x.hit10?1:0),avg_net4h:av(x=>x.net),avg_mfe:av(x=>x.mfe),avg_mae:av(x=>x.mae)}}
(async()=>{let issues=[];for(let p=1;p<=5;p++){const a=await js(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),rows=[];
for(const x of sig){const s=sym(x);if(!s)continue;const t=Math.ceil(Date.parse(x.created_at)/MIN)*MIN;try{const u=new URL(BIN+'/api/v3/klines');Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+3)*MIN,limit:500}).forEach(([k,v])=>u.searchParams.set(k,v));const k=await js(u);if(k.length<H+2)continue;
 const o=+k[0][1],hi=+k[0][2],lo=+k[0][3],cl=+k[0][4],range=Math.max(hi-lo,o*1e-9),closePos=(cl-lo)/range,ret=cl/o-1,adverse=lo/o-1;
 const accept=ret>0&&closePos>=.70&&adverse>-.01,entry=+k[1][1];let mfe=-9,mae=9,first3=null,firstNeg1=null;
 for(let i=1;i<k.length;i++){const aa=+k[i][2]/entry-1,bb=+k[i][3]/entry-1;mfe=Math.max(mfe,aa);mae=Math.min(mae,bb);if(first3===null&&aa>=.03)first3=i-1;if(firstNeg1===null&&bb<=-.01)firstNeg1=i-1}
 const close=+k[Math.min(H+1,k.length-1)][4],net=close/entry-1-COST;rows.push({issue:x.number,s,t,accept,hit3:mfe>=.03,hit5:mfe>=.05,hit10:mfe>=.10,mfe,mae,net,cont:first3!==null&&(firstNeg1===null||first3<firstNeg1)});
 }catch(e){console.error('SKIP',x.number,s,e.message)}await sleep(20)}
rows.sort((a,b)=>a.t-b.t);const n=rows.length,a=Math.floor(n*.55),b=Math.floor(n*.75),purge=240*MIN;
const train=rows.slice(0,a),val=rows.filter((x,i)=>i>=a&&i<b&&x.t>rows[a-1].t+purge),test=rows.filter((x,i)=>i>=b&&x.t>rows[b-1].t+purge);
function block(z){const acc=z.filter(x=>x.accept),rej=z.filter(x=>!x.accept),all=sum(z),sa=sum(acc);return{all,accepted:sa,rejected:sum(rej),coverage:z.length?acc.length/z.length:0,precision_gain:acc.length?sa.hit3-all.hit3:null,net_gain:acc.length?sa.avg_net4h-all.avg_net4h:null}}
const out={ok:true,research_only:true,no_order_created:true,rule:'observe first complete 1m after signal; accept positive return, close in top 30%, adverse above -1%; enter next minute open',cost:COST,rows:n,blocks:{train:block(train),validation:block(val),test:block(test)}};const T=out.blocks.test;out.verdict=T.accepted.n>=20&&T.precision_gain>=.05&&T.net_gain>0&&T.accepted.avg_net4h>0?'SURVIVES_OOS':'REJECT';console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exit(1)});