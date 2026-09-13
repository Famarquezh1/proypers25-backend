'use strict';
const fs=require('fs'),path=require('path'),vm=require('vm');
const V70_PATH=path.join(__dirname,'github-spot-adaptive-mixture-trainer-v7_0.js');
const REGIMES=['TREND_UP','RANGE','VOLATILE','RISK_OFF'];
const PURGE=6*3600000,MIN_TEST_TRADES=8;

function loadV70(){
  let src=fs.readFileSync(V70_PATH,'utf8').replace(/main\(\)\.catch[\s\S]*$/,'');
  src+=`;globalThis.__v70={BASE,INTERVAL,STEP,DAYS,MAX_SYMBOLS,MIN_QV,COST,WARM,FWD,PURGE,COOLDOWN,HARD_STOP,BE_TRIGGER,BE_LOCK,TRAIL_TRIGGER,TRAIL_GAP,STALE_BARS,avg,clamp,agents,universe,klines,btcMap,feat,outcome,state,microCal,microScore,dedupe,breadthFrom,regimeWeights,opportunityScore,chooseSpecialists,metaConfigs,blendedCandidate,metaMetrics,metaObjective};`;
  const c=vm.createContext({require,console,process,fetch,URLSearchParams,AbortController,setTimeout,clearTimeout});
  vm.runInContext(src,c,{filename:V70_PATH});return c.__v70;
}
const v=loadV70(),avg=v.avg,clamp=v.clamp,FWD=v.FWD,STEP=v.STEP,COST=v.COST,COOLDOWN=v.COOLDOWN;
const BASE_EXIT={hardStop:v.HARD_STOP,beTrigger:v.BE_TRIGGER,beLock:v.BE_LOCK,trailTrigger:v.TRAIL_TRIGGER,trailGap:v.TRAIL_GAP,staleBars:v.STALE_BARS,id:'v7_0_fixed'};
const EXIT_GRID={
 TREND_UP:[
  {id:'trend_balanced',hardStop:.050,beTrigger:.060,beLock:.002,trailTrigger:.100,trailGap:.035,staleBars:240},
  {id:'trend_runner',hardStop:.055,beTrigger:.070,beLock:.002,trailTrigger:.120,trailGap:.045,staleBars:264},
  {id:'trend_wide',hardStop:.060,beTrigger:.080,beLock:.001,trailTrigger:.140,trailGap:.050,staleBars:276}],
 RANGE:[
  {id:'range_fast',hardStop:.035,beTrigger:.030,beLock:.003,trailTrigger:.050,trailGap:.018,staleBars:120},
  {id:'range_balanced',hardStop:.040,beTrigger:.035,beLock:.003,trailTrigger:.055,trailGap:.020,staleBars:144},
  {id:'range_loose',hardStop:.045,beTrigger:.040,beLock:.002,trailTrigger:.065,trailGap:.025,staleBars:168}],
 VOLATILE:[
  {id:'volatile_defensive',hardStop:.045,beTrigger:.050,beLock:.002,trailTrigger:.085,trailGap:.035,staleBars:168},
  {id:'volatile_balanced',hardStop:.050,beTrigger:.060,beLock:.002,trailTrigger:.100,trailGap:.040,staleBars:192},
  {id:'volatile_room',hardStop:.060,beTrigger:.070,beLock:.001,trailTrigger:.120,trailGap:.050,staleBars:216}],
 RISK_OFF:[
  {id:'risk_fast',hardStop:.030,beTrigger:.025,beLock:.003,trailTrigger:.045,trailGap:.015,staleBars:72},
  {id:'risk_balanced',hardStop:.035,beTrigger:.030,beLock:.003,trailTrigger:.050,trailGap:.018,staleBars:96},
  {id:'risk_room',hardStop:.040,beTrigger:.035,beLock:.002,trailTrigger:.060,trailGap:.022,staleBars:120}]
};
const median=a=>{if(!a.length)return 0;const b=[...a].sort((x,y)=>x-y),m=Math.floor(b.length/2);return b.length%2?b[m]:(b[m-1]+b[m])/2};

function simulateExit(s,p){
 const r=s.series,e=s.index+1,entry=r[e]?.o;if(!(entry>0))return null;
 let high=entry,low=entry,stop=entry*(1-p.hardStop),exit=entry,exitI=e,hit10=null,stopBefore10=false,reason='HORIZON';
 for(let k=e;k<r.length&&k<=s.index+FWD;k++){
  const b=r[k];high=Math.max(high,b.h);low=Math.min(low,b.l);
  if(hit10===null&&b.h/entry-1>=.10)hit10=(k-e)*5;
  if(hit10===null&&b.l<=entry*(1-p.hardStop))stopBefore10=true;
  if(b.l<=stop){exit=stop;exitI=k;reason=stop<=entry*(1-p.hardStop)+1e-12?'HARD_STOP':(stop>entry?'PROTECTIVE_STOP':'STOP');break}
  const hg=high/entry-1;if(hg>=p.trailTrigger)stop=Math.max(stop,high*(1-p.trailGap));else if(hg>=p.beTrigger)stop=Math.max(stop,entry*(1+p.beLock));
  if(k-e>=p.staleBars&&hg<=.005){exit=b.c;exitI=k;reason='STALE';break}exit=b.c;exitI=k;
 }
 const mfe=high/entry-1,mae=low/entry-1,gross=exit/entry-1,net=gross-COST,pathRatio=mfe/Math.max(.005,Math.abs(mae));
 return {net,gross,mfe,mae,pathRatio,hit10,stopBefore10,captureRatio:mfe>0?clamp(Math.max(0,net)/mfe,0,1):0,holdingMin:(exitI-e)*5,reason,clean:hit10!==null&&hit10<=720&&!stopBefore10&&mae>=-.04&&pathRatio>=2};
}
function fullMFE24h(s){const r=s.series,e=s.index+1,entry=r[e]?.o;if(!(entry>0))return 0;let high=entry;for(let k=e;k<r.length&&k<=s.index+FWD;k++)high=Math.max(high,r[k].h);return high/entry-1}
function enrichCandidate(s,policies,cal,cfg){
 const c=v.blendedCandidate(s,policies,cal,cfg);if(!c)return null;let a=0,z=0;
 for(const [rg,p] of Object.entries(policies)){if(!p||p.off||!p.th)continue;const rw=s.regimeWeights[rg]||0;if(rw<.10)continue;const st=v.state(s,p.th);if(st.passed<p.cfg.consensus)continue;
  const ms=v.microScore(s.f,cal),bq=clamp((st.passed-p.cfg.consensus+1)/Math.max(1,6-p.cfg.consensus)),mq=clamp((st.margin+.15)/.75),q=clamp((1-p.cfg.microWeight)*(.65*bq+.35*mq)+p.cfg.microWeight*ms);if(q<p.cfg.minQuality)continue;const w=rw*p.activation;a+=w*(st.passed/5);z+=w}
 return {...c,baseSize:c.size,agreement:z?a/z:0,regimeConfidence:Math.max(...Object.values(s.regimeWeights))};
}
function candidates(samples,policies,cal,cfg){return v.dedupe(samples.map(s=>enrichCandidate(s,policies,cal,cfg)).filter(Boolean))}
function blendExit(s,selected){const keys=['hardStop','beTrigger','beLock','trailTrigger','trailGap','staleBars'],o=Object.fromEntries(keys.map(k=>[k,0]));let z=0;for(const rg of REGIMES){const p=selected[rg]||BASE_EXIT,w=Math.max(0,s.regimeWeights[rg]||0);z+=w;for(const k of keys)o[k]+=w*p[k]}if(!z)return {...BASE_EXIT};for(const k of keys)o[k]/=z;o.staleBars=Math.max(72,Math.min(FWD-6,Math.round(o.staleBars)));return o}

function portfolio(cands,all,cfg,policy){
 const allClean=new Set(all.filter(s=>s.o.clean).map(s=>`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`));let eq=1,peak=1,dd=0,open=[],skippedOpen=0,skippedExposure=0,skippedDaily=0;const admitted=[],dayRisk=new Map(),det=new Set();
 const close=t=>{const keep=[];for(const p of open){if(p.exitT<=t){eq*=1+p.size*p.out.net;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1)}else keep.push(p)}open=keep};
 for(const s of cands){close(s.t);if(open.length>=cfg.maxOpen){skippedOpen++;continue}const out=policy.outcome(s);if(!out)continue;let size=policy.size(s);if(dd<=-cfg.ddBrake)size*=cfg.ddScale;const exp=open.reduce((a,p)=>a+p.size,0);if(exp+size>cfg.maxExposure)size=Math.max(0,cfg.maxExposure-exp);if(size<.008){skippedExposure++;continue}
  const day=new Date(s.t).toISOString().slice(0,10),risk=size*policy.risk(s),used=dayRisk.get(day)||0;if(used+risk>cfg.dailyRiskBudget){skippedDaily++;continue}dayRisk.set(day,used+risk);admitted.push({...s,size,out});if(s.o.clean)det.add(`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`);open.push({...s,size,out,exitT:s.t+out.holdingMin*60000})}
 close(Infinity);const clean=admitted.filter(s=>s.o.clean),cap=admitted.map(s=>s.out.captureRatio);
 return {signals:cands.length,tradeCount:admitted.length,clean:clean.length,winRate:admitted.length?admitted.filter(s=>s.out.net>0).length/admitted.length:0,precision:admitted.length?clean.length/admitted.length:0,recall:allClean.size?det.size/allClean.size:0,avgNetRet:avg(admitted.map(s=>s.out.net)),netGrowth:eq-1,maxDrawdown:dd,avgCaptureRatio:avg(cap),medianCaptureRatio:median(cap),avgMFE:avg(admitted.map(s=>s.out.mfe)),avgOpportunityMFE24h:avg(admitted.map(s=>s.fullMFE24h)),stopBefore10Rate:admitted.length?admitted.filter(s=>s.out.stopBefore10).length/admitted.length:0,avgHoldingMin:avg(admitted.map(s=>s.out.holdingMin)),avgDetection24hPct:avg(clean.map(s=>s.f.r24*100)),avgHit10Min:avg(clean.map(s=>s.o.hit10).filter(Number.isFinite)),avgSize:avg(admitted.map(s=>s.size)),avgQuality:avg(admitted.map(s=>s.quality)),avgOpportunity:avg(admitted.map(s=>s.opportunity)),avgRegimeConfidence:avg(admitted.map(s=>s.regimeConfidence)),avgAgreement:avg(admitted.map(s=>s.agreement)),skippedOpen,skippedExposure,skippedDaily};
}
function exitMetrics(cands,p){const rows=cands.map(s=>simulateExit(s,p)).filter(Boolean);let eq=1,peak=1,dd=0;for(const o of rows){eq*=1+.05*o.net;peak=Math.max(peak,eq);dd=Math.min(dd,eq/peak-1)}return {trades:rows.length,avgNetRet:avg(rows.map(x=>x.net)),netGrowthAt5Pct:eq-1,maxDrawdownAt5Pct:dd,winRate:rows.length?rows.filter(x=>x.net>0).length/rows.length:0,avgCaptureRatio:avg(rows.map(x=>x.captureRatio)),medianCaptureRatio:median(rows.map(x=>x.captureRatio)),avgMFE:avg(rows.map(x=>x.mfe)),stopBefore10Rate:rows.length?rows.filter(x=>x.stopBefore10).length/rows.length:0,avgHoldingMin:avg(rows.map(x=>x.holdingMin))}}
function exitScore(m){if(m.trades<5)return-1e9;return m.avgNetRet*28+m.netGrowthAt5Pct*6+m.avgCaptureRatio*.8+m.winRate*.3-m.stopBefore10Rate*.3-Math.max(0,Math.abs(m.maxDrawdownAt5Pct)-.08)*12}
function chooseExits(tr,va){const selected={},evidence={};for(const rg of REGIMES){const a=tr.filter(s=>s.primaryRegime===rg),b=va.filter(s=>s.primaryRegime===rg);let best=null;const trials=[];for(const p of EXIT_GRID[rg]){const tm=exitMetrics(a,p),vm=exitMetrics(b,p),ts=exitScore(tm),vs=exitScore(vm),score=ts<=-1e8||vs<=-1e8?-1e9:.35*ts+.65*vs,row={profile:p,train:tm,validation:vm,score};trials.push(row);if(!best||score>best.score)best=row}if(!best||best.score<=-1e8){selected[rg]={...BASE_EXIT,id:`${rg.toLowerCase()}_fallback_baseline`};evidence[rg]={fallback:true,trainTrades:a.length,validationTrades:b.length,trials}}else{selected[rg]=best.profile;evidence[rg]={fallback:false,trainTrades:a.length,validationTrades:b.length,selected:best,trials}}}return {selected,evidence}}
function sizingGrid(){const ws=[{quality:.45,opportunity:.20,regime:.20,agreement:.15},{quality:.35,opportunity:.30,regime:.20,agreement:.15},{quality:.40,opportunity:.20,regime:.15,agreement:.25}],out=[];for(const minSize of [.008,.012])for(const maxSize of [.08,.10,.12])for(const gamma of [1.10,1.35])for(const weights of ws)out.push({minSize,maxSize,gamma,weights});return out}
function asymSize(s,c){const r=s.regimeWeights,fav=clamp(.55+.55*(r.TREND_UP||0)+.10*(r.VOLATILE||0)-.45*(r.RISK_OFF||0),.15,1),reg=clamp(s.regimeConfidence*fav),q=clamp(c.weights.quality*s.quality+c.weights.opportunity*s.opportunity+c.weights.regime*reg+c.weights.agreement*s.agreement);return c.minSize+(c.maxSize-c.minSize)*Math.pow(q,c.gamma)}
function v71Score(m,b){if(m.tradeCount<10)return-1e9;const floor=Math.max(5,b.tradeCount*.65);return m.netGrowth*8+m.avgNetRet*24+m.avgCaptureRatio*1.4+m.winRate*.45+m.precision*.45+m.recall*.8-m.stopBefore10Rate*.45-Math.max(0,Math.abs(m.maxDrawdown)-.12)*24-Math.max(0,floor-m.tradeCount)/Math.max(1,floor)*2}
function chooseSizing(va,all,cfg,exits,baseline){for(const s of va){s.v71Profile=blendExit(s,exits);s.v71Outcome=simulateExit(s,s.v71Profile)}let best=null;for(const c of sizingGrid()){const m=portfolio(va,all,cfg,{outcome:s=>s.v71Outcome,size:s=>asymSize(s,c),risk:s=>s.v71Profile.hardStop}),score=v71Score(m,baseline);if(!best||score>best.score)best={cfg:c,validation:m,score}}return best}
function decision(c,b){if(c.tradeCount<MIN_TEST_TRADES||b.tradeCount<MIN_TEST_TRADES)return {ready:false,label:'REQUIRES_MORE_DATA',reason:'Untouched TEST has too few comparable trades for a robust V7.1 decision.'};const positive=c.netGrowth>0,beat=c.netGrowth>b.netGrowth,retUp=c.avgNetRet>b.avgNetRet,capUp=c.avgCaptureRatio>b.avgCaptureRatio,dd=c.maxDrawdown>=-.12,time=c.avgDetection24hPct<=b.avgDetection24hPct+.25,part=c.tradeCount>=Math.max(5,b.tradeCount*.65)&&c.recall>=Math.max(.05,b.recall*.65),ready=positive&&beat&&retUp&&capUp&&dd&&time&&part;if(ready)return {ready:true,label:'READY_FOR_SHADOW_VALIDATION',reason:'V7.1 improves economics and capture on untouched TEST without violating drawdown, timing or participation gates.'};const redesign=c.maxDrawdown<-.18||(c.netGrowth<b.netGrowth-.05&&c.avgCaptureRatio<=b.avgCaptureRatio);return {ready:false,label:redesign?'REQUIRES_REDESIGN':'REQUIRES_IMPROVEMENT',reason:redesign?'Untouched TEST shows a material economic/risk regression; redesign is required.':'V7.1 completed safely but did not satisfy every economic, capture, drawdown, timing and participation gate on untouched TEST.'}}
function write(r){const d=path.join('backend','training-output');fs.mkdirSync(d,{recursive:true});fs.writeFileSync(path.join(d,'spot-exit-intelligence-v7_1-report.json'),JSON.stringify(r,null,2));console.log(JSON.stringify(r,null,2))}

async function main(){
 const syms=await v.universe();if(!syms.includes('BTCUSDT'))syms.unshift('BTCUSDT');console.log(`V7.1 research lookback=${v.DAYS}d symbols=${syms.length}`);const data=new Map();for(const s of syms){try{const r=await v.klines(s);data.set(s,r);console.log(`LOADED ${s} ${r.length}`)}catch(e){console.log(`SKIP ${s} ${e.message}`)}}
 const bm=v.btcMap(data.get('BTCUSDT')||[]),raw=[],breadth=new Map();for(const [symbol,r] of data){if(symbol==='BTCUSDT'||r.length<v.WARM+FWD+2)continue;for(let i=v.WARM;i<r.length-FWD-1;i++){const f=v.feat(r,i,bm),t=r[i].t,b=breadth.get(t)||{n:0,up15:0,up60:0,breakout:0,ignite:0,sum60:0};b.n++;if(f.r15>0)b.up15++;if(f.r60>0)b.up60++;if(f.breakout60>0)b.breakout++;if(f.vol15>1.2)b.ignite++;b.sum60+=f.r60;breadth.set(t,b);if(f.qv<v.MIN_QV||f.r24<.001||f.r24>=.18||f.r60>=.10||f.r15>=.06)continue;const o=v.outcome(r,i);if(o){const s={symbol,t,f,o,series:r,index:i};s.fullMFE24h=fullMFE24h(s);raw.push(s)}}}
 for(const s of raw){s.breadth=v.breadthFrom(breadth,s.t);s.regimeWeights=v.regimeWeights(s.f,s.breadth);s.primaryRegime=Object.entries(s.regimeWeights).sort((a,b)=>b[1]-a[1])[0][0];s.opportunity=v.opportunityScore(s.breadth)}raw.sort((a,b)=>a.t-b.t);
 if(raw.length<500)return write({generatedAt:new Date().toISOString(),version:'V7.1',researchOnly:true,publicDataOnly:true,productionTradingTouched:false,lookbackDays:v.DAYS,decision:{ready:false,label:'REQUIRES_MORE_DATA',reason:`Only ${raw.length} usable samples`}});
 const t0=raw[0].t,t1=raw.at(-1).t,span=t1-t0,c1=t0+span*.45,c2=t0+span*.80,horizon=FWD*STEP,train=raw.filter(x=>x.t<c1-horizon),val=raw.filter(x=>x.t>c1+PURGE&&x.t<c2-horizon),test=raw.filter(x=>x.t>c2+PURGE);
 if(train.length<250||val.length<80||test.length<80)return write({generatedAt:new Date().toISOString(),version:'V7.1',researchOnly:true,publicDataOnly:true,productionTradingTouched:false,lookbackDays:v.DAYS,samples:{all:raw.length,train:train.length,validation:val.length,test:test.length},split:{trainPct:.45,validationPct:.35,testPct:.20,purgeHours:PURGE/3600000,forwardEmbargoHours:horizon/3600000},decision:{ready:false,label:'REQUIRES_MORE_DATA',reason:'Clean embargoed split leaves insufficient samples in at least one partition.'}});
 const cal=v.microCal(train),policies=v.chooseSpecialists(train,val,cal);let bestMeta=null;for(const cfg of v.metaConfigs()){const m=v.metaMetrics(val,policies,cal,cfg),score=v.metaObjective(m);if(!bestMeta||score>bestMeta.score)bestMeta={cfg,validation:m,score}}
 const trC=candidates(train,policies,cal,bestMeta.cfg),vaC=candidates(val,policies,cal,bestMeta.cfg),teC=candidates(test,policies,cal,bestMeta.cfg),exitSelection=chooseExits(trC,vaC);
 for(const s of vaC)s.baseOutcome=simulateExit(s,BASE_EXIT);for(const s of teC)s.baseOutcome=simulateExit(s,BASE_EXIT);
 const baseVal=portfolio(vaC,val,bestMeta.cfg,{outcome:s=>s.baseOutcome,size:s=>s.baseSize,risk:()=>BASE_EXIT.hardStop}),bestSizing=chooseSizing(vaC,val,bestMeta.cfg,exitSelection.selected,baseVal),baseTest=portfolio(teC,test,bestMeta.cfg,{outcome:s=>s.baseOutcome,size:s=>s.baseSize,risk:()=>BASE_EXIT.hardStop});
 for(const s of teC){s.v71Profile=blendExit(s,exitSelection.selected);s.v71Outcome=simulateExit(s,s.v71Profile)}const candTest=portfolio(teC,test,bestMeta.cfg,{outcome:s=>s.v71Outcome,size:s=>asymSize(s,bestSizing.cfg),risk:s=>s.v71Profile.hardStop}),d=decision(candTest,baseTest),delta={netGrowth:candTest.netGrowth-baseTest.netGrowth,avgNetRet:candTest.avgNetRet-baseTest.avgNetRet,maxDrawdown:candTest.maxDrawdown-baseTest.maxDrawdown,avgCaptureRatio:candTest.avgCaptureRatio-baseTest.avgCaptureRatio,medianCaptureRatio:candTest.medianCaptureRatio-baseTest.medianCaptureRatio,avgMFE:candTest.avgMFE-baseTest.avgMFE,recall:candTest.recall-baseTest.recall,precision:candTest.precision-baseTest.precision,detectionTiming:candTest.avgDetection24hPct-baseTest.avgDetection24hPct,tradeCount:candTest.tradeCount-baseTest.tradeCount,avgHoldingMin:candTest.avgHoldingMin-baseTest.avgHoldingMin};
 write({generatedAt:new Date().toISOString(),version:'V7.1',experiment:'Exit Intelligence + Asymmetric Sizing',researchOnly:true,publicDataOnly:true,publicDataOrigin:v.BASE,privateBinanceUsed:false,firestoreUsed:false,productionTradingTouched:false,automaticPromotion:false,interval:v.INTERVAL,lookbackDays:v.DAYS,costs:{roundTripFraction:COST,description:'Conservative fixed research cost inherited from V7.0.'},captureRatioDefinition:{formula:'max(0, netRealizedReturn) / MFE_during_trade',losingTradeTreatment:'0',zeroOrNegativeMFETreatment:'0',bounded:'[0,1]',note:'MFE is measured while the simulated position is open; avgOpportunityMFE24h reports the full post-entry 24h excursion separately.'},split:{trainPct:.45,validationPct:.35,testPct:.20,purgeHours:PURGE/3600000,forwardEmbargoHours:horizon/3600000,selectionRule:'All specialists, meta-config, exit profiles and sizing parameters use TRAIN/VALIDATION only. TEST is evaluated once after freezing selection.'},samples:{all:raw.length,train:train.length,validation:val.length,test:test.length},specialists:Object.fromEntries(Object.entries(policies).map(([r,p])=>[r,{off:p.off,activation:p.activation,cfg:p.cfg,validation:p.validation,score:p.score}])),metaController:{cfg:bestMeta.cfg,validation:bestMeta.validation,score:bestMeta.score},exitSelection,asymmetricSizing:{selected:bestSizing.cfg,validation:bestSizing.validation,score:bestSizing.score},baseline:{exit:BASE_EXIT,test:baseTest},v71:{test:candTest},deltaVsBaseline:delta,gates:{positive:candTest.netGrowth>0,economicBeat:candTest.netGrowth>baseTest.netGrowth&&candTest.avgNetRet>baseTest.avgNetRet,captureImproved:candTest.avgCaptureRatio>baseTest.avgCaptureRatio,drawdownSafe:candTest.maxDrawdown>=-.12,timingSafe:candTest.avgDetection24hPct<=baseTest.avgDetection24hPct+.25,participationSafe:candTest.tradeCount>=Math.max(5,baseTest.tradeCount*.65)&&candTest.recall>=Math.max(.05,baseTest.recall*.65)},decision:d,promotion:d.ready?'SHADOW VALIDATION NEXT. No automatic production promotion.':'RESEARCH CONTINUES. Production unchanged.'});
}
main().catch(e=>{console.error(e);process.exit(1)});
