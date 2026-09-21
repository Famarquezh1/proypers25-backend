'use strict';

const fs=require('fs'),path=require('path'),vm=require('vm');
const SOURCE=path.join(__dirname,'train-spot-momentum-continuation-historical.js');
const OUTPUT=path.join(__dirname,'..','training-output','spot-monetization-edge.json');
const DELAYS=[0,1,2,3,4,6];

function loadBase(){
  let src=fs.readFileSync(SOURCE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src+=';globalThis.__me={loadR7,buildRaw,selectSignals};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:SOURCE});
  vm.runInContext(src,c,{filename:SOURCE});return c.__me;
}
function metrics(lib,signals,all){
  return {prediction:lib.predictionMetrics(signals),economic:lib.economicMetrics(signals,all)};
}
function delta(a,b){return {
  winner5_precision:a.prediction.winner5Precision-b.prediction.winner5Precision,
  winner10_precision:a.prediction.winner10Precision-b.prediction.winner10Precision,
  avg_mfe12:a.prediction.avgMfe12-b.prediction.avgMfe12,
  net_growth:a.economic.netGrowth-b.economic.netGrowth,
  avg_net_ret:a.economic.avgNetRet-b.economic.avgNetRet,
  max_drawdown:a.economic.maxDrawdown-b.economic.maxDrawdown
}}
function nonneg(d){return d.winner5_precision>=0&&d.winner10_precision>=0&&d.net_growth>=0&&d.avg_net_ret>=0&&d.max_drawdown>=0}
function objective(d){return d.net_growth*16+d.avg_net_ret*10+d.max_drawdown*4+d.winner5_precision*2+d.winner10_precision*3}
function delayed(lib,s,bars){
  if(!bars)return s;
  const ni=s.index+bars;
  if(ni+145>=s.series.length)return null;
  const z={...s,index:ni,t:s.series[ni].t};
  z.outcome=lib.futureOutcome(z);
  if(!z.outcome)return null;
  return z;
}
function shift(lib,sigs,bars){return sigs.map(s=>delayed(lib,s,bars)).filter(Boolean)}

async function main(){
  process.env.DEV_START='2026-04-01T00:00:00Z';process.env.DEV_END='2026-07-01T00:00:00Z';process.env.CONFIRM_START='2026-07-01T00:00:00Z';process.env.CONFIRM_END='2026-08-01T00:00:00Z';
  const base=loadBase(),lib=base.loadR7(),built=await base.buildRaw(lib),raw=built.raw;
  const dev=raw.filter(s=>s.t>=lib.DEV_START&&s.t<lib.DEV_END),hold=raw.filter(s=>s.t>=lib.CONFIRM_START&&s.t<lib.CONFIRM_END);
  const ds=base.selectSignals(lib,dev,0,0).sort((a,b)=>a.t-b.t),hs=base.selectSignals(lib,hold,0,0).sort((a,b)=>a.t-b.t);
  const configs=DELAYS.map(delay=>({delay,folds:[],selected:[]}));
  const initial=Math.floor(ds.length*.45),rest=ds.length-initial,fold=Math.max(10,Math.floor(rest/4));let start=initial;
  for(let round=1;round<=4&&start<ds.length;round++){
    const end=round===4?ds.length:Math.min(ds.length,start+fold),val=ds.slice(start,end),all=dev.filter(s=>s.t>=val[0].t&&s.t<=val[val.length-1].t+30*60000),bm=metrics(lib,val,all);
    for(const cfg of configs){
      const sig=shift(lib,val,cfg.delay),m=metrics(lib,sig,all),d=delta(m,bm);
      cfg.selected.push(...sig);
      cfg.folds.push({round,signals:sig.length,delay_minutes:cfg.delay*5,metrics:m,delta:d,pass:sig.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0});
    }
    start=end;
  }
  const walk=ds.slice(initial),walkAll=dev.filter(s=>s.t>=walk[0].t),bm=metrics(lib,walk,walkAll);
  for(const cfg of configs){
    const sig=shift(lib,walk,cfg.delay),m=metrics(lib,sig,walkAll),d=delta(m,bm);
    cfg.aggregate={signals:sig.length,metrics:m,delta:d,objective:objective(d),pass_folds:cfg.folds.filter(x=>x.pass).length};
    cfg.viable=cfg.delay>0&&cfg.aggregate.pass_folds>=3&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
    delete cfg.selected;
  }
  configs.sort((a,b)=>b.aggregate.objective-a.aggregate.objective);
  const chosen=configs.find(x=>x.viable)||null;
  let confirmation=null,confirmationPass=false;
  if(chosen){
    const sig=shift(lib,hs,chosen.delay),bm=metrics(lib,hs,hold),m=metrics(lib,sig,hold),d=delta(m,bm);
    confirmation={delay_minutes:chosen.delay*5,signals:sig.length,baseline:bm,metrics:m,delta:d};
    confirmationPass=sig.length>=8&&nonneg(d)&&m.economic.netGrowth>0&&m.economic.avgNetRet>0;
  }
  const report={version:'MONETIZATION_EDGE_V11_ENTRY_DELAY',generated_at:new Date().toISOString(),research_only:true,production_mutation:false,
    objective:'Test whether CORE identifies the right opportunities but enters too early. Preserve original CORE candidate selection, then delay actual historical entry by 5-30 minutes and recompute outcome, +5%, +10%, MFE, MAE and BASE_EXIT economics from the delayed price. Require 3/4 Apr-Jun walk-forward folds and positive aggregate before opening July.',
    delays_minutes:DELAYS.map(x=>x*5),candidate_count:configs.length,universe:{pool:built.poolSize,loaded:built.loaded,candidate_rows:raw.length,dev_signals:ds.length,holdout_signals:hs.length},
    selected:chosen?{delay:chosen.delay,delay_minutes:chosen.delay*5,aggregate:chosen.aggregate,folds:chosen.folds}:null,
    candidates:configs.map(x=>({delay:x.delay,delay_minutes:x.delay*5,viable:x.viable,aggregate:x.aggregate,folds:x.folds})),
    confirmation,confirmation_pass:confirmationPass,
    decision:!chosen?{label:'ENTRY_DELAY_NOT_STABLE_IN_WALK_FORWARD',ready:false}:confirmationPass?{label:'ENTRY_DELAY_CONFIRMED_RESEARCH_ONLY',ready:false}:{label:'ENTRY_DELAY_FAILED_FRESH_HOLDOUT',ready:false}};
  fs.mkdirSync(path.dirname(OUTPUT),{recursive:true});fs.writeFileSync(OUTPUT,JSON.stringify(report,null,2));
  console.log(JSON.stringify({version:report.version,selected:report.selected,candidates:report.candidates,confirmation,confirmation_pass:confirmationPass,decision:report.decision},null,2));
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
