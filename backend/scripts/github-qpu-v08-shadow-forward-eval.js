'use strict';
const fs=require('fs'),path=require('path');
const ROOT=process.argv[2]||'.qpu-v08-shadow-decisions';
const OUT=process.argv[3]||'qpu-v08-shadow-forward-eval.json';
const BASE='https://data-api.binance.vision';
const COSTS=[0.002,0.0025,0.004];

async function getJson(url){
  const ctrl=new AbortController(),tm=setTimeout(()=>ctrl.abort(),15000);
  try{
    const r=await fetch(url,{signal:ctrl.signal,headers:{'user-agent':'proypers25-qpu-v08-forward/1.0'}});
    if(!r.ok)throw new Error('HTTP_'+r.status);
    return await r.json();
  }finally{clearTimeout(tm)}
}
function files(dir){
  const out=[];
  if(!fs.existsSync(dir))return out;
  for(const e of fs.readdirSync(dir,{withFileTypes:true})){
    const p=path.join(dir,e.name);
    if(e.isDirectory())out.push(...files(p));
    else if(e.name==='qpu-v08-shadow-decision.json')out.push(p);
  }
  return out;
}
function n(v){const x=Number(v);return Number.isFinite(x)?x:null}
async function label(d){
  const t=Date.parse(d.target||'');
  if(!Number.isFinite(t)||Date.now()-t<245*60000)return null;
  const start=t+5*60000;
  const q=new URLSearchParams({symbol:d.symbol,interval:'1m',startTime:String(start),endTime:String(start+245*60000),limit:'300'});
  const k=await getJson(`${BASE}/api/v3/klines?${q}`);
  if(!Array.isArray(k)||k.length<241)return null;
  const entry=Number(k[0][1]);let first3=null,first1=null,mfe=-Infinity,mae=Infinity;
  for(let i=1;i<=240;i++){
    const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03)first3=i;
    if(first1===null&&lo<=-.01)first1=i;
  }
  const cont=first3!==null&&(first1===null||first3<first1);
  let gross;
  if(first1!==null&&(first3===null||first1<=first3))gross=-.01;
  else if(first3!==null)gross=.03;
  else gross=Number(k[240][4])/entry-1;
  return {entry_price:entry,target_continuator:cont,first_plus3_min:first3,first_minus1_min:first1,
    mfe_pct:mfe*100,mae_pct:mae*100,return_4h_pct:(Number(k[240][4])/entry-1)*100,
    objective_gross_pct:gross*100};
}
function summary(rows,key){
  const sel=rows.filter(r=>r[key]);
  const pos=sel.filter(r=>r.target_continuator).length;
  const mean=(a)=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
  const gross=mean(sel.map(r=>r.objective_gross_pct));
  const out={selected:sel.length,continuators:pos,false_positives:sel.length-pos,
    precision:sel.length?pos/sel.length:null,
    mean_return_4h_pct:mean(sel.map(r=>r.return_4h_pct)),
    mean_mfe_pct:mean(sel.map(r=>r.mfe_pct)),
    objective_gross_pct:gross};
  out.after_cost_pct={};
  for(const c of COSTS)out.after_cost_pct[(c*100).toFixed(2)]=gross===null?null:gross-c*100;
  return out;
}
(async()=>{
  const seen=new Map();
  for(const f of files(ROOT)){
    try{
      const d=JSON.parse(fs.readFileSync(f,'utf8'));
      if(!d.scored||!d.symbol||!d.target)continue;
      const key=`${d.symbol}|${d.target}`;
      seen.set(key,d);
    }catch{}
  }
  const rows=[];
  for(const d of [...seen.values()].sort((a,b)=>Date.parse(a.target)-Date.parse(b.target))){
    try{
      const lab=await label(d);if(!lab)continue;
      rows.push({...d,...lab,
        classical_select:!!d.classical_positive,
        consensus_select:!!d.consensus_accept});
    }catch(e){rows.push({...d,evaluation_error:e.message});}
  }
  const valid=rows.filter(r=>r.target_continuator!==undefined);
  const positives=valid.filter(r=>r.target_continuator).length;
  const output={generated_at:new Date().toISOString(),research_only:true,shadow_only:true,no_order_created:true,
    model_version:'QPU_V0_8_CONSENSUS_FROZEN_2026_09_28',
    mature_rows:valid.length,continuators:positives,prevalence:valid.length?positives/valid.length:null,
    classical:summary(valid,'classical_select'),
    consensus:summary(valid,'consensus_select'),
    rows:valid};
  fs.writeFileSync(OUT,JSON.stringify(output,null,2)+'\n');
  console.log(JSON.stringify({...output,rows:undefined},null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
