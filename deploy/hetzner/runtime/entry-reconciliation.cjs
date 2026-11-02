'use strict';
function filters(info){
  const lot=info?.filters?.find(f=>f.filterType==='LOT_SIZE'),price=info?.filters?.find(f=>f.filterType==='PRICE_FILTER');
  const nf=info?.filters?.find(f=>f.filterType==='NOTIONAL'||f.filterType==='MIN_NOTIONAL');
  if(!(Number(lot?.stepSize)>0&&Number(lot?.minQty)>0&&Number(price?.tickSize)>0&&Number(nf?.minNotional)>0))throw new Error('ENTRY_FILTER_REVIEW_REQUIRED');
  return {lot,price,minNotional:Number(nf.minNotional)};
}
function floor(q,step){return Math.floor((q+Number.EPSILON)/Number(step))*Number(step);}
function protectionFits({info,price,quote,stopPct}){
  const f=filters(info);
  if(!(price>0&&quote>0&&stopPct>0&&stopPct<1)||info.status!=='TRADING'||info.isSpotTradingAllowed!==true)throw new Error('ENTRY_PROTECTION_REVIEW_REQUIRED');
  const type=info.orderTypes?.includes('STOP_LOSS')?'STOP_LOSS':info.orderTypes?.includes('STOP_LOSS_LIMIT')?'STOP_LOSS_LIMIT':null;
  if(!type)return false;
  // Reserve base-asset fees and apply the native stop's own quantity/price rounding.
  const quantity=floor(quote/price*.998,f.lot.stepSize),stop=floor(price*(1-stopPct),f.price.tickSize);
  const limit=type==='STOP_LOSS_LIMIT'?floor(stop*.994,f.price.tickSize):stop;
  return quantity>=Number(f.lot.minQty)&&limit>0&&quantity*limit>=f.minNotional;
}
function isDust(info,total,price){const f=filters(info);if(!(total>=0&&Number.isFinite(total)&&price>0))throw new Error('ENTRY_BALANCE_REVIEW_REQUIRED');const q=floor(total,f.lot.stepSize);return q<Number(f.lot.minQty)||q*price<f.minNotional;}
function closureProof({record,info,total,price,openOrders,orders,trades}){
  if(!record.buy||!isDust(info,total,price)||!Array.isArray(openOrders)||openOrders.length||!Array.isArray(orders)||!Array.isArray(trades)||orders.length>=1000||trades.length>=1000)return null;
  const buy=orders.find(o=>String(o.orderId)===String(record.buy.orderId)&&o.clientOrderId===record.buyId&&o.side==='BUY'&&o.status==='FILLED');
  if(!buy||!(Number(buy.time)>0))return null;
  const fills=trades.filter(t=>Number(t.time)>=Number(buy.time));
  if(!fills.length||fills.some(t=>t.symbol&&t.symbol!==record.symbol))return null;
  const relevant=orders.filter(o=>Number(o.executedQty)>0&&fills.some(t=>String(t.orderId)===String(o.orderId)));
  if(relevant.some(o=>o.symbol!==record.symbol||!String(o.clientOrderId||'').startsWith('proypers-gh-')||!['FILLED','CANCELED','EXPIRED'].includes(o.status)))return null;
  if(relevant.filter(o=>o.side==='BUY').length!==1||relevant.some(o=>o.side==='BUY'&&String(o.orderId)!==String(buy.orderId)))return null;
  let remaining=0,sold=0;const sellIds=[];
  for(const t of [...fills].sort((a,b)=>Number(a.time)-Number(b.time)||Number(a.id)-Number(b.id))){
    const order=relevant.find(o=>String(o.orderId)===String(t.orderId));if(!order)return null;
    const q=Number(t.qty),fee=Number(t.commission||0);if(!(q>0&&fee>=0&&Number.isFinite(fee)))return null;
    if(t.isBuyer===true&&order.side==='BUY')remaining+=q-(t.commissionAsset===info.baseAsset?fee:0);
    else if(t.isBuyer===false&&order.side==='SELL'){const used=q+(t.commissionAsset===info.baseAsset?fee:0);remaining-=used;sold+=used;sellIds.push(order.orderId);}else return null;
    if(remaining< -1e-9)return null;
  }
  for(const order of relevant){const sum=fills.filter(t=>String(t.orderId)===String(order.orderId)).reduce((s,t)=>s+Number(t.qty),0);if(Math.abs(sum-Number(order.executedQty))>Math.max(1e-10,sum*1e-8))return null;}
  if(!(sold>0)||Math.abs(remaining-total)>Math.max(1e-10,total*1e-7))return null;
  return {reason:'CONFIRMED_EXIT_WITH_DUST',residualQuantity:total,sellOrderIds:[...new Set(sellIds)]};
}
module.exports={protectionFits,isDust,closureProof};
