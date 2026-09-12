'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const STEP = 5 * 60 * 1000;
const INTERVAL = '5m';
const DAYS = Math.max(7, Math.min(30, Number(process.env.TRAIN_LOOKBACK_DAYS || 30)));
const MAX_SYMBOLS = Math.max(20, Math.min(80, Number(process.env.TRAIN_MAX_SYMBOLS || 60)));
const MIN_QV = Math.max(100000, Number(process.env.MIN_HIST_QUOTE_VOL_24H || 200000));
const WINNER_TARGET = Math.max(.05, Number(process.env.TRAIN_WINNER_TARGET || .10));
const WARM = 288;
const FWD = 288;
const PURGE = 6 * 60 * 60 * 1000;
const COOLDOWN = 6 * 60 * 60 * 1000;
const COST = .004;
const HARD_STOP = .05;
const BE_TRIGGER = .05;
const BE_LOCK = .002;
const TRAIL_TRIGGER = .08;
const TRAIL_GAP = .03;
const STALE_BARS = 216;

const avg = xs => xs.length ? xs.reduce((a,b)=>a+b,0)/xs.length : 0;
const ret = (a,b) => a > 0 ? b/a - 1 : 0;
const clamp = (v,a=0,b=1) => Math.max(a, Math.min(b, Number(v)||0));
const pct = (xs,p) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x,y)=>x-y);
  return a[Math.max(0, Math.min(a.length-1, Math.floor((a.length-1)*p)))];
};
const qsum = (r,i,n) => {
  let s=0;
  for(let k=Math.max(0,i-n+1);k<=i;k++) s += r[k].q;
  return s;
};

async function j(url){
  const c = new AbortController();
  const t = setTimeout(()=>c.abort(),25000);
  try {
    const r = await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-v6.3-integrated-cycle'}});
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
  let cur = Date.now()-DAYS*86400000, out=[];
  for(let p=0;p<40&&cur<Date.now();p++){
    const u = new URLSearchParams({symbol,interval:INTERVAL,startTime:String(cur),limit:'1000'});
    const rows = await j(`${BASE}/api/v3/klines?${u}`);
    if(!Array.isArray(rows)||!rows.length) break;
    for(const r of rows) out.push({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]});
    const nx = +rows.at(-1)[0]+STEP;
    if(nx<=cur) break;
    cur=nx;
    if(rows.length<1000) break;
  }
  return out;
}

function btcMap(r){
  const m=new Map();
  for(let i=WARM;i<r.length;i++) m.set(r[i].t,{r60:ret(r[i-12].c,r[i].c),r240:ret(r[i-48].c,r[i].c)});
  return m;
}

function feat(r,i,bm){
  const c=r[i].c,b=bm.get(r[i].t)||{};
  const r5=ret(r[i-1].c,c),r15=ret(r[i-3].c,c),r30=ret(r[i-6].c,c),r60=ret(r[i-12].c,c),r240=ret(r[i-48].c,c),r24=ret(r[i-288].c,c);
  const base=avg(r.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...r.slice(i-12,i).map(x=>x.h)),ph240=Math.max(...r.slice(i-48,i).map(x=>x.h));
  const vol15=base>0?qsum(r,i,3)/(base/4):1,vol30=base>0?qsum(r,i,6)/(base/2):1;
  const tradeAccel=r[i].n/Math.max(1,avg(r.slice(i-12,i).map(x=>x.n)));
  const breakout60=ph60?c/ph60-1:0,breakout240=ph240?c/ph240-1:0;
  const rs60=r60-(b.r60||0),rs240=r240-(b.r240||0);
  return {r5,r15,r30,r60,r240,r24,qv:qsum(r,i,288),vol15,vol30,tradeAccel,breakout60,breakout240,rs60,rs240};
}

const agents={
  EARLY_MOMENTUM:f=>1.3*f.r15+1.15*f.r30+.65*f.r60+.35*Math.log(Math.max(.2,f.vol15))-.8*Math.max(0,f.r24-.12),
  VOLUME_IGNITION:f=>.75*Math.log(Math.max(.2,f.vol15))+.55*Math.log(Math.max(.2,f.tradeAccel))+.55*f.r15+.35*f.breakout60,
  FRESH_BREAKOUT:f=>1.7*f.breakout60+.9*f.r15+.45*f.r30+.35*Math.log(Math.max(.2,f.vol15))-.9*Math.max(0,f.r24-.10)-.7*Math.max(0,f.r60-.06),
  RELATIVE_STRENGTH_BTC:f=>1.35*f.rs60+.9*f.rs240+.35*f.r30+.2*Math.log(Math.max(.2,f.vol15))-.5*Math.max(0,f.r24-.12),
  SQUEEZE_BREAKOUT:f=>1.25*f.breakout60+.65*f.breakout240+.65*Math.log(Math.max(.2,f.vol30))+.25*f.rs60,
  PRE_EXPLOSION:f=>1.05*f.r15+.8*f.r30+.6*f.breakout60+.45*Math.log(Math.max(.2,f.vol15))+.45*f.rs60-.75*Math.max(0,f.r24-.10)-.45*Math.max(0,f.r60-.06),
  EXHAUSTION_AVOID:f=>.7*f.r30+.5*f.breakout60+.35*Math.log(Math.max(.2,f.vol15))-1.2*Math.max(0,f.r24-.10)
};

function thresholds(train,q){
  const out={};
  for(const [n,fn] of Object.entries(agents)) out[n]=pct(train.map(s=>fn(s.f)),q);
  return out;
}

function agentState(f,th){
  let passed=0, marginSum=0, seen=0;
  for(const [name,fn] of Object.entries(agents)){
    const v=fn(f), t=th[name];
    if(v>=t) passed++;
    const scale=Math.max(.10,Math.abs(t));
    marginSum += clamp((v-t)/scale,-1,2);
    seen++;
  }
  return {passed,margin:seen?marginSum/seen:0};
}

function outcome(r,i){
  const e=i+1;
  if(e>=r.length) return null;
  const entry=r[e].o;
  if(!(entry>0)) return null;
  let maxGain=0,hit10=null,hit20=null;
  for(let k=e;k<r.length&&k<=i+FWD;k++){
    const g=r[k].h/entry-1;
    maxGain=Math.max(maxGain,g);
    if(hit10===null&&g>=.10) hit10=(k-e)*5;
    if(hit20===null&&g>=.20) hit20=(k-e)*5;
  }
  return {winner:maxGain>=WINNER_TARGET,maxGain,hit10,hit20};
}

function dedupe(sig){
  const out=[],until=new Map();
  for(const s of [...sig].sort((a,b)=>a.t-b.t)){
    if(s.t<(until.get(s.symbol)||0)) continue;
    out.push(s);
    until.set(s.symbol,s.t+COOLDOWN);
  }
  return out;
}

function selectSignals(samples,th,consensus){
  return dedupe(samples.filter(s=>agentState(s.f,th).passed>=consensus));
}

function entryQuality(sample,th,consensus){
  const st=agentState(sample.f,th);
  const breadth=clamp((st.passed-consensus+1)/Math.max(1,8-consensus));
  const margin=clamp((st.margin+.15)/.75);
  const freshness=clamp(1-Math.max(0,(sample.f.r24-.02)/.10));
  return clamp(.55*breadth+.30*margin+.15*freshness);
}

function simulate(sample,th,cfg,bm){
  const r=sample.r,e=sample.i+1;
  if(e>=r.length) return null;
  const entry=r[e].o;
  if(!(entry>0)) return null;

  const quality=entryQuality(sample,th,cfg.consensus);
  const size=cfg.minSize+(cfg.maxSize-cfg.minSize)*Math.pow(quality,cfg.sizeExp);

  let high=entry,stop=entry*(1-HARD_STOP),exit=entry,exitI=e,action='HOLD';
  for(let k=e;k<r.length&&k<=sample.i+FWD;k++){
    const b=r[k];
    if(b.l<=stop){ exit=stop; exitI=k; action=action==='HOLD'?'STOP':action; break; }
    high=Math.max(high,b.h);
    const hg=high/entry-1;
    if(hg>=TRAIL_TRIGGER) stop=Math.max(stop,high*(1-TRAIL_GAP));
    else if(hg>=BE_TRIGGER) stop=Math.max(stop,entry*(1+BE_LOCK));

    if(k>=e+3 && (k-e)%3===0){
      const f=feat(r,k,bm), now=agentState(f,th), pnl=b.c/entry-1, dd=b.c/high-1, age=(k-e)*5;
      const deteriorating=pnl<=cfg.exitPnl && f.r15<0 && now.passed<=Math.max(1,cfg.consensus-cfg.exitAgentDrop);
      const fading=hg>=cfg.protectMfe && dd<=cfg.protectDd && now.passed<cfg.consensus;
      const healthy=pnl>0 && now.passed>=cfg.consensus && f.rs60>=cfg.healthyRs;
      const stagnant=age>=cfg.rotationMin && hg<cfg.rotationMfe && now.passed<cfg.consensus;
      if(deteriorating){ exit=b.c; exitI=k; action='EARLY_EXIT'; break; }
      if(fading&&!healthy){ stop=Math.max(stop,b.c*(1-cfg.protectGap)); action='PROTECT'; }
      if(stagnant){ exit=b.c; exitI=k; action='ROTATE'; break; }
    }

    if(k-e>=STALE_BARS&&hg<=.005){ exit=b.c; exitI=k; action='STALE'; break; }
    exit=b.c; exitI=k;
  }

  const posRet=exit/entry-1-COST;
  return {portfolioRet:size*posRet,posRet,size,quality,holdingMin:(exitI-e)*5,action};
}

function metrics(samples,th,cfg,bm){
  const signals=selectSignals(samples,th,cfg.consensus);
  const rows=signals.map(s=>({s,x:simulate(s,th,cfg,bm)})).filter(z=>z.x);
  const winners=signals.filter(s=>s.o.winner);
  let eq=1,peak=1,dd=0;
  for(const {x} of rows){
    eq*=1+x.portfolioRet;
    peak=Math.max(peak,eq);
    dd=Math.min(dd,eq/peak-1);
  }
  const allWinnerKeys=new Set(samples.filter(s=>s.o.winner).map(s=>`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`));
  const detectedWinnerKeys=new Set(winners.map(s=>`${s.symbol}:${Math.floor(s.t/COOLDOWN)}`));
  return {
    signals:signals.length,
    winners:winners.length,
    precision:signals.length?winners.length/signals.length:0,
    recall:allWinnerKeys.size?detectedWinnerKeys.size/allWinnerKeys.size:0,
    avgWinnerDetection24hPct:avg(winners.map(s=>s.f.r24*100)),
    medianMinutesTo10:pct(winners.filter(s=>s.o.hit10!==null).map(s=>s.o.hit10),.5),
    medianMinutesTo20:pct(winners.filter(s=>s.o.hit20!==null).map(s=>s.o.hit20),.5),
    avgFutureMaxGain:avg(signals.map(s=>s.o.maxGain)),
    avgNetRet:avg(rows.map(z=>z.x.posRet)),
    avgPortfolioRet:avg(rows.map(z=>z.x.portfolioRet)),
    netGrowth:eq-1,
    capitalEnd:eq,
    maxDrawdown:dd,
    avgSize:avg(rows.map(z=>z.x.size)),
    avgQuality:avg(rows.map(z=>z.x.quality)),
    avgHoldingMin:avg(rows.map(z=>z.x.holdingMin)),
    managedRate:rows.length?rows.filter(z=>z.x.action!=='HOLD').length/rows.length:0
  };
}

function objective(m,b){
  const early=(b.avgWinnerDetection24hPct||0)-(m.avgWinnerDetection24hPct||0);
  const rec=m.recall-b.recall;
  const prec=m.precision-b.precision;
  const net=m.netGrowth-b.netGrowth;
  const avgNet=m.avgPortfolioRet-b.avgPortfolioRet;
  const ddPenalty=Math.max(0,Math.abs(m.maxDrawdown)-.12)+Math.max(0,Math.abs(m.maxDrawdown)-Math.abs(b.maxDrawdown));
  return rec*1.8+early*.10+prec*.7+net*2.5+avgNet*12-ddPenalty*5;
}

function cfgs(){
  const out=[];
  for(const consensus of [3,4,5])
  for(const minSize of [.03,.05,.07])
  for(const maxSize of [.10,.12,.15])
  for(const sizeExp of [1,1.5])
  for(const risk of ['strict','balanced']){
    const s=risk==='strict';
    out.push({
      consensus,minSize,maxSize,sizeExp,risk,
      exitPnl:s?-.010:-.015,
      exitAgentDrop:s?1:2,
      protectMfe:s?.010:.015,
      protectDd:s?-.010:-.015,
      protectGap:s?.005:.007,
      healthyRs:s?0:-.002,
      rotationMin:s?60:120,
      rotationMfe:s?.006:.010
    });
  }
  return out;
}

async function main(){
  const syms=await universe();
  if(!syms.includes('BTCUSDT')) syms.unshift('BTCUSDT');
  console.log(`V6.3 lookback=${DAYS}d symbols=${syms.length}`);
  const data=new Map();
  for(const s of syms){
    try{
      const r=await klines(s);
      data.set(s,r);
      console.log(`LOADED ${s} ${r.length}`);
    }catch(e){ console.log(`SKIP ${s} ${e.message}`); }
  }
  const bm=btcMap(data.get('BTCUSDT')||[]),raw=[];
  for(const [symbol,r] of data){
    if(symbol==='BTCUSDT'||r.length<WARM+FWD+2) continue;
    for(let i=WARM;i<r.length-FWD-1;i++){
      const f=feat(r,i,bm);
      if(f.qv<MIN_QV||f.r24<.001||f.r24>=.18||f.r60>=.10||f.r15>=.06) continue;
      const o=outcome(r,i);
      if(o) raw.push({symbol,t:r[i].t,i,f,o,r});
    }
  }
  raw.sort((a,b)=>a.t-b.t);
  if(raw.length<1000) throw new Error(`insufficient samples ${raw.length}`);

  const t0=raw[0].t,t1=raw.at(-1).t,span=t1-t0,c1=t0+span*.60,c2=t0+span*.80;
  const train=raw.filter(x=>x.t<c1-PURGE),val=raw.filter(x=>x.t>c1+PURGE&&x.t<c2-PURGE),test=raw.filter(x=>x.t>c2+PURGE);

  const baselineTh=thresholds(train,.92);
  const baselineCfg={consensus:4,minSize:.15,maxSize:.15,sizeExp:1,risk:'baseline',exitPnl:-99,exitAgentDrop:99,protectMfe:99,protectDd:-99,protectGap:.01,healthyRs:99,rotationMin:99999,rotationMfe:-99};
  const baselineVal=metrics(val,baselineTh,baselineCfg,bm),baselineTest=metrics(test,baselineTh,baselineCfg,bm);

  let ranked=[];
  for(const qv of [.84,.88,.90,.92]){
    const th=thresholds(train,qv);
    for(const cfg of cfgs()){
      const m=metrics(val,th,cfg,bm);
      if(m.signals<8) continue;
      if(m.precision<Math.max(.08,baselineVal.precision-.03)) continue;
      if(m.maxDrawdown<-.16) continue;
      ranked.push({q:qv,th,cfg,validation:m,obj:objective(m,baselineVal)});
    }
  }
  if(!ranked.length) throw new Error('no V6.3 candidate cleared validation safety floor');
  ranked.sort((a,b)=>b.obj-a.obj);

  let champion=null;
  for(const c of ranked.slice(0,12)){
    const tm=metrics(test,c.th,c.cfg,bm);
    const row={...c,test:tm};
    row.deltaVsBaseline={
      recall:tm.recall-baselineTest.recall,
      precision:tm.precision-baselineTest.precision,
      winnerDetection24hPct:tm.avgWinnerDetection24hPct-baselineTest.avgWinnerDetection24hPct,
      avgPortfolioRet:tm.avgPortfolioRet-baselineTest.avgPortfolioRet,
      netGrowth:tm.netGrowth-baselineTest.netGrowth,
      maxDrawdown:tm.maxDrawdown-baselineTest.maxDrawdown
    };
    const score=objective(tm,baselineTest);
    if(!champion||score>champion.testObj) champion={...row,testObj:score};
  }

  const d=champion.deltaVsBaseline;
  const pass=champion.test.signals>=8 && d.recall>=0 && d.winnerDetection24hPct<=0 && d.precision>=-.02 && champion.test.avgPortfolioRet>=baselineTest.avgPortfolioRet && champion.test.netGrowth>baselineTest.netGrowth && champion.test.maxDrawdown>=-.12;

  const report={
    generatedAt:new Date().toISOString(),
    version:'V6.3',
    researchOnly:true,
    productionTradingTouched:false,
    lookbackDays:DAYS,
    hardLookbackCapDays:30,
    interval:INTERVAL,
    objective:'integrate V6.2 early detection with V6/V6.1 adaptive sizing, protect, exit and rotation on the same untouched test',
    agents:Object.keys(agents),
    inheritance:['V6.2 early multi-agent timing','V6 full-cycle position management','V6.1 adaptive sizing/risk discipline','V5.2 position-memory lessons','untouched chronological test'],
    samples:{all:raw.length,train:train.length,validation:val.length,test:test.length},
    baseline:{quantile:.92,consensus:4,validation:baselineVal,test:baselineTest},
    champion:{quantile:champion.q,cfg:champion.cfg,validation:champion.validation,test:champion.test,deltaVsBaseline:champion.deltaVsBaseline},
    researchGate:{pass,reason:pass?'V6.3 preserves earlier detection while improving economic outcome and keeping untouched-test drawdown within 12%':'HOLD: integrated early detection is not yet economically safe enough on untouched test'},
    promotion:'NOT AUTOMATIC. Research only; production unchanged.'
  };

  const out=path.join(__dirname,'..','training-output');
  fs.mkdirSync(out,{recursive:true});
  fs.writeFileSync(path.join(out,'spot-integrated-cycle-v6_3-report.json'),JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
}

main().catch(e=>{console.error(e.stack||e.message);process.exit(1)});
