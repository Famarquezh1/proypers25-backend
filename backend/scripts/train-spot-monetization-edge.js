'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const COST=.004, EMBARGO=24*3600000, FIXED=0.05;
const OVERLAY_RULE={extCut:.07,lowRet:.003,highRet:.008,highClose:.50,highVol:.70,maxDraw:-.04,lowClose:.35,lowVol:.70};
const OVERLAY_EXIT={id:'TP60_SL40_8H',tp:.06,sl:.04,bars:96};

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function avg(x){return x.length?x.reduce((a,b)=>a+b,0)/x.length:0}
function delayed(lib,s){const ni=s.index+1;if(ni+145>=s.series.length)return null;const z={...s,index:ni,t:s.series[ni].t};z.outcome=lib.futureOutcome(z);return z.outcome?z:null}
function postFeat(s){
  const a=s.series,i=s.index,e=Number(a[i+1]?.o||0),j=i+1;if(!(e>0)||j>=a.length)return null;
  const r=a[j],c=Number(r.c||0),l=Number(r.l||0),h=Number(r.h||0),rg=Math.max(1e-12,h-l);
  const prev=a.slice(Math.max(0,i-5),i+1),pv=avg(prev.map(x=>Number(x.q||0)));
  return {ret:c/e-1,draw:l/e-1,close:(c-l)/rg,vol:pv>0?Number(r.q||0)/pv:1};
}
function overlaySignal(lib,s){
  const x=postFeat(s),d=s.productionV42?.detail||{},ext=Number(d.extension||0);
  if(!x||x.draw<OVERLAY_RULE.maxDraw)return null;
  const ok=ext<=OVERLAY_RULE.extCut
    ? x.ret>=OVERLAY_RULE.lowRet&&x.close>=OVERLAY_RULE.lowClose&&x.vol>=OVERLAY_RULE.lowVol
    : x.ret>=OVERLAY_RULE.highRet&&x.close>=OVERLAY_RULE.highClose&&x.vol>=OVERLAY_RULE.highVol;
  return ok?delayed(lib,s):null;
}
function overlayExit(s){
  const p=OVERLAY_EXIT,a=s.series,e=s.index+1,entry=Number(a[e]?.o||0);if(!(entry>0))return null;
  let high=entry,exit=entry,exitI=e,reason='TIMEOUT',hit10=null,stopBefore10=false;
  const stop=entry*(1-p.sl),take=entry*(1+p.tp),end=Math.min(a.length-1,e+p.bars);
  for(let k=e;k<=end;k++){
    const b=a[k],hs=Number(b.l)<=stop,ht=Number(b.h)>=take;high=Math.max(high,Number(b.h));
    if(hit10===null&&Number(b.h)/entry-1>=.10)hit10=(k-e)*5;
    if(hs&&ht){exit=stop;exitI=k;reason='AMBIGUOUS_STOP_FIRST';if(hit10===null)stopBefore10=true;break}
    if(hs){exit=stop;exitI=k;reason='HARD_STOP';if(hit10===null)stopBefore10=true;break}
    if(ht){exit=take;exitI=k;reason='TAKE_PROFIT';break}
    exit=Number(b.c);exitI=k;
  }
  const gross=exit/entry-1,net=gross-COST,mfe=high/entry-1;
  return {net,gross,mfeDuringTrade:mfe,mfeFixed24h:0,captureRatioDuringTrade:mfe>0?Math.max(0,net)/mfe:0,captureRatioFixed24h:0,captureLoss24h:0,holdingMin:(exitI-e)*5,exitReason:reason,stopBefore10,hit10};
}
function baseExit(lib,s){return lib.r.simulateExit(s,lib.b.BASE_EXIT)}
function ctx(s){
  const d=s.productionV42?.detail||{};
  const ext=Number(d.extension||0),conf=Number(d.confirm||0),ign=Number(d.ignition||0);
  const eb=ext<.05?'E0':ext<.085?'E1':'E2';
  const cb=conf<.36?'C0':conf<.48?'C1':'C2';
  const ib=ign<1.0?'I0':ign<1.6?'I1':'I2';
  return `${eb}_${cb}_${ib}`;
}
function reward(exit){return exit?Number(exit.net||0):0}
function resolvedAt(s,exit,overlay){
  if(!exit)return s.t+(overlay?5:0)*60000;
  return s.t+(overlay?5:0)*60000+Math.max(0,Number(exit.holdingMin||0))*60000;
}
function armStats(history,key,arm,now,lookbackDays){
  const from=now-lookbackDays*86400000,eligible=history.filter(h=>h.context===key&&h.arm===arm&&h.resolved<=now-EMBARGO&&h.t>=from);
  if(!eligible.length)return {n:0,mean:0,win:0,dd:0};
  const vals=eligible.map(x=>x.reward),mean=avg(vals),win=eligible.filter(x=>x.reward>0).length/eligible.length;
  let eq=1,peak=1,dd=0;for(const v of vals){eq*=1+FIXED*v;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1)}
  return {n:eligible.length,mean,win,dd};
}
function chooseArm(history,s,lookbackDays,minObs,bonus){
  const key=ctx(s),b=armStats(history,key,'BASE',s.t,lookbackDays),o=armStats(history,key,'OVERLAY',s.t,lookbackDays);
  if(b.n<minObs||o.n<minObs){
    const total=b.n+o.n; return {arm:total%2===0?'BASE':'OVERLAY',key,b,o,reason:'EXPLORE'};
  }
  const n=b.n+o.n;
  const sb=b.mean+bonus*Math.sqrt(Math.log(n+1)/(b.n+1))+.20*b.win+.15*b.dd;
  const so=o.mean+bonus*Math.sqrt(Math.log(n+1)/(o.n+1))+.20*o.win+.15*o.dd;
  return {arm:so>sb?'OVERLAY':'BASE',key,b,o,scoreBase:sb,scoreOverlay:so,reason:'UCB'};
}
function metrics(lib,sigs,rows,exitFn){
  const pred=lib.predictionMetrics(sigs);
  const p=lib.r.portfolio(sigs,rows,lib.b.META_FALLBACK,exitFn,()=>lib.b.FIXED_SIZE);
  lib.r.withRecall(p,p._trades||[],rows);
  return {prediction:pred,economic:lib.r.safeMetrics(p)};
}
function monthly(decisions){
  const out={};
  for(const d of decisions){
    const m=new Date(d.t).toISOString().slice(0,7); if(!out[m])out[m]={signals:0,trades:0,base:0,overlay:0,reward:0,wins:0};
    const x=out[m];x.signals++;x[d.arm.toLowerCase()]++;if(d.executed){x.trades++;x.reward+=d.reward;if(d.reward>0)x.wins++}
  }
  for(const x of Object.values(out)){x.avgNet=x.trades?x.reward/x.trades:0;x.winRate=x.trades?x.wins/x.trades:0}
  return out;
}
function simulate(lib,signals,lookbackDays,minObs,bonus){
  const history=[],decisions=[],executed=[];
  for(const s of signals){
    const ch=chooseArm(history,s,lookbackDays,minObs,bonus);
    let exec=s,ex=null;
    if(ch.arm==='OVERLAY'){exec=overlaySignal(lib,s);ex=exec?overlayExit(exec):null}
    else ex=baseExit(lib,s);
    const rec={t:s.t,context:ch.key,arm:ch.arm,reward:reward(ex),resolved:resolvedAt(s,ex,ch.arm==='OVERLAY'),executed:!!exec,signal:exec,exit:ex,reason:ch.reason,
      baseN:ch.b.n,overlayN:ch.o.n,scoreBase:ch.scoreBase??null,scoreOverlay:ch.scoreOverlay??null};
    history.push(rec);decisions.push(rec);if(exec){exec.__routerArm=ch.arm;exec.__routerExit=ex;executed.push(exec)}
  }
  return {history,decisions,executed};
}
function routedMetrics(lib,sim,rows){
  const map=new Map(sim.executed.map(s=>[`${s.symbol||''}:${s.t}`,s.__routerExit]));
  return metrics(lib,sim.executed,rows,s=>map.get(`${s.symbol||''}:${s.t}`));
}
function delta(a,b){return {net_growth:a.economic.netGrowth-b.economic.netGrowth,avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown,winner5:a.prediction.winner5Precision-b.prediction.winner5Precision,winner10:a.prediction.winner10Precision-b.prediction.winner10Precision}}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';
  process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-09-22T00:00:00Z';
  const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
  const rows=raw.filter(s=>s.t>=Date.parse('2026-04-01T00:00:00Z')&&s.t<Date.parse('2026-09-22T00:00:00Z'));
  const sig=base.selectSignals(lib,rows,0,0).sort((a,b)=>a.t-b.t);
  const evalStart=Date.parse('2026-06-01T00:00:00Z');
  const evalRows=rows.filter(s=>s.t>=evalStart),evalSig=sig.filter(s=>s.t>=evalStart);
  const baseline=metrics(lib,evalSig,evalRows,s=>baseExit(lib,s));
  const configs=[];
  for(const lookbackDays of [7,14,21,30])
  for(const minObs of [2,3,4])
  for(const bonus of [.01,.02,.04]){
    const sim=simulate(lib,sig,lookbackDays,minObs,bonus);
    const filt={...sim,executed:sim.executed.filter(s=>s.t>=evalStart),decisions:sim.decisions.filter(d=>d.t>=evalStart)};
    const m=routedMetrics(lib,filt,evalRows),d=delta(m,baseline),months=monthly(filt.decisions);
    const monthVals=Object.values(months),positiveMonths=monthVals.filter(x=>x.reward>0).length;
    const score=d.net_growth*25+d.avg_net_ret*12+d.max_drawdown*5+d.winner5*2+d.winner10*3+.08*positiveMonths;
    const viable=m.economic.netGrowth>0&&m.economic.avgNetRet>0&&d.max_drawdown>=0&&positiveMonths>=3&&m.prediction.signals>=Math.max(30,evalSig.length*.25);
    configs.push({lookbackDays,minObs,bonus,metrics:m,delta:d,months,positiveMonths,score,viable,
      arm_mix:{base:filt.decisions.filter(x=>x.arm==='BASE').length,overlay:filt.decisions.filter(x=>x.arm==='OVERLAY').length,executed:filt.executed.length,signals:filt.decisions.length}});
  }
  configs.sort((a,b)=>b.score-a.score);
  const chosen=configs.find(x=>x.viable)||null;
  const report={version:'MONETIZATION_EDGE_V19_CAUSAL_REGIME_BANDIT',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
    objective:'Prequential causal meta-router. For every CORE signal choose BASE or the frozen V18 overlay using only rewards from the arm actually chosen in prior signals, only after those trades are resolved and with a 24h embargo. Context is bucketed by V42 extension/confirmation/ignition. Deterministic exploration precedes UCB exploitation. Evaluate Jun-Sep across changing regimes; no counterfactual arm outcomes are used for learning.',
    frozen_overlay:{rule:OVERLAY_RULE,exit:OVERLAY_EXIT},universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,signals:sig.length,evaluation_signals:evalSig.length},
    baseline,selected:chosen,top_configs:configs.slice(0,12),production_candidate_ready:false,
    decision:chosen?{label:'CAUSAL_ROUTER_RESEARCH_SIGNAL_FOUND_NEEDS_SHADOW',ready:false}:{label:'CAUSAL_ROUTER_NOT_STABLE',ready:false}};
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
