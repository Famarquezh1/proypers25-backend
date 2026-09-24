'use strict';
// V24 prospective shadow. Public Binance data only; no authenticated API, orders, Firestore or production influence.
const fs=require('fs');
const BASE='https://data-api.binance.vision';
const STATE_IN=process.argv[2]||'', STATE_OUT=process.argv[3]||'spot-v24-shadow-state.json', EVIDENCE_OUT=process.argv[4]||'spot-v24-shadow-evidence.json';
const SYMBOLS=String(process.env.V24_SYMBOLS||'QNTUSDT,CRVUSDT,SAHARAUSDT,FILUSDT,IOTXUSDT,TUTUSDT,BTTCUSDT,BABYUSDT,NEARUSDT,SUSDT,ONGUSDT,LISTAUSDT,FETUSDT,METUSDT,TSTUSDT,PENGUUSDT,HBARUSDT,MINAUSDT,LTCUSDT,RAYUSDT,UNIUSDT').split(',').map(x=>x.trim()).filter(Boolean);
const RULES=[
 {f:'compression',op:'gte',t:.03333333333333337},
 {f:'r180',op:'gte',t:.020214782059380987},
 {f:'relative60',op:'gte',t:.010507510831508027},
 {f:'r30',op:'gte',t:.008447135013374574},
 {f:'r60',op:'gte',t:.01200000000000001}
];
const MIN_VOTES=3,HORIZON_MS=8*60*60*1000,EXPLOSION=.10;
const n=(v,f=0)=>Number.isFinite(Number(v))?Number(v):f, avg=a=>a.length?a.reduce((s,x)=>s+x,0)/a.length:0, pct=(a,b)=>a>0?b/a-1:0, iso=v=>new Date(v).toISOString();
async function get(url){const c=new AbortController(),t=setTimeout(()=>c.abort(),12000);try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-v24-shadow/1.0'}});if(!r.ok)throw Error('HTTP_'+r.status);return r.json()}finally{clearTimeout(t)}}
async function bars(s,limit=290){const r=await get(BASE+'/api/v3/klines?symbol='+encodeURIComponent(s)+'&interval=5m&limit='+limit);return r.map(x=>({t:+x[0],h:+x[2],l:+x[3],c:+x[4],q:+x[7],n:+x[8],ct:+x[6]}))}
function feat(b,btc){const i=b.length-2,j=btc.length-2;if(i<288||j<288)return null;const c=b[i].c,r30=pct(b[i-6].c,c),r60=pct(b[i-12].c,c),r180=pct(b[i-36].c,c),r24=pct(b[i-288].c,c),qbase=avg(b.slice(i-72,i-12).map(x=>x.q))*12,hi=Math.max(...b.slice(i-12,i).map(x=>x.h)),lo=Math.min(...b.slice(i-12,i).map(x=>x.l)),btc60=pct(btc[j-12].c,btc[j].c);return {bar_time:b[i].t,price:c,r30,r60,r180,r24,compression:(hi-lo)/Math.max(c,1e-12),relative60:r60-btc60}}
function votes(f){const matched=RULES.filter(r=>r.op==='gte'?f[r.f]>=r.t:f[r.f]<=r.t);return {count:matched.length,matched:matched.map(x=>x.f)}}
function load(){try{return JSON.parse(fs.readFileSync(STATE_IN,'utf8'))}catch{return {version:'V24_PROSPECTIVE_SHADOW_1',signals:[],outcomes:[]}}}
async function main(){const now=Date.now(),state=load(),e={generated_at:iso(now),shadow_only:true,no_order_created:true,production_action:'NONE',new_signals:[],new_outcomes:[],errors:[]};state.signals=state.signals||[];state.outcomes=state.outcomes||[];
 for(const s of state.signals.filter(x=>!x.resolved_at&&now-x.signal_time>=HORIZON_MS)){try{const b=await bars(s.symbol);const after=b.filter(x=>x.t>s.signal_time&&x.t<=s.signal_time+HORIZON_MS);if(!after.length)continue;const max=Math.max(...after.map(x=>x.h))/s.signal_price-1,min=Math.min(...after.map(x=>x.l))/s.signal_price-1,o={id:'outcome_'+s.id,symbol:s.symbol,signal_at:s.signal_at,resolved_at:iso(now),max_return_8h:max,min_return_8h:min,exploded:max>=EXPLOSION,shadow_only:true,no_order_created:true};s.resolved_at=o.resolved_at;state.outcomes.push(o);e.new_outcomes.push(o)}catch(err){e.errors.push({stage:'RESOLVE',symbol:s.symbol,error:err.message})}}
 const btc=await bars('BTCUSDT');for(const symbol of SYMBOLS){try{const b=symbol==='BTCUSDT'?btc:await bars(symbol),f=feat(b,btc);if(!f||f.r24>=.18)continue;const v=votes(f);if(v.count<MIN_VOTES)continue;const bucket=Math.floor(f.bar_time/(30*60*1000)),id='v24_'+symbol+'_'+bucket;if(state.signals.some(x=>x.id===id))continue;const sig={id,symbol,signal_time:f.bar_time,signal_at:iso(f.bar_time),signal_price:f.price,votes:v.count,matched:v.matched,features:f,status:'V24_PRECURSOR',shadow_only:true,no_order_created:true};state.signals.push(sig);e.new_signals.push(sig)}catch(err){e.errors.push({stage:'SCAN',symbol,error:err.message})}}
 state.signals=state.signals.slice(-1000);state.outcomes=state.outcomes.slice(-1000);state.updated_at=iso(now);const done=state.outcomes.length,hits=state.outcomes.filter(x=>x.exploded).length;e.summary={signals:state.signals.length,unresolved:state.signals.filter(x=>!x.resolved_at).length,resolved:done,explosions:hits,precision:done?hits/done:0,new_signals:e.new_signals.length,new_outcomes:e.new_outcomes.length};fs.writeFileSync(STATE_OUT,JSON.stringify(state,null,2));fs.writeFileSync(EVIDENCE_OUT,JSON.stringify(e,null,2));console.log(JSON.stringify({ok:true,...e.summary,shadow_only:true,no_order_created:true,production_action:'NONE'}))}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});