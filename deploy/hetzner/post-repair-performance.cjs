'use strict';
// Performance attribution only. No strategy search or order endpoint writes.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const SINCE=Date.parse('2026-11-02T19:29:31.447Z'),root='/var/lib/proypers25';
function attribute({trades,openingQuantity,buyIds,asset,price,minNotional}){
  const lots=[{old:true,remaining:openingQuantity,costRemaining:0}],map=new Map();let fees=0;
  for(const t of [...trades].sort((a,b)=>Number(a.time)-Number(b.time)||Number(a.id)-Number(b.id))){
    const qty=Number(t.qty),quote=Number(t.quoteQty),fee=Number(t.commission||0);
    if(!(qty>0&&quote>0&&fee>=0&&Number.isFinite(fee)))throw new Error('INVALID_PERFORMANCE_FILL');
    if(fee>0&&![asset,'USDT'].includes(t.commissionAsset))throw new Error('THIRD_ASSET_COMMISSION_REQUIRES_VALUATION');
    fees+=t.commissionAsset===asset?fee*Number(t.price):fee;
    if(t.isBuyer===true){
      if(!buyIds.has(String(t.orderId)))throw new Error('UNEXPECTED_PERFORMANCE_BUY');
      let lot=map.get(String(t.orderId));if(!lot){lot={buyOrderId:t.orderId,buyAt:Number(t.time),initialCost:0,remaining:0,costRemaining:0,proceeds:0,allocatedCost:0,soldQuantity:0,exitAt:null};map.set(String(t.orderId),lot);lots.push(lot);}
      const acquired=qty-(t.commissionAsset===asset?fee:0),cost=quote+(t.commissionAsset==='USDT'?fee:0);
      if(!(acquired>0))throw new Error('INVALID_BUY_COMMISSION');
      lot.remaining+=acquired;lot.costRemaining+=cost;lot.initialCost+=cost;
    }else if(t.isBuyer===false){
      const disposed=qty+(t.commissionAsset===asset?fee:0),net=quote-(t.commissionAsset==='USDT'?fee:0);let left=disposed;
      if(lots.reduce((s,l)=>s+l.remaining,0)+1e-9<left)throw new Error('SELL_EXCEEDS_SNAPSHOT_INVENTORY');
      for(const lot of lots){if(left<=1e-12)break;if(!(lot.remaining>0))continue;const used=Math.min(lot.remaining,left),cost=lot.costRemaining*used/lot.remaining;lot.remaining-=used;lot.costRemaining-=cost;left-=used;if(lot.old)continue;lot.proceeds+=net*used/disposed;lot.allocatedCost+=cost;lot.soldQuantity+=used;lot.exitAt=Number(t.time);}
    }else throw new Error('INVALID_PERFORMANCE_SIDE');
  }
  return {fees,endingQuantity:lots.reduce((s,l)=>s+l.remaining,0),lots:[...map.values()].map(l=>({...l,realizedNet:l.proceeds-l.allocatedCost,unrealizedNet:l.remaining*price-l.costRemaining,netMarked:l.proceeds+l.remaining*price-l.initialCost,operationallyClosed:l.soldQuantity>0&&l.remaining*price<minNotional}))};
}
async function main(){
  const key=fs.readFileSync('/etc/proypers25/binance-key','utf8').trim(),secret=fs.readFileSync('/etc/proypers25/binance-secret','utf8').trim();
  const transport=require('/opt/proypers25/runtime/readonly.cjs').makeFetch();let requests=0;
  async function get(endpoint,params={},signed=true){if(++requests>120)throw new Error('PERFORMANCE_READ_BUDGET');const q=new URLSearchParams(params);if(signed){q.set('recvWindow','5000');q.set('timestamp',String(Date.now()));q.set('signature',crypto.createHmac('sha256',secret).update(q.toString()).digest('hex'));}const r=await transport('https://api.binance.com'+endpoint+'?'+q,{method:'GET',headers:signed?{'X-MBX-APIKEY':key}:{}});if(!r.ok)throw new Error('PERFORMANCE_HTTP_'+r.status);return r.json();}
  const records=()=>fs.readdirSync(root+'/execution-state').filter(n=>/^[a-f0-9]{32}\.json$/.test(n)).map(n=>JSON.parse(fs.readFileSync(root+'/execution-state/'+n,'utf8'))).filter(r=>Number(r.buy?.executedQty)>0&&Date.parse(r.createdAt)>=SINCE);
  for(let attempt=0;attempt<2;attempt++){
    const wanted=records(),ids=new Set(wanted.map(r=>String(r.buy.orderId))),symbols=[...new Set(wanted.map(r=>r.symbol))];
    if(!symbols.length||symbols.length>20||Date.now()-SINCE>3*86400000)throw new Error('PERFORMANCE_SCOPE_REVIEW_REQUIRED');
    const before=await get('/api/v3/account',{omitZeroBalances:'true'}),end=Date.now(),rows=[];let sells=0,fees=0;
    const owned=(account,asset)=>{const b=account.balances.find(b=>b.asset===asset)||{};return Number(b.free||0)+Number(b.locked||0);};
    for(const symbol of symbols){
      async function window(endpoint){const all=[];for(let from=SINCE;from<end;from+=23*3600000){const p=await get(endpoint,{symbol,startTime:String(from),endTime:String(Math.min(end,from+23*3600000-1)),limit:'1000'});if(!Array.isArray(p)||p.length===1000)throw new Error('PERFORMANCE_HISTORY_TRUNCATED');all.push(...p);}return all;}
      const [orders,trades,ei,ticker]=await Promise.all([window('/api/v3/allOrders'),window('/api/v3/myTrades'),get('/api/v3/exchangeInfo',{symbol,showPermissionSets:'false'},false),get('/api/v3/ticker/price',{symbol},false)]);
      const info=ei.symbols?.find(s=>s.symbol===symbol),asset=info?.baseAsset,price=Number(ticker.price),nf=info?.filters?.find(f=>['NOTIONAL','MIN_NOTIONAL'].includes(f.filterType)),minNotional=Number(nf?.minNotional);
      if(!asset||!(price>0&&minNotional>0))throw new Error('PERFORMANCE_FILTER_REVIEW');
      const executed=orders.filter(o=>Number(o.executedQty)>0);
      if(executed.some(o=>!String(o.clientOrderId||'').startsWith('proypers-gh-')))throw new Error('EXTERNAL_EXECUTION_REQUIRES_REVIEW');
      if(trades.some(t=>!executed.some(o=>String(o.orderId)===String(t.orderId))))throw new Error('PERFORMANCE_ORDER_FILL_MISMATCH');
      for(const o of executed){const q=trades.filter(t=>String(t.orderId)===String(o.orderId)).reduce((s,t)=>s+Number(t.qty),0);if(Math.abs(q-Number(o.executedQty))>Math.max(1e-9,q*1e-7))throw new Error('PERFORMANCE_INCOMPLETE_FILLS');}
      const flow=trades.reduce((s,t)=>s+(t.isBuyer?1:-1)*Number(t.qty)-(t.commissionAsset===asset?Number(t.commission):0),0),held=owned(before,asset),opening=Math.max(0,held-flow);
      if(held-flow< -1e-9||opening*price>=minNotional)throw new Error('OPENING_INVENTORY_REQUIRES_REVIEW');
      const a=attribute({trades,openingQuantity:opening,buyIds:ids,asset,price,minNotional});
      if(Math.abs(a.endingQuantity-held)>Math.max(1e-9,held*1e-7))throw new Error('PERFORMANCE_BALANCE_MISMATCH');
      fees+=a.fees;sells+=executed.filter(o=>o.side==='SELL').length;
      rows.push(...a.lots.map(l=>({symbol,buyAt:new Date(l.buyAt).toISOString(),lastSaleAt:l.exitAt?new Date(l.exitAt).toISOString():null,buyOrderId:l.buyOrderId,costUsdt:l.initialCost,realizedNetUsdt:l.realizedNet,unrealizedNetUsdt:l.unrealizedNet,combinedNetUsdt:l.netMarked,returnPct:l.netMarked/l.initialCost*100,remainingQuantity:l.remaining,remainingValueUsdt:l.remaining*price,operationallyClosed:l.operationallyClosed})));
    }
    const after=await get('/api/v3/account',{omitZeroBalances:'true'});
    if(records().map(r=>String(r.buy.orderId)).sort().join()!==[...ids].sort().join()||symbols.some(s=>Math.abs(owned(before,s.slice(0,-4))-owned(after,s.slice(0,-4)))>1e-10)){if(attempt===0)continue;throw new Error('PERFORMANCE_SNAPSHOT_CHANGED');}
    const sum=k=>rows.reduce((s,r)=>s+r[k],0),result={at:new Date().toISOString(),since:new Date(SINCE).toISOString(),through:new Date(end).toISOString(),method:'Authenticated fills, FIFO attribution; pre-existing dust excluded from new BUY profit; opening dust inferred from stable account balance minus interval fills, assumes no transfers; remaining inventory marked at query prices. Not whole-account return. No new order dispatch.',summary:{buys:rows.length,sellOrders:sells,openPositions:rows.filter(r=>!r.operationallyClosed).length,closedPositions:rows.filter(r=>r.operationallyClosed).length,deployedCostUsdt:sum('costUsdt'),realizedNetUsdt:sum('realizedNetUsdt'),unrealizedNetUsdt:sum('unrealizedNetUsdt'),combinedNetUsdt:sum('combinedNetUsdt'),combinedReturnOnDeployedCostPct:sum('combinedNetUsdt')/sum('costUsdt')*100,closedPositive:rows.filter(r=>r.operationallyClosed&&r.combinedNetUsdt>0).length,closedNegative:rows.filter(r=>r.operationallyClosed&&r.combinedNetUsdt<0).length,commissionsUsdt:fees},rows,requests,realOrdersSent:0};
    fs.mkdirSync(root+'/analysis',{recursive:true,mode:0o700});fs.writeFileSync(root+'/analysis/post-repair-20261103.json',JSON.stringify(result),{mode:0o600});console.log('POST_REPAIR_PERFORMANCE',JSON.stringify(result));return;
  }
}
module.exports={attribute};
if(require.main===module||module.filename.endsWith('/[stdin]'))main().catch(e=>{console.error(/^[A-Z_0-9]+$/.test(e.message)?e.message:'PERFORMANCE_READ_FAILED');process.exitCode=2;});
