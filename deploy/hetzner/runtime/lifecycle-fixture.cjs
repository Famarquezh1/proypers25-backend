'use strict';
// Disk-backed fake exchange. No network implementation exists in this fixture.
const fs=require('node:fs'),path=require('node:path');
function exchange(dir,mode='happy'){
  const file=path.join(dir,'exchange.json');
  const load=()=>JSON.parse(fs.readFileSync(file,'utf8'));
  const save=book=>fs.writeFileSync(file,JSON.stringify(book),{mode:0o600});
  const info={symbol:'SOLUSDT',baseAsset:'SOL',quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['MARKET','STOP_LOSS'],filters:[
    {filterType:'LOT_SIZE',minQty:'0.001',maxQty:'10000',stepSize:'0.001'},
    {filterType:'MARKET_LOT_SIZE',minQty:'0.001',maxQty:'10000',stepSize:'0.001'},
    {filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'1000000',tickSize:'0.01'},
    {filterType:'MIN_NOTIONAL',minNotional:mode==='repeated-partial'?'0.01':'5'}]};
  function orderList(book){return [...book.buys,...book.stops,...(book.sells||[])];}
  function create(book,p){
    const quantity=Number(p.get('quantity')),type=p.get('type');
    if(orderList(book).some(o=>o.clientOrderId===p.get('newClientOrderId')))throw new Error('DUPLICATE_CLIENT_ORDER_ID');
    const o={symbol:'SOLUSDT',orderId:1000+orderList(book).length,orderListId:-1,side:'SELL',type,
      clientOrderId:p.get('newClientOrderId'),origQty:String(quantity),executedQty:'0',stopPrice:p.get('stopPrice')||'0',time:Date.now(),status:'NEW'};
    if(type==='MARKET'){
      const partial=['partial','partial-lost','residual-lost','dust','repeated-partial'].includes(mode)&&(!(book.sells||[]).length||mode==='repeated-partial');
      const executed=partial?(mode==='dust'?Math.max(0,quantity-.001):Math.floor(quantity/2*1000)/1000):quantity;
      o.executedQty=String(executed);o.cummulativeQuoteQty=String(executed*102);o.status=partial?'EXPIRED':'FILLED';
      book.qty=Number((book.qty-executed).toFixed(9));book.cash+=executed*102;(book.sells||=[]).push(o);
    }else book.stops.push(o);
    return o;
  }
  const transport=async(input,init={})=>{
    const u=new URL(input),p=u.searchParams,method=init.method||'GET';
    if(u.hostname!=='api.binance.com')throw new Error('OFFLINE_FIXTURE_HOST_REFUSED');
    const book=load(),list=orderList(book);
    if(method==='GET'){
      if(u.pathname==='/api/v3/order'){
        const o=list.find(o=>p.has('orderId')?String(o.orderId)===p.get('orderId'):o.clientOrderId===p.get('origClientOrderId'));
        return o?Response.json(o):Response.json({code:-2013},{status:400});
      }
      if(u.pathname==='/api/v3/allOrders')return Response.json(list);
      if(u.pathname==='/api/v3/exchangeInfo')return Response.json({symbols:[info]});
      if(u.pathname==='/api/v3/ticker/price')return Response.json({symbol:'SOLUSDT',price:'102'});
      if(u.pathname==='/api/v3/openOrders')return Response.json(list.filter(o=>['NEW','PARTIALLY_FILLED'].includes(o.status)&&o.side==='SELL'));
      if(u.pathname==='/api/v3/account'){
        const locked=book.stops.filter(o=>['NEW','PARTIALLY_FILLED'].includes(o.status)).reduce((n,o)=>n+Number(o.origQty)-Number(o.executedQty),0);
        return Response.json({balances:[{asset:'USDT',free:String(book.cash),locked:'0'},{asset:'SOL',free:String(Math.max(0,book.qty-locked)),locked:String(locked)}]});
      }
      throw new Error('OFFLINE_ROUTE_REFUSED');
    }
    if(method!=='POST')throw new Error('OFFLINE_MUTATION_REFUSED');
    if(u.pathname==='/api/v3/order/cancelReplace'){
      const old=list.find(o=>String(o.orderId)===p.get('cancelOrderId'));
      if(mode==='unknown-before-accept')throw new Error('SIMULATED_TIMEOUT');
      if(old.status!=='NEW')return Response.json({cancelResult:'FAILURE',newOrderResult:'NOT_ATTEMPTED'},{status:400});
      old.status='CANCELED';save(book);
      if(mode==='new-rejected')return Response.json({data:{cancelResult:'SUCCESS',newOrderResult:'FAILURE'}},{status:409});
      const created=create(book,p);save(book);
      if(mode==='partial-lost'&&p.get('type')==='MARKET')throw new Error('SIMULATED_REPLY_LOST');
      return Response.json({cancelResult:'SUCCESS',newOrderResult:'SUCCESS',newOrderResponse:created});
    }
    if(u.pathname==='/api/v3/order'){
      if(mode==='inventory-changed')throw new Error('UNEXPECTED_DISPATCH');
      const created=create(book,p);save(book);
      if(mode==='residual-lost'&&book.sells.length===2)throw new Error('SIMULATED_RESIDUAL_REPLY_LOST');
      return Response.json(created);
    }
    throw new Error('OFFLINE_ROUTE_REFUSED');
  };
  return {transport,info,load,save};
}
module.exports={exchange};
