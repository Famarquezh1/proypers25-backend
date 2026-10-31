'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawnSync}=require('node:child_process');
const path=require('node:path');
const {buyPause}=require('./spot-buy-pause.cjs');
test('maintenance pause blocks pyramid BUY and unknown Binance POST before transport',async()=>{
  let calls=0;const fetch=buyPause(()=>{calls++;throw new Error('unexpected network');});
  for(const [url,init] of [
    ['https://api.binance.com/api/v3/order?side=BUY&type=MARKET',{method:'POST'}],
    ['https://api1.binance.com/api/v3/order/cancelReplace?side=BUY',{method:'POST'}],
    ['https://api.binance.com/api/v3/order',{method:'POST',body:'side=BUY'}]
  ])assert.equal((await fetch(url,init)).status,403);
  assert.equal(calls,0);
});
test('existing SELL, GET, cancellation and original GitHub notification calls are preserved',async()=>{
  const seen=[];const fetch=buyPause(async(input,init)=>{seen.push([input,init]);return Response.json({ok:true});});
  const cases=[['https://api.binance.com/api/v3/order?side=SELL&type=STOP_LOSS',{method:'POST'}],
    ['https://api.binance.com/api/v3/order?side=SELL&type=MARKET',{method:'POST'}],
    ['https://api.binance.com/api/v3/account',{method:'GET'}],
    ['https://api.binance.com/api/v3/order?orderId=1',{method:'DELETE'}],
    ['https://api.github.com/repos/example/repo/issues',{method:'POST',body:'{}'}]];
  for(const [url,init] of cases)assert.equal((await fetch(url,init)).status,200);
  assert.deepEqual(seen,cases);
});
test('NODE_OPTIONS passes the pause to an actual nested exit child',()=>{
  const guard=path.join(__dirname,'spot-buy-pause.cjs');
  const child="fetch('https://api.binance.com/api/v3/order?side=BUY',{method:'POST'}).then(r=>process.exit(r.status===403?0:1))";
  const parent=`const r=require('node:child_process').spawnSync(process.execPath,['-e',${JSON.stringify(child)}],{env:process.env,stdio:'inherit'});process.exit(r.status??2);`;
  const r=spawnSync(process.execPath,['-e',parent],{env:{PATH:process.env.PATH,NODE_OPTIONS:`--require=${guard}`,SPOT_NEW_BUYS_PAUSED:'1'},encoding:'utf8',timeout:3000});
  assert.equal(r.status,0);assert.match(r.stderr,/SPOT_NEW_BUY_BLOCKED_MAINTENANCE/);
});
