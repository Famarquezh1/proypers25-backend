'use strict';
// Trigger historical replay after workflow registration.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateSpotMetaDecision } = require('../services/spotMetaDecisionEngine');

const BIN = 'https://api.binance.com';
const COST = 0.004;
const H = 240;
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function json(url) {
  for (let i=0;i<4;i++) {
    const r = await fetch(url, { headers:{'User-Agent':'Proypers25-MetaReplay/1.0'} });
    if (r.ok) return r.json();
    if (r.status===429 || r.status>=500) { await sleep(250*(i+1)); continue; }
    throw new Error('HTTP '+r.status+' '+url);
  }
  throw new Error('fetch failed '+url);
}
function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:null}
function summarize(rows){
  return {
    n: rows.length,
    continuator_rate: rows.length ? rows.filter(x=>x.continuator).length/rows.length : null,
    hit3_rate: rows.length ? rows.filter(x=>x.hit3).length/rows.length : null,
    avg_net4h: avg(rows.map(x=>x.net4h)),
    avg_mfe: avg(rows.map(x=>x.mfe)),
    avg_mae: avg(rows.map(x=>x.mae))
  };
}
function dedupe(rows){
  rows.sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  const out=[], last=new Map();
  for(const r of rows){
    const t=Date.parse(r.ts), key=String(r.symbol||'').toUpperCase();
    if(!key || !Number.isFinite(t)) continue;
    if(last.has(key) && t-last.get(key)<5*60*1000) continue;
    last.set(key,t); out.push(r);
  }
  return out;
}
async function future(symbol, ts){
  const t=Date.parse(ts);
  const u=new URL(BIN+'/api/v3/klines');
  for(const [k,v] of Object.entries({symbol,interval:'1m',startTime:t,endTime:t+(H+5)*60000,limit:500}))u.searchParams.set(k,v);
  const k=await json(u);
  if(!Array.isArray(k)||k.length<61) return null;
  const entry=Number(k[0][1]); if(!(entry>0)) return null;
  let mfe=-Infinity,mae=Infinity,first3=null,firstNeg1=null;
  for(let i=1;i<k.length;i++){
    const hi=Number(k[i][2])/entry-1, lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi); mae=Math.min(mae,lo);
    if(first3===null && hi>=.03) first3=i;
    if(firstNeg1===null && lo<=-.01) firstNeg1=i;
  }
  const close=Number(k[Math.min(H,k.length-1)][4]);
  return {
    entry,mfe,mae,
    net4h: close/entry-1-COST,
    hit3:mfe>=.03,
    continuator:first3!==null && (firstNeg1===null || first3<firstNeg1)
  };
}
(async()=>{
  const mem = process.argv[2] || path.join(os.homedir(), '.proypers25', 'local-pretrade-memory.jsonl');
  if(!fs.existsSync(mem)) throw new Error('MEMORY_NOT_FOUND '+mem);
  const raw=fs.readFileSync(mem,'utf8').split(/\r?\n/).filter(Boolean).map(x=>{try{return JSON.parse(x)}catch{return null}}).filter(Boolean);
  const rows=dedupe(raw.filter(x=>x && x.symbol && x.ts && x.metrics));
  const out=[];
  for(const r of rows){
    const m=r.metrics||{};
    const decision=evaluateSpotMetaDecision({
      lane:r.lane||'CORE',
      localGuard:{allow:r.allow!==false,metrics:m},
      v61Score:0,
      v42PassCount:0,
      v42Norm:0,
      signalPct:0,
      currentPct:0,
      exposureUsdt:0,
      equityUsdt:0
    });
    let f=null;
    try{f=await future(String(r.symbol).toUpperCase(),r.ts)}catch(e){console.error('SKIP',r.symbol,r.ts,e.message)}
    if(f) out.push({ts:r.ts,symbol:String(r.symbol).toUpperCase(),lane:r.lane||'CORE',decision:decision.decision,confidence:decision.confidence,evidence:decision.evidence_score,reasons:decision.reasons,warnings:decision.warnings,...f});
    await sleep(20);
  }
  out.sort((a,b)=>Date.parse(a.ts)-Date.parse(b.ts));
  const cut=Math.floor(out.length*.7), train=out.slice(0,cut), test=out.slice(cut);
  const by=(arr,d)=>summarize(arr.filter(x=>x.decision===d));
  const baseTrain=summarize(train), baseTest=summarize(test);
  const testBuy=by(test,'BUY'), testReject=by(test,'REJECT'), testWait=by(test,'WAIT');
  const pass=Boolean(
    testBuy.n>=8 &&
    testBuy.avg_net4h!==null && baseTest.avg_net4h!==null &&
    testBuy.avg_net4h>baseTest.avg_net4h &&
    testBuy.continuator_rate>baseTest.continuator_rate &&
    testBuy.hit3_rate>=baseTest.hit3_rate
  );
  const report={
    ok:true,
    source:'local-pretrade-memory + public Binance 1m historical follow-through',
    cost:COST,
    records_raw:raw.length,
    records_deduped:rows.length,
    labeled:out.length,
    chronological_split:{train:train.length,test:test.length},
    train:{baseline:baseTrain,BUY:by(train,'BUY'),WAIT:by(train,'WAIT'),REJECT:by(train,'REJECT')},
    test:{baseline:baseTest,BUY:testBuy,WAIT:testWait,REJECT:testReject},
    production_gate:pass?'PROMOTE_BUY_ONLY':'KEEP_SHADOW',
    pass,
    caveat:'Replay uses exact stored local microstructure/continuation/manipulation metrics. v61/v42/exposure are neutral because they were not persisted in local-pretrade memory.'
  };
  const outPath=process.argv[3]||'meta-decision-historical-replay.json';
  fs.writeFileSync(outPath,JSON.stringify(report,null,2));
  console.log(JSON.stringify(report,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});