'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const ENTRY={lambdaOpportunity:3,lambdaMonetization:3,mix:1,keep:.30,source:'MONETIZATION_EDGE_V1 development-only near-edge'};
const TIMING_LAMBDAS=[.1,.3,1,3];
const TIMING_KEEPS=[.50,.65,.80,1];
const EXITS=[
 {id:'BASE',base:true},
 {id:'cap_35_18_35_15_8h',hardStop:.035,beTrigger:.018,beLock:.001,trailTrigger:.035,trailGap:.015,staleBars:96},
 {id:'cap_40_20_40_18_10h',hardStop:.040,beTrigger:.020,beLock:.001,trailTrigger:.040,trailGap:.018,staleBars:120},
 {id:'cap_45_22_45_20_12h',hardStop:.045,beTrigger:.022,beLock:.001,trailTrigger:.045,trailGap:.020,staleBars:144},
 {id:'cap_50_25_50_22_14h',hardStop:.050,beTrigger:.025,beLock:.001,trailTrigger:.050,trailGap:.022,staleBars:168}
];

function loadBase(){
 let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
 vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function sd(x){const m=avg(x);return Math.sqrt(avg(x.map(v=>(v-m)**2)))||1}
function qtl(x,q){if(!x.length)return 0;const a=[...x].sort((a,b)=>a-b),p=(a.length-1)*q,i=Math.floor(p),f=p-i;return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2))}
function ret(a,b){return a>0&&b>0?b/a-1:0}

function baseVec(s){
 const f=s.f||{},d=s.productionV42?.detail||{};
 return [logSafe(f.tradeAccel),Number(f.breakout60||0),Number(f.breakout240||0),Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(f.rs60||0),Number(d.extension||0),logSafe(f.vol15)-logSafe(f.vol30),Number(s.continuationScore||0),Number(d.confirm||0)].map(x=>Number.isFinite(x)?x:0);
}
const TIMING=['ret5','ret10_prev','ret15_prev','ret_accel','body','close_location','upper_wick','range_expansion','volume_jump','volume_accel','compression_30_120','prior_high_distance','breakout_age','green_streak'];
function timingVec(s){
 const a=s.series,i=s.index,b=a[i],p1=a[i-1],p2=a[i-2],p3=a[i-3];
 const r5=ret(p1.c,b.c),r10=ret(p2.c,p1.c),r15=ret(p3.c,p2.c);
 const body=ret(b.o,b.c),range=Math.max(1e-12,Number(b.h)-Number(b.l));
 const cl=(Number(b.c)-Number(b.l))/range,uw=(Number(b.h)-Math.max(Number(b.o),Number(b.c)))/range;
 const ranges=a.slice(i-6,i).map(x=>(Number(x.h)-Number(x.l))/Math.max(1e-12,Number(x.o)));
 const rangeNow=(Number(b.h)-Number(b.l))/Math.max(1e-12,Number(b.o)),rangeExpansion=rangeNow/Math.max(1e-9,avg(ranges));
 const q6=avg(a.slice(i-6,i).map(x=>Number(x.q||0))),qPrev=avg(a.slice(i-7,i-1).map(x=>Number(x.q||0)));
 const vj=Number(b.q||0)/Math.max(1,q6),va=avg([Number(b.q||0),Number(p1.q||0)])/Math.max(1,qPrev);
 const r30=avg(a.slice(i-6,i).map(x=>(Number(x.h)-Number(x.l))/Math.max(1e-12,Number(x.o))));
 const r120=avg(a.slice(i-24,i-6).map(x=>(Number(x.h)-Number(x.l))/Math.max(1e-12,Number(x.o))));
 const compression=r30/Math.max(1e-9,r120),ph=Math.max(...a.slice(i-12,i).map(x=>Number(x.h||0))),dist=ph>0?Number(b.c)/ph-1:0;
 let age=0;for(let k=i;k>=Math.max(12,i-6);k--){const h=Math.max(...a.slice(k-12,k).map(x=>Number(x.h||0)));if(h>0&&Number(a[k].c)>h)age++;else break}
 let green=0;for(let k=i;k>=Math.max(0,i-5);k--){if(Number(a[k].c)>Number(a[k].o))green++;else break}
 return [r5,r10,r15,r5-r10,body,cl,uw,rangeExpansion,vj,va,compression,dist,age,green].map(x=>Number.isFinite(x)?x:0);
}
function solve(A,y){
 const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
 for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;if(Math.abs(M[p][c])<1e-12)return null;[M[c],M[p]]=[M[p],M[c]];const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j]}}
 return M.map(r=>r[n]);
}
function fit(rows,lambda,fn){
 if(rows.length<20)return null;
 const X=rows.map(x=>fn(x.s)),p=X[0].length,mean=Array(p).fill(0),scale=Array(p).fill(1);
 for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);scale[j]=sd(col)}
 const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);
 rows.forEach((r,k)=>{const x=[1,...X[k].map((v,j)=>(v-mean[j])/scale[j])];for(let i=0;i<d;i++){Y[i]+=x[i]*r.y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j]}});
 for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;
 const beta=solve(A,Y);return beta?{beta,mean,scale}:null;
}
function pred(m,s,fn){const x=fn(s);let z=m.beta[0];for(let j=0;j<x.length;j++)z+=m.beta[j+1]*((x[j]-m.mean[j])/m.scale[j]);return z}
function tradeNet(lib,s){return Number(lib.r.simulateExit(s,lib.b.BASE_EXIT)?.net||0)}
function oppTarget(s){const o=s.outcome||{};return .35*Number(o.mfe12||0)+.006*(o.winner5?1:0)+.014*(o.winner10?1:0)-.05*Math.max(0,-Number(o.maeToPeak||0))}
function fitLine(rows){const x=rows.map(r=>Number(r.s.outcome?.mfe12||0)),y=rows.map(r=>r.net),xm=avg(x),ym=avg(y),den=x.reduce((a,v)=>a+(v-xm)**2,0)||1,b=x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/den;return {a:ym-b*xm,b}}
function fitEntry(lib,sigs){
 const opp=fit(sigs.map(s=>({s,y:oppTarget(s)})),ENTRY.lambdaOpportunity,baseVec);
 const rr=sigs.map(s=>({s,net:tradeNet(lib,s)})),ln=fitLine(rr);
 const mon=fit(rr.map(x=>({s:x.s,y:x.net-(ln.a+ln.b*Number(x.s.outcome?.mfe12||0))})),ENTRY.lambdaMonetization,baseVec);
 return {opp,mon};
}
function entryStats(p,s){const a=s.map(x=>pred(p.opp,x,baseVec)),b=s.map(x=>pred(p.mon,x,baseVec));return {am:avg(a),as:sd(a),bm:avg(b),bs:sd(b)}}
function entryScore(p,st,s){return (pred(p.opp,s,baseVec)-st.am)/st.as+ENTRY.mix*(pred(p.mon,s,baseVec)-st.bm)/st.bs}
function selectEntry(p,st,train,evals){const th=qtl(train.map(s=>entryScore(p,st,s)),1-ENTRY.keep);return evals.filter(s=>entryScore(p,st,s)>=th)}
function timingTarget(lib,s){const o=s.outcome||{};return tradeNet(lib,s)+.10*Number(o.mfe12||0)+.004*(o.winner5?1:0)+.008*(o.winner10?1:0)}
function exitCfg(lib,e){return e.base?lib.b.BASE_EXIT:e}
function economic(lib,s,all,e){
 const cfg=exitCfg(lib,e),m=lib.r.portfolio(s,all,lib.b.META_FALLBACK,x=>lib.r.simulateExit(x,cfg),()=>lib.b.FIXED_SIZE);
 lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m);
}
function metrics(lib,s,all,e={base:true}){return {prediction:lib.predictionMetrics(s),economic:economic(lib,s,all,e)}}
function delta(a,b){return {winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,net_growth:a.economic.netGrowth-b.economic.netGrowth,avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown}}
function nonneg(d){return d.winner5_precision>=0&&d.winner10_precision>=0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}
function obj(d){return d.net_growth*14+d.avg_net_ret*10+d.max_drawdown*3+d.winner5_precision*2+d.winner10_precision*3}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
 const configs=[];for(const lambda of TIMING_LAMBDAS)for(const keep of TIMING_KEEPS)for(const e of EXITS)configs.push({lambda,keep,exit:e,folds:[],selected:[]});
 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
 for(let round=1;round<=4&&start<ds.length;round++){
   const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
   const ep=fitEntry(lib,train),es=entryStats(ep,train),tr=selectEntry(ep,es,train,train),ve=selectEntry(ep,es,train,val),baseM=metrics(lib,val,all,{base:true});
   for(const lambda of TIMING_LAMBDAS){
     const tm=fit(tr.map(s=>({s,y:timingTarget(lib,s)})),lambda,timingVec);if(!tm)continue;
     const trainScores=tr.map(s=>pred(tm,s,timingVec));
     for(const keep of TIMING_KEEPS){
       const th=qtl(trainScores,1-keep),selected=ve.filter(s=>pred(tm,s,timingVec)>=th);
       for(const e of EXITS){
         const cfg=configs.find(x=>x.lambda===lambda&&x.keep===keep&&x.exit.id===e.id),m=metrics(lib,selected,all,e),d=delta(m,baseM);
         cfg.selected.push(...selected);cfg.folds.push({round,entry_selected:ve.length,selected:selected.length,threshold:th,delta:d,metrics:m,pass:selected.length>=4&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0});
       }
     }
   }
   start=end;
 }
 const walkAll=dev.filter(s=>s.t>=ds[initial].t),walkBase=metrics(lib,ds.slice(initial),walkAll,{base:true});
 for(const cfg of configs){
   const m=metrics(lib,cfg.selected,walkAll,cfg.exit),d=delta(m,walkBase);
   cfg.aggregate={selected:cfg.selected.length,metrics:m,delta:d,objective:obj(d),pass_folds:cfg.folds.filter(f=>f.pass).length};
   cfg.viable=cfg.aggregate.selected>=16&&cfg.aggregate.pass_folds>=3&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
   delete cfg.selected;
 }
 configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);const chosen=configs.find(x=>x.viable)||null;
 let confirmation=null,pass=false,attr=null;
 if(chosen){
   const ep=fitEntry(lib,ds),es=entryStats(ep,ds),tr=selectEntry(ep,es,ds,ds),he=selectEntry(ep,es,ds,hs);
   const tm=fit(tr.map(s=>({s,y:timingTarget(lib,s)})),chosen.lambda,timingVec),th=qtl(tr.map(s=>pred(tm,s,timingVec)),1-chosen.keep);
   const selected=he.filter(s=>pred(tm,s,timingVec)>=th),bm=metrics(lib,hs,hold,{base:true}),m=metrics(lib,selected,hold,chosen.exit),d=delta(m,bm);
   confirmation={entry_selected:he.length,selected:selected.length,threshold:th,baseline:bm,metrics:m,delta:d,exit:chosen.exit};
   pass=selected.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
   attr=TIMING.map((n,i)=>({feature:n,coefficient:tm.beta[i+1],abs:Math.abs(tm.beta[i+1])})).sort((a,b)=>b.abs-a.abs);
 }
 const adequate=configs.filter(x=>x.aggregate.selected>=16).sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
 const report={version:'MONETIZATION_EDGE_V5_TIMING_CAPTURE_JOINT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
 objective:'Jointly evaluate a small causal timing-freshness model and a small capture-exit family on expanding Apr-Jun walk-forward. Entry V1 remains frozen. A joint policy must be absolutely profitable, improve all five CORE-relative metrics, and pass >=3 folds before July is opened.',
 entry_policy:ENTRY,timing_features:TIMING,exit_family:EXITS,candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
 selected:chosen?{lambda:chosen.lambda,keep:chosen.keep,exit:chosen.exit,aggregate:chosen.aggregate,folds:chosen.folds}:null,
 top_adequate:adequate.slice(0,20).map(x=>({lambda:x.lambda,keep:x.keep,exit:x.exit,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
 confirmation,attribution:attr,confirmation_pass:pass,
 decision:!chosen?{label:'JOINT_TIMING_CAPTURE_NOT_FOUND_IN_WALK_FORWARD',ready:false}:pass?{label:'JOINT_TIMING_CAPTURE_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'JOINT_TIMING_CAPTURE_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,candidate_count:report.candidate_count,selected:report.selected?{lambda:report.selected.lambda,keep:report.selected.keep,exit:report.selected.exit,aggregate:report.selected.aggregate}:null,top_adequate:report.top_adequate.slice(0,8).map(x=>({lambda:x.lambda,keep:x.keep,exit:x.exit.id,viable:x.viable,aggregate:x.aggregate})),confirmation,top_timing:attr?.slice(0,8)||null,confirmation_pass:pass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
