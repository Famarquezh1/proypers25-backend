'use strict';

const BASE='https://data-api.binance.vision';
const MIN_PCT=0.25;
const MAX_PCT=12;
const MIN_QUOTE_VOLUME=200000;
const PROBE=120;
const CONCURRENCY=12;
const V42_THRESHOLDS=[
  {i:0.904010256302157,c:0.30262335308700017,e:0.0333071863419859},
  {i:0.7912647052581232,c:0.36672756172128707,e:0.029510140018270917},
  {i:1.6626658194027173,c:0.43305908219072103,e:0.019614079751271593}
];

function avg(a){return a.length?a.reduce((s,x)=>s+x,0)/a.length:0}
function ret(a,b){return a>0?b/a-1:0}
function clamp(x,a=0,b=1){return Math.max(a,Math.min(b,Number(x)||0))}
function qsum(rows,i,n){let s=0;for(let k=Math.max(0,i-n+1);k<=i;k++)s+=rows[k].q;return s}
async function get(url){
  const c=new AbortController();const t=setTimeout(()=>c.abort(),20000);
  try{const r=await fetch(url,{signal:c.signal,headers:{'user-agent':'proypers25-precore-shadow/1.0'}});if(!r.ok)throw new Error('HTTP '+r.status);return await r.json()}
  finally{clearTimeout(t)}
}
async function klines(symbol,limit=290){
  const rows=await get(`${BASE}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=${limit}`);
  return rows.map(r=>({t:+r[0],o:+r[1],h:+r[2],l:+r[3],c:+r[4],q:+r[7],n:+r[8]}));
}
async function mapLimit(items,limit,fn){
  const out=new Array(items.length);let p=0;
  async function worker(){while(true){const i=p++;if(i>=items.length)return;try{out[i]=await fn(items[i])}catch(e){out[i]={error:String(e.message||e)}}}}
  await Promise.all(Array.from({length:Math.min(limit,items.length)},worker));return out;
}
function parts(sb,bb){
  const i=sb.length-2,bi=bb.length-2;if(i<288||bi<48)return null;
  const c=sb[i].c;
  const r15=ret(sb[i-3].c,c),r30=ret(sb[i-6].c,c),r60=ret(sb[i-12].c,c),r240=ret(sb[i-48].c,c),r24=ret(sb[i-288].c,c);
  const base=avg(sb.slice(i-72,i-12).map(x=>x.q))*12;
  const ph60=Math.max(...sb.slice(i-12,i).map(x=>x.h)),ph240=Math.max(...sb.slice(i-48,i).map(x=>x.h));
  const vol15=base>0?qsum(sb,i,3)/(base/4):1,vol30=base>0?qsum(sb,i,6)/(base/2):1;
  const ta=sb[i].n/Math.max(1,avg(sb.slice(i-12,i).map(x=>x.n)));
  const br60=ph60>0?c/ph60-1:0,br240=ph240>0?c/ph240-1:0;
  const btc60=ret(bb[bi-12].c,bb[bi].c),btc240=ret(bb[bi-48].c,bb[bi].c);
  const rs60=r60-btc60,rs240=r240-btc240;
  const ignition=.9*Math.log(Math.max(.2,vol15))+.65*Math.log(Math.max(.2,ta))+.65*r15+.35*br60;
  const confirm=1.2*br60+.65*rs60+.35*Math.log(Math.max(.2,vol30))-.8*Math.max(0,r24-.10)-.5*Math.max(0,r60-.06);
  const extension=1.15*rs60+.75*rs240+.35*r30+.25*br240-.45*Math.max(0,r24-.12);
  const fresh=r24<.10&&r60<.10&&r15<.06;
  const passCount=fresh?V42_THRESHOLDS.filter(th=>ignition>=th.i&&confirm>=th.c&&extension>=th.e).length:0;
  const allPositive=fresh&&ignition>0&&confirm>0&&extension>0;
  let stage='NONE';
  if(allPositive)stage='PRECURSOR_BUILDING';
  if(passCount>=1)stage='PASS1_EARLY';
  if(passCount>=2)stage='PASS2_ESCALATED';
  if(passCount>=3)stage='CORE_FORMING';
  const score=(passCount*2)+(allPositive?1:0)+clamp(ignition/2)+clamp(confirm/.8)+clamp(extension/.12);
  return {price:c,r15,r60,r24,ignition,confirm,extension,fresh,passCount,allPositive,stage,score};
}
async function main(){
  const [ticks,info,btc]=await Promise.all([
    get(`${BASE}/api/v3/ticker/24hr`),
    get(`${BASE}/api/v3/exchangeInfo`),
    klines('BTCUSDT')
  ]);
  const active=new Set((info.symbols||[]).filter(x=>x.status==='TRADING'&&x.isSpotTradingAllowed!==false).map(x=>x.symbol));
  const eligible=(ticks||[]).map(x=>({symbol:String(x.symbol||''),pct:+x.priceChangePercent||0,qv:+x.quoteVolume||0,price:+x.lastPrice||0}))
    .filter(x=>active.has(x.symbol)&&x.symbol.endsWith('USDT')&&!/(UP|DOWN|BULL|BEAR)USDT$/.test(x.symbol)&&x.price>0&&x.pct>=MIN_PCT&&x.pct<MAX_PCT&&x.qv>=MIN_QUOTE_VOLUME)
    .sort((a,b)=>(b.qv*(1+Math.max(0,b.pct)/12))-(a.qv*(1+Math.max(0,a.pct)/12))).slice(0,PROBE);
  const scanned=await mapLimit(eligible,CONCURRENCY,async x=>{
    const sb=await klines(x.symbol);const f=parts(sb,btc);return f?{...x,...f}:null;
  });
  const candidates=scanned.filter(x=>x&&x.stage!=='NONE').sort((a,b)=>b.score-a.score);
  const result={
    ok:true,mode:'PRE_CORE_PHASED_SHADOW_V1',shadow_only:true,no_order_created:true,production_action:'NONE',
    evidence_basis:'historical fixed precursor rules: PASS1 / ALL_PARTS_POSITIVE; progression only, zero execution influence',
    probed:eligible.length,candidates:candidates.length,
    stage_counts:candidates.reduce((o,x)=>(o[x.stage]=(o[x.stage]||0)+1,o),{}),
    top:candidates.slice(0,12).map(x=>({
      symbol:x.symbol,pct24h:+x.pct.toFixed(3),price:x.price,stage:x.stage,passCount:x.passCount,
      allPositive:x.allPositive,score:+x.score.toFixed(4),
      ignition:+x.ignition.toFixed(4),confirm:+x.confirm.toFixed(4),extension:+x.extension.toFixed(4),
      r15_pct:+(x.r15*100).toFixed(3),r60_pct:+(x.r60*100).toFixed(3),r24_pct:+(x.r24*100).toFixed(3)
    }))
  };
  console.log(JSON.stringify(result));
}
main().catch(e=>{console.error(e.stack||e);process.exit(1)});
