'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  context,
  evaluateConfirmation,
  evaluateExit,
  BASE_EXIT,
  OVERLAY_EXIT,
  CONFIRM
} = require('../services/spotV21ShadowRouter');

function bar({o=100,h=101,l=99,c=100.5,q=100,closeTime=Date.now()-120000}={}){
  return {o,h,l,c,q,closeTime,t:closeTime-300000};
}

(function safetySourceGuard(){
  const source=fs.readFileSync(path.join(__dirname,'..','services','spotV21ShadowRouter.js'),'utf8');
  const forbidden=[
    "api/v3/order",
    "BINANCE_API_SECRET",
    "BINANCE_SECRET",
    "executeApprovedSpotCandidate",
    "placeOrder(",
    "withdraw("
  ];
  for(const token of forbidden) assert(!source.includes(token),`shadow service must not contain forbidden token: ${token}`);
  assert(source.includes('shadow_only:true'),'shadow writes must be explicitly marked shadow_only');
  assert(source.includes('no_order_created:true'),'shadow writes must explicitly state no_order_created');
})();

(function contextBuckets(){
  assert.strictEqual(context({extension:.03,confirm:.30}),'E0_C0');
  assert.strictEqual(context({extension:.07,confirm:.50}),'E1_C1');
  assert.strictEqual(context({extension:.10,confirm:.50}),'E2_C1');
})();

(function confirmationFreshPass(){
  const bars=[
    bar({q:100,c:100}),
    bar({q:100,c:100}),
    bar({q:100,c:100}),
    bar({q:100,c:100}),
    bar({q:100,c:100}),
    bar({q:100,c:100}),
    bar({o:100,h:101,l:99.5,c:100.5,q:100})
  ];
  const r=evaluateConfirmation(bars,100,.04);
  assert.strictEqual(r.ready,true);
  assert.strictEqual(r.passed,true);
  assert(r.ret>=CONFIRM.lowRet);
})();

(function confirmationExtendedNeedsMore(){
  const bars=[
    bar({q:100,c:100}),bar({q:100,c:100}),bar({q:100,c:100}),
    bar({q:100,c:100}),bar({q:100,c:100}),bar({q:100,c:100}),
    bar({o:100,h:100.7,l:99.6,c:100.5,q:100})
  ];
  const r=evaluateConfirmation(bars,100,.10);
  assert.strictEqual(r.ready,true);
  assert.strictEqual(r.passed,false);
  assert.strictEqual(r.ret_threshold,CONFIRM.highRet);
})();

(function overlayStopFirstIsConservative(){
  const p={arm:'OVERLAY',entry_price:100,opened_at:new Date(Date.now()-60000).toISOString(),highest_price:100};
  const r=evaluateExit(p,[bar({o:100,h:107,l:95,c:102})],102,Date.now());
  assert.strictEqual(r.reason,'AMBIGUOUS_STOP_FIRST');
  assert.strictEqual(Number(r.price.toFixed(2)),96.00);
})();

(function baseBreakEvenAndTrail(){
  const p={arm:'BASE',entry_price:100,opened_at:new Date(Date.now()-60000).toISOString(),highest_price:100};
  const noExit=evaluateExit(p,[bar({o:100,h:106,l:101,c:105})],105,Date.now());
  assert.strictEqual(noExit.reason,null);
  assert(noExit.stop>=100*(1+BASE_EXIT.beLock)-1e-9);

  const trail=evaluateExit(p,[bar({o:100,h:109,l:105,c:106})],106,Date.now());
  assert.strictEqual(trail.reason,'TRAIL_OR_BE');
})();

(function timeouts(){
  const old=new Date(Date.now()-(OVERLAY_EXIT.timeoutMinutes+1)*60000).toISOString();
  const p={arm:'OVERLAY',entry_price:100,opened_at:old,highest_price:101};
  const r=evaluateExit(p,[],102,Date.now());
  assert.strictEqual(r.reason,'TIMEOUT');
  assert.strictEqual(r.price,102);
})();

console.log('spotV21ShadowRouter tests: PASS');
