'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {createExitSafety}=require('./exit-safety.cjs');
const {atomic}=require('./journal.cjs');
const {makeFetch}=require('./readonly.cjs');
const buy={symbol:'BTCUSDT',orderId:1,clientOrderId:'proypers-gh-base',side:'BUY',status:'FILLED',time:100,executedQty:'2'};
const request='https://api.binance.com/api/v3/order?symbol=BTCUSDT&side=SELL&type=MARKET&quantity=2&newClientOrderId=random';
function fixture(mode){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-exit-test-'));
  let posts=0,accepted=null,lookups=0;
  const transport=async(input,init={})=>{
    const u=new URL(input);
    if(init.method==='POST'){
      posts++;
      // Prove intent exists on disk before the simulated exchange receives the request.
      const state=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0])));assert.equal(state.state,'SELL_INTENT');
      if(mode==='rejected')return Response.json({code:-1013},{status:400});
      if(mode!=='not-found')accepted={symbol:'BTCUSDT',orderId:2,clientOrderId:u.searchParams.get('newClientOrderId'),side:'SELL',type:'MARKET',status:mode==='partial'?'CANCELED':'FILLED',origQty:'2',executedQty:mode==='partial'?'1':'2'};
      if(['lost','not-found'].includes(mode))throw new Error('simulated connection loss');
      return Response.json(accepted);
    }
    if(u.pathname==='/api/v3/allOrders')return Response.json(mode==='prior-native'?[buy,{side:'SELL',status:'FILLED',time:200}]:[buy]);
    if(u.pathname==='/api/v3/order'){
      lookups++;return accepted?Response.json(accepted):Response.json({code:-2013},{status:400});
    }
    assert.fail('unexpected transport route');
  };
  const create=()=>createExitSafety({transport,dir,key:'fixture',secret:'fixture'});
  return {dir,create,posts:()=>posts,lookups:()=>lookups,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('accepted SELL with lost reply is reconciled after restart, never resubmitted',async()=>{
  const f=fixture('lost');try{
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/UNKNOWN/);
    const restarted=f.create();assert.equal(restarted.pending(),1);
    assert.equal((await restarted.recover()).pending,0);
    assert.equal(restarted.records()[0].state,'SELL_FILLED');
    assert.equal((await restarted.fetch(request+'&ignored=retry',{method:'POST'})).status,200);
    assert.equal(f.posts(),1);assert.equal(f.lookups(),1);
    assert(restarted.records()[0].clientId.length<=36);
  }finally{f.clean();}
});
test('unknown SELL absent from exchange remains blocked through repeated recovery',async()=>{
  const f=fixture('not-found');try{
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/UNKNOWN/);
    for(let i=0;i<2;i++)assert.equal((await f.create().recover()).pending,1);
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/RECOVERY_PENDING/);
    assert.equal(f.posts(),1);
  }finally{f.clean();}
});
test('process death after fsync intent and before dispatch does not authorize a blind retry',async()=>{
  const f=fixture('not-found');try{
    atomic(path.join(f.dir,'a'.repeat(32)+'.json'),{version:1,id:'a'.repeat(32),symbol:'BTCUSDT',clientId:'proypers-gh-exit-crash',state:'SELL_INTENT'});
    assert.equal((await f.create().recover()).pending,1);
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/RECOVERY_PENDING/);assert.equal(f.posts(),0);
  }finally{f.clean();}
});
test('partial terminal SELL and rejected SELL require review and suppress further dispatch',async()=>{
  for(const mode of ['partial','rejected']){const f=fixture(mode);try{
    await f.create().fetch(request,{method:'POST'});assert.equal(f.create().pending(),1);
    assert.equal((await f.create().recover()).pending,1);
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/RECOVERY_PENDING/);assert.equal(f.posts(),1);
  }finally{f.clean();}}
});
test('a native stop already filled prevents a subsequent discretionary SELL',async()=>{
  const f=fixture('prior-native');try{
    await assert.rejects(f.create().fetch(request,{method:'POST'}),/PRIOR_SELL/);assert.equal(f.posts(),0);
  }finally{f.clean();}
});
test('cancel-first, cancelReplace, bulk/OCO cancellation and pyramiding are blocked before transport',async()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-retain-stop-'));let calls=0;
  try{
    const s=createExitSafety({transport:()=>{calls++;assert.fail('old stop must remain untouched');},dir,key:'fixture',secret:'fixture'});
    for(const [endpoint,method,query] of [['order','DELETE','orderId=7'],['openOrders','DELETE','symbol=BTCUSDT'],['orderList','DELETE','orderListId=7'],['order/cancelReplace','POST','cancelOrderId=7'],['order','POST','side=BUY&type=MARKET&quoteOrderQty=10']]){
      await assert.rejects(s.fetch(`https://api.binance.com/api/v3/${endpoint}?${query}`,{method}),/MUTATION_REFUSED/);
    }
    assert.equal(calls,0);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('SELL adapter preserves immutable staging barrier',async()=>{
  const f=fixture('normal');try{
    const get=makeFetch(()=>assert.fail('no live exchange write'));
    const s=createExitSafety({transport:(input,init)=>init.method==='GET'?Promise.resolve(Response.json([buy])):get(input,init),dir:f.dir,key:'fixture',secret:'fixture'});
    assert.equal((await s.fetch(request,{method:'POST'})).status,403);assert.equal(s.pending(),1);
  }finally{f.clean();}
});
test('pending SELL blocks a new entry in the real entry worker before any network',()=>{
  const f=fixture('normal');try{
    const state=path.join(f.dir,'exit-state');fs.mkdirSync(state);
    atomic(path.join(state,'b'.repeat(32)+'.json'),{version:1,symbol:'BTCUSDT',clientId:'proypers-gh-exit-block',state:'SELL_UNKNOWN'});
    const r=spawnSync(process.execPath,['--require',path.join(__dirname,'readonly.cjs'),path.join(__dirname,'entry-safe.cjs'),'--recover-only'],
      {env:{PATH:process.env.PATH,PROYPERS_STATE_DIR:f.dir,PROYPERS_STAGING_PRELOAD:'1'},encoding:'utf8',timeout:3000});
    assert.equal(r.status,2);assert.match(r.stderr,/ENTRY_SAFETY_BLOCKED/);
  }finally{f.clean();}
});
test('corrupt or unknown persisted exit state fails closed',()=>{
  const f=fixture('normal');try{
    atomic(path.join(f.dir,'c'.repeat(32)+'.json'),{version:1,symbol:'BTCUSDT',clientId:'example',state:'INVALID'});
    assert.throws(()=>f.create().pending(),/REVIEW_REQUIRED/);
  }finally{f.clean();}
});
