'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {atomic}=require('./journal.cjs');
const {updatePositions,localManagedIssues}=require('./positions.cjs');
const {validate,fresh}=require('./v10-scan.cjs');
test('position lifecycle survives reload, keeps external balances separate, and confirms absence twice',()=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'spot-positions-'));
  try{
    const audit={at:new Date().toISOString(),positions:[{symbol:'BTCUSDT',quantity:1,status:'NATIVE_STOP_PRESENT'}]};
    let p=updatePositions(state,audit);assert.equal(p.positions.BTCUSDT.origin,'EXTERNAL_BALANCE_OBSERVED');
    atomic(path.join(state,'execution-state','a'.repeat(32)+'.json'),{symbol:'BTCUSDT',createdAt:'2020-01-01',lane:'CORE',state:'PROTECTED',buy:{orderId:7,executedQty:'1'}});
    p=updatePositions(state,audit);assert.equal(p.positions.BTCUSDT.origin,'LOCAL_CONFIRMED_BUY');assert.deepEqual(p.positions.BTCUSDT.managedBuyIds,[7]);
    assert.equal(localManagedIssues(state).length,1);assert.equal(localManagedIssues(state)[0].state_reason,'completed');
    p=updatePositions(state,{...audit,positions:[]});assert.equal(p.positions.BTCUSDT.status,'ABSENCE_PENDING_CONFIRMATION');
    p=updatePositions(state,{...audit,positions:[]});assert.equal(p.positions.BTCUSDT.status,'BALANCE_NO_LONGER_PRESENT');
    assert(!JSON.stringify(p).includes('SOLD'));
  }finally{fs.rmSync(state,{recursive:true,force:true});}
});
test('invalid position state fails closed and unknown assets remain visible for review',()=>{
  const state=fs.mkdtempSync(path.join(os.tmpdir(),'spot-positions-'));
  try{
    const a={at:new Date().toISOString(),positions:[{asset:'UNKNOWN',status:'UNVALUED_REQUIRES_REVIEW'}]};
    assert.equal(updatePositions(state,a).positions['asset:UNKNOWN'].status,'UNVALUED_REQUIRES_REVIEW');
    fs.writeFileSync(path.join(state,'positions.json'),'{}');assert.throws(()=>updatePositions(state,a),/REVIEW_REQUIRED/);
  }finally{fs.rmSync(state,{recursive:true,force:true});}
});
test('V10 abstention is valid; failed, stale or future snapshots cannot dispatch a signal',()=>{
  const now=Date.now(),snapshot={version:1,code:0,completedAt:new Date(now).toISOString(),result:{ok:true,notify:false,lane:'V10_HUNTER',reason:'no positive calibration'}};
  assert.equal(fresh(snapshot,now).notify,false);
  for(const change of [s=>s.code=124,s=>s.completedAt='2000-01-01',s=>s.completedAt=new Date(now+1).toISOString()]){const s=structuredClone(snapshot);change(s);assert.equal(fresh(s,now),null);}
});
test('V10 requires the original calibration and execution policy for a positive signal',()=>{
  const r={ok:true,notify:true,lane:'V10_HUNTER',symbol:'BTCUSDT',price:100,pct:5,target:new Date().toISOString(),
    microflow_score:.2,microflow_margin:.1,score_cut:.1,margin_cut:null,
    calibration:{avgNet:.01,growth:.01,avgAlpha:.01,top10HitRate:.3,stopRate:.2},trained_samples:900,calibration_samples:400,
    maximum_real_order_usdt:10,exit_policy:{hard_stop:.012,take_profit:.03,timeout_minutes:180}};
  assert.equal(validate(r),r);
  for(const change of [s=>s.maximum_real_order_usdt=70,s=>s.calibration.avgNet=-1,s=>s.trained_samples=2,s=>s.exit_policy.hard_stop=.1]){const s=structuredClone(r);change(s);assert.throws(()=>validate(s),/INVALID/);}
});
