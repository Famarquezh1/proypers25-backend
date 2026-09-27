'use strict';

/*
 * H-COMPETING-HAZARD-001
 * Research-only competing-risks model from the minute-5 decision point.
 * No authenticated exchange APIs, no orders, no production writes.
 */
const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const H=240, DECISION=5, COST=.004;
const INTERVALS=[[6,15],[16,30],[31,60],[61,120],[121,240]];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-Hazard-Research/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function feat(k,p0,m){const z=k.slice(0,m+1),cl=+z.at(-1)[4],hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3]));let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}return{ret:cl/p0-1,adverse:lo/p0-1,range:hi/lo-1,closePos:(cl-lo)/Math.max(1e-12,hi-lo),upFrac:up/Math.max(1,m),volRatio:vol/Math.max(1e-12,vprev)}}
function event(k,p0){let c=Infinity,f=Infinity;for(let i=1;i<=Math.min(H,k.length-1);i++){if(c===Infinity&&+k[i][2]/p0-1>=.03)c=i;if(f===Infinity&&+k[i][3]/p0-1<=-.01)f=i}if(c===f&&c!==Infinity)return{type:'AMBIG',time:c};if(c<f)return{type:'C',time:c};if(f<c)return{type:'F',time:f};return{type:'NONE',time:H+1}}
function baseVec(r){const a=r.f[5],b=r.f[2],c=r.f[1];return[a.ret,a.adverse,a.range,a.closePos,a.upFrac,Math.log(Math.max(.01,a.volRatio)),b.ret,c.ret,a.ret-b.ret,b.ret-c.ret]}
function fitScaler(rows){const X=rows.map(baseVec),d=X[0]?.length||0,mu=[],sd=[];for(let j=0;j<d;j++){const a=X.map(x=>x[j]),m=mean(a),s=Math.sqrt(mean(a.map(v=>(v-m)**2)))||1;mu.push(m);sd.push(s)}return x=>x.map((v,j)=>(v-mu[j])/sd[j])}
function design(z,interval){const one=INTERVALS.map((_,i)=>i===interval?1:0);return[1,...z,...one]}
function fitLogistic(X,y,lambda=.05,iters=1200,lr=.04){const d=X[0].length,w=Array(d).fill(0),n=X.length;for(let it=0;it<iters;it++){const g=Array(d).fill(0);for(let i=0;i<n;i++){let s=0;for(let j=0;j<d;j++)s+=w[j]*X[i][j];const e=sigmoid(s)-y[i];for(let j=0;j<d;j++)g[j]+=e*X[i][j]}for(let j=0;j<d;j++){g[j]/=n;if(j>0)g[j]+=lambda*w[j];w[j]-=lr*g[j]}}return w}
function dot(w,x){let s=0;for(let i=0;i<w.length;i++)s+=w[i]*x[i];return s}
function riskRows(rows,scale){const Xc=[],yc=[],Xf=[],yf=[];for(const r of rows){if(r.ev.time<=DECISION||r.ev.type==='AMBIG')continue;const z=scale(baseVec(r));for(let q=0;q<INTERVALS.length;q++){const [a,b]=INTERVALS[q];if(r.ev.time<a&&r.ev.type!=='NONE')break;const inBin=r.ev.time>=a&&r.ev.time<=b;const x=design(z,q);Xc.push(x);Xf.push(x);yc.push(inBin&&r.ev.type==='C'?1:0);yf.push(inBin&&r.ev.type==='F'?1:0);if(inBin)break}}return{Xc,yc,Xf,yf}}
function fitHazard(train){const eligible=train.filter(r=>r.ev.time>DECISION&&r.ev.type!=='AMBIG');const scale=fitScaler(eligible),pp=riskRows(eligible,scale),wc=fitLogistic(pp.Xc,pp.yc),wf=fitLogistic(pp.Xf,pp.yf);return{scale,wc,wf,person_periods:pp.Xc.length,eligible:eligible.length}}
function hazardScore(r,M){const z=M.scale(baseVec(r));let S=1,cifC=0,cifF=0;const hs=[];for(let q=0;q<INTERVALS.length;q++){let hc=sigmoid(dot(M.wc,design(z,q))),hf=sigmoid(dot(M.wf,design(z,q)));const sm=hc+hf;if(sm>.95){hc*=.95/sm;hf*=.95/sm}cifC+=S*hc;cifF+=S*hf;S*=1-hc-hf;hs.push({interval:INTERVALS[q],hc,hf,S})}return{score:cifC-cifF,cifC,cifF,survival:S,hazards:hs}}
function auc(rows,get){const p=rows.filter(r=>r.target===1),n=rows.filter(r=>r.target===0);let w=0,t=0;for(const a of p)for(const b of n){const x=get(a),y=get(b);t++;w+=x>y?1:x===y?.5:0}return t?w/t:null}
function zfit(rows,get){const a=rows.map(get),m=mean(a),s=Math.sqrt(mean(a.map(v=>(v-m)**2)))||1;return r=>(get(r)-m)/s}
function fitMeta(train,val){
 const zr=zfit(train,r=>r.f[5].ret),za=zfit(train,r=>r.f[5].adverse),zc=zfit(train,r=>r.f[5].closePos),zu=zfit(train,r=>r.f[5].upFrac),zg=zfit(train,r=>r.f[5].range),zv=zfit(train,r=>Math.log(Math.max(.01,r.f[5].volRatio))),ze=zfit(train,r=>r.f[2].ret),zx=zfit(train,r=>r.f[5].ret-r.f[2].ret);
 const A={trajectory:r=>.35*zr(r)+.25*zc(r)+.25*zu(r)+.15*zx(r),survival:r=>.55*za(r)+.25*zc(r)+.20*ze(r),efficiency:r=>.45*zr(r)-.35*zg(r)+.20*zc(r),participation:r=>.50*zv(r)+.25*zu(r)+.25*zr(r)};
 const W={};for(const [n,f] of Object.entries(A))W[n]=Math.max(0,Math.min((auc(train,f)||.5)-.5,(auc(val,f)||.5)-.5));if(Object.values(W).every(x=>x===0))for(const n of Object.keys(A))W[n]=1;
 const score=r=>{let s=0,w=0;for(const n of Object.keys(A)){s+=W[n]*A[n](r);w+=W[n]}return s/Math.max(1e-12,w)};
 return{score,W};
}
function metrics(rows,get,cut){const s=rows.filter(r=>get(r)>=cut),base=mean(rows.map(r=>r.target));return{n:rows.length,selected_n:s.length,coverage:s.length/Math.max(1,rows.length),base_cont:base,selected_cont:mean(s.map(r=>r.target)),lift:mean(s.map(r=>r.target))-base,auc:auc(rows,get),avg_net4h:mean(s.map(r=>r.net5)),symbols:new Set(s.map(r=>r.s)).size}}
function bootstrapAucDiff(rows,hget,mget,B=1000){let seed=911;const rnd=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296},d=[];for(let b=0;b<B;b++){const z=[];for(let i=0;i<rows.length;i++)z.push(rows[Math.floor(rnd()*rows.length)]);const ah=auc(z,hget),am=auc(z,mget);if(Number.isFinite(ah)&&Number.isFinite(am))d.push(ah-am)}d.sort((a,b)=>a-b);return{n:d.length,mean:mean(d),ci95:[quant(d,.025),quant(d,.975)],p_le_0:d.filter(x=>x<=0).length/Math.max(1,d.length)}}
function econ(rows,get,cut){const sel=rows.filter(r=>get(r)>=cut);function at(delay,cost){const a=sel.map(r=>r.exit/r.entry[delay]-1-cost).filter(Number.isFinite);return{delay_min:delay,cost,avg:mean(a),positive:mean(a.map(x=>x>0?1:0)),n:a.length}}return{base:at(5,.004),cost06:at(5,.006),cost08:at(5,.008),delay10:at(10,.004),delay15:at(15,.004)}}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const candidates=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),errors={},rows=[];
 for(const x of candidates){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1],ev=event(k,p0);rows.push({t,s,ev,f:{1:feat(k,p0,1),2:feat(k,p0,2),5:feat(k,p0,5)},entry:{5:+k[5][4],10:+k[10][4],15:+k[15][4]},exit:+k[H][4]})}catch(e){const z=String(e?.message||e).split(' ')[0];errors[z]=(errors[z]||0)+1}await sleep(15)}
 if(rows.length<100)throw Error('INSUFFICIENT_CAUSAL_UNIVERSE rows='+rows.length+' candidates='+candidates.length+' errors='+JSON.stringify(errors));
 rows.sort((a,b)=>a.t-b.t);const n=rows.length,i1=Math.floor(n*.50),i2=Math.floor(n*.70),i3=Math.floor(n*.85);
 const raw={train:rows.slice(0,i1),val:rows.slice(i1,i2),test:rows.slice(i2,i3),final:rows.slice(i3)};
 const eligible=z=>z.filter(r=>r.ev.time>DECISION&&r.ev.type!=='AMBIG').map(r=>({...r,target:r.ev.type==='C'?1:0,net5:r.exit/r.entry[5]-1-COST}));
 const train=eligible(raw.train),val=eligible(raw.val),test=eligible(raw.test); // FINAL never transformed/scored
 const HZ=fitHazard(raw.train),hget=r=>hazardScore(r,HZ).score,M=fitMeta(train,val),mget=M.score;
 const hCut=quant(val.map(hget),.70),mCut=quant(val.map(mget),.70);
 const hm=metrics(test,hget,hCut),mm=metrics(test,mget,mCut),boot=bootstrapAucDiff(test,hget,mget);
 const syms=[...new Set(test.map(r=>r.s))];const loo=syms.map(s=>{const z=test.filter(r=>r.s!==s);return{excluded:s,n:z.length,hazard_auc:auc(z,hget),meta_auc:auc(z,mget),auc_delta:(auc(z,hget)??0)-(auc(z,mget)??0)}}).filter(x=>x.n>=20);
 const halves=[test.slice(0,Math.floor(test.length/2)),test.slice(Math.floor(test.length/2))].map((z,i)=>({half:i+1,n:z.length,hazard_auc:auc(z,hget),meta_auc:auc(z,mget),hazard_buy_cont:metrics(z,hget,hCut).selected_cont,meta_buy_cont:metrics(z,mget,mCut).selected_cont}));
 const selected=test.filter(r=>hget(r)>=hCut),counts={};for(const r of selected)counts[r.s]=(counts[r.s]||0)+1;const cs=Object.values(counts).sort((a,b)=>b-a),conc={symbols:Object.keys(counts).length,top_symbol_share:selected.length?(cs[0]||0)/selected.length:0,top3_share:selected.length?cs.slice(0,3).reduce((a,b)=>a+b,0)/selected.length:0};
 const report={ok:true,research_only:true,hypothesis_id:'H-COMPETING-HAZARD-001',hypothesis:'A discrete-time competing-risks model from minute 5 separates continuation hazard from failure hazard better than the static meta-agent.',acquisition:{source:'BINANCE_VISION_DATA_API',candidates:candidates.length,usable:n,errors},decision_point_minute:DECISION,intervals:INTERVALS,split_raw:{train:raw.train.length,val:raw.val.length,test:raw.test.length,final_holdout:raw.final.length},risk_set:{train:train.length,val:val.length,test:test.length},ambiguous_same_bar:rows.filter(r=>r.ev.type==='AMBIG').length,final_holdout_status:'UNTOUCHED_NOT_EVALUATED',model:{person_periods_train:HZ.person_periods,eligible_train:HZ.eligible,l2:.05,meta_weights:M.W,hazard_buy_threshold:hCut,meta_buy_threshold:mCut},test:{hazard:hm,meta:mm,auc_delta:(hm.auc??0)-(mm.auc??0),bootstrap_auc_delta:boot,economics_hazard:econ(test,hget,hCut),economics_meta:econ(test,mget,mCut)},adversarial:{leave_one_symbol_out:loo,temporal_halves:halves,concentration:conc},guard:'FINAL HOLDOUT CLOSED / NO ORDERS / NO PRODUCTION WRITES'};
 const looStable=loo.length===0||loo.filter(x=>x.auc_delta>=0).length/loo.length>=.65;
 const timeStable=halves.filter(x=>Number.isFinite(x.hazard_auc)&&Number.isFinite(x.meta_auc)&&x.hazard_auc>=x.meta_auc).length>=1;
 report.decision=(hm.auc!==null&&mm.auc!==null&&hm.auc>=mm.auc+.02&&hm.selected_cont>=mm.selected_cont&&boot.ci95[0]>-.03&&looStable&&timeStable&&conc.top_symbol_share<=.40)?'SURVIVES_FOR_FURTHER_TESTING':'REJECTED_OR_INCONCLUSIVE';
 report.next_hypothesis=report.decision==='SURVIVES_FOR_FURTHER_TESTING'?'Red-team competing hazards with purged walk-forward, interval perturbation, cost/delay stress, and calibration before any final holdout.':'Model the joint distribution of MFE/MAE or latent continuation species; competing hazards did not add robust OOS separation over the static meta-agent.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
