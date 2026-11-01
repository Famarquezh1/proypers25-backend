'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {untradeableResidual,transform}=require('./exit-integration.cjs');
const {exitHealthy}=require('./exit-health.cjs');
const info={filters:[{filterType:'LOT_SIZE',stepSize:'0.001',minQty:'0.001'},{filterType:'NOTIONAL',minNotional:'5'}]};
test('sold residual below lot or notional is skipped; operable inventory and existing protection are retained',()=>{
  assert.equal(untradeableResidual({info,quantity:0.00001,price:100}),true);
  assert.equal(untradeableResidual({info,quantity:0.01,price:100}),true);
  assert.equal(untradeableResidual({info,quantity:0.05,price:100}),false);
  assert.equal(untradeableResidual({info,quantity:0.01,price:100,hasProtection:true}),false);
  assert.throws(()=>untradeableResidual({info:{filters:[]},quantity:1,price:100}),/REVIEW_REQUIRED/);
  assert.throws(()=>untradeableResidual({info,quantity:NaN,price:100}),/REVIEW_REQUIRED/);
});
test('original legacy source accepts dust guard and protected-order transitions together',()=>{
  const src=fs.readFileSync(path.resolve(__dirname,'../../../backend/scripts/github-spot-auto-exit-legacy.js'),'utf8');
  const out=transform(src,'github-spot-auto-exit-legacy.js');
  new(require('node:vm').Script)(out);
  assert(out.includes('EXIT_DUST_RECONCILED'));assert(out.includes('__protectionTransitions.exit'));
});
test('exit failure remains unhealthy across minute cycles until a fresh successful check',()=>{
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'exit-health-'));
  try{
    const file=path.join(dir,'github-spot-auto-exit.js.last.json'),now=Date.now();
    assert.equal(exitHealthy(dir,now),false);
    for(const r of [{code:2,timedOut:false,at:new Date(now).toISOString()},{code:0,timedOut:true,at:new Date(now).toISOString()},{code:0,timedOut:false,at:new Date(now-16*60000).toISOString()},{code:0,timedOut:false,at:new Date(now+1).toISOString()}]){fs.writeFileSync(file,JSON.stringify(r));assert.equal(exitHealthy(dir,now),false);}
    fs.writeFileSync(file,JSON.stringify({code:0,timedOut:false,at:new Date(now).toISOString()}));assert.equal(exitHealthy(dir,now),true);
  }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
