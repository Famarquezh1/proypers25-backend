'use strict';
// Offline fixture: every request is replaced; no account credentials or external network.
const fs=require('node:fs');
const path=require('node:path');
const mode=process.env.SPOT_TEST_CASE||'normal-v10';
const folder=process.env.SPOT_TEST_DIR;
if(!folder)throw new Error('FIXTURE_DIRECTORY_REQUIRED');
const ledgerFile=path.join(folder,'exchange.json');
let ledger=fs.existsSync(ledgerFile)?JSON.parse(fs.readFileSync(ledgerFile,'utf8')):{buys:[],stops:[],qty:0,cash:mode==='minimum-protection'?45:1000};
if(mode==='duplicate-position'&&!ledger.qty)ledger.qty=1;
const symbol=process.env.SIGNAL_SYMBOL;
const asset=symbol.replace(/USDT$/,'');
function save(){fs.writeFileSync(ledgerFile,JSON.stringify(ledger),{mode:0o600});}
function response(value,status=200){return new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});}
const native=mode==='stop-limit'?'STOP_LOSS_LIMIT':'STOP_LOSS';
const info={symbol,baseAsset:asset,quoteAsset:'USDT',status:'TRADING',isSpotTradingAllowed:true,
  orderTypes:['MARKET',native],filters:[{filterType:'LOT_SIZE',minQty:'0.001',stepSize:'0.001',maxQty:'10000'},
    {filterType:'MARKET_LOT_SIZE',minQty:'0.001',stepSize:'0.001',maxQty:'10000'},
    {filterType:'PRICE_FILTER',minPrice:'0.01',maxPrice:'1000000',tickSize:'0.01'},
    {filterType:'MIN_NOTIONAL',minNotional:'5',applyToMarket:true}]};
function bars(s,n=290){
  return Array.from({length:n},(_,i)=>{
    const strong=mode==='normal-core'&&s!== 'BTCUSDT';
    const c=strong?(i<277?96:96+Math.min(12,i-276)/3):100;
    const volume=strong&&i>=283?10000:1000;
    const trades=strong&&i===288?1000:100;
    return [Date.now()-(n-i)*300000,String(c),String(c*1.0001),String(c*.9999),String(c),'100',Date.now(),String(volume),trades];
  });
}
const realTimeout=global.setTimeout;
global.setTimeout=(callback,delay,...args)=>realTimeout(callback,delay<=3500?1:delay,...args);
global.fetch=async(input,init={})=>{
  const url=new URL(typeof input==='string'?input:input.url);
  if(!/^api[1-4]?\.binance\.com$/.test(url.hostname))throw new Error('FIXTURE_EXTERNAL_REQUEST_DENIED');
  const p=url.searchParams,method=(init.method||'GET').toUpperCase();
  if(url.pathname==='/api/v3/ping')return response({});
  if(url.pathname==='/api/v3/time')return response({serverTime:Date.now()});
  if(url.pathname==='/api/v3/account')return response({canTrade:true,balances:[{asset:'USDT',free:String(ledger.cash),locked:'0'},
    {asset,free:String(ledger.qty),locked:'0'}]});
  if(url.pathname==='/sapi/v1/account/apiRestrictions')return response({enableWithdrawals:false,ipRestrict:true,enableReading:true,enableSpotAndMarginTrading:true});
  if(url.pathname==='/api/v3/exchangeInfo')return response({symbols:[info]});
  if(url.pathname==='/api/v3/openOrders')return response([]);
  if(url.pathname==='/api/v3/ticker/24hr')return response({symbol,lastPrice:'100',priceChangePercent:'5',quoteVolume:'10000000'});
  if(url.pathname==='/api/v3/ticker/price')return response([{symbol,price:'100'},{symbol:'BTCUSDT',price:'100'}]);
  if(url.pathname==='/api/v3/ticker/bookTicker')return response({symbol,bidPrice:'99.99',askPrice:'100.01'});
  if(url.pathname==='/api/v3/depth')return response({bids:Array.from({length:20},(_,i)=>[String(99.99-i*.01),'100']),asks:Array.from({length:20},(_,i)=>[String(100.01+i*.01),'100'])});
  if(url.pathname==='/api/v3/aggTrades')return response(Array.from({length:100},(_,i)=>({p:'100',q:'1',m:i%2===0})));
  if(url.pathname==='/api/v3/klines')return response(bars(p.get('symbol'),Number(p.get('limit')||290)));
  if(url.pathname==='/api/v3/order'&&method==='POST'){
    if(p.get('side')==='BUY'){
      const quote=Number(p.get('quoteOrderQty')),qty=quote/100;
      const order={symbol,orderId:ledger.buys.length+1,status:'FILLED',executedQty:String(qty),cummulativeQuoteQty:String(quote),clientOrderId:p.get('newClientOrderId')};
      ledger.buys.push(order);ledger.qty+=qty*(mode==='accepted-timeout'?0.999:1);ledger.cash-=quote;save();
      if(mode==='accepted-timeout')throw new Error('FIXTURE_RESPONSE_LOST_AFTER_FILL');
      return response(order);
    }
    const qty=Number(p.get('quantity')),stop=Number(p.get('stopPrice')),price=Number(p.get('price')||stop);
    if(qty*price<5)return response({code:-1013,msg:'Filter failure: MIN_NOTIONAL'},400);
    if(mode==='protection-rejected')return response({code:-2010,msg:'FIXTURE_PROTECTION_REJECTED'},400);
    const order={symbol,orderId:100+ledger.stops.length,type:p.get('type'),side:'SELL',status:'NEW',origQty:String(qty),executedQty:'0',stopPrice:String(stop),price:p.get('price'),clientOrderId:p.get('newClientOrderId')};
    ledger.stops.push(order);save();return response(order);
  }
  throw new Error(`FIXTURE_ROUTE_NOT_DEFINED ${method} ${url.pathname}`);
};
save();
