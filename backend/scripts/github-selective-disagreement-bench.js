'use strict';

/*
 * Research-only selective prediction bench.
 * Hypothesis: disagreement between heterogeneous post-signal specialists contains
 * incremental information about false BUYs. No credentials, no orders, no writes
 * outside local research artifacts.
 */
const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const H=240, COST=.004;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Selective-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const sd=a=>{const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))||0};
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),cl=+z.at(-1)[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}return{ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev)}}
function outcome(k,p0){let hp=Infinity,hm=Infinity,mfe=-Infinity,mae=Infinity;for(let i=1;i<=Math.min(H,k.length-1);i++){const hi=+k[i][2]/p0-1,lo=+k[i][3]/p0-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(hp===Infinity&&hi>=.03)hp=i;if(hm===Infinity&&lo<=-.01)hm=i}return{cont:hp<hm,hit3:hp,hitm1:hm,mfe,mae,net4h:+k[Math.min(H,k.length-1)][4]/p0-1-COST}}
function zfit(rows,get){const a=rows.map(get).filter(Number.isFinite),m=mean(a),s=sd(a)||1;return r=>(get(r)-m)/s}
function auc(rows,get){const p=rows.filter(r=>r.y.cont),n=rows.filter(r=>!r.y.cont);let w=0,t=0;for(const a of p)for(const b of n){const x=get(a),y=get(b);t++;w+=x>y?1:x===y?.5:0}return t?w/t:null}
function build(train){
 const zr=zfit(train,r=>r.f[5].ret),za=zfit(train,r=>r.f[5].adverse),zc=zfit(train,r=>r.f[5].closePos),zu=zfit(train,r=>r.f[5].upFrac),zg=zfit(train,r=>r.f[5].range),zv=zfit(train,r=>Math.log(Math.max(.01,r.f[5].volRatio))),ze=zfit(train,r=>r.f[2].ret),zx=zfit(train,r=>r.f[5].ret-r.f[2].ret);
 return {trajectory:r=>.35*zr(r)+.25*zc(r)+.25*zu(r)+.15*zx(r),survival:r=>.55*za(r)+.25*zc(r)+.20*ze(r),efficiency:r=>.45*zr(r)-.35*zg(r)+.20*zc(r),participation:r=>.50*zv(r)+.25*zu(r)+.25*zr(r)};
}
function fitMeta(train,val,A){
 const W={}; for(const [n,f] of Object.entries(A)) W[n]=Math.max(0,Math.min((auc(train,f)||.5)-.5,(auc(val,f)||.5)-.5));
 if(Object.values(W).every(x=>x===0))for(const n of Object.keys(A))W[n]=1;
 const vector=r=>Object.keys(A).map(n=>A[n](r));
 const score=r=>{let s=0,w=0;for(const n of Object.keys(A)){s+=W[n]*A[n](r);w+=W[n]}return s/Math.max(w,1e-12)};
 const disagreement=r=>sd(vector(r));
 return {W,score,disagreement};
}
function summarize(rows,score,disagreement,rule){
 const z=rows.map(r=>({...r,score:score(r),disagreement:disagreement(r)}));
 const selected=z.filter(rule), base=mean(z.map(r=>r.y.cont?1:0)),cr=mean(selected.map(r=>r.y.cont?1:0));
 return {n:z.length,selected_n:selected.length,coverage:selected.length/Math.max(1,z.length),base_cont:base,selected_cont:cr,lift:cr-base,avg_net4h:mean(selected.map(r=>r.y.net4h)),auc:auc(z,r=>r.score),selected_symbols:new Set(selected.map(r=>r.s)).size};
}
function bootstrapDiff(rows,score,disagreement,baseRule,newRule,B=1000){
 let seed=1771;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296};const diffs=[];
 for(let b=0;b<B;b++){const s=[];for(let i=0;i<rows.length;i++)s.push(rows[Math.floor(rnd()*rows.length)]);const base=s.filter(baseRule),neu=s.filter(newRule);if(!base.length||!neu.length)continue;diffs.push(mean(neu.map(r=>r.y.cont?1:0))-mean(base.map(r=>r.y.cont?1:0)))}
 diffs.sort((a,b)=>a-b);return{n:diffs.length,mean:mean(diffs),ci95:[quant(diffs,.025),quant(diffs,.975)],p_le_0:diffs.filter(x=>x<=0).length/Math.max(1,diffs.length)};
}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const candidates=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300); const acquisitionErrors={};
 const rows=[];for(const x of candidates){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,f:{2:feat(k,p0,2),5:feat(k,p0,5)},y:outcome(k,p0)})}catch(e){const k=String(e?.message||e).split(' ')[0];acquisitionErrors[k]=(acquisitionErrors[k]||0)+1}await sleep(15)}
 if(rows.length<100) throw Error('INSUFFICIENT_CAUSAL_UNIVERSE rows='+rows.length+' candidates='+candidates.length+' errors='+JSON.stringify(acquisitionErrors));
 rows.sort((a,b)=>a.t-b.t);const n=rows.length,i1=Math.floor(n*.50),i2=Math.floor(n*.70),i3=Math.floor(n*.85);
 const train=rows.slice(0,i1),val=rows.slice(i1,i2),test=rows.slice(i2,i3),finalHoldout=rows.slice(i3);
 const A=build(train),M=fitMeta(train,val,A);
 const hi=quant(val.map(M.score),.70);
 const dCut=quant(val.filter(r=>M.score(r)>=hi).map(M.disagreement),.60);
 const baseRule=r=>M.score(r)>=hi;
 const selectiveRule=r=>M.score(r)>=hi&&M.disagreement(r)<=dCut;
 const selectedTest=test.filter(selectiveRule), symbols=[...new Set(test.map(r=>r.s))];
 const loo=symbols.map(s=>{const z=test.filter(r=>r.s!==s);const b=z.filter(baseRule),q=z.filter(selectiveRule);return{excluded_symbol:s,n:z.length,baseline_n:b.length,selective_n:q.length,baseline_cont:mean(b.map(r=>r.y.cont?1:0)),selective_cont:mean(q.map(r=>r.y.cont?1:0)),delta:mean(q.map(r=>r.y.cont?1:0))-mean(b.map(r=>r.y.cont?1:0))}}).filter(x=>x.selective_n>=5);
 const halves=[test.slice(0,Math.floor(test.length/2)),test.slice(Math.floor(test.length/2))].map((z,i)=>{const b=z.filter(baseRule),q=z.filter(selectiveRule);return{half:i+1,n:z.length,baseline_n:b.length,selective_n:q.length,baseline_cont:mean(b.map(r=>r.y.cont?1:0)),selective_cont:mean(q.map(r=>r.y.cont?1:0)),delta:mean(q.map(r=>r.y.cont?1:0))-mean(b.map(r=>r.y.cont?1:0))}});
 const concentration=(()=>{const m={};for(const r of selectedTest)m[r.s]=(m[r.s]||0)+1;const counts=Object.values(m).sort((a,b)=>b-a);return{symbols:Object.keys(m).length,top_symbol_share:selectedTest.length?(counts[0]||0)/selectedTest.length:0,top3_share:selectedTest.length?counts.slice(0,3).reduce((a,b)=>a+b,0)/selectedTest.length:0}})();
 const report={
  ok:true,research_only:true,hypothesis_id:'H-SELECTIVE-DISAGREE-001',
  acquisition:{source:'BINANCE_VISION_DATA_API',candidates:candidates.length,usable:rows.length,errors:acquisitionErrors},
  hypothesis:'Low specialist disagreement among high-meta-score signals reduces false BUYs out of sample.',
  universe:n,split:{train:train.length,val:val.length,test:test.length,final_holdout:finalHoldout.length},
  final_holdout_status:'UNTOUCHED_NOT_EVALUATED',
  calibration:{weights:M.W,buy_threshold:hi,max_disagreement:dCut},
  validation:{baseline:summarize(val,M.score,M.disagreement,baseRule),selective:summarize(val,M.score,M.disagreement,selectiveRule)},
  test:{baseline:summarize(test,M.score,M.disagreement,baseRule),selective:summarize(test,M.score,M.disagreement,selectiveRule),bootstrap_delta:bootstrapDiff(test,M.score,M.disagreement,baseRule,selectiveRule)},
  agents_test:Object.fromEntries(Object.entries(A).map(([k,f])=>[k,{auc:auc(test,f)}])),
  adversarial_test:{leave_one_symbol_out:loo,temporal_halves:halves,concentration},
  guard:'FINAL HOLDOUT CLOSED / NO ORDERS / NO PRODUCTION WRITES'
 };
 const t=report.test, s=t.selective, b=t.baseline, ci=t.bootstrap_delta.ci95;
 const looStable=loo.length===0||loo.filter(x=>x.delta>=0).length/loo.length>=.70;
 const timeStable=halves.filter(x=>x.selective_n>=3&&x.delta>=0).length>=1;
 report.decision=(s.selected_n>=8 && s.selected_cont>b.selected_cont && ci[0]>-.05 && looStable && timeStable && concentration.top_symbol_share<=.40)?'SURVIVES_FOR_FURTHER_TESTING':'REJECTED_OR_INCONCLUSIVE';
 report.next_hypothesis=report.decision==='SURVIVES_FOR_FURTHER_TESTING'
   ?'Test whether disagreement remains incremental under purged walk-forward and symbol/month leave-one-out before opening final holdout.'
   :'Model post-signal time-to-failure/continuation as competing risks; disagreement did not add robust selective value.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
