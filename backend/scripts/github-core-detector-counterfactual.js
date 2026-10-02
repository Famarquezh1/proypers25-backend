'use strict';

const fs = require('fs');
const BASE = 'https://data-api.binance.vision';
const HORIZON_MIN = 240;
const COST_PCT = Number(process.env.CORE_CF_COST_PCT || 0.2);

const input = JSON.parse(fs.readFileSync(process.argv[2] || 'core-counterfactual-input.json', 'utf8'));
const outFile = process.argv[3] || 'core-counterfactual-results.json';

async function getJson(url) {
  let last;
  for (let i=0;i<5;i++) {
    try {
      const r=await fetch(url,{headers:{'user-agent':'proypers25-core-counterfactual/1.0'}});
      if(r.ok) return await r.json();
      if(r.status===429 || r.status>=500){await new Promise(x=>setTimeout(x,300*(i+1)));continue;}
      throw new Error('HTTP_'+r.status);
    } catch(e){last=e;if(i<4)await new Promise(x=>setTimeout(x,300*(i+1)));}
  }
  throw last || new Error('fetch failed');
}

async function evaluate(s) {
  const start=Date.parse(s.created_at);
  if(!s.symbol || !Number.isFinite(start)) return {...s,status:'INVALID_INPUT'};
  if(Date.now() < start + HORIZON_MIN*60000) return {...s,status:'PENDING_4H'};
  const q=new URLSearchParams({symbol:s.symbol,interval:'1m',startTime:String(start),endTime:String(start+(HORIZON_MIN+2)*60000),limit:'300'});
  const k=await getJson(`${BASE}/api/v3/klines?${q}`);
  if(!Array.isArray(k)||k.length<241) return {...s,status:'INSUFFICIENT_1M',bars:Array.isArray(k)?k.length:0};
  const entry=Number(s.signal_price) || Number(k[0][1]);
  let first3=null,firstNeg1=null,first5=null,first10=null,mfe=-Infinity,mae=Infinity;
  for(let i=0;i<=HORIZON_MIN;i++){
    const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03)first3=i;
    if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
    if(first5===null&&hi>=.05)first5=i;
    if(first10===null&&hi>=.10)first10=i;
  }
  const close1h=Number(k[60][4]), close4h=Number(k[240][4]);
  const cont=first3!==null&&(firstNeg1===null||first3<firstNeg1);
  return {...s,status:'MATURE',entry_price:entry,target_continuator:cont,first_plus3_min:first3,first_minus1_min:firstNeg1,first_plus5_min:first5,first_plus10_min:first10,
    hit_plus3:mfe>=.03,hit_plus5:mfe>=.05,hit_plus10:mfe>=.10,mfe_pct:mfe*100,mae_pct:mae*100,
    return_1h_pct:(close1h/entry-1)*100,return_4h_pct:(close4h/entry-1)*100,return_4h_net_pct:(close4h/entry-1)*100-COST_PCT};
}

(async()=>{
 const rows=[];
 for(const s of input.signals||[]){try{rows.push(await evaluate(s));}catch(e){rows.push({...s,status:'ERROR',error:e.message});}}
 const mature=rows.filter(x=>x.status==='MATURE');
 const avg=k=>mature.length?mature.reduce((a,x)=>a+Number(x[k]||0),0)/mature.length:null;
 const result={ok:true,research_only:true,no_order_created:true,target:'+3% before -1% within 240m',cost_pct:COST_PCT,
   summary:{total:rows.length,mature:mature.length,pending:rows.filter(x=>x.status==='PENDING_4H').length,continuators:mature.filter(x=>x.target_continuator).length,
     continuator_rate:mature.length?mature.filter(x=>x.target_continuator).length/mature.length:null,hit5_rate:mature.length?mature.filter(x=>x.hit_plus5).length/mature.length:null,
     hit10_rate:mature.length?mature.filter(x=>x.hit_plus10).length/mature.length:null,avg_mfe_pct:avg('mfe_pct'),avg_mae_pct:avg('mae_pct'),avg_return_1h_pct:avg('return_1h_pct'),
     avg_return_4h_pct:avg('return_4h_pct'),avg_return_4h_net_pct:avg('return_4h_net_pct')},rows};
 fs.writeFileSync(outFile,JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1);});
