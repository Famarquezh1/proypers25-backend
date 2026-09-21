'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const ENTRY={lambdaOpportunity:3,lambdaMonetization:3,mix:1,keep:.30,source:'MONETIZATION_EDGE_V1 development-only near-edge'};
const MIN_FOLD_SELECTED=4;

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

const BASE=['log_trade_accel','breakout60','breakout240','breakout_x_volume','r15','r60','r240','rs60','extension','vol_slope','continuation','confirm'];
function baseVec(s){
  const f=s.f||{},d=s.productionV42?.detail||{};
  return [logSafe(f.tradeAccel),Number(f.breakout60||0),Number(f.breakout240||0),Math.max(0,Number(f.breakout60||0))*logSafe(f.vol15),Number(f.r15||0),Number(f.r60||0),Number(f.r240||0),Number(f.rs60||0),Number(d.extension||0),logSafe(f.vol15)-logSafe(f.vol30),Number(s.continuationScore||0),Number(d.confirm||0)].map(x=>Number.isFinite(x)?x:0);
}
function solve(A,y){
  const n=y.length,M=A.map((r,i)=>[...r,y[i]]);
  for(let c=0;c<n;c++){
    let p=c;for(let i=c+1;i<n;i++)if(Math.abs(M[i][c])>Math.abs(M[p][c]))p=i;
    if(Math.abs(M[p][c])<1e-12)return null;
    [M[c],M[p]]=[M[p],M[c]];
    const d=M[c][c];for(let j=c;j<=n;j++)M[c][j]/=d;
    for(let i=0;i<n;i++){if(i===c)continue;const f=M[i][c];for(let j=c;j<=n;j++)M[i][j]-=f*M[c][j];}
  }
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
function pred(m,s,fn){
  const x=fn(s);let z=m.beta[0];
  for(let j=0;j<x.length;j++)z+=m.beta[j+1]*((x[j]-m.mean[j])/m.scale[j]);
  return z;
}
function tradeNet(lib,s){return Number(lib.r.simulateExit(s,lib.b.BASE_EXIT)?.net||0)}
function oppTarget(s){
  const o=s.outcome||{};
  return .35*Number(o.mfe12||0)+.006*(o.winner5?1:0)+.014*(o.winner10?1:0)-.05*Math.max(0,-Number(o.maeToPeak||0));
}
function line(rows){
  const x=rows.map(r=>Number(r.s.outcome?.mfe12||0)),y=rows.map(r=>r.net),xm=avg(x),ym=avg(y),den=x.reduce((a,v)=>a+(v-xm)**2,0)||1,b=x.reduce((a,v,i)=>a+(v-xm)*(y[i]-ym),0)/den;
  return {a:ym-b*xm,b};
}
function fitEntry(lib,sigs){
  const opp=fit(sigs.map(s=>({s,y:oppTarget(s)})),ENTRY.lambdaOpportunity,baseVec);
  const rr=sigs.map(s=>({s,net:tradeNet(lib,s)})),ln=line(rr);
  const mon=fit(rr.map(x=>({s:x.s,y:x.net-(ln.a+ln.b*Number(x.s.outcome?.mfe12||0))})),ENTRY.lambdaMonetization,baseVec);
  return {opp,mon};
}
function entryStats(p,s){
  const a=s.map(x=>pred(p.opp,x,baseVec)),b=s.map(x=>pred(p.mon,x,baseVec));
  return {am:avg(a),as:sd(a),bm:avg(b),bs:sd(b)};
}
function entryScore(p,st,s){return (pred(p.opp,s,baseVec)-st.am)/st.as+ENTRY.mix*(pred(p.mon,s,baseVec)-st.bm)/st.bs}
function selectEntry(p,st,train,evals){
  const th=qtl(train.map(s=>entryScore(p,st,s)),1-ENTRY.keep);
  return {threshold:th,signals:evals.filter(s=>entryScore(p,st,s)>=th)};
}

const SEQ_FEATURES=['compression','breakout_age','sign_flips','upper_wick','close_location','volume_concentration','ret_concentration','efficiency30','pre_drawdown30','range_expansion','ret_accel','volume_accel','green_streak','prior_high_distance'];
function seq(s){
  const a=s.series,i=s.index,b=a[i],bars=a.slice(i-24,i+1),last6=a.slice(i-5,i+1),prior18=a.slice(i-23,i-5);
  const rets=[];for(let k=i-5;k<=i;k++)rets.push(ret(a[k-1]?.c,a[k]?.c));
  const absSum=rets.reduce((z,x)=>z+Math.abs(x),0)||1e-9;
  let flips=0;for(let k=1;k<rets.length;k++)if(rets[k]&&rets[k-1]&&Math.sign(rets[k])!==Math.sign(rets[k-1]))flips++;
  const total30=ret(a[i-6]?.c,b.c),eff=Math.abs(total30)/absSum;
  const range=x=>(Number(x.h)-Number(x.l))/Math.max(1e-12,Number(x.o));
  const shortRange=avg(last6.slice(0,-1).map(range)),longRange=avg(prior18.map(range));
  const compression=shortRange/Math.max(1e-9,longRange);
  const currRange=Math.max(1e-12,Number(b.h)-Number(b.l));
  const closeLoc=(Number(b.c)-Number(b.l))/currRange;
  const upper=(Number(b.h)-Math.max(Number(b.o),Number(b.c)))/currRange;
  const qsum=last6.reduce((z,x)=>z+Number(x.q||0),0)||1;
  const vConc=Number(b.q||0)/qsum;
  const rConc=Math.abs(rets[rets.length-1])/absSum;
  const maxClose=Math.max(...last6.map(x=>Number(x.c||0))),preDD=maxClose>0?Number(b.c)/maxClose-1:0;
  const rExp=range(b)/Math.max(1e-9,shortRange);
  const rAccel=rets[5]-rets[4];
  const priorQ=avg(a.slice(i-12,i-6).map(x=>Number(x.q||0)))||1;
  const vAccel=avg(last6.slice(-2).map(x=>Number(x.q||0)))/priorQ;
  let green=0;for(let k=i;k>=Math.max(0,i-5);k--){if(Number(a[k].c)>Number(a[k].o))green++;else break}
  let age=0;for(let k=i;k>=Math.max(12,i-6);k--){const h=Math.max(...a.slice(k-12,k).map(x=>Number(x.h||0)));if(h>0&&Number(a[k].c)>h)age++;else break}
  const ph=Math.max(...a.slice(i-12,i).map(x=>Number(x.h||0))),phd=ph>0?Number(b.c)/ph-1:0;
  return {compression,breakout_age:age,sign_flips:flips,upper_wick:upper,close_location:closeLoc,volume_concentration:vConc,ret_concentration:rConc,efficiency30:eff,pre_drawdown30:preDD,range_expansion:rExp,ret_accel:rAccel,volume_accel:vAccel,green_streak:green,prior_high_distance:phd};
}
const ATOMS=[
  ['compression','le',.50],['compression','le',.65],
  ['breakout_age','le',.50],['breakout_age','le',.75],
  ['sign_flips','le',.50],['sign_flips','le',.75],
  ['upper_wick','le',.50],['upper_wick','le',.65],
  ['close_location','ge',.50],['close_location','ge',.65],
  ['volume_concentration','ge',.50],['volume_concentration','ge',.65],
  ['ret_concentration','le',.50],['ret_concentration','le',.65],
  ['efficiency30','ge',.50],['efficiency30','ge',.65],
  ['pre_drawdown30','ge',.50],['pre_drawdown30','ge',.65],
  ['range_expansion','ge',.50],['range_expansion','ge',.65],
  ['ret_accel','ge',.50],['ret_accel','ge',.65],
  ['volume_accel','ge',.50],['volume_accel','ge',.65],
  ['green_streak','le',.50],['green_streak','le',.75],
  ['prior_high_distance','ge',.50],['prior_high_distance','ge',.65],
].map((x,i)=>({id:i,feature:x[0],dir:x[1],q:x[2],name:`${x[0]}_${x[1]}_q${Math.round(x[2]*100)}`}));

function rules(){
  const out=[{id:'BASE',atoms:[]}];
  for(let i=0;i<ATOMS.length;i++)out.push({id:ATOMS[i].name,atoms:[ATOMS[i]]});
  for(let i=0;i<ATOMS.length;i++)for(let j=i+1;j<ATOMS.length;j++){
    if(ATOMS[i].feature===ATOMS[j].feature)continue;
    out.push({id:`${ATOMS[i].name}__${ATOMS[j].name}`,atoms:[ATOMS[i],ATOMS[j]]});
  }
  const coreFeatures=new Set(['compression','breakout_age','sign_flips','upper_wick','close_location','volume_concentration','efficiency30','pre_drawdown30','range_expansion']);
  for(let i=0;i<ATOMS.length;i++)for(let j=i+1;j<ATOMS.length;j++)for(let k=j+1;k<ATOMS.length;k++){
    const fs=new Set([ATOMS[i].feature,ATOMS[j].feature,ATOMS[k].feature]);
    if(fs.size<3)continue;
    if(![...fs].some(x=>coreFeatures.has(x)))continue;
    out.push({id:`${ATOMS[i].name}__${ATOMS[j].name}__${ATOMS[k].name}`,atoms:[ATOMS[i],ATOMS[j],ATOMS[k]]});
  }
  return out;
}
function calibrateRule(rule,train){
  const vals=train.map(s=>seq(s)),ths={};
  for(const a of rule.atoms)ths[a.id]=qtl(vals.map(v=>v[a.feature]),a.q);
  return ths;
}
function passes(rule,ths,s){
  const v=seq(s);
  return rule.atoms.every(a=>a.dir==='le'?v[a.feature]<=ths[a.id]:v[a.feature]>=ths[a.id]);
}
function metrics(lib,s,all){return {prediction:lib.predictionMetrics(s),economic:lib.economicMetrics(s,all)}}
function delta(a,b){return {winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,net_growth:a.economic.netGrowth-b.economic.netGrowth,avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown}}
function nonneg(d){return d.winner5_precision>=0&&d.winner10_precision>=0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}
function obj(d){return d.net_growth*14+d.avg_net_ret*10+d.max_drawdown*3+d.winner5_precision*2+d.winner10_precision*3}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
  const configs=rules().map(r=>({rule:r,folds:[],selected:[]}));
  const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));
  let start=initial;
  for(let round=1;round<=4&&start<ds.length;round++){
    const end=round===4?ds.length:Math.min(ds.length,start+fold),train=ds.slice(0,start),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t);
    const ep=fitEntry(lib,train),es=entryStats(ep,train),tr=selectEntry(ep,es,train,train).signals,ve=selectEntry(ep,es,train,val).signals,baseM=metrics(lib,val,all);
    for(const cfg of configs){
      const th=calibrateRule(cfg.rule,tr),selected=ve.filter(s=>passes(cfg.rule,th,s)),m=metrics(lib,selected,all),d=delta(m,baseM);
      cfg.selected.push(...selected);
      cfg.folds.push({round,entry_selected:ve.length,selected:selected.length,thresholds:th,delta:d,objective:obj(d),pass:selected.length>=MIN_FOLD_SELECTED&&nonneg(d)});
    }
    start=end;
  }
  const walkAll=dev.filter(s=>s.t>=ds[initial].t),walkBase=metrics(lib,ds.slice(initial),walkAll);
  for(const cfg of configs){
    const m=metrics(lib,cfg.selected,walkAll),d=delta(m,walkBase);
    cfg.aggregate={selected:cfg.selected.length,metrics:m,delta:d,objective:obj(d),pass_folds:cfg.folds.filter(f=>f.pass).length};
    cfg.viable=cfg.aggregate.selected>=16&&cfg.aggregate.pass_folds>=3&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
    delete cfg.selected;
  }
  configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
  const chosen=configs.find(x=>x.viable)||null;
  let confirmation=null,pass=false;
  if(chosen){
    const ep=fitEntry(lib,ds),es=entryStats(ep,ds),tr=selectEntry(ep,es,ds,ds).signals,he=selectEntry(ep,es,ds,hs).signals,th=calibrateRule(chosen.rule,tr);
    const selected=he.filter(s=>passes(chosen.rule,th,s)),bm=metrics(lib,hs,hold),m=metrics(lib,selected,hold),d=delta(m,bm);
    confirmation={entry_selected:he.length,selected:selected.length,thresholds:th,baseline:bm,metrics:m,delta:d};
    pass=selected.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
  }
  const report={version:'MONETIZATION_EDGE_V4_SEQUENCE_RULES',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
    objective:'Search interpretable pre-entry sequence rules on top of the frozen V1 entry policy. Rules describe compression, breakout age, zigzag, candle geometry, volume/return concentration and trend efficiency. Rule identities are fixed; quantile thresholds are recalibrated only on each past training fold. July remains untouched unless Apr-Jun walk-forward yields a positive absolute policy.',
    entry_policy:ENTRY,sequence_features:SEQ_FEATURES,rule_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
    selected:chosen?{rule:chosen.rule,aggregate:chosen.aggregate,folds:chosen.folds}:null,
    top_rules:configs.slice(0,20).map(x=>({rule:x.rule,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
    confirmation,confirmation_pass:pass,
    decision:!chosen?{label:'SEQUENCE_RULE_EDGE_NOT_FOUND_IN_WALK_FORWARD',ready:false}:pass?{label:'SEQUENCE_RULE_EDGE_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'SEQUENCE_RULE_EDGE_FAILED_FRESH_HOLDOUT',ready:false}};
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,rule_count:report.rule_count,selected:report.selected?{rule:report.selected.rule,aggregate:report.selected.aggregate}:null,top_rules:report.top_rules.slice(0,8).map(x=>({id:x.rule.id,atoms:x.rule.atoms,viable:x.viable,aggregate:x.aggregate})),confirmation,confirmation_pass:pass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
