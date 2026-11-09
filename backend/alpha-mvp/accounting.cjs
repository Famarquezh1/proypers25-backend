'use strict';
// FIFO per managed Binance BUY order; 12-decimal exact fixed-point, GET-only ledger.
const S=10n**12n;
function d(v){if(v===null||v===undefined||v==='')throw Error('DECIMAL_MISSING');const s=String(v);if(!/^-?\d+(\.\d{1,12})?$/.test(s))throw Error('DECIMAL_INVALID');const neg=s[0]==='-';const [a,b='']=s.replace('-','').split('.');return (neg?-1n:1n)*(BigInt(a)*S+BigInt(b.padEnd(12,'0')));}
function fmt(v){let n=v<0n?-v:v;return(v<0n?'-':'')+(n/S)+'.'+(n%S).toString().padStart(12,'0').replace(/0+$/,'').padEnd(1,'0');}
function mul(a,b){return a*b/S;}function div(a,b){if(!b)throw Error('DIV_BY_ZERO');return a*S/b;}
function feeOf(f,base){const n=d(f.commission??'0');if(n<0n)throw Error('NEGATIVE_FEE');if(!n)return 0n;const asset=f.commissionAsset;if(asset==='USDT')return n;if(asset===base)return mul(n,d(f.price));if(f.commission_usdt!==undefined&&f.commission_usdt!==null)return d(f.commission_usdt);throw Error('UNVALUED_FEE:'+asset);}
function allocate({symbol,orders,fills,accountId='spot-primary',metadataByOrder={}}){
 if(!/^[A-Z0-9]+USDT$/.test(symbol))throw Error('INVALID_SYMBOL');
 const base=symbol.slice(0,-4),byOrder=new Map(orders.map(o=>[String(o.orderId),o])),seen=new Set(),qByOrder=new Map(),anomalies=[],lots=[];
 const rows=fills.map(f=>{const id=String(f.id),key=accountId+':'+symbol+':'+id;if(seen.has(key))throw Error('DUPLICATE_FILL_ID');seen.add(key);const order=byOrder.get(String(f.orderId));if(!order||order.symbol!==symbol)throw Error('FILL_ORDER_NOT_FOUND');const qty=d(f.qty),price=d(f.price),quote=f.quoteQty===undefined?mul(qty,price):d(f.quoteQty),fee=d(f.commission??'0');if(qty<=0n||price<=0n||quote<0n||fee<0n||!Number.isFinite(Number(f.time)))throw Error('INVALID_FILL');const row={...f,order,qty,price,quote,fee,feeU:feeOf(f,base),timeMs:Number(f.time)};qByOrder.set(String(f.orderId),(qByOrder.get(String(f.orderId))||0n)+qty);return row;}).sort((a,b)=>a.timeMs-b.timeMs||Number(a.id)-Number(b.id));
 for(const o of orders)if(d(o.executedQty??'0')>0n){const gap=(qByOrder.get(String(o.orderId))||0n)-d(o.executedQty);if(gap>2n||gap< -2n)anomalies.push('INCOMPLETE_ORDER_FILLS:'+o.orderId);}
 for(const f of rows){
   const id=String(f.orderId);
   if(f.order.managed!==true){if(lots.some(l=>l.remaining>0n))anomalies.push('FOREIGN_SYMBOL_ACTIVITY:'+id);continue;}
   if(f.order.side==='BUY'){
     const feeBase=f.commissionAsset===base?f.fee:0n,qty=f.qty-feeBase;if(qty<=0n)throw Error('BUY_QTY_INVALID');
     let l=lots.find(x=>x.buyOrderId===id);
     if(!l){l={buyOrderId:id,entryAt:f.timeMs,exitAt:null,entryQty:0n,grossQty:0n,entryQuote:0n,remaining:0n,costRemaining:0n,costSold:0n,proceeds:0n,pnl:0n,feeEntry:0n,feeAllocated:0n,feeSales:0n,qtySold:0n,exitQuote:0n,sellIds:new Set(),entryIds:[],exitIds:[],realized:[],metadata:metadataByOrder[id]||{}};lots.push(l);}
     l.entryAt=Math.min(l.entryAt,f.timeMs);l.entryQty+=qty;l.grossQty+=f.qty;l.remaining+=qty;l.entryQuote+=f.quote;l.costRemaining+=f.quote+(f.commissionAsset===base?0n:f.feeU);l.feeEntry+=f.feeU;l.entryIds.push(String(f.id));continue;
   }
   if(f.order.side!=='SELL')throw Error('INVALID_SIDE');
   let remaining=f.qty+(f.commissionAsset===base?f.fee:0n),total=remaining;
   const received=f.quote-(f.commissionAsset===base?0n:f.feeU);if(received<0n)throw Error('NEGATIVE_PROCEEDS');
   for(const l of lots){if(remaining<=0n)break;if(l.remaining<=0n)continue;
     const take=remaining<l.remaining?remaining:l.remaining,share=div(take,total),prior=l.remaining;
     const cost=mul(l.costRemaining,div(take,prior)),proceeds=mul(received,share),feeSale=mul(f.feeU,share),feeEntry=mul(l.feeEntry-l.feeAllocated,div(take,prior));
     l.remaining-=take;l.costRemaining-=cost;l.costSold+=cost;l.proceeds+=proceeds;l.pnl+=proceeds-cost;l.feeSales+=feeSale;l.feeAllocated+=feeEntry;l.qtySold+=mul(f.qty,share);l.exitQuote+=mul(f.quote,share);l.exitAt=l.exitAt===null?f.timeMs:Math.max(l.exitAt,f.timeMs);l.sellIds.add(id);l.exitIds.push(String(f.id));
     l.realized.push({at:new Date(f.timeMs).toISOString(),fill_id:String(f.id),order_id:id,cost_usdt:fmt(cost),proceeds_usdt:fmt(proceeds),net_pnl_usdt:fmt(proceeds-cost),fees_usdt:fmt(feeSale+feeEntry)});remaining-=take;
   }
   if(remaining>2n)anomalies.push('SELL_WITHOUT_MANAGED_INVENTORY:'+id);
 }
 return{anomalies:[...new Set(anomalies)],trades:lots.map(l=>{const m=l.metadata,hasSale=l.qtySold>0n,fees=l.feeSales+l.feeAllocated;return{
  trade_id:accountId+':'+symbol+':'+l.buyOrderId,symbol,account_id:accountId,buy_order_id:l.buyOrderId,
  entry_timestamp:new Date(l.entryAt).toISOString(),exit_timestamp:hasSale?new Date(l.exitAt).toISOString():null,
  entry_price:l.grossQty?fmt(div(l.entryQuote,l.grossQty)):null,exit_price:hasSale?fmt(div(l.exitQuote,l.qtySold)):null,
  quantity:fmt(l.entryQty),remaining_quantity:fmt(l.remaining),capital_allocated_usdt:fmt(l.entryQuote),cost_basis_sold_usdt:fmt(l.costSold),
  gross_pnl_usdt:hasSale?fmt(l.pnl+fees):null,fees_usdt:hasSale?fmt(fees):null,fees_total_entry_usdt:fmt(l.feeEntry),
  net_pnl_usdt:hasSale?fmt(l.pnl):null,net_pnl_pct:hasSale&&l.costSold>0n?fmt(mul(div(l.pnl,l.costSold),d('100'))):null,
  status:l.remaining<=2n&&hasSale?'CLOSED':hasSale?'PARTIALLY_CLOSED':'OPEN',
  sell_order_ids:[...l.sellIds],entry_fill_ids:l.entryIds,exit_fill_ids:l.exitIds,realized_events:l.realized,
  strategy_version:m.strategy_version??null,strategy_hash:m.strategy_hash??null,capital_at_entry_usdt:m.capital_at_entry_usdt??null,
  radar_signal:m.radar_signal??null,v42_prediction:m.v42_prediction??null,qubo_decision:m.qubo_decision??null,
  entry_v61_decision:m.entry_v61_decision??null,entry_reason:m.entry_reason??null,exit_reason:m.exit_reason??null,
  accounting_method:'FIFO_PER_MANAGED_BUY_ORDER_V1',
  reconciliation_status:anomalies.length?'REVIEW_REQUIRED':'COMPLETE',anomalies:[...new Set(anomalies)]
 };})};
}
module.exports={allocate,d,fmt,mul,div,SCALE:S};
