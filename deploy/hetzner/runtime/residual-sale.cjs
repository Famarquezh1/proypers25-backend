'use strict';
// Only continues a SELL whose terminal partial fill has been authenticated and reconciled.
const crypto=require('node:crypto');
function floor(value,step){
  const n=Number(step);if(!(n>0&&Number.isFinite(value)))throw new Error('RESIDUAL_FILTER_INVALID');
  const decimals=(String(step).replace(/0+$/,'').split('.')[1]||'').length;
  return Number((Math.floor((value+Number.EPSILON)/n)*n).toFixed(decimals));
}
async function planResidual({record,get}) {
  const order=record.order;
  if(!order||!['CANCELED','EXPIRED','EXPIRED_IN_MATCH'].includes(order.status))throw new Error('TERMINAL_SELL_REQUIRED');
  const original=Number(order.origQty),executed=Number(order.executedQty),remaining=original-executed;
  if(!(Number.isFinite(remaining)&&original>0&&executed>=0&&remaining>0))throw new Error('RESIDUAL_QUANTITY_INVALID');
  const [market,account,prices,orders]=await Promise.all([
    get('/api/v3/exchangeInfo',{symbol:record.symbol,showPermissionSets:'false'},false),
    get('/api/v3/account',{omitZeroBalances:'true'}),
    get('/api/v3/ticker/price',{symbol:record.symbol},false),get('/api/v3/openOrders',{symbol:record.symbol})]);
  const info=market.symbols?.find(s=>s.symbol===record.symbol);
  if(!info||info.status!=='TRADING'||info.isSpotTradingAllowed!==true)throw new Error('RESIDUAL_SYMBOL_UNAVAILABLE');
  const lot=info.filters?.find(f=>f.filterType==='LOT_SIZE');
  const marketLot=info.filters?.find(f=>f.filterType==='MARKET_LOT_SIZE');
  const nf=info.filters?.find(f=>f.filterType==='NOTIONAL')||info.filters?.find(f=>f.filterType==='MIN_NOTIONAL');
  const price=Number(prices.price),step=Number(lot?.stepSize);
  if(!(price>0&&step>0&&Number.isFinite(Number(nf?.minNotional))))throw new Error('RESIDUAL_FILTER_INVALID');
  let quantity=floor(remaining,lot.stepSize);
  if(marketLot&&Number(marketLot.stepSize)>0)quantity=floor(quantity,marketLot.stepSize);
  const min=Math.max(Number(lot.minQty),Number(marketLot?.minQty||0));
  const max=Math.min(Number(lot.maxQty),Number(marketLot?.maxQty)>0?Number(marketLot.maxQty):Infinity);
  if(!Number.isFinite(min)||!Number.isFinite(max))throw new Error('RESIDUAL_FILTER_INVALID');
  if(quantity<min||quantity*price<Number(nf.minNotional))return {kind:'DUST',remaining};
  if(quantity>max||nf.maxNotional&&quantity*price>Number(nf.maxNotional))throw new Error('RESIDUAL_LIMIT_EXCEEDED');
  if(!Array.isArray(account.balances)||!Array.isArray(orders))throw new Error('RESIDUAL_ACCOUNT_INVALID');
  const balance=account.balances.find(b=>b.asset===info.baseAsset);
  const free=Number(balance?.free||0),locked=Number(balance?.locked||0);
  if(!Number.isFinite(free)||!Number.isFinite(locked)||free<0||locked<0)throw new Error('RESIDUAL_ACCOUNT_INVALID');
  const stops=orders.filter(o=>o.symbol===record.symbol&&o.side==='SELL'&&['STOP_LOSS','STOP_LOSS_LIMIT'].includes(o.type)&&
    ['NEW','PARTIALLY_FILLED'].includes(o.status)&&/^(proypers-gh-protect-|proypers-gh-orphan-)/.test(o.clientOrderId||'')&&Number(o.stopPrice)>0);
  const protectedQty=stops.reduce((n,o)=>n+Math.max(0,Number(o.origQty)-Number(o.executedQty)),0);
  if(protectedQty+step*.01>=quantity)return {kind:'PROTECTED',remaining,orderIds:stops.map(o=>o.orderId)};
  if(floor(free,lot.stepSize)+step*.01<quantity)throw new Error('RESIDUAL_INVENTORY_CHANGED_REVIEW_REQUIRED');
  if(Number(record.generation||0)>=2)throw new Error('RESIDUAL_ATTEMPT_LIMIT');
  const id=crypto.createHash('sha256').update(`${record.id}:remainder:${order.orderId}`).digest('hex').slice(0,32);
  return {kind:'SELL',remaining,quantity,id,clientId:`proypers-gh-exit-${id.slice(0,19)}`};
}
module.exports={planResidual};
