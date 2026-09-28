'use strict';

const fs=require('fs'),vm=require('vm'),path=require('path');
const V10=path.join(__dirname,'github-spot-microflow-trainer-v10.js');
let src=fs.readFileSync(V10,'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/,'\n');
src+=';globalThis.__qpuv10={v,klines,flowFeatures,future,simulate,crossSection,train,choose,topEvents,select,NAMES};';
const ctx=vm.createContext({require,console,process,fetch,URLSearchParams,AbortController,setTimeout,clearTimeout,Date,Math,Map,Set,Array,Number,String,JSON,__dirname:path.dirname(V10),__filename:V10});
vm.runInContext(src,ctx,{filename:V10});const m=ctx.__qpuv10;

const DAYS=Math.max(14,Math.min(45,Number(process.env.QPU_V10_DAYS||30)));
const OUT=process.argv[2]||'qpu-v10-reconstructed.jsonl';
const META=process.argv[3]||'qpu-v10-reconstructed.meta.json';
const BASE='https://data-api.binance.vision';
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

async function getJson(url){
 let last;
 for(let i=0;i<5;i++){try{const r=await fetch(url,{headers:{'user-agent':'proypers25-qpu-v10-reconstruct/1.0'}});if(r.ok)return await r.json();if(r.status===429||r.status>=500){await sleep(300*(i+1));continue}throw new Error('HTTP_'+r.status)}catch(e){last=e;if(i<4)await sleep(300*(i+1))}}
 throw last||new Error('fetch failed');
}
async function exactLabel(r){
 const start=r.t+m.v.STEP_MS; // V10 entry is next 5m bar open
 const q=new URLSearchParams({symbol:r.symbol,interval:'1m',startTime:String(start),endTime:String(start+245*60000),limit:'300'});
 const k=await getJson(`${BASE}/api/v3/klines?${q}`);
 if(!Array.isArray(k)||k.length<241)return null;
 const entry=Number(k[0][1]);let first3=null,firstNeg1=null,mfe=-Infinity,mae=Infinity;
 for(let i=1;i<=240;i++){const hi=Number(k[i][2])/entry-1,lo=Number(k[i][3])/entry-1;mfe=Math.max(mfe,hi);mae=Math.min(mae,lo);if(first3===null&&hi>=.03)first3=i;if(firstNeg1===null&&lo<=-.01)firstNeg1=i;}
 return {entry_timestamp:new Date(start).toISOString(),entry_price:entry,target_continuator:first3!==null&&(firstNeg1===null||first3<firstNeg1),
  first_plus3_min:first3,first_minus1_min:firstNeg1,hit_plus3:mfe>=.03,hit_plus5:mfe>=.05,hit_plus10:mfe>=.10,mfe_pct:mfe*100,mae_pct:mae*100,
  return_4h_pct:(Number(k[240][4])/entry-1)*100};
}

(async()=>{
 const now=Date.now(),evalEnd=m.v.utcDay(now),evalStart=evalEnd-DAYS*m.v.DAY_MS;
 const dataStart=evalStart-(8*m.v.DAY_MS)-m.v.WARM*m.v.STEP_MS;
 const dataEnd=evalEnd+37*m.v.STEP_MS;
 const symbols=(await m.v.universe()).slice(0,40);
 const loaded=await m.v.mapLimit(symbols,8,async symbol=>({symbol,rows:await m.klines(symbol,dataStart,dataEnd)}));
 const data=new Map();for(const x of loaded)if(x&&!x.__error&&x.rows?.length)data.set(x.symbol,x.rows);
 const btc=data.get('BTCUSDT');if(!btc?.length)throw new Error('BTC unavailable');const bm=m.v.btcMap(btc),raw=[];
 for(const [symbol,rows] of data){
  if(symbol==='BTCUSDT'||rows.length<m.v.WARM+40)continue;
  for(let i=m.v.WARM;i<rows.length-38;i+=3){
   const f=m.v.feature(rows,i,bm);if(!m.v.candidate(f))continue;
   const fu=m.future(rows,i),exec=m.simulate(rows,i);if(!fu||!exec)continue;
   raw.push({symbol,t:rows[i].t,z:[...m.v.vector(f),...m.flowFeatures(rows,i)],future:fu,exec});
  }
 }
 const all=m.crossSection(raw),selected=[];
 for(let d=evalStart;d<evalEnd;d+=m.v.DAY_MS){
  const fitStart=d-7*m.v.DAY_MS,fitEnd=d-2*m.v.DAY_MS-3*60*60*1000,calStart=d-2*m.v.DAY_MS,calEnd=d-3*60*60*1000;
  const fit=all.filter(r=>r.t>=fitStart&&r.t<fitEnd),cal=all.filter(r=>r.t>=calStart&&r.t<calEnd),test=all.filter(r=>r.t>=d&&r.t<d+m.v.DAY_MS);
  if(fit.length<800||cal.length<300||test.length<100)continue;
  const model=m.train(fit),policy=m.choose(cal,model);if(!policy)continue;
  const chosen=m.select(m.topEvents(test,model),policy.scoreCut,policy.marginCut);
  for(const r of chosen)selected.push({...r,day:new Date(d).toISOString().slice(0,10),score:model.predict(r.cz),policy_score_cut:policy.scoreCut,policy_margin_cut:Number.isFinite(policy.marginCut)?policy.marginCut:null});
 }
 selected.sort((a,b)=>a.t-b.t);
 const rows=[],skipped=[];
 for(const r of selected){
  try{const lab=await exactLabel(r);if(!lab){skipped.push({symbol:r.symbol,t:r.t,reason:'INSUFFICIENT_1M'});continue}
   const feat={};for(let i=0;i<m.NAMES.length;i++){feat[m.NAMES[i]]=r.z[i];feat['cs_'+m.NAMES[i]]=r.cz[i];}
   rows.push({timestamp:new Date(r.t).toISOString(),symbol:r.symbol,day:r.day,score:r.score,policy_score_cut:r.policy_score_cut,policy_margin_cut:r.policy_margin_cut,...feat,...lab});
  }catch(e){skipped.push({symbol:r.symbol,t:r.t,reason:e.message});}
  await sleep(15);
 }
 fs.writeFileSync(OUT,rows.map(x=>JSON.stringify(x)).join('\n')+(rows.length?'\n':''));
 const meta={ok:true,research_only:true,no_order_created:true,days:DAYS,universe_loaded:data.size,raw_rows:raw.length,cross_section_rows:all.length,selected: selected.length,rows:rows.length,skipped:skipped.length,
  continuators:rows.filter(x=>x.target_continuator).length,non_continuators:rows.filter(x=>!x.target_continuator).length,prevalence:rows.length?rows.filter(x=>x.target_continuator).length/rows.length:0,
  first:rows[0]?.timestamp||null,last:rows.at(-1)?.timestamp||null,feature_names:m.NAMES,target:'+3% before -1% within 240m',label_source:'Binance public Spot 1m',bytes:fs.statSync(OUT).size};
 fs.writeFileSync(META,JSON.stringify(meta,null,2)+'\n');console.log(JSON.stringify(meta,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
