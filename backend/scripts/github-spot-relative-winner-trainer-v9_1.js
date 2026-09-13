'use strict';

const fs=require('fs'),vm=require('vm'),path=require('path');
const BASE_FILE=path.join(__dirname,'github-spot-relative-winner-trainer-v9.js');
let src=fs.readFileSync(BASE_FILE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'\n');
src+=';globalThis.__v9={v,TRAIN_DAYS,EVAL_DAYS,COST,SYMBOL_COOLDOWN,GLOBAL_COOLDOWN,NAMES,expand,future,crossSection,trainRank,metrics,median,percentile};';
const ctx=vm.createContext({require,console,process,fetch,URLSearchParams,AbortController,setTimeout,clearTimeout,Date,Math,Map,Set,Array,Number,String,JSON,__dirname});vm.runInContext(src,ctx,{filename:'v9-base.js'});const b=ctx.__v9,v=b.v;

const EVAL_DAYS=Math.max(3,Math.min(7,Number(process.env.V91_EVAL_DAYS||7)));
const SCORE_Q=[.50,.65,.75,.85,.90],MARGIN_Q=[0,.40,.60,.75];

function topEvents(rows,model){const byT=new Map(),out=[];for(const r of rows){if(!byT.has(r.t))byT.set(r.t,[]);byT.get(r.t).push({...r,score:model.predict(r.cz)});}for(const t of [...byT.keys()].sort((a,b)=>a-b)){const g=byT.get(t).sort((a,b)=>b.score-a.score),a=g[0],c=g[1];if(!a)continue;out.push({...a,margin:a.score-(c?.score||0)});}return out;}
function select(events,scoreCut,marginCut){const until=new Map(),out=[];let last=-Infinity;for(const e of events){if(e.score<scoreCut||e.margin<marginCut)continue;if(e.t-last<b.GLOBAL_COOLDOWN)continue;if(e.t<(until.get(e.symbol)||0))continue;out.push(e);until.set(e.symbol,e.t+b.SYMBOL_COOLDOWN);last=e.t;}return out;}
function choose(cal,model){const ev=topEvents(cal,model),scores=ev.map(x=>x.score),margins=ev.map(x=>x.margin);let best=null;for(const sq of SCORE_Q){for(const mq of MARGIN_Q){const sc=b.percentile(scores,sq),mc=mq?b.percentile(margins,mq):-Infinity,sel=select(ev,sc,mc),m=b.metrics(sel);if(m.trades<6)continue;if(!(m.avgAlpha>.001&&m.avgNet180>0&&m.top10HitRate>.18&&m.positiveAbsRate>.45))continue;const score=m.avgAlpha+.5*m.avgNet180+.01*m.top10HitRate;if(!best||score>best.score)best={scoreQuantile:sq,marginQuantile:mq,scoreCut:sc,marginCut:mc,score,metrics:m};}}return best;}

async function main(){
  const now=Date.now(),evalEnd=v.utcDay(now),evalStart=evalEnd-EVAL_DAYS*v.DAY_MS,dataStart=evalStart-(b.TRAIN_DAYS+1)*v.DAY_MS-v.WARM*v.STEP_MS;
  const symbols=await v.universe();console.log(`V91_UNIVERSE symbols=${symbols.length} eval=${v.isoDay(evalStart)}..${v.isoDay(evalEnd)}`);
  const loaded=await v.mapLimit(symbols,8,async symbol=>({symbol,rows:await v.klines(symbol,dataStart,evalEnd+37*v.STEP_MS)}));const data=new Map();for(const x of loaded)if(x&&!x.__error&&x.rows?.length)data.set(x.symbol,x.rows);const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTCUSDT unavailable');const bm=v.btcMap(btc),raw=[];
  for(const [symbol,rows] of data){if(symbol==='BTCUSDT'||rows.length<v.WARM+40)continue;for(let i=v.WARM;i<rows.length-38;i+=3){const f=v.feature(rows,i,bm);if(!v.candidate(f))continue;const fu=b.future(rows,i);if(!fu)continue;raw.push({symbol,t:rows[i].t,z:b.expand(v.vector(f)),future:fu});}}
  const all=b.crossSection(raw);console.log(`V91_SAMPLES ${all.length}`);const days=[];
  for(let d=evalStart;d<evalEnd;d+=v.DAY_MS){const start=d-b.TRAIN_DAYS*v.DAY_MS,fitEnd=d-2*v.DAY_MS-3*60*60*1000,calStart=d-2*v.DAY_MS,calEnd=d-3*60*60*1000;const fit=all.filter(r=>r.t>=start&&r.t<fitEnd),cal=all.filter(r=>r.t>=calStart&&r.t<calEnd),test=all.filter(r=>r.t>=d&&r.t<d+v.DAY_MS);if(fit.length<800||cal.length<300||test.length<100){days.push({day:v.isoDay(d),active:false,reason:'insufficient samples'});continue;}const model=b.trainRank(fit),policy=choose(cal,model);if(!policy){days.push({day:v.isoDay(d),active:false,reason:'no positive confidence regime'});console.log(`V91_DAY ${v.isoDay(d)} ABSTAIN`);continue;}const chosen=select(topEvents(test,model),policy.scoreCut,policy.marginCut),m=b.metrics(chosen);days.push({day:v.isoDay(d),active:true,policy,test:m});console.log(`V91_DAY ${v.isoDay(d)} trades=${m.trades} net=${(m.avgNet180*100).toFixed(3)}% alpha=${(m.avgAlpha*100).toFixed(3)}% top10=${(m.top10HitRate*100).toFixed(1)}%`);}
  const a=days.filter(x=>x.active),agg={evaluatedDays:days.length,activeDays:a.length,abstainDays:days.length-a.length,positiveAbsDays:a.filter(x=>x.test.avgNet180>0).length,positiveAlphaDays:a.filter(x=>x.test.avgAlpha>0).length,totalTrades:a.reduce((s,x)=>s+x.test.trades,0),avgNet180:v.avg(a.map(x=>x.test.avgNet180)),avgAlpha:v.avg(a.map(x=>x.test.avgAlpha)),avgTop10HitRate:v.avg(a.map(x=>x.test.top10HitRate)),avgPositiveAbsRate:v.avg(a.map(x=>x.test.positiveAbsRate))};
  const verdict=a.length>=2&&agg.positiveAbsDays>=Math.ceil(a.length*.67)&&agg.positiveAlphaDays>=Math.ceil(a.length*.67)&&agg.avgNet180>0&&agg.avgAlpha>0&&agg.avgTop10HitRate>.18?'CONFIDENCE_EDGE_FOUND':'NOT_READY';
  const report={version:'V9_1_CONFIDENCE_CALIBRATED_RELATIVE_WINNER',generatedAt:new Date().toISOString(),design:{trainFitDays:5,calibrationDays:2,decisionCadenceMinutes:5,target:'relative winner with recent confidence calibration',productionMutation:false,causal:true},universe:{loaded:data.size},samples:all.length,days,aggregate:agg,verdict};fs.writeFileSync('spot-relative-winner-v9_1.json',JSON.stringify(report,null,2));console.log(`V91_RESULT ${JSON.stringify({aggregate:agg,verdict})}`);
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
