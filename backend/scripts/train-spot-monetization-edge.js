'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const ENTRY={lambdaOpportunity:3,lambdaMonetization:3,mix:1,keep:.30,source:'MONETIZATION_EDGE_V1 development-only near-edge'};
const LAMBDAS=[.1,.3,1,3];
const KEEPS=[.35,.50,.65,.80,1];
const EXITS=[
 {id:'BASE',base:true},
 {id:'cap40',hardStop:.040,beTrigger:.020,beLock:.001,trailTrigger:.040,trailGap:.018,staleBars:120}
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
function corrLag1(xs){if(xs.length<3)return 0;const a=xs.slice(0,-1),b=xs.slice(1),am=avg(a),bm=avg(b),as=sd(a),bs=sd(b);return avg(a.map((x,i)=>((x-am)/as)*((b[i]-bm)/bs)))}

function baseVec(s){
 const f=s.f||{},d=s.productionV42?.detail||{};
 return [logSafe(f.tradeAccel),Number(f.breakout60||0),Number(f.breakout240||0),Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(f.rs60||0),Number(d.extension||0),logSafe(f.vol15)-logSafe(f.vol30),Number(s.continuationScore||0),Number(d.confirm||0)].map(x=>Number.isFinite(x)?x:0);
}
const CONTEXT=['rv24','rv72','ret24','ret72','trend_eff24','trend_eff72','autocorr24','up_ratio24','jump_freq24','jump_freq72','range_mean24','upper_wick_mean24','volume_cv24','volume_autocorr24','drawdown24','recovery24','qv_log'];
function contextVec(s){
 const a=s.series,i=s.index,win24=a.slice(Math.max(1,i-288),i+1),win72=a.slice(Math.max(1,i-864),i+1);
 function returns(win){const z=[];for(let k=1;k<win.length;k++)z.push(ret(win[k-1].c,win[k].c));return z}
 const r24=returns(win24),r72=returns(win72);
 const rv24=sd(r24),rv72=sd(r72),ret24=ret(win24[0]?.c,win24[win24.length-1]?.c),ret72=ret(win72[0]?.c,win72[win72.length-1]?.c);
 const eff=(rs,total)=>Math.abs(total)/Math.max(1e-9,rs.reduce((z,x)=>z+Math.abs(x),0));
 const up=r24.length?r24.filter(x=>x>0).length/r24.length:.5;
 const jf=(rs,th)=>rs.length?rs.filter(x=>x>th).length/rs.length:0;
 const ranges=win24.map(x=>(Number(x.h)-Number(x.l))/Math.max(1e-12,Number(x.o)));
 const wick=win24.map(x=>{const rg=Math.max(1e-12,Number(x.h)-Number(x.l));return (Number(x.h)-Math.max(Number(x.o),Number(x.c)))/rg});
 const qs=win24.map(x=>Math.log1p(Number(x.q||0))),qcv=sd(qs)/Math.max(1e-9,Math.abs(avg(qs)));
 const vmax=Math.max(...win24.map(x=>Number(x.h||0))),vmin=Math.min(...win24.map(x=>Number(x.l||0))),last=Number(win24[win24.length-1]?.c||0);
 const dd=vmax>0?last/vmax-1:0,recovery=vmin>0?last/vmin-1:0;
 return [rv24,rv72,ret24,ret72,eff(r24,ret24),eff(r72,ret72),corrLag1(r24),up,jf(r24,.005),jf(r72,.005),avg(ranges),avg(wick),qcv,corrLag1(qs),dd,recovery,Math.log1p(Number(s.f?.qv||0))].map(x=>Number.isFinite(x)?x:0);
}
function solve(A,y){
 const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
 for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;if(Math.abs(M[p][c])<1e-12)return null;[M[c],M[p]]=[M[p],M[c]];const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j]}}
 return M.map(r=>r[n]);
}
function fit(rows,lambda,fn){
 if(rows.length<24)return null;
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
function exitCfg(lib,e){return e.base?lib.b.BASE_EXIT:e}
function netWithExit(lib,s,e){return Number(lib.r.simulateExit(s,exitCfg(lib,e))?.net||0)}
function economic(lib,s,all,e){const cfg=exitCfg(lib,e),m=lib.r.portfolio(s,all,lib.b.META_FALLBACK,x=>lib.r.simulateExit(x,cfg),()=>lib.b.FIXED_SIZE);lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m)}
function metrics(lib,s,all,e={base:true}){return {prediction:lib.predictionMetrics(s),economic:economic(lib,s,all,e)}}
function delta(a,b){return {winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,net_growth:a.economic.netGrowth-b.economic.netGrowth,avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown}}
function nonneg(d){return d.winner5_precision>=0&&d.winner10_precision>=0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}
function obj(d){return d.net_growth*14+d.avg_net_ret*10+d.max_drawdown*3+d.winner5_precision*2+d.winner10_precision*3}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
 const configs=[];for(const lambda of LAMBDAS)for(const keep of KEEPS)for(const e of EXITS)configs.push({lambda,keep,exit:e,folds:[],selected:[]});
 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
 for(let round=1;round<=4&&start<ds.length;round++){
   const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
   const ep=fitEntry(lib,train),es=entryStats(ep,train),tr=selectEntry(ep,es,train,train),ve=selectEntry(ep,es,train,val),baseM=metrics(lib,val,all,{base:true});
   for(const e of EXITS){
     const cm=fit(tr.map(s=>({s,y:netWithExit(lib,s,e)})),.3,contextVec);
     for(const lambda of LAMBDAS){
       const model=lambda===.3?cm:fit(tr.map(s=>({s,y:netWithExit(lib,s,e)})),lambda,contextVec);if(!model)continue;
       const trainScores=tr.map(s=>pred(model,s,contextVec));
       for(const keep of KEEPS){
         const th=qtl(trainScores,1-keep),selected=ve.filter(s=>pred(model,s,contextVec)>=th),m=metrics(lib,selected,all,e),d=delta(m,baseM);
         const cfg=configs.find(x=>x.lambda===lambda&&x.keep===keep&&x.exit.id===e.id);
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
   const model=fit(tr.map(s=>({s,y:netWithExit(lib,s,chosen.exit)})),chosen.lambda,contextVec),th=qtl(tr.map(s=>pred(model,s,contextVec)),1-chosen.keep);
   const selected=he.filter(s=>pred(model,s,contextVec)>=th),bm=metrics(lib,hs,hold,{base:true}),m=metrics(lib,selected,hold,chosen.exit),d=delta(m,bm);
   confirmation={entry_selected:he.length,selected:selected.length,threshold:th,baseline:bm,metrics:m,delta:d,exit:chosen.exit};
   pass=selected.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
   attr=CONTEXT.map((n,i)=>({feature:n,coefficient:model.beta[i+1],abs:Math.abs(model.beta[i+1])})).sort((a,b)=>b.abs-a.abs);
 }
 const adequate=configs.filter(x=>x.aggregate.selected>=16).sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
 const report={version:'MONETIZATION_EDGE_V6_ASSET_PERSISTENCE_CONTEXT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
 objective:'Use only pre-entry 24h/72h asset-state context to learn whether a V1 signal is likely to monetize: trend persistence, realized volatility, return autocorrelation, jump frequency, trend efficiency, wick structure, volume persistence and drawdown/recovery. Context and exit are trained only on Apr-Jun walk-forward; July opens only after a positive stable policy exists.',
 entry_policy:ENTRY,context_features:CONTEXT,exit_family:EXITS,candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
 selected:chosen?{lambda:chosen.lambda,keep:chosen.keep,exit:chosen.exit,aggregate:chosen.aggregate,folds:chosen.folds}:null,
 top_adequate:adequate.slice(0,20).map(x=>({lambda:x.lambda,keep:x.keep,exit:x.exit,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
 confirmation,attribution:attr,confirmation_pass:pass,
 decision:!chosen?{label:'ASSET_PERSISTENCE_CONTEXT_NOT_FOUND_IN_WALK_FORWARD',ready:false}:pass?{label:'ASSET_PERSISTENCE_CONTEXT_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'ASSET_PERSISTENCE_CONTEXT_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,candidate_count:report.candidate_count,selected:report.selected?{lambda:report.selected.lambda,keep:report.selected.keep,exit:report.selected.exit,aggregate:report.selected.aggregate}:null,top_adequate:report.top_adequate.slice(0,8).map(x=>({lambda:x.lambda,keep:x.keep,exit:x.exit.id,viable:x.viable,aggregate:x.aggregate})),confirmation,top_context:attr?.slice(0,10)||null,confirmation_pass:pass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
