'use strict';
/**
 * Second independent chronological validation for the frozen pct>=8.944 rule.
 * Research only. Reads GitHub signal issues + public Binance klines.
 */
const GH='https://api.github.com', BIN='https://api.binance.com', TOKEN=process.env.GITHUB_TOKEN;
const COST=.004, H=240, TH=8.944;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,headers={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Research/2.0',...headers}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(350*(i+1));continue;}throw Error(r.status+' '+url)}throw Error('fetch failed')}
function num(s,re){const m=String(s||'').match(re);return m?+m[1]:null}
function symbolOf(x){const s=(x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/);return s?.[1]||null}
function avg(a){return a.length?a.reduce((x,y)=>x+y,0)/a.length:null}
function summarize(a){return {n:a.length,hit3:a.length?a.filter(x=>x.hit3).length/a.length:null,hit5:a.length?a.filter(x=>x.hit5).length/a.length:null,hit10:a.length?a.filter(x=>x.hit10).length/a.length:null,avg_mfe:avg(a.map(x=>x.mfe)),avg_mae:avg(a.map(x=>x.mae)),avg_net4h:avg(a.map(x=>x.net4h))}}
(async()=>{
 let issues=[];
 for(let p=1;p<=8;p++){
   const u=GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc';
   const a=await json(u,{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});
   issues.push(...a.filter(x=>!x.pull_request)); if(a.length<100) break;
 }
 const sig=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,500);
 const rows=[];
 for(const x of sig){
   const symbol=symbolOf(x); if(!symbol) continue;
   const body=x.body||'';
   const pct=num(body,/(?:pct|24h[^\d-]*|change[^\d-]*)[:=\s]+([+-]?\d+(?:\.\d+)?)/i);
   if(!Number.isFinite(pct)) continue;
   const t=Date.parse(x.created_at);
   try{
     const u=new URL(BIN+'/api/v3/klines');
     for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(k,v);
     const k=await json(u); if(k.length<61) continue;
     const entry=+k[0][1]; let mfe=-Infinity,mae=Infinity;
     for(let i=1;i<k.length;i++){const hi=+k[i][2]/entry-1,lo=+k[i][3]/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo)}
     const close=+k[Math.min(H,k.length-1)][4];
     rows.push({issue:x.number,symbol,t,pct,mfe,mae,net4h:close/entry-1-COST,hit3:mfe>=.03,hit5:mfe>=.05,hit10:mfe>=.10});
   }catch(e){console.error('SKIP',x.number,symbol,e.message)}
   await sleep(20);
 }
 rows.sort((a,b)=>a.t-b.t);
 if(rows.length<120) throw new Error('insufficient rows '+rows.length);

 // Frozen rule, two later chronological blocks. First 60% treated as historical discovery context only.
 const a=Math.floor(rows.length*.60), b=Math.floor(rows.length*.80);
 const validation=rows.slice(a,b), holdout=rows.slice(b);
 const valSel=validation.filter(x=>x.pct>=TH), holdSel=holdout.filter(x=>x.pct>=TH);
 const valBase=summarize(validation), holdBase=summarize(holdout), val=summarize(valSel), hold=summarize(holdSel);
 const validationPass=Boolean(val.n>=20 && val.avg_net4h>valBase.avg_net4h && val.hit3>valBase.hit3);
 const holdoutPass=Boolean(hold.n>=20 && hold.avg_net4h>0 && hold.avg_net4h>holdBase.avg_net4h && hold.hit3>holdBase.hit3 && hold.hit5>=holdBase.hit5);
 const promote=validationPass&&holdoutPass;
 const out={
   ok:true,research_only:true,no_order_created:true,
   frozen_rule:{feature:'pct',op:'>=',threshold:TH},
   rows:rows.length,
   chronological_blocks:{discovery:a,validation:validation.length,holdout:holdout.length},
   validation:{baseline:valBase,selected:val,delta:{hit3:val.hit3-valBase.hit3,hit5:val.hit5-valBase.hit5,net4h:val.avg_net4h-valBase.avg_net4h},pass:validationPass},
   holdout:{baseline:holdBase,selected:hold,delta:{hit3:hold.hit3-holdBase.hit3,hit5:hold.hit5-holdBase.hit5,net4h:hold.avg_net4h-holdBase.avg_net4h},pass:holdoutPass},
   production_decision:promote?'PROMOTE_FROZEN_RULE':'DO_NOT_PROMOTE',
   promote
 };
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});