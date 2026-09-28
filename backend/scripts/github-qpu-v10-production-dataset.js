'use strict';

const fs=require('fs');
const OUT=process.argv[2]||'qpu-v10-production-dataset.jsonl';
const META=process.argv[3]||'qpu-v10-production-dataset.meta.json';
const OWNER='Famarquezh1',REPO='proypers25-backend';
const BIN='https://data-api.binance.vision';
const token=process.env.GITHUB_TOKEN||'';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url,headers={}){
  let last;
  for(let i=0;i<5;i++){
    try{
      const r=await fetch(url,{headers:{'user-agent':'proypers25-qpu-v10-production/1.0',...headers}});
      if(r.ok)return await r.json();
      if(r.status===429||r.status>=500){await sleep(250*(i+1));continue}
      throw new Error('HTTP_'+r.status+' '+url);
    }catch(e){last=e;if(i<4)await sleep(250*(i+1))}
  }
  throw last||new Error('fetch failed');
}
function num(body,label){
  const m=body.match(new RegExp(label+'\\s*:?\\s*([^\\s|]+)','i'));
  if(!m)return null; const x=Number(String(m[1]).replace('%','')); return Number.isFinite(x)?x:null;
}
function parseIssue(x){
  const b=x.body||'';
  if(!b.includes('Lane: V10_HUNTER'))return null;
  const sm=b.match(/Símbolo:\s*([A-Z0-9]+USDT)/i);
  const sym=(sm?sm[1]:(x.title.match(/\[SPOT SIGNAL\]\s+([A-Z0-9]+USDT)/i)||[])[1]||'').toUpperCase();
  if(!sym)return null;
  const val=(re)=>{const m=b.match(re);if(!m)return null;const n=Number(m[1]);return Number.isFinite(n)?n:null};
  return {
    issue_number:x.number,symbol:sym,signal_at:x.created_at,
    pct:val(/Cambio 24h:\s*\+?([-+0-9.eE]+)/i),
    price:val(/Precio:\s*([-+0-9.eE]+)/i),
    quote_volume:val(/Volumen quote 24h:\s*([-+0-9.eE]+)/i),
    microflow_score:val(/Microflow score:\s*([-+0-9.eE]+)/i),
    score_cut:val(/Microflow score:[^\n]*cut:\s*([-+0-9.eE]+)/i),
    microflow_margin:val(/Microflow margin:\s*([-+0-9.eE]+)/i),
    margin_cut:val(/Microflow margin:[^\n]*cut:\s*([-+0-9.eE]+)/i),
    cal_avg_net:val(/Calibración avg net:\s*([-+0-9.eE]+)/i),
    cal_growth:val(/growth:\s*([-+0-9.eE]+)/i),
    cal_win_rate:val(/Calibración win rate:\s*([-+0-9.eE]+)/i),
    cal_stop_rate:val(/stop rate:\s*([-+0-9.eE]+)/i),
    trained_samples:val(/Samples entrenamiento:\s*([-+0-9.eE]+)/i),
    calibration_samples:val(/calibración:\s*([-+0-9.eE]+)/i)
  };
}
async function label(r){
  const t=Date.parse(r.signal_at);
  const start=Math.ceil(t/60000)*60000;
  const q=new URLSearchParams({symbol:r.symbol,interval:'1m',startTime:String(start),endTime:String(start+245*60000),limit:'300'});
  const k=await getJson(`${BIN}/api/v3/klines?${q}`);
  if(!Array.isArray(k)||k.length<241)return null;
  const entry=Number(k[0][1]);
  let first3=null,firstNeg1=null,mfe=-Infinity,mae=Infinity;
  for(let i=1;i<=240;i++){
    const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;
    mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);
    if(first3===null&&hi>=.03)first3=i;
    if(firstNeg1===null&&lo<=-.01)firstNeg1=i;
  }
  return {...r,entry_timestamp:new Date(start).toISOString(),entry_price:entry,
    target_continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1),
    first_plus3_min:first3,first_minus1_min:firstNeg1,
    hit_plus3:mfe>=.03,hit_plus5:mfe>=.05,hit_plus10:mfe>=.10,
    mfe_pct:mfe*100,mae_pct:mae*100,
    return_4h_pct:(Number(k[240][4])/entry-1)*100};
}
(async()=>{
  const issues=[],headers=token?{authorization:'Bearer '+token}:{};
  for(let page=1;page<=5;page++){
    const arr=await getJson(`https://api.github.com/repos/${OWNER}/${REPO}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`,headers);
    if(!Array.isArray(arr)||!arr.length)break;
    for(const x of arr){if(!x.pull_request)issues.push(x)}
    if(arr.length<100)break;
  }
  const parsed=issues.map(parseIssue).filter(Boolean).sort((a,b)=>Date.parse(a.signal_at)-Date.parse(b.signal_at));
  const rows=[],skipped=[];
  for(const r of parsed){
    try{const x=await label(r);if(x)rows.push(x);else skipped.push({issue:r.issue_number,symbol:r.symbol,reason:'INSUFFICIENT_1M'});}
    catch(e){skipped.push({issue:r.issue_number,symbol:r.symbol,reason:e.message});}
    await sleep(25);
  }
  fs.writeFileSync(OUT,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''));
  const meta={ok:true,research_only:true,no_order_created:true,issues_scanned:issues.length,v10_issues:parsed.length,rows:rows.length,
    skipped:skipped.length,continuators:rows.filter(x=>x.target_continuator).length,non_continuators:rows.filter(x=>!x.target_continuator).length,
    prevalence:rows.length?rows.filter(x=>x.target_continuator).length/rows.length:0,
    first_signal:rows[0]?.signal_at||null,last_signal:rows.at(-1)?.signal_at||null,
    target:'+3% before -1% within 240m',source:'GitHub production V10 issues + Binance public Spot 1m',bytes:fs.statSync(OUT).size,
    skipped_examples:skipped.slice(0,10)};
  fs.writeFileSync(META,JSON.stringify(meta,null,2)+'\n');
  console.log(JSON.stringify(meta,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
