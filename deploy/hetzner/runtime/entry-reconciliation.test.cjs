'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {protectionFits,closureProof}=require('./entry-reconciliation.cjs');
const {createSafety}=require('./execution-safety.cjs');
const info={symbol:'SOXLBUSDT',baseAsset:'SOXLB',status:'TRADING',isSpotTradingAllowed:true,orderTypes:['STOP_LOSS'],filters:[{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001'},{filterType:'PRICE_FILTER',tickSize:'.01'},{filterType:'NOTIONAL',minNotional:'5'}]};
const buy={symbol:info.symbol,orderId:1,clientOrderId:'proypers-gh-buy',side:'BUY',status:'FILLED',time:1000,executedQty:'.065',cummulativeQuoteQty:'5.17595'};
const sale={symbol:info.symbol,orderId:2,clientOrderId:'proypers-gh-protect-alternate',side:'SELL',type:'STOP_LOSS',status:'FILLED',time:2000,executedQty:'.064'};
const trades=[{id:1,orderId:1,time:1001,isBuyer:true,qty:'.065',commission:'.000065',commissionAsset:'SOXLB'},{id:2,orderId:2,time:2001,isBuyer:false,qty:'.064',commission:'.0052384',commissionAsset:'USDT'}];
const record={id:'a'.repeat(32),symbol:info.symbol,buyId:buy.clientOrderId,stopId:'proypers-gh-protect-original',buy,stopPct:.03,state:'PROTECTION_PENDING'};
const fixture=()=>({record,info,total:.000935,price:71.48,openOrders:[],orders:[buy,sale],trades});
test('actual SOXLB fee and lot rounding would reject the original too-small BUY before dispatch',()=>{
  assert.equal(protectionFits({info,price:79.63,quote:5.17595,stopPct:.03}),false);
  assert.equal(protectionFits({info,price:79.63,quote:10,stopPct:.03}),true);
  assert.equal(protectionFits({info:{...info,orderTypes:[]},price:79.63,quote:10,stopPct:.03}),false);
  assert.throws(()=>protectionFits({info:{filters:[]},price:100,quote:10,stopPct:.05}),/FILTER_REVIEW/);
});
test('a confirmed alternate native stop sale reconciles exact base fees and remaining dust',()=>{
  assert.deepEqual(closureProof(fixture()),{reason:'CONFIRMED_EXIT_WITH_DUST',residualQuantity:.000935,sellOrderIds:[2]});
});
test('open orders, operable inventory, mismatched balance, missing fills and truncated histories cannot close an entry',()=>{
  for(const patch of [{openOrders:[sale]},{total:1},{total:.000936},{trades:trades.slice(0,1)},{trades:Array(1000).fill(trades[0])},{orders:[{...buy,status:'PARTIALLY_FILLED'},sale]},{orders:[buy,{...sale,clientOrderId:'external'}]}])assert.equal(closureProof({...fixture(),...patch}),null);
});
test('a later BUY or an unidentified execution cannot be attributed to the old pending entry',()=>{
  assert.equal(closureProof({...fixture(),trades:[...trades,{...trades[0],id:3,time:3000,orderId:3}],orders:[buy,sale,{...buy,time:2999,orderId:3}]}),null);
  assert.equal(closureProof({...fixture(),trades:[...trades,{...trades[1],id:4,time:4000,orderId:4}]}),null);
});
test('recovery closes persisted sold dust once, survives restart, and sends no write or second SELL',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-dust-recovery-')),file=path.join(dir,record.id+'.json');let writes=0;
  fs.writeFileSync(file,JSON.stringify(record));
  const transport=async(input,init={})=>{
    if(init.method!=='GET'){writes++;throw new Error('NO_WRITE_PERMITTED');}const u=new URL(input);
    if(u.pathname==='/api/v3/order')return Response.json({code:-2013},{status:400});
    if(u.pathname==='/api/v3/exchangeInfo')return Response.json({symbols:[info]});
    if(u.pathname==='/api/v3/account')return Response.json({balances:[{asset:'SOXLB',free:'.000935',locked:'0'}]});
    if(u.pathname==='/api/v3/ticker/price')return Response.json({price:'71.48'});
    if(u.pathname==='/api/v3/openOrders')return Response.json([]);
    if(u.pathname==='/api/v3/allOrders')return Response.json([buy,sale]);
    if(u.pathname==='/api/v3/myTrades')return Response.json(trades);
    throw new Error('UNEXPECTED_READ');
  };
  try{
    const make=()=>createSafety({transport,dir,key:'fixture',secret:'fixture'});
    assert.equal((await make().recover()).pending,0);assert.equal(JSON.parse(fs.readFileSync(file)).state,'CLOSED');
    assert.equal((await make().recover()).pending,0);assert.equal(writes,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('minimum protection refusal persists REJECTED without a BUY intent or any exchange write',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'entry-minimum-'));let writes=0;
  const transport=async(input,init={})=>{if(init.method!=='GET'){writes++;throw new Error('NO_WRITE_PERMITTED');}return Response.json(new URL(input).pathname==='/api/v3/exchangeInfo'?{symbols:[info]}:{price:'79.63'});};
  try{
    const s=createSafety({transport,dir,key:'fixture',secret:'fixture',context:{symbol:info.symbol,lane:'CORE',createdAt:'2026-11-02T00:00:00Z'},repo:path.resolve(__dirname,'../../..')});
    const r=await s.fetch('https://api.binance.com/api/v3/order?symbol=SOXLBUSDT&side=BUY&type=MARKET&quoteOrderQty=5.17595',{method:'POST'});
    assert.equal(r.status,400);assert.equal(s.current().state,'REJECTED');assert.equal(s.pending(),0);assert.equal(writes,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
