'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const INTERVAL = '5m';
const STEP = 300000;
const DAYS = Math.max(7, Math.min(30, Number(process.env.TRAIN_LOOKBACK_DAYS || 30)));
const MAX_SYMBOLS = Math.max(20, Math.min(80, Number(process.env.TRAIN_MAX_SYMBOLS || 60)));
const MIN_QV = Math.max(100000, Number(process.env.MIN_HIST_QUOTE_VOL_24H || 200000));
const COST = 0.004;
const WARM = 288;
const FWD = 288;
const PURGE = 6 * 3600000;
const COOLDOWN = 6 * 3600000;
const HARD_STOP = 0.05;
const BE_TRIGGER = 0.05;
const BE_LOCK = 0.002;
const TRAIL_TRIGGER = 0.08;
const TRAIL_GAP = 0.03;
const STALE_BARS = 216;

const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
const ret = (a,b) => a > 0 ? b/a - 1 : 0;
const clamp = (x,a=0,b=1) => Math.max(a, Math.min(b, Number(x) || 0));
function pct(xs,p){
  if(!xs.length) return 0;
  const a=[...xs].sort((x,y)=>x-y);
  return a[Math.max(0,Math.min(a.length-1,Math.floor((a.length-1)*p)))];
}
function qsum(r,i,n){ let s=0; for(let k=Math.max(0,i-n+1);k<=i;k++) s += r[k].q; return s; }

async function j(url){
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(),25000);
  try{
    const r = await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-v6.9-regime-meta'}});
    if(!r.ok) throw new Error(`HTTP ${r.status}`);
    return r.json();
  } finally { clearTimeout(t); }
}

async function universe(){
  const rows = await j(`${BASE}/api/v3/ticker/24hr`);
  return rows
    .filter(x=>String(x.symbol).endsWith('USDT'))
    .filter(x=>!/(UP|DOWN|BULL|BEAR)USDT$/.test(String(x.symbol)))
    .filter(x=>Number(x.quoteVolume)>=MIN_QV)
    .sort((a,b)=>Number(b.quoteVolume)-Number(a.quoteVolume))
    .slice(0,MAX_SYMBOLS)
    .map(x=>String(x.symbol));
}

async function klines(symbol){
  let cur=Date.now()-DAYS*86400000, out=[];
  for(let p=0;p<40 && cur<Date.now();p++){
    const u = new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cur),limit:'1000'});
    const rows = await j(`${BASE}/api/v3/klines?${u}`);
    if(!Array.isArray(rows)||!rows.length) break;
    for(const r of rows) out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]});
    const nx=+rows.at(-1)[0]+STEP;
    if(nx<=cur) break;
    cur=nx;
    if(rows.length<1000) break;
  }
  return out;
}

function btcMap(r){
  const m=new Map();
  for(let i=WARM;i<r.length;i++){
    const rr=r.slice(i-12,i+1).map((b,k,a)=>k?ret(a[k-1].c,b.c):0).slice(1);
    m.set(r[i].t,{
      r60:ret(r[i-12].c,r[i].c),
      r240:ret(r[i-48].c,r[i].c),
      r24:ret(r[i-288].c,r[i].c),
      vol60:Math.sqrt(avg(rr.map(x=>x*x)))
    });
  }
  return m;
}

function candleMicro(r,i){
  const w=r.slice(i-11,i+1);
  let hh=0,hl=0,bull=0,upper=0,body=0,vr=[];
  for(let k=0;k<w.length;k++){
    const b=w[k], rg=Math.max(1e-12,b.h-b.l);
    body+=Math.abs(b.c-b.o)/rg;
    upper+=(b.h-Math.max(b.o,b.c))/rg;
    if(b.c>b.o) bull++;
    if(k>0){ if(b.h>w[k-1].h) hh++; if(b.l>w[k-1].l) hl++; }
    vr.push(b.q);
  }
  const first=w[0],last=w.at(-1),peak=Math.max(...w.map(x=>x.h));
  const pullback=(peak-last.c)/Math.max(1e-12,last.c);
  const v0=avg(vr.slice(0,8)),v1=avg(vr.slice(8));
  const volumePersistence=v0>0?v1/v0:1;
  const trendEfficiency=Math.abs(last.c-first.o)/Math.max(1e-12,w.reduce((s,b)=>s+Math.abs(b.c-b.o),0));
  return {hhRate:hh/11,hlRate:hl/11,bullRate:bull/12,upperWick:upper/12,bodyShare:body/12,pullback,volumePersistence,trendEfficiency};
}

function feat(r,i,bm){
  const c=r[i].c,b=bm.get(r[i].t)||{};
  const r15=ret(r[i-3].c,c),r30=ret(r[i-6].c,c),r60=ret(r[i-12].c,c),r240=ret(r[i-48].c,c),r24=ret(r[i-288].c,c);
  const base=avg(r.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...r.slice(i-12,i).map(x=>x.h));
  const vol15=base>0?qsum(r,i,3)/(base/4):1;
  const tradeAccel=r[i].n/Math.max(1,avg(r.slice(i-12,i).map(x=>x.n)));
  const breakout60=ph60?c/ph60-1:0;
  const rs60=r60-(b.r60||0), rs240=r240-(b.r240||0);
  return {r15,r30,r60,r240,r24,qv:qsum(r,i,288),vol15,tradeAccel,breakout60,rs60,rs240,btcR60:b.r60||0,btcR240:b.r240||0,btcR24:b.r24||0,btcVol60:b.vol60||0,...candleMicro(r,i)};
}

const agents={
  EARLY:f=>1.30*f.r15+1.10*f.r30+.60*f.r60+.35*Math.log(Math.max(.2,f.vol15))-.75*Math.max(0,f.r24-.12),
  VOLUME:f=>.75*Math.log(Math.max(.2,f.vol15))+.55*Math.log(Math.max(.2,f.tradeAccel))+.55*f.r15+.30*f.breakout60,
  BREAKOUT:f=>1.60*f.breakout60+.90*f.r15+.45*f.r30+.35*Math.log(Math.max(.2,f.vol15))-.80*Math.max(0,f.r24-.10),
  RS:f=>1.35*f.rs60+.90*f.rs240+.35*f.r30+.20*Math.log(Math.max(.2,f.vol15)),
  PRE:f=>1.05*f.r15+.80*f.r30+.60*f.breakout60+.45*Math.log(Math.max(.2,f.vol15))+.45*f.rs60-.75*Math.max(0,f.r24-.10)
};

function regime(f){
  if(f.btcR240 < -0.02 || (f.btcVol60 > 0.012 && f.btcR60 < -0.004)) return 'RISK_OFF';
  if(f.btcR240 > 0.015 && f.btcR60 > 0) return 'TREND_UP';
  if(f.btcVol60 > 0.010) return 'VOLATILE';
  return 'RANGE';
}

function outcome(r,i){
  const e=i+1; if(e>=r.length) return null;
  const entry=r[e].o; if(!(entry>0)) return null;
  let high=entry,low=entry,stop=entry*(1-HARD_STOP),exit=entry,exitI=e,hit10=null,stopBefore10=false;
  for(let k=e;k<r.length&&k<=i+FWD;k++){
    const b=r[k]; high=Math.max(high,b.h); low=Math.min(low,b.l);
    if(hit10===null&&b.h/entry-1>=.10) hit10=(k-e)*5;
    if(hit10===null&&b.l<=entry*(1-HARD_STOP)) stopBefore10=true;
    if(b.l<=stop){ exit=stop; exitI=k; break; }
    const hg=high/entry-1;
    if(hg>=TRAIL_TRIGGER) stop=Math.max(stop,high*(1-TRAIL_GAP));
    else if(hg>=BE_TRIGGER) stop=Math.max(stop,entry*(1+BE_LOCK));
    if(k-e>=STALE_BARS&&hg<=.005){ exit=b.c; exitI=k; break; }
    exit=b.c; exitI=k;
  }
  const mfe=high/entry-1,mae=low/entry-1,pathRatio=mfe/Math.max(.005,Math.abs(mae));
  const net=exit/entry-1-COST;
  const clean=hit10!==null&&hit10<=720&&!stopBefore10&&mae>=-.04&&pathRatio>=2;
  return {net,clean,mfe,mae,pathRatio,hit10,stopBefore10,holdingMin:(exitI-e)*5};
}

function thresholds(train,q){
  const out={};
  for(const [n,fn] of Object.entries(agents)) out[n]=pct(train.map(s=>fn(s.f)),q);
  return out;
}
function state(s,th){
  let passed=0,margin=0;
  for(const [n,fn] of Object.entries(agents)){
    const v=fn(s.f),t=th[n];
    if(v>=t) passed++;
    margin += clamp((v-t)/Math.max(.10,Math.abs(t)),-1,2);
  }
  return {passed,margin:margin/Object.keys(agents).length};
}

function microCal(train){
  const keys=['hhRate','hlRate','bullRate','bodyShare','volumePersistence','trendEfficiency','pullback','upperWick'];
  const c={};
  for(const k of keys){
    const xs=train.map(s=>s.f[k]).filter(Number.isFinite);
    c[k]={lo:pct(xs,.2),hi:pct(xs,.8),neg:k==='pullback'||k==='upperWick'};
  }
  return c;
}
function microScore(f,c){
  let s=0,w=0;
  for(const [k,z] of Object.entries(c)){
    const d=Math.max(1e-12,z.hi-z.lo);
    let v=clamp((f[k]-z.lo)/d); if(z.neg) v=1-v;
    const wt=(k==='hlRate'||k==='volumePersistence'||k==='trendEfficiency'||k==='pullback')?1.3:1;
    s+=wt*v; w+=wt;
  }
  return w?s/w:.5;
}

function dedupe(sig){
  const out=[],until=new Map();
  for(const s of [...sig].sort((a,b)=>a.t-b.t)){
    if(s.t<(until.get(s.symbol)||0)) continue;
    out.push(s); until.set(s.symbol,s.t+COOLDOWN);
  }
  return out;
}

function localMetrics(samples,th,cal,cfg){
  if(cfg.off) return {signals:0,admitted:0,clean:0,winRate:0,precision:0,recall:0,avgNetRet:0,netGrowth:0,maxDrawdown:0,avgDetection24hPct:0,stopBefore10Rate:0,avgSize:0};
  const allClean=new Set(samples.filter(s=>s.o.clean).map(s=>`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`));
  const sig=dedupe(samples.filter(s=>state(s,th).passed>=cfg.consensus));
  let eq=1,peak=1,dd=0,sizeSum=0; const admitted=[],det=new Set();
  for(const s of sig){
    const st=state(s,th),ms=microScore(s.f,cal);
    const baseQ=clamp((st.passed-cfg.consensus+1)/Math.max(1,6-cfg.consensus));
    const marginQ=clamp((st.margin+.15)/.75);
    const quality=clamp((1-cfg.microWeight)*(.65*baseQ+.35*marginQ)+cfg.microWeight*ms);
    if(quality<cfg.minQuality) continue;
    const size=cfg.minSize+(cfg.maxSize-cfg.minSize)*Math.pow(quality,cfg.gamma);
    admitted.push({...s,size,quality}); sizeSum+=size;
    eq*=1+size*s.o.net; peak=Math.max(peak,eq); dd=Math.min(dd,eq/peak-1);
    if(s.o.clean) det.add(`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`);
  }
  const clean=admitted.filter(s=>s.o.clean);
  return {signals:sig.length,admitted:admitted.length,clean:clean.length,winRate:admitted.length?admitted.filter(s=>s.o.net>0).length/admitted.length:0,precision:admitted.length?clean.length/admitted.length:0,recall:allClean.size?det.size/allClean.size:0,avgNetRet:avg(admitted.map(s=>s.o.net)),netGrowth:eq-1,maxDrawdown:dd,avgDetection24hPct:avg(clean.map(s=>s.f.r24*100)),stopBefore10Rate:admitted.length?admitted.filter(s=>s.o.stopBefore10).length/admitted.length:0,avgSize:admitted.length?sizeSum/admitted.length:0};
}

function specialistConfigs(){
  const out=[{off:true}];
  for(const q of [.82,.86,.90,.92])
  for(const consensus of [2,3,4])
  for(const microWeight of [.20,.40,.60])
  for(const minQuality of [.35,.45,.55])
  for(const maxSize of [.06,.09,.12])
    out.push({q,consensus,microWeight,minQuality,minSize:.02,maxSize,gamma:1.2,off:false});
  return out;
}

function specialistObjective(m){
  if(m.admitted<5) return -1e9;
  const ddPenalty=Math.max(0,Math.abs(m.maxDrawdown)-.10)*12;
  return m.netGrowth*5+m.avgNetRet*18+m.winRate*.7+m.precision*.9+m.recall*.8-m.stopBefore10Rate*.5-ddPenalty;
}

function chooseSpecialists(train,val,cal){
  const policies={};
  for(const rg of ['TREND_UP','RANGE','VOLATILE','RISK_OFF']){
    const tr=train.filter(s=>s.regime===rg), va=val.filter(s=>s.regime===rg);
    let best={cfg:{off:true},validation:localMetrics([],{},cal,{off:true}),score:0};
    if(tr.length<100||va.length<20){ policies[rg]=best; continue; }
    for(const cfg of specialistConfigs()){
      if(cfg.off) continue;
      const th=thresholds(tr,cfg.q),m=localMetrics(va,th,cal,cfg),score=specialistObjective(m);
      if(score>best.score && m.netGrowth>0 && m.avgNetRet>0 && m.maxDrawdown>=-.12) best={cfg,th,validation:m,score};
    }
    policies[rg]=best;
  }
  return policies;
}

function metaConfigs(){
  const out=[];
  for(const maxOpen of [3,5,8])
  for(const maxExposure of [.25,.40,.60])
  for(const dailyRiskBudget of [.012,.02,.03])
  for(const ddBrake of [.06,.09,.12])
    out.push({maxOpen,maxExposure,dailyRiskBudget,ddBrake,ddScale:.45});
  return out;
}

function metaMetrics(samples,policies,cal,cfg){
  const candidates=[];
  for(const s of samples){
    const p=policies[s.regime]; if(!p||p.cfg.off||!p.th) continue;
    const st=state(s,p.th); if(st.passed<p.cfg.consensus) continue;
    const ms=microScore(s.f,cal),baseQ=clamp((st.passed-p.cfg.consensus+1)/Math.max(1,6-p.cfg.consensus)),marginQ=clamp((st.margin+.15)/.75);
    const quality=clamp((1-p.cfg.microWeight)*(.65*baseQ+.35*marginQ)+p.cfg.microWeight*ms);
    if(quality<p.cfg.minQuality) continue;
    const size=p.cfg.minSize+(p.cfg.maxSize-p.cfg.minSize)*Math.pow(quality,p.cfg.gamma);
    candidates.push({...s,size,quality});
  }
  const sig=dedupe(candidates);
  const allClean=new Set(samples.filter(s=>s.o.clean).map(s=>`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`));
  let eq=1,peak=1,dd=0,open=[],admitted=[],skippedOpen=0,skippedExposure=0,skippedDaily=0;
  const dayRisk=new Map(),det=new Set();
  const closeUntil=t=>{ const keep=[]; for(const p of open){ if(p.exitT<=t){eq*=1+p.size*p.o.net; peak=Math.max(peak,eq); dd=Math.min(dd,eq/peak-1);} else keep.push(p); } open=keep; };
  for(const s of sig){
    closeUntil(s.t);
    if(open.length>=cfg.maxOpen){skippedOpen++;continue;}
    let size=s.size;
    if(dd<=-cfg.ddBrake) size*=cfg.ddScale;
    const exposure=open.reduce((a,p)=>a+p.size,0);
    if(exposure+size>cfg.maxExposure) size=Math.max(0,cfg.maxExposure-exposure);
    if(size<.01){skippedExposure++;continue;}
    const day=new Date(s.t).toISOString().slice(0,10),risk=size*HARD_STOP,used=dayRisk.get(day)||0;
    if(used+risk>cfg.dailyRiskBudget){skippedDaily++;continue;}
    dayRisk.set(day,used+risk);
    admitted.push({...s,size}); if(s.o.clean) det.add(`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`);
    open.push({...s,size,exitT:s.t+s.o.holdingMin*60000});
  }
  closeUntil(Infinity);
  const clean=admitted.filter(s=>s.o.clean);
  return {signals:sig.length,admitted:admitted.length,clean:clean.length,winRate:admitted.length?admitted.filter(s=>s.o.net>0).length/admitted.length:0,precision:admitted.length?clean.length/admitted.length:0,recall:allClean.size?det.size/allClean.size:0,avgNetRet:avg(admitted.map(s=>s.o.net)),netGrowth:eq-1,maxDrawdown:dd,avgDetection24hPct:avg(clean.map(s=>s.f.r24*100)),stopBefore10Rate:admitted.length?admitted.filter(s=>s.o.stopBefore10).length/admitted.length:0,avgSize:avg(admitted.map(s=>s.size)),skippedOpen,skippedExposure,skippedDaily,regimeAdmissions:Object.fromEntries(['TREND_UP','RANGE','VOLATILE','RISK_OFF'].map(r=>[r,admitted.filter(s=>s.regime===r).length]))};
}

function metaObjective(m){
  if(m.admitted<10) return -1e9;
  const ddPenalty=Math.max(0,Math.abs(m.maxDrawdown)-.12)*18;
  return m.netGrowth*6+m.avgNetRet*18+m.winRate*.7+m.precision*.8+m.recall*.9-m.stopBefore10Rate*.5-ddPenalty;
}

function writeReport(report){
  const d=path.join('backend','training-output'); fs.mkdirSync(d,{recursive:true});
  fs.writeFileSync(path.join(d,'spot-regime-meta-v6_9-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}

async function main(){
  const syms=await universe(); if(!syms.includes('BTCUSDT')) syms.unshift('BTCUSDT');
  console.log(`V6.9 lookback=${DAYS}d symbols=${syms.length}`);
  const data=new Map();
  for(const s of syms){
    try{ const r=await klines(s); data.set(s,r); console.log(`LOADED ${s} ${r.length}`); }
    catch(e){ console.log(`SKIP ${s} ${e.message}`); }
  }
  const bm=btcMap(data.get('BTCUSDT')||[]),raw=[];
  for(const [symbol,r] of data){
    if(symbol==='BTCUSDT'||r.length<WARM+FWD+2) continue;
    for(let i=WARM;i<r.length-FWD-1;i++){
      const f=feat(r,i,bm);
      if(f.qv<MIN_QV||f.r24<.001||f.r24>=.18||f.r60>=.10||f.r15>=.06) continue;
      const o=outcome(r,i); if(o) raw.push({symbol,t:r[i].t,f,o,regime:regime(f)});
    }
  }
  raw.sort((a,b)=>a.t-b.t);
  if(raw.length<500){
    return writeReport({generatedAt:new Date().toISOString(),version:'V6.9',researchOnly:true,productionTradingTouched:false,lookbackDays:DAYS,decision:{ready:false,label:'REQUIRES_MORE_DATA',reason:`Only ${raw.length} usable samples`}});
  }
  const t0=raw[0].t,t1=raw.at(-1).t,span=t1-t0,c1=t0+span*.60,c2=t0+span*.80;
  const train=raw.filter(x=>x.t<c1-PURGE),val=raw.filter(x=>x.t>c1+PURGE&&x.t<c2-PURGE),test=raw.filter(x=>x.t>c2+PURGE);
  const cal=microCal(train);
  const policies=chooseSpecialists(train,val,cal);
  let bestMeta=null;
  for(const cfg of metaConfigs()){
    const m=metaMetrics(val,policies,cal,cfg),score=metaObjective(m);
    if(!bestMeta||score>bestMeta.score) bestMeta={cfg,validation:m,score};
  }
  const testM=metaMetrics(test,policies,cal,bestMeta.cfg);
  const basePolicy={TREND_UP:{cfg:{q:.92,consensus:4,microWeight:0,minQuality:0,minSize:.15,maxSize:.15,gamma:1},th:thresholds(train.filter(s=>s.regime==='TREND_UP'),.92)},RANGE:{cfg:{q:.92,consensus:4,microWeight:0,minQuality:0,minSize:.15,maxSize:.15,gamma:1},th:thresholds(train.filter(s=>s.regime==='RANGE'),.92)},VOLATILE:{cfg:{q:.92,consensus:4,microWeight:0,minQuality:0,minSize:.15,maxSize:.15,gamma:1},th:thresholds(train.filter(s=>s.regime==='VOLATILE'),.92)},RISK_OFF:{cfg:{q:.92,consensus:4,microWeight:0,minQuality:0,minSize:.15,maxSize:.15,gamma:1},th:thresholds(train.filter(s=>s.regime==='RISK_OFF'),.92)}};
  const baseM=metaMetrics(test,basePolicy,cal,{maxOpen:99,maxExposure:9,dailyRiskBudget:9,ddBrake:9,ddScale:1});
  const ready=testM.netGrowth>0 && testM.avgNetRet>0 && testM.maxDrawdown>=-.12 && testM.netGrowth>baseM.netGrowth && testM.avgDetection24hPct<=baseM.avgDetection24hPct+.25 && testM.recall>=Math.max(.05,baseM.recall*.55);
  const report={
    generatedAt:new Date().toISOString(),version:'V6.9',researchOnly:true,productionTradingTouched:false,lookbackDays:DAYS,
    objective:'regime-specialist policies plus meta-controller that can switch policy or stay out of the market',
    samples:{all:raw.length,train:train.length,validation:val.length,test:test.length},
    regimeCounts:Object.fromEntries(['TREND_UP','RANGE','VOLATILE','RISK_OFF'].map(r=>[r,{train:train.filter(x=>x.regime===r).length,validation:val.filter(x=>x.regime===r).length,test:test.filter(x=>x.regime===r).length}])),
    specialists:Object.fromEntries(Object.entries(policies).map(([r,p])=>[r,{off:Boolean(p.cfg.off),cfg:p.cfg,validation:p.validation,score:p.score}])),
    metaController:{cfg:bestMeta.cfg,validation:bestMeta.validation,test:testM},baseline:{test:baseM},
    deltaVsBaseline:{netGrowth:testM.netGrowth-baseM.netGrowth,avgNetRet:testM.avgNetRet-baseM.avgNetRet,maxDrawdown:testM.maxDrawdown-baseM.maxDrawdown,recall:testM.recall-baseM.recall,precision:testM.precision-baseM.precision,detection:testM.avgDetection24hPct-baseM.avgDetection24hPct},
    decision:{ready,label:ready?'READY_FOR_SHADOW_VALIDATION':'REQUIRES_IMPROVEMENT',reason:ready?'Regime-specialist meta-controller is positive, drawdown-safe, earlier/non-later and economically superior on untouched test':'Meta-controller completed but did not satisfy all economic, drawdown, timing and participation requirements on untouched test'},
    promotion:ready?'SHADOW VALIDATION NEXT. No automatic production promotion.':'RESEARCH CONTINUES. Production unchanged.'
  };
  writeReport(report);
}

main().catch(e=>{console.error(e);process.exit(1)});
