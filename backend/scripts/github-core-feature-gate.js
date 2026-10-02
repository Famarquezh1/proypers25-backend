'use strict';
const fs=require('fs');
const data=JSON.parse(fs.readFileSync(process.argv[2]||'core-counterfactual-results.json','utf8'));
const rows=data.rows.filter(x=>x.status==='MATURE').sort((a,b)=>Date.parse(a.created_at)-Date.parse(b.created_at));
const cut1=Math.floor(rows.length*.6),cut2=Math.floor(rows.length*.8);
const train=rows.slice(0,cut1),validation=rows.slice(cut1,cut2),holdout=rows.slice(cut2);
const numeric=['utility','v42_norm','ignition','confirm','extension','base_utility','stable_norm'];
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
function summary(a){const n=a.length,w=a.filter(x=>x.target_continuator).length;return {n,continuators:w,continuator_rate:n?w/n:null,avg_return4h_net_pct:n?mean(a.map(x=>x.return_4h_net_pct)):null,avg_mfe_pct:n?mean(a.map(x=>x.mfe_pct)):null,hit5_rate:n?a.filter(x=>x.hit_plus5).length/n:null};}
function qs(vals){const a=vals.filter(Number.isFinite).sort((x,y)=>x-y);const q=p=>a[Math.min(a.length-1,Math.max(0,Math.floor((a.length-1)*p)))];return [.2,.35,.5,.65,.8].map(q).filter((x,i,z)=>Number.isFinite(x)&&z.indexOf(x)===i)}
const baseV=summary(validation),baseH=summary(holdout),rules=[];
for(const f of numeric){for(const t of qs(train.map(x=>x[f]))){rules.push({id:`${f}>=${t}`,fn:x=>Number.isFinite(x[f])&&x[f]>=t});rules.push({id:`${f}<=${t}`,fn:x=>Number.isFinite(x[f])&&x[f]<=t});}}
for(const regime of [...new Set(train.map(x=>x.market_regime).filter(Boolean))])rules.push({id:`regime=${regime}`,fn:x=>x.market_regime===regime});
for(let i=0;i<numeric.length;i++)for(let j=i+1;j<numeric.length;j++){
 for(const a of qs(train.map(x=>x[numeric[i]])).filter((_,k)=>k%2===0))for(const b of qs(train.map(x=>x[numeric[j]])).filter((_,k)=>k%2===0)){
  rules.push({id:`${numeric[i]}>=${a}&${numeric[j]}>=${b}`,fn:x=>Number.isFinite(x[numeric[i]])&&Number.isFinite(x[numeric[j]])&&x[numeric[i]]>=a&&x[numeric[j]]>=b});
 }
}
const tested=rules.map(r=>{const s=summary(validation.filter(r.fn));const delta=s.continuator_rate==null?null:s.continuator_rate-baseV.continuator_rate;
 const eligible=s.n>=8&&s.continuator_rate>=.35&&delta>=.10&&s.avg_return4h_net_pct>0;
 return {id:r.id,validation:s,delta,eligible,fn:r.fn};
}).filter(x=>x.validation.n).sort((a,b)=>(b.eligible-a.eligible)||((b.validation.avg_return4h_net_pct??-999)-(a.validation.avg_return4h_net_pct??-999)));
const selected=tested.find(x=>x.eligible)||null;
let h=null,pass=false;
if(selected){const s=summary(holdout.filter(selected.fn));const delta=s.continuator_rate==null?null:s.continuator_rate-baseH.continuator_rate;pass=!!(s.n>=8&&s.continuator_rate>=.35&&delta>=.10&&s.avg_return4h_net_pct>0);h={baseline:baseH,selected:s,delta,pass};}
const out={ok:true,research_only:true,no_order_created:true,rows:rows.length,blocks:{train:train.length,validation:validation.length,holdout:holdout.length},baselines:{validation:baseV,holdout:baseH},rules_tested:tested.length,top_validation:tested.slice(0,12).map(({fn,...x})=>x),selected:selected?(({fn,...x})=>x)(selected):null,holdout_result:h,promote_to_shadow:pass,decision:pass?'PROMOTE_RULE_TO_SHADOW':'KEEP_CORE_DETECTOR_ONLY',gate:'validation+holdout n>=8, continuator>=35%, +10pp vs baseline, positive 4h net'};
fs.writeFileSync(process.argv[3]||'core-feature-gate-results.json',JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
