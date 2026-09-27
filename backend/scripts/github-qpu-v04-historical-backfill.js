'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const HIST = path.join(__dirname, 'train-spot-momentum-continuation-historical.js');
const OUT = process.argv[2] || 'qpu-v04-historical-backfill.jsonl';
const META = process.argv[3] || 'qpu-v04-historical-backfill.meta.json';
const MAX_ROWS = Math.max(100, Math.min(1200, Number(process.env.QPU_BACKFILL_MAX || 700)));
const H = 240;
const BIN='https://data-api.binance.vision';

const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function loadHistoricalLib(){
  let src=fs.readFileSync(HIST,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'');
  src += ';globalThis.__qpuHist={loadR7,buildRaw,productionEligible,productionV42};';
  const c=vm.createContext({require,console,process,fetch,URL,URLSearchParams,AbortController,Buffer,setTimeout,clearTimeout,__dirname,__filename:HIST});
  vm.runInContext(src,c,{filename:HIST});
  return c.__qpuHist;
}

async function getJson(url){
  let last;
  for(let i=0;i<5;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'proypers25-qpu-v04-backfill/1.0'}});
      if(r.ok)return await r.json();
      if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}
      throw new Error('HTTP_'+r.status);
    }catch(e){last=e;if(i<4)await sleep(300*(i+1))}
  }
  throw last||new Error('fetch failed');
}

function dedupe(rows){
  const out=[],last=new Map();
  for(const s of [...rows].sort((a,b)=>a.t-b.t||a.symbol.localeCompare(b.symbol))){
    const prev=last.get(s.symbol)||-Infinity;
    if(s.t-prev<30*60*1000)continue;
    out.push(s);last.set(s.symbol,s.t);
  }
  return out;
}

async function label(s){
  const start=s.t+5*60*1000; // historical feature state is 5m close; enter next 5m open.
  const q=new URLSearchParams({symbol:s.symbol,interval:'1m',startTime:String(start),endTime:String(start+(H+5)*60000),limit:'500'});
  const k=await getJson(`${BIN}/api/v3/klines?${q}`);
  if(!Array.isArray(k)||k.length<241)return null;
  const entry=Number(k[0][1]);
  let first3=null,firstNeg1=null,first5=null,first10=null,mfe=-Infinity,mae=Infinity;
  for(let i=1;i<=Math.min(H,k.length-1);i++){
    const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03)first3=i;
    if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
    if(first5===null&&hi>=.05)first5=i;
    if(first10===null&&hi>=.10)first10=i;
  }
  const f=s.f||{},p=s.productionV42||{},d=p.detail||{},bd=s.breadth||{},rw=s.regimeWeights||{};
  return {
    timestamp:new Date(s.t).toISOString(),
    entry_timestamp:new Date(start).toISOString(),
    symbol:s.symbol,
    entry_price:entry,
    r5:Number(f.r5||0),r15:Number(f.r15||0),r30:Number(f.r30||0),r60:Number(f.r60||0),r240:Number(f.r240||0),r24:Number(f.r24||0),
    vol15:Number(f.vol15||0),vol30:Number(f.vol30||0),trade_accel:Number(f.tradeAccel||0),
    breakout60:Number(f.breakout60||0),breakout240:Number(f.breakout240||0),
    rs60:Number(f.rs60||0),rs240:Number(f.rs240||0),qv:Number(f.qv||0),
    ignition:Number(d.ignition||0),confirm:Number(d.confirm||0),extension:Number(d.extension||0),
    fresh_enough:p.freshEnough===true,v42_pass:Number(p.pass||0),v42_norm:Number(p.norm||0),
    breadth_up15:Number(bd.up15||0),breadth_up60:Number(bd.up60||0),breadth_breakout:Number(bd.breakout||0),breadth_ignite:Number(bd.ignite||0),breadth_mean60:Number(bd.mean60||0),
    regime_trend_up:Number(rw.TREND_UP||0),regime_volatile:Number(rw.VOLATILE||0),regime_risk_off:Number(rw.RISK_OFF||0),
    target_continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1),
    first_plus3_min:first3,first_minus1_min:firstNeg1,first_plus5_min:first5,first_plus10_min:first10,
    hit_plus3:mfe>=.03,hit_plus5:mfe>=.05,hit_plus10:mfe>=.10,
    mfe_pct:mfe*100,mae_pct:mae*100,return_4h_pct:(Number(k[Math.min(H,k.length-1)][4])/entry-1)*100
  };
}

(async()=>{
  const h=loadHistoricalLib();
  const lib=h.loadR7();
  const built=await h.buildRaw(lib);
  const eligible=built.raw.filter(h.productionEligible);
  const unique=dedupe(eligible).slice(0,MAX_ROWS);
  const rows=[],skipped=[];
  for(const s of unique){
    try{const x=await label(s);if(x)rows.push(x);else skipped.push({symbol:s.symbol,t:s.t,reason:'INSUFFICIENT_1M'});}
    catch(e){skipped.push({symbol:s.symbol,t:s.t,reason:e.message});}
    await sleep(20);
  }
  rows.sort((a,b)=>Date.parse(a.timestamp)-Date.parse(b.timestamp));
  fs.writeFileSync(OUT,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''),'utf8');
  const meta={
    ok:true,research_only:true,no_order_created:true,
    historical_period:['2026-04-01','2026-06-01'],
    raw_feature_rows:built.raw.length,
    production_eligible:eligible.length,
    deduped_selected:unique.length,
    rows:rows.length,
    skipped:skipped.length,
    continuators:rows.filter(x=>x.target_continuator).length,
    non_continuators:rows.filter(x=>!x.target_continuator).length,
    prevalence:rows.length?rows.filter(x=>x.target_continuator).length/rows.length:0,
    target_definition:'+3% before -1% within 240m',
    exact_label_source:'Binance public Spot 1m',
    complete_prebuy_state:true,
    output:OUT,
    bytes:fs.statSync(OUT).size,
    skipped_examples:skipped.slice(0,10)
  };
  fs.writeFileSync(META,JSON.stringify(meta,null,2)+'\n','utf8');
  console.log(JSON.stringify(meta,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
