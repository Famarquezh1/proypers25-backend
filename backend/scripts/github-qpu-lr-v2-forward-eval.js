'use strict';

const fs=require('fs');
const path=require('path');
const ROOT=process.argv[2]||'.qpu-lr-eval';
const OUT=process.argv[3]||'qpu-lr-v2-forward-eval.json';
const BIN='https://data-api.binance.vision';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url){
  let last;
  for(let i=0;i<5;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'proypers25-qpu-lr-eval/1.0'}});
      if(r.ok)return await r.json();
      if(r.status===429||r.status>=500){await sleep(250*(i+1));continue}
      throw new Error('HTTP_'+r.status);
    }catch(e){last=e;if(i<4)await sleep(250*(i+1))}
  }
  throw last||new Error('fetch failed');
}
function mean(xs){return xs.length?xs.reduce((a,b)=>a+b,0)/xs.length:null}
function med(xs){if(!xs.length)return null;const a=[...xs].sort((x,y)=>x-y);return a[Math.floor(a.length/2)]}
function summarize(rows){
  const mature=(h)=>rows.filter(x=>Number.isFinite(x['ret_'+h+'m_pct']));
  return {
    n:rows.length,
    ask:rows.filter(x=>x.side==='ASK').length,
    bid:rows.filter(x=>x.side==='BID').length,
    persistent_failure:rows.filter(x=>x.persistent_failure).length,
    r5_median:med(rows.map(x=>x.R_5s)),
    mature_5m:mature(5).length,mature_15m:mature(15).length,mature_30m:mature(30).length,mature_60m:mature(60).length,
    mature_240m:rows.filter(x=>x.target_continuator_240!==null&&x.target_continuator_240!==undefined).length,
    ret_5m_mean:mean(mature(5).map(x=>x.ret_5m_pct)),
    ret_15m_mean:mean(mature(15).map(x=>x.ret_15m_pct)),
    ret_30m_mean:mean(mature(30).map(x=>x.ret_30m_pct)),
    ret_60m_mean:mean(mature(60).map(x=>x.ret_60m_pct)),
    continuator_240_rate:mean(rows.filter(x=>x.target_continuator_240!==null&&x.target_continuator_240!==undefined).map(x=>x.target_continuator_240?1:0)),
    hit5_240_rate:mean(rows.filter(x=>x.hit5_240!==null&&x.hit5_240!==undefined).map(x=>x.hit5_240?1:0)),
    ret_240m_mean:mean(rows.map(x=>x.ret_240m_pct).filter(Number.isFinite)),
    up_5m_rate:mean(rows.map(x=>x.ret_5m_pct>0?1:0).filter((_,i)=>Number.isFinite(rows[i].ret_5m_pct))),
    up_15m_rate:mean(rows.map(x=>x.ret_15m_pct>0?1:0).filter((_,i)=>Number.isFinite(rows[i].ret_15m_pct))),
    up_30m_rate:mean(rows.map(x=>x.ret_30m_pct>0?1:0).filter((_,i)=>Number.isFinite(rows[i].ret_30m_pct)))
  };
}

(async()=>{
  const files=[];
  function walk(d){
    for(const name of fs.readdirSync(d)){
      const p=path.join(d,name),st=fs.statSync(p);
      if(st.isDirectory())walk(p);
      else if(name.endsWith('.ndjson'))files.push(p);
    }
  }
  walk(ROOT);
  const curves=[];
  for(const f of files){
    for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){
      if(!line.trim())continue;
      const x=JSON.parse(line);
      if(x.type==='resilience_curve'&&x.valid===true)curves.push(x);
    }
  }
  const seen=new Set(),unique=[];
  for(const x of curves.sort((a,b)=>a.available_at-b.available_at)){
    const key=[x.symbol,x.side,x.started_at].join('|');
    if(seen.has(key))continue;seen.add(key);unique.push(x);
  }
  const now=Date.now(),labeled=[];
  for(const x of unique){
    const start=x.available_at;
    const q=new URLSearchParams({symbol:x.symbol,interval:'1m',startTime:String(start),endTime:String(start+245*60000),limit:'300'});
    try{
      const k=await getJson(`${BIN}/api/v3/klines?${q}`);
      if(!Array.isArray(k)||!k.length)continue;
      const entry=Number(k[0][1]);
      const ret=h=>{
        if(now<start+h*60000)return null;
        const row=k[Math.min(h,k.length-1)];
        return row?(Number(row[4])/entry-1)*100:null;
      };
      let target240=null,hit3_240=null,hit5_240=null,hit10_240=null,mfe_240_pct=null,mae_240_pct=null,ret_240m_pct=null;
      if(now>=start+240*60000 && k.length>=241){
        let first3=null,firstNeg1=null,mfe=-Infinity,mae=Infinity;
        for(let i=1;i<=Math.min(240,k.length-1);i++){
          const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
          mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
          if(first3===null&&hi>=.03)first3=i;
          if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
        }
        target240=first3!==null&&(firstNeg1===null||first3<firstNeg1);
        hit3_240=mfe>=.03;hit5_240=mfe>=.05;hit10_240=mfe>=.10;
        mfe_240_pct=mfe*100;mae_240_pct=mae*100;
        ret_240m_pct=(Number(k[Math.min(240,k.length-1)][4])/entry-1)*100;
      }
      labeled.push({...x,ret_5m_pct:ret(5),ret_15m_pct:ret(15),ret_30m_pct:ret(30),ret_60m_pct:ret(60),
        target_continuator_240:target240,hit3_240,hit5_240,hit10_240,mfe_240_pct,mae_240_pct,ret_240m_pct});
    }catch{}
    await sleep(20);
  }
  const deduped=[];const last=new Map();
  for(const x of labeled.sort((a,b)=>a.available_at-b.available_at)){
    const key=x.symbol+'|'+x.side,prev=last.get(key)||-Infinity;
    if(x.available_at-prev<30*60*1000)continue;
    deduped.push(x);last.set(key,x.available_at);
  }
  const ask=deduped.filter(x=>x.side==='ASK');
  const askFail=ask.filter(x=>x.persistent_failure);
  const askRecover=ask.filter(x=>!x.persistent_failure);
  const output={
    generated_at:new Date().toISOString(),research_only:true,no_order_created:true,
    valid_curves_raw:labeled.length,
    valid_curves_deduped:deduped.length,
    overall:summarize(deduped),
    radar_candidates:summarize(deduped.filter(x=>x.radar_candidate===true)),
    ask_all:summarize(ask),
    ask_persistent_failure:summarize(askFail),
    ask_nonfailure:summarize(askRecover),
    rows:labeled
  };
  fs.writeFileSync(OUT,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({...output,rows:undefined},null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
