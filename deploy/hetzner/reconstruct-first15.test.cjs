'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {allocate}=require('./reconstruct-first15.cjs');
const order=(id,side,qty)=>({symbol:'SOLUSDT',orderId:id,side,executedQty:String(qty),time:id});
const fill=(id,orderId,time,qty,price,commission,commissionAsset)=>({id,orderId,time,qty:String(qty),price:String(price),quoteQty:String(qty*price),commission:String(commission),commissionAsset});
test('base-asset entry fee and quote-asset exit fee reconcile net cost without double counting',()=>{
  const lots=allocate([order(1,'BUY',1),order(2,'SELL',.999)],[fill(1,1,1,1,100,.001,'SOL'),fill(2,2,2,.999,110,.10989,'USDT')],new Map([['2',.10989]]));
  assert(Math.abs(lots[0].proceeds-109.78011)<1e-9);assert.equal(lots[0].remaining,0);assert.equal(lots[0].allocatedCost,100);assert(Math.abs(lots[0].commissionQuote-.20989)<1e-9);
});
test('FIFO allocation follows execution time rather than stop creation time and preserves unsold basis',()=>{
  const orders=[order(1,'BUY',1),order(2,'SELL',1.5),order(3,'BUY',1)];
  const fills=[fill(1,1,10,1,100,0,'USDT'),fill(2,2,30,1.5,120,0,'USDT'),fill(3,3,20,1,110,0,'USDT')];
  const lots=allocate(orders,fills,new Map([['1',0],['2',0],['3',0]]));
  assert.equal(lots[0].remaining,0);assert.equal(lots[0].proceeds,120);assert.equal(lots[1].remaining,.5);assert.equal(lots[1].costRemaining,55);assert.equal(lots[1].proceeds,60);
});
test('missing fills, unvalued fees and unmatched sale inventory refuse attribution',()=>{
  assert.throws(()=>allocate([order(1,'BUY',1)],[],new Map()),/MISSING/);
  assert.throws(()=>allocate([order(1,'BUY',1)],[fill(1,1,1,1,100,.001,'BNB')],new Map()),/UNVALUED/);
  assert.throws(()=>allocate([order(2,'SELL',1)],[fill(2,2,2,1,100,0,'USDT')],new Map([['2',0]])),/OUTSIDE/);
});
