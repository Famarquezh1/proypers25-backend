'use strict';

/**
 * Accelerated historical falsification of Astra's derivatives-pressure hypothesis.
 * Public Binance data only. No credentials/orders. Decision features use only data
 * timestamped at or before the simulated decision.
 *
 * Historical limitation: Binance public OI history is 5m, so this tests the same
 * mechanism causally at 5m resolution rather than pretending historical 5s OI exists.
 */
const SPOT='https://api.binance.com', FUT='https://fapi.binance.com';
const SYMBOLS=String(process.env.DP_SYMBOLS||'BTCUSDT,ETHUSDT,SOLUSDT,XRPUSDT,DOGEUSDT,ADAUSDT,SUIUSDT,LINKUSDT,NEARUSDT,LTCUSDT').split(',');
const DAYS=Math.max(7,Math.min(30,+process.env.DP_DAYS||21));
const MINUTE=60000, FIVE=300000;
const COST=0.004, TAKE=.03, STOP=-.01, HORIZON=15*60*1000;
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function pagedKlines(base,path,symbol,start,end){
 const out=[];let cursor=start;
 while(cursor<end){const a=await get(base,path,{symbol,interval:'1m',startTime:cursor,endTime:end,limit:1000});if(!a.length)break;out.push(...a);const next=+a[a.length-1][0]+MINUTE;if(next<=cursor)break;cursor=next;await sleep(40)}
 return out;
}
async function pagedOI(symbol,start,end){
 const out=[];let cursor=start;
 while(cursor<end){const a=await get(FUT,'/futures/data/openInterestHist',{symbol,period:'5m',startTime:cursor,endTime:end,limit:500});if(!a.length)break;out.push(...a);const next=+a[a.length-1].timestamp+FIVE;if(next<=cursor)break;cursor=next;await sleep(40)}
 return out;
}
async function get(base,path,params){
 const u=new URL(base+path);Object.entries(params||{}).forEach(([k,v])=>u.searchParams.set(k,v));
 for(let i=0;i<4;i++){const r=await fetch(u,{headers:{'User-Agent':'Proypers25-Research/1.0'}});if(r.ok)return r.json();if(r.status===429||r.status>=500){await sleep(500*(i+1));continue;}throw Error(r.status+' '+u.pathname);}
 throw Error('fetch failed '+u.pathname);
}
const ret=(a,b)=>b/a-1;
function qtile(a,q){const s=[...a].sort((x,y)=>x-y);return s[Math.min(s.length-1,Math.max(0,Math.floor(q*(s.length-1))))]}
function metrics(rows,score){
 if(!rows.length)return {n:0};
 const vals=rows.map(x=>x[score]).filter(Number.isFinite); if(!vals.length)return {n:0}; const cut=qtile(vals,.8);
 const sel=rows.filter(x=>Number.isFinite(x[score])&&x[score]>=cut);
 const hits=sel.filter(x=>x.hit).length, pnl=sel.reduce((a,x)=>a+x.pnl-COST,0)/Math.max(sel.length,1);
 return {n:sel.length,precision:hits/Math.max(sel.length,1),avg_net:pnl,cut};
}
(async()=>{
 const end=Date.now()-10*60*1000,start=end-DAYS*86400000, all=[];
 for(const symbol of SYMBOLS){
  try{
   const [sk,fk,oi]=await Promise.all([
    pagedKlines(SPOT,'/api/v3/klines',symbol,start,end),
    pagedKlines(FUT,'/fapi/v1/klines',symbol,start,end),
    pagedOI(symbol,start,end)
   ]);
   console.error('DATA',symbol,'spot',sk.length,'futures',fk.length,'oi',oi.length);
   const fm=new Map(fk.map(k=>[+k[0],k])), om=new Map(oi.map(x=>[Math.floor(+x.timestamp/FIVE)*FIVE,x]));
   for(let i=60;i<sk.length-16;i++){
    const s=sk[i],t=+s[0],f=fm.get(t);if(!f)continue;
    const bucket=Math.floor(t/FIVE)*FIVE;
    // Historical OI is 5m. Use the last COMPLETED OI bucket only, never the current bucket.
    const o=om.get(bucket-FIVE),op=om.get(bucket-2*FIVE);if(!o||!op)continue;
    const spot=+s[4], fut=+f[4], basis=fut/spot-1, g=+o.sumOpenInterest/+op.sumOpenInterest-1;
    const prev=[];for(let z=i-60;z<=i-5;z++){const ff=fm.get(+sk[z][0]);if(ff)prev.push(+ff[4]/+sk[z][4]-1)}
    if(prev.length<40)continue; const b0=qtile(prev,.5), A=Math.max(basis-Math.max(0,b0),0), H=A*Math.max(g,0);
    const fRet60=ret(+fm.get(+sk[i-1][0])?.[4]||fut,fut), fRet300=ret(+fm.get(+sk[i-5][0])?.[4]||fut,fut);
    // Existing-style alert population proxy: positive but not already extreme Spot impulse.
    const r15=ret(+sk[i-15][4],spot), r60=ret(+sk[i-60][4],spot);
    if(!(r15>.002&&r15<.04&&r60>.004&&r60<.08))continue;
    let hit=false,pnl=ret(spot,+sk[i+15][4]);
    for(let z=i+1;z<=i+15;z++){const hi=ret(spot,+sk[z][2]),lo=ret(spot,+sk[z][3]);if(lo<=STOP){pnl=STOP;break}if(hi>=TAKE){hit=true;pnl=TAKE;break}}
    // M1 proxy contains derivative momentum+basis+OI separately; fixed scale, no fitting.
    const m1=10*basis+5*g+2*fRet60+fRet300;
    all.push({symbol,t,basis,g,H,m1,m2:m1+100*H,hit,pnl});
   }
  }catch(e){console.error('SKIP',symbol,e.message)}
 }
 all.sort((a,b)=>a.t-b.t); const n=all.length,a=Math.floor(n*.6),b=Math.floor(n*.8);
 const purge=75*MINUTE, ta=all[a]?.t??Infinity, tb=all[b]?.t??Infinity;
 const blocks={train:all.filter(x=>x.t<ta-purge),validation:all.filter(x=>x.t>=ta&&x.t<tb-purge),test:all.filter(x=>x.t>=tb)};
 const out={ok:true,method_note:'Historical causal proxy: 1m close basis and completed 5m OI; not the exact live 60s/bookTicker H',purge_minutes:75,shadow_only:true,no_order_created:true,historical_resolution:'OI 5m; price 1m',days:DAYS,cost:COST,rows:n,blocks:{}};
 for(const [k,v] of Object.entries(blocks)){
   const m1=metrics(v,'m1'),m2=metrics(v,'m2');
   out.blocks[k]={M1:m1,M2:m2,relative_precision_gain:m1.precision?m2.precision/m1.precision-1:null,net_gain:m2.avg_net-m1.avg_net};
 }
 const te=out.blocks.test;out.continue_hypothesis=te.M2.n>=20&&te.relative_precision_gain>=.20&&te.M2.avg_net>0;
 console.log(JSON.stringify(out,null,2));
})().catch(e=>{console.error(e);process.exit(1)});
