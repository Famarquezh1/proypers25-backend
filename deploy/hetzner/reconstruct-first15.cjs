'use strict';
// Read-only, fixed-cohort attribution. No training, strategy search or order placement.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const CUTOFF=Date.parse('2026-11-01T20:50:12.251Z');
function allocate(orders,fills,feeQuotes){
  const lots=[];
  const fillTime=o=>Math.max(...fills.filter(f=>String(f.orderId)===String(o.orderId)).map(f=>Number(f.time)));
  for(const o of [...orders].filter(o=>Number(o.executedQty)>0).sort((a,b)=>fillTime(a)-fillTime(b)||Number(a.orderId)-Number(b.orderId))){
    const trades=fills.filter(f=>String(f.orderId)===String(o.orderId));
    if(!trades.length)throw new Error('MISSING_EXECUTION_FILLS');
    const qty=trades.reduce((s,t)=>s+Number(t.qty),0),quote=trades.reduce((s,t)=>s+Number(t.quoteQty??Number(t.qty)*Number(t.price)),0);
    if(Math.abs(qty-Number(o.executedQty))>Math.max(1e-10,qty*1e-7))throw new Error('INCOMPLETE_EXECUTION_FILLS');
    const asset=o.symbol.slice(0,-4);
    let baseFee=0,extraFee=0,totalFee=0;
    for(const t of trades){const fee=Number(t.commission);if(!(fee>=0))throw new Error('INVALID_COMMISSION');
      if(t.commissionAsset===asset){baseFee+=fee;totalFee+=fee*Number(t.price);}
      else {const value=fee===0?0:feeQuotes.get(String(t.id));if(!Number.isFinite(value))throw new Error('UNVALUED_COMMISSION');extraFee+=value;totalFee+=value;}}
    const at=Math.max(...trades.map(t=>Number(t.time)));
    if(o.side==='BUY'){
      const netQty=qty-baseFee;if(!(netQty>0))throw new Error('INVALID_BUY_QUANTITY');
      lots.push({symbol:o.symbol,buyOrderId:o.orderId,buyAt:at,entry:quote/qty,quantity:netQty,remaining:netQty,initialCost:quote+extraFee,costRemaining:quote+extraFee,
        proceeds:0,allocatedCost:0,soldQuantity:0,exitAt:null,sellOrders:[],commissionQuote:totalFee,grossQuote:quote});
    }else{
      const available=lots.filter(l=>l.symbol===o.symbol&&l.remaining>1e-12);let left=qty+baseFee;
      if(available.reduce((s,l)=>s+l.remaining,0)+Math.max(1e-9,left*1e-7)<left)throw new Error('SELL_OUTSIDE_COHORT_INVENTORY');
      for(const l of available){if(left<=1e-12)break;const used=Math.min(l.remaining,left),fraction=used/(qty+baseFee),cost=l.costRemaining*used/l.remaining;
        l.remaining-=used;l.costRemaining-=cost;l.allocatedCost+=cost;l.proceeds+=(quote-extraFee)*fraction;l.soldQuantity+=qty*fraction;l.exitAt=at;
        l.commissionQuote+=totalFee*fraction;l.sellOrders.push({orderId:o.orderId,type:o.type,at,price:quote/qty,quantity:qty*fraction});left-=used;}
    }
  }
  return lots;
}
async function main(){
  const root='/var/lib/proypers25',cred='/etc/proypers25';
  const auth=JSON.parse(fs.readFileSync(path.join(cred,'LIVE_AUTHORIZATION.json'),'utf8'));
  const since=Date.parse(auth.authorizedAt);if(!(since<CUTOFF))throw new Error('INVALID_COHORT_INTERVAL');
  const key=fs.readFileSync(path.join(cred,'binance-key'),'utf8').trim(),secret=fs.readFileSync(path.join(cred,'binance-secret'),'utf8').trim();
  const getFetch=require('/opt/proypers25/runtime/readonly.cjs').makeFetch();let requests=0;
  async function get(endpoint,params={},signed=false){
    if(++requests>180)throw new Error('READ_ONLY_REQUEST_BUDGET_EXCEEDED');
    const q=new URLSearchParams(params);
    if(signed){q.set('recvWindow','5000');q.set('timestamp',String(Date.now()));q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));}
    const r=await getFetch('https://api.binance.com'+endpoint+'?'+q,{method:'GET',headers:signed?{'X-MBX-APIKEY':key}:{}});
    if(!r.ok)throw new Error('RECONSTRUCTION_HTTP_'+r.status);return r.json();
  }
  const records=fs.readdirSync(path.join(root,'execution-state')).filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(path.join(root,'execution-state',n),'utf8')));
  const wanted=records.filter(r=>Number(r.buy?.executedQty)>0&&Number(r.buy.updateTime||r.buy.time)<=CUTOFF);
  if(wanted.length!==15)throw new Error('FIXED_COHORT_IS_NOT_15');
  const symbols=[...new Set(wanted.map(r=>r.symbol))],allLots=[],priceCache=new Map(),feeAssets=new Set();
  const issues=fs.existsSync(path.join(root,'local-issues.json'))?JSON.parse(fs.readFileSync(path.join(root,'local-issues.json'),'utf8')):[];
  async function minutePrice(symbol,time){const minute=Math.floor(time/60000)*60000,k=symbol+':'+minute;
    if(!priceCache.has(k)){const rows=await get('/api/v3/klines',{symbol,interval:'1m',startTime:String(minute),limit:'1'});if(!rows.length||Number(rows[0][0])!==minute)throw new Error('MISSING_COMMISSION_PRICE');priceCache.set(k,Number(rows[0][4]));}
    return priceCache.get(k);}
  async function window(endpoint,symbol){const out=[];for(let from=since;from<CUTOFF;from+=23*3600000){const p=await get(endpoint,{symbol,startTime:String(from),endTime:String(Math.min(CUTOFF,from+23*3600000-1)),limit:'1000'},true);if(!Array.isArray(p)||p.length===1000)throw new Error('HISTORY_TRUNCATED');out.push(...p);}return [...new Map(out.map(o=>[String(o.orderId)+':'+String(o.id??''),o])).values()];}
  async function candles(symbol,start,end){const out=[];for(let from=Math.floor(start/60000)*60000;from<end;){const p=await get('/api/v3/klines',{symbol,interval:'1m',startTime:String(from),endTime:String(end),limit:'1000'});if(!p.length)throw new Error('CANDLE_GAP');out.push(...p);const next=Number(p.at(-1)[0])+60000;if(next<=from)throw new Error('CANDLE_CURSOR');from=next;}return out;}
  for(const symbol of symbols){
    const [orders,fills]=await Promise.all([window('/api/v3/allOrders',symbol),window('/api/v3/myTrades',symbol)]);
    const wantedIds=new Set(wanted.filter(r=>r.symbol===symbol).map(r=>String(r.buy.orderId)));
    if(orders.some(o=>Number(o.executedQty)>0&&!/^proypers-gh-/.test(o.clientOrderId||'')))throw new Error('EXTERNAL_EXECUTIONS_REQUIRE_REVIEW');
    const managed=orders.filter(o=>/^proypers-gh-/.test(o.clientOrderId||'')&&Number(o.executedQty)>0);
    if(managed.some(o=>o.side==='BUY'&&!wantedIds.has(String(o.orderId))))throw new Error('UNEXPECTED_BUY_IN_COHORT');
    const fees=new Map();
    for(const t of fills.filter(t=>managed.some(o=>String(o.orderId)===String(t.orderId)))){feeAssets.add(t.commissionAsset);const fee=Number(t.commission);
      if(t.commissionAsset===symbol.slice(0,-4))continue;
      fees.set(String(t.id),fee===0?0:t.commissionAsset==='USDT'?fee:fee*await minutePrice(t.commissionAsset+'USDT',Number(t.time)));}
    const lots=allocate(managed,fills,fees);if(lots.length!==wantedIds.size)throw new Error('MISSING_COHORT_BUY');
    for(const l of lots)for(const sale of l.sellOrders){
      const i=issues.find(i=>new RegExp('orderId='+sale.orderId+'(?:\\D|$)').test(i.body||'')&&String(i.title||'').startsWith('[SPOT EXIT] '+symbol+' '));
      sale.reason=i?.body?.match(/Motivo:\s*([A-Z_]+)/)?.[1]||(['STOP_LOSS','STOP_LOSS_LIMIT'].includes(sale.type)?'NATIVE_PROTECTIVE_STOP':'MARKET_EXIT_REASON_NOT_PERSISTED');
    }
    const start=Math.min(...lots.map(l=>l.buyAt))-4*3600000,end=Math.min(Date.now(),Math.max(...lots.map(l=>l.exitAt||CUTOFF))+4*3600000+60000);
    const bars=await candles(symbol,start,end);
    const closeAt=t=>{const b=bars.filter(b=>Number(b[6])<=t).at(-1);return b&&t-Number(b[6])<=60000?Number(b[4]):null;};
    const ticker=await get('/api/v3/ticker/price',{symbol});
    for(const l of lots){const during=bars.filter(b=>Number(b[0])>=l.buyAt&&Number(b[6])<=l.exitAt);
      const exitMean=l.sellOrders.reduce((s,x)=>s+x.price*x.quantity,0)/l.soldQuantity;
      l.grossReturnPct=(exitMean/l.entry-1)*100;l.netRealizedPct=l.allocatedCost>0?(l.proceeds/l.allocatedCost-1)*100:null;
      l.remainingMarkedValue=l.remaining*Number(ticker.price);l.netMarkedPct=(l.proceeds+l.remainingMarkedValue-l.initialCost)/l.initialCost*100;
      l.durationMinutes=(l.exitAt-l.buyAt)/60000;l.mfePct=during.length?(Math.max(l.entry,exitMean,...during.map(b=>Number(b[2])))/l.entry-1)*100:null;
      l.maePct=during.length?(Math.min(l.entry,exitMean,...during.map(b=>Number(b[3])))/l.entry-1)*100:null;
      l.preEntry1hPct=closeAt(l.buyAt-3600000)?(l.entry/closeAt(l.buyAt-3600000)-1)*100:null;
      l.postExit={};for(const minutes of [30,60,240]){const p=closeAt(l.exitAt+minutes*60000);l.postExit[minutes]=l.exitAt+minutes*60000<=Date.now()&&p?{versusEntryPct:(p/l.entry-1)*100,versusActualExitPct:(p/exitMean-1)*100}:null;}
      allLots.push(l);
    }
  }
  const spent=allLots.reduce((s,l)=>s+l.initialCost,0),proceeds=allLots.reduce((s,l)=>s+l.proceeds,0),dust=allLots.reduce((s,l)=>s+l.remainingMarkedValue,0);
  const fees=allLots.reduce((s,l)=>s+l.commissionQuote,0),winners=allLots.filter(l=>l.netMarkedPct>0);
  const grossGain=allLots.reduce((s,l)=>s+l.grossQuote*l.grossReturnPct/100,0);
  const result={at:new Date().toISOString(),cohort:{since:auth.authorizedAt,cutoff:new Date(CUTOFF).toISOString(),buys:15,symbols:symbols.length},requests,
    method:{orders:'authenticated Binance allOrders + myTrades, fixed cohort; FIFO within symbol',commissions:'base fees reduce inventory; quote fees exact; other-asset fees valued at historical 1m close',candles:'1m bars fully inside holding interval; actual entry/exit included; no intraminute path inference',postExit:'observed prices only, not simulated executable policy or profitability claim'},
    summary:{netMarkedReturnPct:(proceeds+dust-spent)/spent*100,commissionPctOfDeployedCost:fees/spent*100,grossPriceReturnPct:grossGain/allLots.reduce((s,l)=>s+l.grossQuote,0)*100,positive: winners.length,negative:allLots.length-winners.length,feeAssets:[...feeAssets],dustMarkedPct:dust/spent*100},lots:allLots};
  const dir=path.join(root,'analysis');fs.mkdirSync(dir,{recursive:true,mode:0o700});fs.writeFileSync(path.join(dir,'first15-20261101.json'),JSON.stringify(result),{mode:0o600});
  const round=x=>typeof x==='number'?Math.round(x*1000)/1000:x;
  const rows=allLots.map(l=>({symbol:l.symbol,buyAt:new Date(l.buyAt).toISOString(),exitAt:new Date(l.exitAt).toISOString(),grossPct:round(l.grossReturnPct),netPct:round(l.netMarkedPct),commissionPct:round(l.commissionQuote/l.initialCost*100),minutes:round(l.durationMinutes),mfePct:round(l.mfePct),maePct:round(l.maePct),preEntry1hPct:round(l.preEntry1hPct),reason:[...new Set(l.sellOrders.map(s=>s.reason))],postExit:Object.fromEntries(Object.entries(l.postExit).map(([k,v])=>[k,v?{versusEntryPct:round(v.versusEntryPct),versusActualExitPct:round(v.versusActualExitPct)}:null]))}));
  console.log('FIRST15_RECONSTRUCTION',JSON.stringify({...result,lots:undefined,rows}));
}
module.exports={allocate};
if(require.main===module)main().catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'READ_ONLY_RECONSTRUCTION_FAILED');process.exitCode=2;});
