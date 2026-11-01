'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const {createTransitions}=require('./protection-transition.cjs');
const {transform}=require('./exit-integration.cjs');
const {makeFetch}=require('./readonly.cjs');
const info={symbol:'BTCUSDT',status:'TRADING',isSpotTradingAllowed:true,filters:[
  {filterType:'LOT_SIZE',stepSize:'0.1',minQty:'0.1',maxQty:'100'},
  {filterType:'PRICE_FILTER',tickSize:'1',minPrice:'1',maxPrice:'10000'},
  {filterType:'NOTIONAL',minNotional:'5',maxNotional:'100000'}]};
function fixture(mode){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'spot-transition-'));
  const old={symbol:'BTCUSDT',orderId:7,clientOrderId:'proypers-gh-protect-old',orderListId:-1,side:'SELL',type:'STOP_LOSS',status:'NEW',origQty:'2',executedQty:'0',stopPrice:'90'};
  const orders=[old];let posts=0,replacements=0;
  const transport=async(input,init={})=>{
    const u=new URL(input),p=u.searchParams;
    if(u.pathname==='/api/v3/ticker/price')return Response.json({price:'100'});
    if(init.method==='GET'){
      const order=orders.find(o=>p.has('orderId')?String(o.orderId)===p.get('orderId'):o.clientOrderId===p.get('origClientOrderId'));
      return order?Response.json(order):Response.json({code:-2013},{status:400});
    }
    posts++;
    const disk=JSON.parse(fs.readFileSync(path.join(dir,fs.readdirSync(dir)[0])));
    assert(['INTENT','RESTORE_INTENT'].includes(disk.state));
    if(u.pathname.endsWith('cancelReplace')){
      replacements++;
      assert.equal(p.get('cancelRestrictions'),'ONLY_NEW');assert.equal(p.get('cancelReplaceMode'),'STOP_ON_FAILURE');
      if(mode==='retained')return Response.json({data:{cancelResult:'FAILURE',newOrderResult:'NOT_ATTEMPTED'}},{status:400});
      if(mode==='old-filled'){old.status='FILLED';return Response.json({data:{cancelResult:'FAILURE',newOrderResult:'NOT_ATTEMPTED'}},{status:400});}
      if(mode==='unknown-not-accepted')throw new Error('disconnect before result');
      old.status='CANCELED';
      if(['new-rejected','restore-lost','restore-rejected'].includes(mode))return Response.json({data:{cancelResult:'SUCCESS',newOrderResult:'FAILURE'}},{status:409});
      orders.push({...old,orderId:8,clientOrderId:p.get('newClientOrderId'),type:p.get('type'),stopPrice:p.get('stopPrice')||'0',
        status:p.get('type')==='MARKET'?'FILLED':'NEW',executedQty:p.get('type')==='MARKET'?'2':'0'});
      if(mode==='lost')throw new Error('accepted response lost');
      return Response.json({cancelResult:'SUCCESS',newOrderResult:'SUCCESS'});
    }
    if(mode==='restore-rejected')return Response.json({code:-1013},{status:400});
    orders.push({...old,orderId:9,clientOrderId:p.get('newClientOrderId'),status:'NEW'});
    if(mode==='restore-lost')throw new Error('restore accepted response lost');
    return Response.json(orders.at(-1));
  };
  const create=(t=transport)=>createTransitions({transport:t,dir,key:'fixture',secret:'fixture'});
  const request={symbol:'BTCUSDT',oldOrder:old,stopPrice:95,info};
  return {dir,old,orders,transport,create,request,posts:()=>posts,replacements:()=>replacements,clean:()=>fs.rmSync(dir,{recursive:true,force:true})};
}
test('replacement survives accepted reply loss without a second cancel/replace',async()=>{
  const f=fixture('lost');try{
    await assert.rejects(f.create().replace(f.request),/RECOVERY_REQUIRED/);
    assert.equal((await f.create().recover()).pending,0);assert.equal(f.create().records()[0].state,'REPLACED');assert.equal(f.replacements(),1);
    assert.equal(f.orders.filter(o=>o.status==='NEW').length,1);
  }finally{f.clean();}
});
test('definitive cancellation refusal keeps the old stop; fill race never submits an extra SELL',async()=>{
  for(const [mode,state] of [['retained','OLD_RETAINED'],['old-filled','CLOSED']]){const f=fixture(mode);try{
    assert.equal((await f.create().replace(f.request)).state,state);assert.equal(f.posts(),1);
  }finally{f.clean();}}
});
test('confirmed new-stop rejection restores old protection using a durable deterministic ID',async()=>{
  const f=fixture('new-rejected');try{
    assert.equal((await f.create().replace(f.request)).state,'RESTORED');assert.equal(f.posts(),2);
    assert.equal(f.orders.at(-1).stopPrice,'90');assert(f.orders.at(-1).clientOrderId.length<=36);
    await f.create().recover();assert.equal(f.posts(),2);
  }finally{f.clean();}
});
test('lost restoration reply is queried on restart and never resubmitted',async()=>{
  const f=fixture('restore-lost');try{
    await assert.rejects(f.create().replace(f.request),/RECOVERY_REQUIRED/);
    assert.equal((await f.create().recover()).pending,0);assert.equal(f.create().records()[0].state,'RESTORED');assert.equal(f.posts(),2);
  }finally{f.clean();}
});
test('ambiguous no-result and rejected restoration keep all new buys blocked',async()=>{
  for(const mode of ['unknown-not-accepted','restore-rejected']){const f=fixture(mode);try{
    await assert.rejects(f.create().replace(f.request),/RECOVERY_REQUIRED/);
    assert.equal((await f.create().recover()).pending,1);
    const posts=f.posts();await assert.rejects(f.create().replace(f.request),/RECOVERY_PENDING/);assert.equal(f.posts(),posts);
  }finally{f.clean();}}
});
test('invalid filters fail before cancellation and the staging transport prevents live replacement',async()=>{
  const f=fixture('normal');try{
    await assert.rejects(f.create().replace({...f.request,stopPrice:90}),/FILTERS_REFUSED/);assert.equal(f.posts(),0);
    const readonly=makeFetch(()=>assert.fail('no live mutation'));
    const s=f.create((u,i)=>i.method==='POST'?readonly(u,i):f.transport(u,i));
    assert.equal((await s.replace(f.request)).state,'STAGING_BLOCKED');assert.equal(f.old.status,'NEW');assert.equal(f.posts(),0);
  }finally{f.clean();}
});
test('protected MARKET exit reconciles an accepted fill without re-selling',async()=>{
  const f=fixture('lost');try{
    await assert.rejects(f.create().replace({...f.request,kind:'EXIT',managedQty:2}),/RECOVERY_REQUIRED/);
    assert.equal((await f.create().recover()).pending,0);assert.equal(f.create().records()[0].state,'CLOSED');assert.equal(f.posts(),1);
  }finally{f.clean();}
});
test('all pinned exit integration anchors compile and unknown source fails closed',()=>{
  const repo=process.env.PROYPERS_CHECK_REPO||path.resolve(__dirname,'../../..');
  for(const name of ['github-spot-v61-protect.js','github-spot-auto-exit-legacy.js','github-spot-auto-exit-legacy-v10-aware.js','github-spot-orphan-protect.js']){
    const original=fs.readFileSync(path.join(repo,'backend/scripts',name),'utf8').replace(/\r\n/g,'\n');
    const patched=transform(original,name);assert.notEqual(patched,original);new vm.Script(patched,{filename:name});
    assert.throws(()=>transform('invalid',name),/SOURCE_MISMATCH/);
  }
});
test('partially filled native stop retains its protected remainder without a second SELL',async()=>{
  const f=fixture('normal');try{
    f.old.status='PARTIALLY_FILLED';f.old.executedQty='.5';
    assert.equal((await f.create().replace(f.request)).state,'OLD_RETAINED');assert.equal(f.posts(),0);
  }finally{f.clean();}
});
test('orphan stop replacement preserves its ownership prefix',async()=>{
  const f=fixture('lost');try{
    f.old.clientOrderId='proypers-gh-orphan-original';
    await assert.rejects(f.create().replace(f.request),/RECOVERY_REQUIRED/);
    assert.equal((await f.create().recover()).pending,0);
    assert.match(f.orders.at(-1).clientOrderId,/^proypers-gh-orphan-/);assert(f.orders.at(-1).clientOrderId.length<=36);
  }finally{f.clean();}
});
