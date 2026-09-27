'use strict';

/*
 * H-FAST-TRANSITION-WF-001
 * Expanding purged walk-forward on the development block only.
 * Decision at minute 5. Target: +2% before -1% within the next 25 minutes,
 * both measured from minute-5 entry. Fixed policy TP2/SL1/timeout30.
 * Last 15% FINAL HOLDOUT is never scored.
 */
const GH='https://api.github.com', BIN='https://data-api.binance.vision', TOKEN=process.env.GITHUB_TOKEN;
const H=240,D=5,FAST_END=30,COST=.004,EMBARGO=4*60*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function json(url,h={}){for(let i=0;i<5;i++){const r=await fetch(url,{headers:{'User-Agent':'Proypers25-FastTransition-WF/1.0',...h}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw Error(r.status+' '+url)}throw Error('fetch failed')}
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0;
const quant=(a,q)=>{const z=a.filter(Number.isFinite).sort((x,y)=>x-y);return z.length?z[Math.floor((z.length-1)*q)]:0};
const sigmoid=x=>x>=0?1/(1+Math.exp(-x)):Math.exp(x)/(1+Math.exp(x));
function sym(x){return (x.title+'\n'+(x.body||'')).match(/\b([A-Z0-9]{2,15}USDT)\b/)?.[1]}
function stepFeatures(k,p0){
 const cs=[1,2,3,5].map(i=>+k[i][4]/p0-1), inc=[cs[0],cs[1]-cs[0],cs[2]-cs[1],cs[3]-cs[2]];
 const z=k.slice(0,D+1);const hi=Math.max(...z.map(x=>+x[2])),lo=Math.min(...z.map(x=>+x[3])),cl=+z.at(-1)[4];
 let up=0,vol=0,vprev=0;for(let i=1;i<z.length;i++){if(+z[i][4]>+z[i-1][4])up++;vol+=+z[i][5];vprev+=+z[i-1][5]}
 const peakIdx=z.reduce((a,x,i)=>+x[2]>+z[a][2]?i:a,0),lowIdx=z.reduce((a,x,i)=>+x[3]<+z[a][3]?i:a,0);
 const recovery=(cl-lo)/Math.max(1e-12,hi-lo),giveback=hi>p0?(hi-cl)/(hi-p0):0;
 return [...cs,...inc,lo/p0-1,hi/p0-1,recovery,giveback,up/D,Math.log(Math.max(.01,vol/Math.max(1e-12,vprev))),peakIdx/D,lowIdx/D];
}
function target(k){
 const e=+k[D][4];let hp=Infinity,hs=Infinity;
 for(let i=D+1;i<=FAST_END;i++){if(hp===Infinity&&+k[i][2]>=e*1.02)hp=i;if(hs===Infinity&&+k[i][3]<=e*.99)hs=i}
 return{y:hp<hs&&hp<=FAST_END?1:0,hitProfit:hp,hitStop:hs,entry:e};
}
function simulate(r,cost=COST){const e=r.fast.entry;for(let i=D+1;i<=FAST_END;i++){const hi=+r.k[i][2],lo=+r.k[i][3];if(lo<=e*.99)return-.01-cost;if(hi>=e*1.02)return.02-cost}return +r.k[FAST_END][4]/e-1-cost}
function fitScaler(rows,get){const X=rows.map(get),d=X[0].length,mu=[],sd=[];for(let j=0;j<d;j++){const a=X.map(x=>x[j]),m=mean(a),s=Math.sqrt(mean(a.map(v=>(v-m)**2)))||1;mu.push(m);sd.push(s)}return x=>[1,...x.map((v,j)=>(v-mu[j])/sd[j])]}
function fitLogistic(rows,get,lambda=.10,iters=1400,lr=.035){const scale=fitScaler(rows,get),X=rows.map(r=>scale(get(r))),y=rows.map(r=>r.fast.y),w=Array(X[0].length).fill(0);for(let it=0;it<iters;it++){const g=Array(w.length).fill(0);for(let i=0;i<X.length;i++){let s=0;for(let j=0;j<w.length;j++)s+=w[j]*X[i][j];const e=sigmoid(s)-y[i];for(let j=0;j<w.length;j++)g[j]+=e*X[i][j]}for(let j=0;j<w.length;j++){g[j]/=X.length;if(j>0)g[j]+=lambda*w[j];w[j]-=lr*g[j]}}return r=>{const x=scale(get(r));return sigmoid(w.reduce((s,v,i)=>s+v*x[i],0))}}
function fullGet(r){return r.x}
function baseGet(r){return [r.x[3],r.x[8],r.x[9],r.x[12]]} // state-only baseline: ret5, adverse, high, upFrac
function metrics(rows,get,cut){const s=rows.filter(r=>get(r)>=cut),rets=s.map(simulate),allR=rows.map(simulate);const gp=rets.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=-rets.filter(x=>x<0).reduce((a,b)=>a+b,0);return{n:rows.length,selected_n:s.length,coverage:s.length/Math.max(1,rows.length),event_rate:mean(rows.map(r=>r.fast.y)),selected_event_rate:mean(s.map(r=>r.fast.y)),avg_net:mean(rets),baseline_all_avg_net:mean(allR),positive:mean(rets.map(x=>x>0?1:0)),profit_factor:gl?gp/gl:null,symbols:new Set(s.map(r=>r.s)).size}}
function auc(rows,get){const p=rows.filter(r=>r.fast.y),n=rows.filter(r=>!r.fast.y);let w=0,t=0;for(const a of p)for(const b of n){const x=get(a),y=get(b);t++;w+=x>y?1:x===y?.5:0}return t?w/t:null}
function purgeBefore(rows,start){return rows.filter(r=>r.t<=start-EMBARGO)}
function fold(rows,trainEnd,valEnd,evalEnd){
 const rawTrain=rows.slice(0,trainEnd),rawVal=rows.slice(trainEnd,valEnd),ev=rows.slice(valEnd,evalEnd);
 if(!rawVal.length||!ev.length)return null;
 const tr=purgeBefore(rawTrain,rawVal[0].t),va=purgeBefore(rawVal,ev[0].t);
 if(tr.length<50||va.length<10||ev.length<15)return null;
 const F=fitLogistic(tr,fullGet),B=fitLogistic(tr,baseGet),fc=quant(va.map(F),.75),bc=quant(va.map(B),.75);
 return{boundaries:{train_raw:rawTrain.length,train_purged:tr.length,val_raw:rawVal.length,val_purged:va.length,eval:ev.length},full:{val:metrics(va,F,fc),eval:metrics(ev,F,fc),auc:auc(ev,F),cut:fc},baseline:{val:metrics(va,B,bc),eval:metrics(ev,B,bc),auc:auc(ev,B),cut:bc},evalRows:ev.map(r=>({r,full:F(r),base:B(r),fullCut:fc,baseCut:bc}))};
}
function aggregate(fs,key){const z=[];for(const f of fs)for(const q of f.evalRows){const sc=key==='full'?q.full:q.base,cut=key==='full'?q.fullCut:q.baseCut;if(sc>=cut)z.push(q.r)}const rets=z.map(simulate),gp=rets.filter(x=>x>0).reduce((a,b)=>a+b,0),gl=-rets.filter(x=>x<0).reduce((a,b)=>a+b,0);return{selected_n:z.length,avg_net:mean(rets),positive:mean(rets.map(x=>x>0?1:0)),profit_factor:gl?gp/gl:null,event_rate:mean(z.map(r=>r.fast.y)),symbols:new Set(z.map(r=>r.s)).size,rows:z}}
function bootstrap(rows,B=1500){let seed=727;const rnd=()=>{seed=(seed*1664525+1013904223)>>>0;return seed/4294967296},a=[];for(let b=0;b<B;b++){const z=[];for(let i=0;i<rows.length;i++)z.push(rows[Math.floor(rnd()*rows.length)]);a.push(mean(z.map(simulate)))}a.sort((x,y)=>x-y);return{n:a.length,mean:mean(a),ci95:[quant(a,.025),quant(a,.975)],p_le_0:a.filter(x=>x<=0).length/a.length}}
(async()=>{
 let issues=[];for(let p=1;p<=5;p++){const a=await json(GH+'/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page='+p+'&sort=created&direction=desc',{Authorization:'Bearer '+TOKEN,'X-GitHub-Api-Version':'2022-11-28'});issues.push(...a.filter(x=>!x.pull_request));if(a.length<100)break}
 const candidates=issues.filter(x=>/spot signal/i.test(x.title)||/SPOT SIGNAL/i.test(x.body||'')).slice(0,300),errors={},rows=[];
 for(const x of candidates){const s=sym(x);if(!s)continue;const t=Date.parse(x.created_at);try{const u=new URL(BIN+'/api/v3/klines');for(const [a,b] of Object.entries({symbol:s,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(a,b);const k=await json(u);if(k.length<H+1)continue;const p0=+k[0][1];rows.push({t,s,k,x:stepFeatures(k,p0),fast:target(k)})}catch(e){const z=String(e?.message||e).split(' ')[0];errors[z]=(errors[z]||0)+1}await sleep(15)}
 if(rows.length<100)throw Error('INSUFFICIENT_CAUSAL_UNIVERSE '+rows.length);
 rows.sort((a,b)=>a.t-b.t);const finalN=Math.ceil(rows.length*.15),dev=rows.slice(0,rows.length-finalN),final=rows.slice(rows.length-finalN);
 const specs=[[100,120,160],[140,160,200],[180,200,dev.length]],folds=specs.map(x=>fold(dev,...x)).filter(Boolean);
 const full=aggregate(folds,'full'),base=aggregate(folds,'base');
 const byFold=folds.map((f,i)=>({fold:i+1,boundaries:f.boundaries,full:{...f.full,evalRows:undefined},baseline:{...f.baseline,evalRows:undefined}}));
 const syms=[...new Set(full.rows.map(r=>r.s))],loo=syms.map(s=>{const z=full.rows.filter(r=>r.s!==s);return{excluded:s,n:z.length,avg_net:mean(z.map(simulate)),event_rate:mean(z.map(r=>r.fast.y))}}).filter(x=>x.n>=8);
 const halves=[full.rows.slice(0,Math.floor(full.rows.length/2)),full.rows.slice(Math.floor(full.rows.length/2))].map((z,i)=>({half:i+1,n:z.length,avg_net:mean(z.map(simulate)),event_rate:mean(z.map(r=>r.fast.y))}));
 const report={ok:true,research_only:true,hypothesis_id:'H-FAST-TRANSITION-WF-001',hypothesis:'Front-loaded minute-5 transition structure predicts a monetizable +2% before -1% event within 30 minutes better than a static state baseline.',acquisition:{source:'BINANCE_VISION_DATA_API',candidates:candidates.length,usable:rows.length,errors},method:{development_n:dev.length,final_holdout_n:final.length,embargo_hours:4,fold_specs:specs,validation_quantile:.75,l2:.10,target:'minute5 entry: +2% before -1% by minute30',policy:'TP2/SL1/timeout30',cost:COST},folds:byFold,aggregate:{full:{...full,rows:undefined,bootstrap:bootstrap(full.rows)},baseline:{...base,rows:undefined,bootstrap:bootstrap(base.rows)}},red_team:{leave_one_symbol_out:loo,temporal_halves:halves,concentration:(()=>{const m={};for(const r of full.rows)m[r.s]=(m[r.s]||0)+1;const a=Object.values(m).sort((x,y)=>y-x);return{symbols:Object.keys(m).length,top_symbol_share:full.rows.length?(a[0]||0)/full.rows.length:0,top3_share:full.rows.length?a.slice(0,3).reduce((x,y)=>x+y,0)/full.rows.length:0}})()},final_holdout_status:'UNTOUCHED_NOT_EVALUATED',guard:'NO FINAL HOLDOUT SCORING / NO ORDERS / NO PRODUCTION WRITES'};
 const foldPositive=byFold.filter(x=>x.full.eval.avg_net>0).length;
 report.decision=(full.avg_net>0&&full.profit_factor>1&&full.event_rate>base.event_rate&&full.avg_net>base.avg_net&&report.aggregate.full.bootstrap.ci95[0]>-.005&&foldPositive>=2&&report.red_team.concentration.top_symbol_share<=.35)?'SURVIVES_FOR_FURTHER_TESTING':'REJECTED_OR_INCONCLUSIVE';
 report.next_hypothesis=report.decision==='SURVIVES_FOR_FURTHER_TESTING'?'Freeze the walk-forward fast-transition architecture; stress costs, delay, episode grouping and threshold perturbation on development only before considering a single final-holdout opening.':'Investigate discrete failure/recovery transition motifs or market-context interactions using the same purged walk-forward framework.';
 console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
