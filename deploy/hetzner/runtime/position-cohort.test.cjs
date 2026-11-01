'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {splitInventory,resolveManagedResidual}=require('./position-cohort.cjs');
const info={filters:[{filterType:'LOT_SIZE',stepSize:'.001',minQty:'.001'},{filterType:'NOTIONAL',minNotional:'5'}]};
const old=100000,newTime=old+30*86400000;
const fill=(id,orderId,time,isBuyer,qty,quoteQty,commission=0,commissionAsset='USDT')=>({id,orderId,time,isBuyer,qty,quoteQty,commission,commissionAsset});
function scenario(){return [fill(1,1,old,true,10,1000),fill(2,2,old+1,false,9.99999,999.999),fill(3,3,newTime,true,1,100)];}
const run=(trades,orders=[])=>splitInventory({trades,orders,baseAsset:'SOL',info});
test('old sub-lot dust cannot age a new position; old cost and quantity are conserved separately',()=>{
  const c=run(scenario());assert.equal(c.startTime,newTime);assert.equal(c.entryPrice,100);assert(Math.abs(c.dustQuantity-.00001)<1e-10);assert(Math.abs(c.totalQuantity-1.00001)<1e-10);assert(Math.abs(c.totalCostQuote-100.001)<1e-9);
});
test('below-notional inventory also rolls into historical dust at a distinct buy',()=>{
  const c=run([fill(1,1,old,true,.01,1),fill(2,2,newTime,true,1,100)]);assert.equal(c.startTime,newTime);assert.equal(c.dustCostQuote,1);
});
test('genuine overlapping operational buys retain the first entry time and weighted basis',()=>{
  const c=run([fill(1,1,old,true,1,100),fill(2,2,newTime,true,1,120)]);assert.equal(c.startTime,old);assert.equal(c.entryPrice,110);assert.equal(c.dustQuantity,0);
});
test('multiple fills of a single order retain lifecycle identity below the temporary minimum',()=>{
  const c=run([fill(1,1,old,true,.01,1),fill(2,1,old+10,true,.99,99)]);assert.equal(c.startTime,old);assert.equal(c.quantity,1);
});
test('existing native protection prevents a lifecycle reset for small protected inventory',()=>{
  const c=run([fill(1,1,old,true,.01,1),fill(2,2,newTime,true,1,100)],[{side:'SELL',type:'STOP_LOSS',status:'NEW',time:old+1,clientOrderId:'proypers-gh-protect-old'}]);assert.equal(c.startTime,old);assert.equal(c.dustQuantity,0);
});
test('FIFO sales and base/quote fees preserve total remaining basis without losing historical dust',()=>{
  const c=run([...scenario(),fill(4,4,newTime+1,false,.5,55,.01,'USDT')]);assert(Math.abs(c.totalQuantity-.50001)<1e-9);assert(Math.abs(c.totalCostQuote-50.001)<1e-8);
  const f=run([fill(1,1,old,true,1,100,.001,'SOL'),fill(2,2,old+1,false,.5,50,.001,'SOL')]);assert(Math.abs(f.quantity-.498)<1e-10);
});
test('original resolver quantities/native protection stay unchanged while contaminated identity is replaced',()=>{
  const orders=[{orderId:1,side:'BUY',status:'FILLED',time:old,updateTime:old,executedQty:'10',cummulativeQuoteQty:'1000',clientOrderId:'proypers-gh-old'},
    {orderId:2,side:'SELL',status:'FILLED',time:old+1,updateTime:old+1,executedQty:'9.99999',clientOrderId:'proypers-gh-exit-old'},
    {orderId:3,side:'BUY',status:'FILLED',time:newTime,updateTime:newTime,executedQty:'1',cummulativeQuoteQty:'100',clientOrderId:'proypers-gh-new'}];
  const options={buy:orders[2],orders,trades:scenario(),ownedTotal:1.00001,baseAsset:'SOL',info,forceReconstruct:true};
  const original=require('../../../backend/services/spotManagedResidual').resolveManagedResidual(options),fixed=resolveManagedResidual(options);
  assert.equal(original.startTime,old);assert.equal(fixed.startTime,newTime);assert.equal(fixed.managedQty,original.managedQty);assert.equal(fixed.openProtect,original.openProtect);
  assert.throws(()=>resolveManagedResidual({...options,ownedTotal:.5}),/BALANCE_REVIEW/);
});
test('missing or corrupt filters refuse to replace lifecycle identity',()=>{
  assert.throws(()=>splitInventory({trades:scenario(),orders:[],baseAsset:'SOL',info:{filters:[]}}),/FILTER_REVIEW/);
});
test('sold dust bypasses identity reconciliation; operable and protected inventory still reaches it',()=>{
  const fs=require('node:fs'),path=require('node:path');
  const {transform}=require('./exit-integration.cjs');
  const src=fs.readFileSync(path.resolve(__dirname,'../../../backend/scripts/github-spot-auto-exit-legacy.js'),'utf8');
  const out=transform(src,'github-spot-auto-exit-legacy.js');
  const start=out.indexOf('    if (require('),end=out.indexOf('    const multipleManagedBuys =');
  assert(start>=0&&end>start&&end<out.indexOf('    const managed = resolveManagedResidual'));
  const reach=new Function('require','info','ownedTotal','currentPrice','openProtect','symbol',`let reached=false; for(let i=0;i<1;i++){${out.slice(start,end)} reached=true;}return reached;`);
  assert.equal(reach(require,info,.00001,100,null,'TESTUSDT'),false);
  assert.equal(reach(require,info,1,100,null,'TESTUSDT'),true);
  assert.equal(reach(require,info,.00001,100,{orderId:1},'TESTUSDT'),true);
});
