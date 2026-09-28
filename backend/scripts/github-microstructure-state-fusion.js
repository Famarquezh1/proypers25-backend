'use strict';

const fs=require('fs'),path=require('path');
const ROOT=process.argv[2]||'.lr-fusion';
const OUT=process.argv[3]||'research/results/microstructure_state_fusion.json';
const BIN='https://data-api.binance.vision';
const COST=Number(process.env.FUSION_COST||0.004);
const MIN_TEST=12,MIN_TRAIN=30;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const mean=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:null;
const med=a=>{a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.floor(a.length/2)]:null};
const sd=a=>{if(!a.length)return 1;const m=mean(a);return Math.sqrt(mean(a.map(x=>(x-m)**2)))||1};
const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
async function getJson(url){let last;for(let i=0;i<5;i++){try{const r=await fetch(url,{headers:{'user-agent':'proypers25-microstructure-fusion/1.0'}});if(r.ok)return r.json();last=new Error('HTTP_'+r.status);if(r.status!==429&&r.status<500)throw last}catch(e){last=e}await sleep(250*(i+1))}throw last}
function walk(d,out=[]){if(!fs.existsSync(d))return out;for(const n of fs.readdirSync(d)){const p=path.join(d,n),s=fs.statSync(p);if(s.isDirectory())walk(p,out);else if(n.endsWith('.ndjson'))out.push(p)}return out}
function q(a,p){a=a.filter(Number.isFinite).sort((x,y)=>x-y);return a.length?a[Math.floor((a.length-1)*p)]:null}
function ranks(v){const a=v.map((x,i)=>({x,i})).sort((u,w)=>u.x-w.x),r=new Array(v.length);for(let i=0;i<a.length;){let j=i+1;while(j<a.length&&a[j].x===a[i].x)j++;const z=(i+j+1)/2;for(let k=i;k<j;k++)r[a[k].i]=z;i=j}return r}
function corr(a,b){if(a.length<3)return 0;const ma=mean(a),mb=mean(b);let n=0,da=0,db=0;for(let i=0;i<a.length;i++){const x=a[i]-ma,y=b[i]-mb;n+=x*y;da+=x*x;db+=y*y}return da&&db?n/Math.sqrt(da*db):0}
function auc(rows,score){const p=rows.filter(x=>x.target===1),n=rows.filter(x=>x.target===0);if(!p.length||!n.length)return null;let w=0,t=0;for(const a of p)for(const b of n){t++;const x=score(a),y=score(b);w+=x>y?1:x===y?.5:0}return w/t}
function fit(rows){const d=rows[0].f.length,mu=[],ss=[];for(let j=0;j<d;j++){const a=rows.map(r=>r.f[j]);mu[j]=mean(a);ss[j]=sd(a)}const z=rows.map(r=>r.f.map((v,j)=>(v-mu[j])/ss[j]));let w=Array(d+1).fill(0),sig=x=>1/(1+Math.exp(-clamp(x,-30,30)));for(let it=0;it<500;it++){const g=Array(d+1).fill(0);for(let i=0;i<rows.length;i++){const xx=[1,...z[i]],p=sig(w.reduce((s,v,j)=>s+v*xx[j],0)),e=p-rows[i].target;for(let j=0;j<w.length;j++)g[j]+=e*xx[j]}for(let j=0;j<w.length;j++)w[j]-=.03*(g[j]/rows.length+(j?.18*w[j]:0))}return r=>sig(w.reduce((s,v,j)=>s+v*[1,...r.f.map((x,k)=>(x-mu[k])/ss[k])][j],0))}
function metrics(rows,score,cut){const s=rows.filter(r=>score(r)>=cut),nets=s.map(r=>r.net60).filter(Number.isFinite),mature=s.filter(r=>r.cont240!==null);return{selected:s.length,net60_mean:mean(nets),positive60_rate:mean(nets.map(x=>x>0?1:0)),continuator240_rate:mean(mature.map(x=>x.cont240?1:0)),mature240:mature.length,symbols:new Set(s.map(x=>x.symbol)).size}}
(async()=>{
 const raw=[];
 for(const f of walk(ROOT))for(const line of fs.readFileSync(f,'utf8').split(/\r?\n/)){if(!line.trim())continue;try{const x=JSON.parse(line);if(x.type==='resilience_state_v2'&&x.radar_candidate===true)raw.push(x)}catch{}}
 raw.sort((a,b)=>a.at-b.at);
 const seen=new Set(),ded=[];for(const x of raw){const key=x.symbol+'|'+x.at;if(seen.has(key))continue;seen.add(key);ded.push(x)}
 const hist=new Map(),samples=[];
 for(const x of ded){
   const arr=(hist.get(x.symbol)||[]).filter(y=>x.at-y.at<=15*60000);
   const prev=arr.at(-1),last3=arr.slice(-3),last5=arr.slice(-5);
   const val=v=>Number.isFinite(Number(v))?Number(v):0;
   const transitions=last5.length>1?last5.slice(1).filter((z,i)=>Boolean(z.directional_candidate)!==Boolean(last5[i].directional_candidate)).length/(last5.length-1):0;
   const persistence=last3.length?mean(last3.map(z=>z.directional_candidate?1:0)):0;
   const f=[val(x.ask_R5_median),val(x.bid_R5_median),val(x.S),val(x.ask_failure_rate),val(x.bid_failure_rate),Math.log1p(val(x.episodes_180s)),x.complete_both_sides?1:0,x.directional_candidate?1:0,prev?val(x.S)-val(prev.S):0,prev?val(x.ask_R5_median)-val(prev.ask_R5_median):0,prev?val(x.bid_R5_median)-val(prev.bid_R5_median):0,persistence,transitions];
   arr.push(x);hist.set(x.symbol,arr);
   samples.push({symbol:x.symbol,at:x.at,f,state:x});
 }
 const spaced=[];const last=new Map();for(const x of samples){const p=last.get(x.symbol)||-Infinity;if(x.at-p<10*60000)continue;spaced.push(x);last.set(x.symbol,x.at)}
 const now=Date.now(),labeled=[];
 for(const x of spaced){
   try{
    const end=x.at+245*60000,qry=new URLSearchParams({symbol:x.symbol,interval:'1m',startTime:String(x.at),endTime:String(end),limit:'300'});
    const k=await getJson(BIN+'/api/v3/klines?'+qry);if(!Array.isArray(k)||k.length<61)continue;
    const entry=Number(k[0][1]),ret60=Number(k[60][4])/entry-1-COST;
    let cont=null,mfe=null,mae=null;
    if(now>=x.at+240*60000&&k.length>=241){let u=Infinity,d=Infinity,hi=-Infinity,lo=Infinity;for(let i=1;i<=240;i++){const h=Number(k[i][2])/entry-1,l=Number(k[i][3])/entry-1;hi=Math.max(hi,h);lo=Math.min(lo,l);if(u===Infinity&&h>=.03)u=i;if(d===Infinity&&l<=-.01)d=i}cont=u<d;mfe=hi;mae=lo}
    labeled.push({...x,net60:ret60,cont240:cont,mfe240:mfe,mae240:mae});
   }catch{}
   await sleep(12);
 }
 const mature=labeled.filter(x=>x.cont240!==null);
 const useCont=mature.length>=40;
 for(const x of labeled)x.target=useCont?(x.cont240?1:0):(x.net60>0?1:0);
 labeled.sort((a,b)=>a.at-b.at);
 if(labeled.length<MIN_TRAIN+MIN_TEST){
   const out={ok:true,research_only:true,hypothesis_id:'H-MICROSTRUCTURE-STATE-FUSION-001',status:'INSUFFICIENT_OVERLAP',raw_states:raw.length,deduped_states:spaced.length,labeled:labeled.length,mature_240:mature.length,target:useCont?'continuator_240': 'positive_net_60m',final_signal_holdout:'UNTOUCHED_NOT_ACCESSED',next:'accumulate more prospective depth-state overlap; do not infer edge yet'};
   fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));return;
 }
 const split=Math.max(MIN_TRAIN,Math.floor(labeled.length*.7)),train=labeled.slice(0,split),test=labeled.slice(split);
 const score=fit(train);let best=null;
 for(const z of [.55,.6,.65,.7,.75,.8,.85]){const cut=q(train.map(score),z),m=metrics(train,score,cut);if(m.selected<12)continue;const objective=(m.net60_mean??-9)+.01*(m.positive60_rate??0);if(!best||objective>best.objective)best={z,cut,objective,train:m}}
 if(!best)throw new Error('no viable threshold');
 const base={selected:test.length,net60_mean:mean(test.map(x=>x.net60)),positive60_rate:mean(test.map(x=>x.net60>0?1:0)),continuator240_rate:mean(test.filter(x=>x.cont240!==null).map(x=>x.cont240?1:0)),mature240:test.filter(x=>x.cont240!==null).length,symbols:new Set(test.map(x=>x.symbol)).size};
 const gated=metrics(test,score,best.cut),testAuc=auc(test,score);
 const improvement=(gated.net60_mean??-9)-(base.net60_mean??-9);
 const survives=gated.selected>=6&&gated.symbols>=3&&improvement>0&&gated.net60_mean>0&&gated.positive60_rate>base.positive60_rate;
 const out={ok:true,research_only:true,hypothesis_id:'H-MICROSTRUCTURE-STATE-FUSION-001',status:survives?'SURVIVES_FOR_RED_TEAM':'REJECTED_OR_INCONCLUSIVE',target:useCont?'continuator_240':'positive_net_60m',raw_states:raw.length,deduped_states:spaced.length,labeled:labeled.length,mature_240:mature.length,train_n:train.length,test_n:test.length,threshold_quantile:best.z,test_auc:testAuc,baseline_test:base,gated_test:gated,net60_improvement:improvement,feature_count:train[0].f.length,features:['ask_R5','bid_R5','S','ask_failure_rate','bid_failure_rate','episodes_log','complete_both_sides','directional_state','delta_S','delta_ask_R5','delta_bid_R5','directional_persistence','transition_rate'],final_signal_holdout:'UNTOUCHED_NOT_ACCESSED',guard:'NO ORDERS / NO PRODUCTION WRITES / PUBLIC BINANCE DATA ONLY',next:survives?'red-team concentration, time stability, cost and latency before any holdout':'accumulate more prospective states or abandon this fusion if evidence remains negative'};
 fs.mkdirSync(path.dirname(OUT),{recursive:true});fs.writeFileSync(OUT,JSON.stringify(out,null,2)+'\n');console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e.stack||e.message||String(e));process.exit(1)});
