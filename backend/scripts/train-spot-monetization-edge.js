'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const COST=.004, EMBARGO=24*3600000, FIXED=.05;
const RULE={extCut:.07,lowRet:.003,highRet:.008,highClose:.50,highVol:.70,maxDraw:-.04,lowClose:.35,lowVol:.70};
const OEXIT={id:'TP60_SL40_8H',tp:.06,sl:.04,bars:96};

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
 const r=a[j],c=Number(r.c||0),l=Number(r.l||0),h=Number(r.h||0),rg=Math.max(1e-12,h-l),pv=avg(a.slice(Math.max(0,i-5),i+1).map(x=>Number(x.q||0)));
 return {ret:c/e-1,draw:l/e-1,close:(c-l)/rg,vol:pv>0?Number(r.q||0)/pv:1};
}
function overlaySignal(lib,s){
 const x=postFeat(s),d=s.productionV42?.detail||{},ext=Number(d.extension||0);if(!x||x.draw<RULE.maxDraw)return null;
 const ok=ext<=RULE.extCut?x.ret>=RULE.lowRet&&x.close>=RULE.lowClose&&x.vol>=RULE.lowVol:x.ret>=RULE.highRet&&x.close>=RULE.highClose&&x.vol>=RULE.highVol;
 return ok?delayed(lib,s):null;
}
function overlayExit(s){
 const a=s.series,e=s.index+1,entry=Number(a[e]?.o||0);if(!(entry>0))return null;
 let high=entry,exit=entry,exitI=e,reason='TIMEOUT',hit10=null,stopBefore10=false;
 const stop=entry*(1-OEXIT.sl),take=entry*(1+OEXIT.tp),end=Math.min(a.length-1,e+OEXIT.bars);
 for(let k=e;k<=end;k++){const b=a[k],hs=Number(b.l)<=stop,ht=Number(b.h)>=take;high=Math.max(high,Number(b.h));
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
function context(s){
 const d=s.productionV42?.detail||{},ext=Number(d.extension||0),conf=Number(d.confirm||0);
 const eb=ext<.055?'E0':ext<.085?'E1':'E2', cb=conf<.42?'C0':'C1';
 return `${eb}_${cb}`;
}
function resolvedAt(s,exit,overlay){return s.t+(overlay?5:0)*60000+Math.max(0,Number(exit?.holdingMin||0))*60000}
function record(arm,s,exec,ex,ctx){return {arm,t:s.t,context:ctx,reward:ex?Number(ex.net||0):0,resolved:resolvedAt(s,ex,arm==='OVERLAY'),executed:!!exec}}
function weightedStats(hist,ctx,arm,now,days,tau,includeGlobal=true){
 const from=now-days*86400000; let sw=0,sr=0,wins=0,n=0;
 for(const h of hist){if(h.arm!==arm||h.resolved>now-EMBARGO||h.t<from)continue;if(h.context!==ctx&&!includeGlobal)continue;
  const age=(now-h.t)/86400000,w=Math.exp(-age/tau)*(h.context===ctx?1:.20);sw+=w;sr+=w*h.reward;if(h.reward>0)wins+=w;n++;
 }
 return {n,weight:sw,mean:sw?sr/sw:0,win:sw?wins/sw:0};
}
function decide(hist,s,cfg){
 const k=context(s),b=weightedStats(hist,k,'BASE',s.t,cfg.days,cfg.tau,true),o=weightedStats(hist,k,'OVERLAY',s.t,cfg.days,cfg.tau,true);
 const sb=b.mean+cfg.winWeight*(b.win-.5),so=o.mean+cfg.winWeight*(o.win-.5);
 const best=Math.max(sb,so);
 if(b.weight<cfg.minWeight&&o.weight<cfg.minWeight)return {arm:'BASE',context:k,b,o,sb,so,reason:'LOW_EVIDENCE'};
 if(best<cfg.skipThreshold)return {arm:'SKIP',context:k,b,o,sb,so,reason:'NEGATIVE_EDGE'};
 return {arm:so>sb?'OVERLAY':'BASE',context:k,b,o,sb,so,reason:'EDGE'};
}
function metrics(lib,sigs,rows,exitMap){
 const pred=lib.predictionMetrics(sigs),p=lib.r.portfolio(sigs,rows,lib.b.META_FALLBACK,s=>exitMap.get(`${s.symbol||''}:${s.t}`),()=>lib.b.FIXED_SIZE);lib.r.withRecall(p,p._trades||[],rows);
 return {prediction:pred,economic:lib.r.safeMetrics(p)};
}
function monthly(ds){const out={};for(const d of ds){const m=new Date(d.t).toISOString().slice(0,7),x=out[m]||(out[m]={signals:0,trades:0,base:0,overlay:0,skip:0,reward:0,wins:0});x.signals++;x[d.arm.toLowerCase()]++;if(d.executed){x.trades++;x.reward+=d.reward;if(d.reward>0)x.wins++}}for(const x of Object.values(out)){x.avgNet=x.trades?x.reward/x.trades:0;x.winRate=x.trades?x.wins/x.trades:0}return out}
function warmStart(lib,warmSignals,cut){
 const hist=[];
 for(const s of warmSignals){const k=context(s),be=baseExit(lib,s);if(resolvedAt(s,be,false)<=cut-EMBARGO)hist.push(record('BASE',s,s,be,k));
  const os=overlaySignal(lib,s),oe=os?overlayExit(os):null;if(resolvedAt(s,oe,true)<=cut-EMBARGO)hist.push(record('OVERLAY',s,os,oe,k));
 }
 return hist;
}
function run(lib,signals,cfg,start){
 const warm=signals.filter(s=>s.t<start),live=signals.filter(s=>s.t>=start),hist=warmStart(lib,warm,start),decisions=[],exec=[],emap=new Map();
 for(const s of live){
  const d=decide(hist,s,cfg);let es=null,ex=null;
  if(d.arm==='BASE'){es=s;ex=baseExit(lib,s)}
  else if(d.arm==='OVERLAY'){es=overlaySignal(lib,s);ex=es?overlayExit(es):null}
  const rec={...record(d.arm,s,es,ex,d.context),scoreBase:d.sb,scoreOverlay:d.so,reason:d.reason};decisions.push(rec);
  if(d.arm!=='SKIP')hist.push(rec);
  if(es){es.__arm=d.arm;exec.push(es);emap.set(`${es.symbol||''}:${es.t}`,ex)}
 }
 return {decisions,exec,emap};
}
function delta(a,b){return {net:a.economic.netGrowth-b.economic.netGrowth,avg:a.economic.avgNetRet-b.economic.avgNetRet,dd:a.economic.maxDrawdown-b.economic.maxDrawdown,w5:a.prediction.winner5Precision-b.prediction.winner5Precision,w10:a.prediction.winner10Precision-b.prediction.winner10Precision}}

async function main(){
 process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-09-22T00:00:00Z';
 const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw.filter(s=>s.t>=Date.parse('2026-04-01T00:00:00Z')&&s.t<Date.parse('2026-09-22T00:00:00Z'));
 const sig=base.selectSignals(lib,raw,0,0).sort((a,b)=>a.t-b.t),start=Date.parse('2026-06-01T00:00:00Z'),liveRows=raw.filter(s=>s.t>=start),liveSig=sig.filter(s=>s.t>=start);
 const bmap=new Map(liveSig.map(s=>[`${s.symbol||''}:${s.t}`,baseExit(lib,s)])),baseline=metrics(lib,liveSig,liveRows,bmap);
 const configs=[];
 for(const days of [14,21,30,45])for(const tau of [5,10,15])for(const winWeight of [.00,.01,.02])for(const skipThreshold of [-.012,-.008,-.004,0]){
  const cfg={days,tau,winWeight,skipThreshold,minWeight:2},r=run(lib,sig,cfg,start),m=metrics(lib,r.exec,liveRows,r.emap),d=delta(m,baseline),months=monthly(r.decisions),mv=Object.values(months),pm=mv.filter(x=>x.reward>0).length;
  const score=d.net*25+d.avg*15+d.dd*6+d.w5*2+d.w10*3+.10*pm-.08*(r.decisions.filter(x=>x.arm==='SKIP').length/r.decisions.length);
  const viable=m.economic.netGrowth>0&&m.economic.avgNetRet>0&&d.dd>=0&&pm>=3&&r.exec.length>=100;
  configs.push({cfg,metrics:m,delta:d,months,positiveMonths:pm,score,viable,arm_mix:{base:r.decisions.filter(x=>x.arm==='BASE').length,overlay:r.decisions.filter(x=>x.arm==='OVERLAY').length,skip:r.decisions.filter(x=>x.arm==='SKIP').length,executed:r.exec.length,signals:r.decisions.length}});
 }
 configs.sort((a,b)=>b.score-a.score);const chosen=configs.find(x=>x.viable)||null;
 const report={version:'MONETIZATION_EDGE_V20_HIERARCHICAL_ROUTER_WITH_ABSTENTION',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
  objective:'Warm-start a causal hierarchical router from Apr-May historical outcomes, then from Jun onward update only the actually chosen arm after trade resolution plus 24h embargo. Use six broad extension/confirmation contexts with global shrinkage and exponential recency weighting. Add SKIP as a third action when both BASE and OVERLAY have negative recent expected edge.',
  frozen_overlay:{rule:RULE,exit:OEXIT},universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,signals:sig.length,evaluation_signals:liveSig.length},baseline,selected:chosen,top_configs:configs.slice(0,15),production_candidate_ready:false,
  decision:chosen?{label:'HIERARCHICAL_ROUTER_RESEARCH_SIGNAL_FOUND_NEEDS_SHADOW',ready:false}:{label:'HIERARCHICAL_ROUTER_NOT_STABLE',ready:false}};
 fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
