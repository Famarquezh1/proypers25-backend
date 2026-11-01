'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto');
const {EventEmitter}=require('node:events');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {candidateFetch}=require('./candidate-preload.cjs');
function order(params={},endpoint='order'){
  const p=new URLSearchParams({symbol:'SOLUSDT',side:'BUY',type:'MARKET',quoteOrderQty:'10',newClientOrderId:'proypers-gh-test',timestamp:'100',recvWindow:'5000',...params});
  for(const [k,v] of [...p])if(v==='DELETE_PARAM')p.delete(k);
  p.set('signature',crypto.createHmac('sha256','fixture-secret').update(p.toString()).digest('hex'));
  return `https://api.binance.com/api/v3/${endpoint}?${p}`;
}
function setup(options={}){
  let calls=0,authorized=0,locked=0;
  const f=candidateFetch({role:'entry-safe.cjs',lane:'CORE',key:'fixture-key',secret:'fixture-secret',
    authorize:()=>{authorized++;},lock:()=>{locked++;},read:()=>assert.fail('unexpected read'),
    request:(url,opts,callback)=>{
      calls++;assert.equal(opts.family,4);assert.equal(opts.method,'POST');
      const req=new EventEmitter();req.end=()=>{const res=new EventEmitter();res.statusCode=200;callback(res);queueMicrotask(()=>{res.emit('data',Buffer.from('{"orderId":1}'));res.emit('end');});};return req;
    },...options});
  return {f,calls:()=>calls,authorized:()=>authorized,locked:()=>locked};
}
const post={method:'POST',headers:{'X-MBX-APIKEY':'fixture-key'}};
test('dormant candidate permits a signed CORE order only after authorization and exclusive lock',async()=>{
  const s=setup();assert.equal((await s.f(order(),post)).status,200);assert.equal(s.calls(),1);assert.equal(s.authorized(),1);assert.equal(s.locked(),1);
  for(const hook of ['authorize','lock']){
    const s=setup({[hook]:()=>{throw new Error('required');}});await assert.rejects(s.f(order(),post),/required/);assert.equal(s.calls(),0);
  }
});
test('candidate denies V10 buys, exit-worker buys, excessive sizing, withdrawals, bulk cancel and unsigned writes',async()=>{
  for(const [options,url,init] of [
    [{lane:'V10_HUNTER'},order(),post],[{role:'exit-worker.cjs'},order(),post],[{},order({quoteOrderQty:'71'}),post],
    [{},'https://api.binance.com/sapi/v1/capital/withdraw/apply',post],[{},order(),{...post,method:'DELETE'}],
    [{},order().replace(/signature=.*/,'signature=invalid'),post],[{},order(),{...post,headers:{'X-MBX-APIKEY':'other'}}],
    [{},order().replace('api.binance.com','example.org'),post]
  ]){
    const s=setup(options);await assert.rejects(s.f(url,init));assert.equal(s.calls(),0);
  }
});
test('candidate permits only guarded SELL cancelReplace and standalone native stops',async()=>{
  const s=setup({role:'exit-worker.cjs'});
  const sell={side:'SELL',type:'STOP_LOSS',quantity:'0.1',quoteOrderQty:'DELETE_PARAM',stopPrice:'95'};
  assert.equal((await s.f(order(sell),post)).status,200);
  const replace={...sell,cancelOrderId:'7',cancelReplaceMode:'STOP_ON_FAILURE',cancelRestrictions:'ONLY_NEW',orderRateLimitExceededMode:'DO_NOTHING'};
  assert.equal((await s.f(order(replace,'order/cancelReplace'),post)).status,200);
  await assert.rejects(s.f(order({...replace,cancelReplaceMode:'ALLOW_FAILURE'},'order/cancelReplace'),post),/REPLACEMENT_REFUSED/);assert.equal(s.calls(),2);
});
test('candidate preload without an owner credential refuses startup before any order can run',()=>{
  const r=spawnSync(process.execPath,['--require',path.join(__dirname,'candidate-preload.cjs'),'-e',"process.exit(99)"],{
    env:{PATH:process.env.PATH,PROYPERS_CANDIDATE_PRELOAD:'1'},encoding:'utf8',timeout:3000});
  assert.notEqual(r.status,0);assert.notEqual(r.status,99);assert.match(r.stderr,/OWNER_AUTHORIZATION_REQUIRED/);
});
