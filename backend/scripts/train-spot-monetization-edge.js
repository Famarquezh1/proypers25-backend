'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const ENTRY={lambdaOpportunity:3,lambdaMonetization:3,mix:1,keep:.30,source:'MONETIZATION_EDGE_V1 best development-only near-edge; 3/4 folds and all aggregate deltas positive'};
const EXITS=[
  {id:'capture_15_08_15_06_2h',hardStop:.015,beTrigger:.008,beLock:.001,trailTrigger:.015,trailGap:.006,staleBars:24},
  {id:'capture_20_10_20_08_3h',hardStop:.020,beTrigger:.010,beLock:.001,trailTrigger:.020,trailGap:.008,staleBars:36},
  {id:'capture_25_12_25_10_4h',hardStop:.025,beTrigger:.012,beLock:.001,trailTrigger:.025,trailGap:.010,staleBars:48},
  {id:'capture_30_15_30_12_6h',hardStop:.030,beTrigger:.015,beLock:.001,trailTrigger:.030,trailGap:.012,staleBars:72},
  {id:'capture_35_18_35_15_8h',hardStop:.035,beTrigger:.018,beLock:.001,trailTrigger:.035,trailGap:.015,staleBars:96},
  {id:'capture_40_20_40_18_10h',hardStop:.040,beTrigger:.020,beLock:.001,trailTrigger:.040,trailGap:.018,staleBars:120}
];

function loadBase(){
 let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
 src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
 const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
 vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function sd(x){const m=avg(x);return Math.sqrt(avg(x.map(v=>(v-m)**2)))||1}
function qtl(x,q){const a=[...x].sort((a,b)=>a-b),p=(a.length-1)*q,i=Math.floor(p),f=p-i;return a[i]+(a[Math.min(a.length-1,i+1)]-a[i])*f}
function logSafe(x){return Math.log(Math.max(.2,Number(x)||.2))}
const FEATURES=['log_trade_accel','breakout60','breakout240','breakout_x_volume','r15','r60','r240','rs60','extension','vol_slope','continuation','confirm'];
function vec(s){const f=s.f||{},d=s.productionV42?.detail||{};return [
 logSafe(f.tradeAccel),Number(f.breakout60||0),Number(f.breakout240||0),Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),
 Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(f.rs60||0),Number(d.extension||0),
 logSafe(f.vol15)-logSafe(f.vol30),Number(s.continuationScore||0),Number(d.confirm||0)
].map(x=>Number.isFinite(x)?x:0)}
function solve(A,y){const n=y.length,M=A.map((r,i)=>[...r,y[i]]);for(let c=0;c<n;c++){let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;if(Math.abs(M[p][c])<1e-12)return null;[M[c],M[p]]=[M[p],M[c]];const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j]}}return M.map(r=>r[n])}
function fit(rows,lambda){if(rows.length<25)return null;const X=rows.map(x=>vec(x.s)),p=X[0].length,mean=Array(p).fill(0),scale=Array(p).fill(1);for(let j=0;j<p;j++){const col=X.map(x=>x[j]);mean[j]=avg(col);scale[j]=sd(col)}const d=p+1,A=Array.from({length:d},()=>Array(d).fill(0)),Y=Array(d).fill(0);rows.forEach((r,k)=>{const x=[1,...X[k].map((v,j)=>(v-mean[j])/scale[j])];for(let i=0;i<d;i++){Y[i]+=x[i]*r.y;for(let j=0;j<d;j++)A[i][j]+=x[i]*x[j]}});for(let j=1;j<d;j++)A[j][j]+=lambda*rows.length;const beta=solve(A,Y);return beta?{beta,mean,scale}:null}
function pred(m,s){const x=vec(s);let z=m.beta[0];for(let j=0;j<x.length;j++)z+=m.beta[j+1]*((x[j]-m.mean[j])/m.scale[j]);return z}
function tradeNet(lib,s){return Number(lib.r.simulateExit(s,lib.b.BASE_EXIT)?.net||0)}
function oppTarget(s){const o=s.outcome||{};return .35*Number(o.mfe12||0)+.006*(o.winner5?1:0)+.014*(o.winner10?1:0)-.05*Math.max(0,-Number(o.maeToPeak||0))}
function fitLine(rows){const x=rows.map(r=>Number(r.s.outcome?.mfe12||0)),y=rows.map(r=>r.net),xm=avg(x),ym=avg(y),den=x.reduce((a,v)=>a+(v-xm)**2,0)||1,b=x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/den;return {a:ym-b*xm,b}}
function fitPair(lib,sigs){const opp=fit(sigs.map(s=>({s,y:oppTarget(s)})),ENTRY.lambdaOpportunity);const b=sigs.map(s=>({s,net:tradeNet(lib,s)})),line=fitLine(b),mon=fit(b.map(x=>({s:x.s,y:x.net-(line.a+line.b*Number(x.s.outcome?.mfe12||0))})),ENTRY.lambdaMonetization);return {opp,mon,line}}
function stats(pair,sigs){const a=sigs.map(s=>pred(pair.opp,s)),b=sigs.map(s=>pred(pair.mon,s));return {am:avg(a),as:sd(a),bm:avg(b),bs:sd(b)}}
function score(pair,st,s){return (pred(pair.opp,s)-st.am)/st.as+ENTRY.mix*(pred(pair.mon,s)-st.bm)/st.bs}
function select(pair,st,train,evals){const th=qtl(train.map(s=>score(pair,st,s)),1-ENTRY.keep);return {threshold:th,signals:evals.filter(s=>score(pair,st,s)>=th)}}
function predMetrics(lib,s){return lib.predictionMetrics(s)}
function econ(lib,s,all,exit){const m=lib.r.portfolio(s,all,lib.b.META_FALLBACK,x=>lib.r.simulateExit(x,exit),()=>lib.b.FIXED_SIZE);lib.r.withRecall(m,m._trades||[],all);return lib.r.safeMetrics(m)}
function econDelta(a,b){return {net_growth:a.netGrowth-b.netGrowth,avg_net_ret:a.avgNetRet-b.avgNetRet,max_drawdown:a.maxDrawdown-b.maxDrawdown,win_rate:a.winRate-b.winRate}}
function entryDelta(a,b){return {winner5_precision:a.winner5Precision-b.winner5Precision,winner10_precision:a.winner10Precision-b.winner10Precision,avg_mfe12:a.avgMfe12-b.avgMfe12}}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';
 process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
 const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
 const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
 const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));
 const audits=[],allSelected=[];let start=initial;
 for(let round=1;round<=4&&start<ds.length;round++){
   const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end);
   const pair=fitPair(lib,train),st=stats(pair,train),sel=select(pair,st,train,val);
   allSelected.push(...sel.signals);
   const all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
   const baseExit=econ(lib,sel.signals,all,lib.b.BASE_EXIT);
   const exits=EXITS.map(exit=>{const m=econ(lib,sel.signals,all,exit),d=econDelta(m,baseExit);return {exit,metrics:m,delta_vs_base:d,pass:m.netGrowth>0&&m.avgNetRet>0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}});
   audits.push({round,train:train.length,eval:val.length,selected:sel.signals.length,threshold:sel.threshold,base_exit:baseExit,exits});
   start=end;
 }
 const walkAll=dev.filter(s=>s.t>=ds[initial].t);
 const baseWalk=econ(lib,allSelected,walkAll,lib.b.BASE_EXIT);
 const exitSummary=EXITS.map(exit=>{
   const m=econ(lib,allSelected,walkAll,exit),d=econDelta(m,baseWalk);
   const folds=audits.map(a=>a.exits.find(x=>x.exit.id===exit.id));
   return {exit,metrics:m,delta_vs_base:d,pass_folds:folds.filter(x=>x.pass).length,folds,viable:m.netGrowth>0&&m.avgNetRet>0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0&&folds.filter(x=>x.pass).length>=3};
 }).sort((a,b)=>(b.metrics.netGrowth*15+b.metrics.avgNetRet*10+b.metrics.maxDrawdown*2)-(a.metrics.netGrowth*15+a.metrics.avgNetRet*10+a.metrics.maxDrawdown*2));
 const chosen=exitSummary.find(x=>x.viable)||null;

 let confirmation=null,pass=false;
 if(chosen){
   const pair=fitPair(lib,ds),st=stats(pair,ds),sel=select(pair,st,ds,hs);
   const pm=predMetrics(lib,sel.signals),pb=predMetrics(lib,hs),pd=entryDelta(pm,pb);
   const base=econ(lib,sel.signals,hold,lib.b.BASE_EXIT),matched=econ(lib,sel.signals,hold,chosen.exit),ed=econDelta(matched,base);
   confirmation={selected:sel.signals.length,threshold:sel.threshold,prediction:pm,baseline_prediction:pb,prediction_delta:pd,base_exit:base,matched_exit:matched,exit_delta:ed};
   pass=sel.signals.length>=8&&pd.winner5_precision>=0&&pd.winner10_precision>=0&&matched.netGrowth>0&&matched.avgNetRet>0&&ed.net_growth>=0&&ed.avg_net_ret>=0&&ed.max_drawdown>=0;
 }
 const report={version:'MONETIZATION_EDGE_V2_CAPTURE',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
   objective:'Keep the V1 development-only opportunity+monetization entry policy fixed, train only a small frozen family of earlier capture exits on chronological development folds, then test entry+exit once on the untouched July holdout.',
   entry_policy:ENTRY,base_exit:lib.b.BASE_EXIT,exit_family:EXITS,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
   walk_forward:audits,base_walk:baseWalk,exit_summary:exitSummary,selected_exit:chosen?chosen:null,confirmation,confirmation_pass:pass,
   decision:!chosen?{label:'CAPTURE_EXIT_NOT_FOUND_IN_WALK_FORWARD',ready:false}:pass?{label:'MONETIZATION_CAPTURE_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'MONETIZATION_CAPTURE_FAILED_FRESH_HOLDOUT',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
 console.log(JSON.stringify({version:report.version,entry_policy:ENTRY,base_walk:baseWalk,top_exits:exitSummary.slice(0,4).map(x=>({id:x.exit.id,metrics:x.metrics,delta:x.delta_vs_base,pass_folds:x.pass_folds,viable:x.viable})),selected_exit:chosen?.exit||null,confirmation:confirmation?{selected:confirmation.selected,prediction_delta:confirmation.prediction_delta,base_exit:confirmation.base_exit,matched_exit:confirmation.matched_exit,exit_delta:confirmation.exit_delta}:null,confirmation_pass:pass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
