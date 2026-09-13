'use strict';

const fs=require('fs'),vm=require('vm'),path=require('path');
const BASE_FILE=path.join(__dirname,'github-spot-instant-decision-trainer-v8.js');
let src=fs.readFileSync(BASE_FILE,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'\n');
src+=';globalThis.__v8={universe,klines,mapLimit,btcMap,feature,vector,candidate,avg,std,clamp,utcDay,isoDay,DAY_MS,STEP_MS,WARM,HOLD_BARS,FEATURE_NAMES};';
const ctx=vm.createContext({require,console,process,fetch,URLSearchParams,AbortController,setTimeout,clearTimeout,Date,Math,Map,Set,Array,Number,String,JSON});vm.runInContext(src,ctx,{filename:'v8-base.js'});const v=ctx.__v8;

const TRAIN_DAYS=7,EVAL_DAYS=Math.max(3,Math.min(7,Number(process.env.V9_EVAL_DAYS||7)));
const COST=Math.max(.0015,Number(process.env.V8_ROUNDTRIP_COST||.0025));
const SYMBOL_COOLDOWN=3*60*60*1000,GLOBAL_COOLDOWN=30*60*1000;
const EXTRA=['accel15_60','volSurge','breakoutVol','rsVol','freshness','microAccel','btcAlign'];
const NAMES=[...v.FEATURE_NAMES,...EXTRA];

function expand(x){const m=Object.fromEntries(v.FEATURE_NAMES.map((n,i)=>[n,x[i]])),p=z=>Math.max(0,z||0);return [...x,m.r15-m.r60/4,m.logVol15-m.logVol30,m.breakout60*p(m.logVol15),m.rs60*p(m.logVol15),-p(m.r24-.08),m.r5-m.r15/3,m.r60*m.btc60].map(z=>v.clamp(z,-5,5));}
function median(a){if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),i=Math.floor(b.length/2);return b.length%2?b[i]:(b[i-1]+b[i])/2;}
function percentile(a,p){if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y);return b[Math.max(0,Math.min(b.length-1,Math.floor((b.length-1)*p)))];}

function future(rows,i){const e=i+1;if(e>=rows.length)return null;const entry=rows[e].o;if(!(entry>0)||i+36>=rows.length)return null;const r30=rows[i+6].c/entry-1,r60=rows[i+12].c/entry-1,r180=rows[i+36].c/entry-1;const composite=.25*r30+.40*r60+.35*r180;return {r30,r60,r180,composite,net180:r180-COST};}

function crossSection(raw){
  const byT=new Map();for(const r of raw){if(!byT.has(r.t))byT.set(r.t,[]);byT.get(r.t).push(r);}const out=[];
  for(const [t,g] of byT){if(g.length<8)continue;const d=NAMES.length,mu=Array(d).fill(0),sd=Array(d).fill(1);for(let j=0;j<d;j++){mu[j]=v.avg(g.map(r=>r.z[j]));const s=v.std(g.map(r=>r.z[j]));sd[j]=s>1e-9?s:1;}const med=median(g.map(r=>r.future.composite));const sorted=[...g].sort((a,b)=>b.future.composite-a.future.composite);const top=Math.max(1,Math.ceil(g.length*.10));const topSet=new Set(sorted.slice(0,top).map(r=>r.symbol));for(const r of g){out.push({...r,cz:r.z.map((x,j)=>v.clamp((x-mu[j])/sd[j],-5,5)),alpha:v.clamp(r.future.composite-med,-.08,.08),top10:topSet.has(r.symbol),groupSize:g.length});}}
  return out.sort((a,b)=>a.t-b.t);
}

function trainRank(rows){
  const d=NAMES.length,w=Array(d+1).fill(0);w[0]=v.avg(rows.map(r=>r.alpha));const lr=.035,l2=.006,delta=.02;
  for(let epoch=0;epoch<65;epoch++){const g=Array(d+1).fill(0);for(const r of rows){let pred=w[0];for(let j=0;j<d;j++)pred+=w[j+1]*r.cz[j];const err=Math.max(-delta,Math.min(delta,pred-r.alpha));g[0]+=err;for(let j=0;j<d;j++)g[j+1]+=err*r.cz[j];}const n=Math.max(1,rows.length);w[0]-=lr*g[0]/n;for(let j=1;j<w.length;j++)w[j]-=lr*(g[j]/n+l2*w[j]);}
  return {w,predict(z){let y=w[0];for(let j=0;j<d;j++)y+=w[j+1]*z[j];return y;}};
}

function selectDay(rows,model){
  const byT=new Map();for(const r of rows){if(!byT.has(r.t))byT.set(r.t,[]);byT.get(r.t).push({...r,score:model.predict(r.cz)});}const out=[],until=new Map();let lastGlobal=-Infinity;
  for(const t of [...byT.keys()].sort((a,b)=>a-b)){if(t-lastGlobal<GLOBAL_COOLDOWN)continue;const ranked=byT.get(t).sort((a,b)=>b.score-a.score);const a=ranked[0],b=ranked[1];if(!a||a.score<=0)continue;const margin=a.score-(b?.score||0);if(margin<0.00015)continue;if(t<(until.get(a.symbol)||0))continue;out.push({...a,rankInFuture:null});until.set(a.symbol,t+SYMBOL_COOLDOWN);lastGlobal=t;}
  return out;
}

function metrics(sel){
  const n=sel.length;if(!n)return {trades:0,positiveAbsRate:0,avgNet180:0,avgAlpha:0,top10HitRate:0,avgComposite:0};
  return {trades:n,positiveAbsRate:sel.filter(r=>r.future.net180>0).length/n,avgNet180:v.avg(sel.map(r=>r.future.net180)),avgAlpha:v.avg(sel.map(r=>r.alpha)),top10HitRate:sel.filter(r=>r.top10).length/n,avgComposite:v.avg(sel.map(r=>r.future.composite))};
}

async function main(){
  const now=Date.now(),evalEnd=v.utcDay(now),evalStart=evalEnd-EVAL_DAYS*v.DAY_MS,dataStart=evalStart-(TRAIN_DAYS+1)*v.DAY_MS-v.WARM*v.STEP_MS;
  const symbols=await v.universe();console.log(`V9_UNIVERSE symbols=${symbols.length} eval=${v.isoDay(evalStart)}..${v.isoDay(evalEnd)}`);
  const loaded=await v.mapLimit(symbols,8,async symbol=>({symbol,rows:await v.klines(symbol,dataStart,evalEnd+37*v.STEP_MS)}));const data=new Map();for(const x of loaded)if(x&&!x.__error&&x.rows?.length)data.set(x.symbol,x.rows);
  const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTCUSDT unavailable');const bm=v.btcMap(btc),raw=[];
  for(const [symbol,rows] of data){if(symbol==='BTCUSDT'||rows.length<v.WARM+40)continue;for(let i=v.WARM;i<rows.length-38;i+=3){const f=v.feature(rows,i,bm);if(!v.candidate(f))continue;const fu=future(rows,i);if(!fu)continue;raw.push({symbol,t:rows[i].t,z:expand(v.vector(f)),future:fu});}}
  const all=crossSection(raw);console.log(`V9_SAMPLES raw=${raw.length} cross=${all.length}`);
  const days=[];
  for(let d=evalStart;d<evalEnd;d+=v.DAY_MS){const tr=all.filter(r=>r.t>=d-TRAIN_DAYS*v.DAY_MS&&r.t<d-3*60*60*1000),test=all.filter(r=>r.t>=d&&r.t<d+v.DAY_MS);if(tr.length<1000||test.length<100){days.push({day:v.isoDay(d),ready:false,train:tr.length,test:test.length});continue;}const model=trainRank(tr);const selected=selectDay(test,model),m=metrics(selected);days.push({day:v.isoDay(d),ready:true,test:m});console.log(`V9_DAY ${v.isoDay(d)} trades=${m.trades} abs=${(m.avgNet180*100).toFixed(3)}% alpha=${(m.avgAlpha*100).toFixed(3)}% top10=${(m.top10HitRate*100).toFixed(1)}%`);}
  const valid=days.filter(x=>x.ready),agg={evaluatedDays:days.length,readyDays:valid.length,positiveAbsDays:valid.filter(x=>x.test.avgNet180>0).length,positiveAlphaDays:valid.filter(x=>x.test.avgAlpha>0).length,totalTrades:valid.reduce((s,x)=>s+x.test.trades,0),avgNet180:v.avg(valid.map(x=>x.test.avgNet180)),avgAlpha:v.avg(valid.map(x=>x.test.avgAlpha)),avgTop10HitRate:v.avg(valid.map(x=>x.test.top10HitRate)),avgPositiveAbsRate:v.avg(valid.map(x=>x.test.positiveAbsRate))};
  const verdict=valid.length>=5&&agg.positiveAlphaDays>=5&&agg.avgAlpha>0&&agg.avgTop10HitRate>0.14?'RELATIVE_EDGE_FOUND':'NOT_READY';
  const latestRows=all.filter(r=>r.t>=evalEnd-TRAIN_DAYS*v.DAY_MS&&r.t<evalEnd-3*60*60*1000);let latest=null;if(latestRows.length>=1000){const lm=trainRank(latestRows);latest={weights:lm.w,featureNames:NAMES,trainedSamples:latestRows.length};}
  const report={version:'V9_CROSS_SECTIONAL_RELATIVE_WINNER',generatedAt:new Date().toISOString(),design:{trainDays:TRAIN_DAYS,decisionCadenceMinutes:5,sampleCadenceMinutes:15,target:'cross-sectional future excess return',futureBlend:{m30:.25,m60:.40,m180:.35},globalCooldownMinutes:30,symbolCooldownMinutes:180,productionMutation:false,causal:true},universe:{loaded:data.size},samples:all.length,days,aggregate:agg,latestModelAvailable:!!latest,latest,verdict};fs.writeFileSync('spot-relative-winner-v9.json',JSON.stringify(report,null,2));console.log(`V9_RESULT ${JSON.stringify({aggregate:agg,verdict})}`);
}
main().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
