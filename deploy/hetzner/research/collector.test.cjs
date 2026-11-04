'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,predict,features,metric,report,FREEZE}=require('./collector.cjs');
test('proposal grammar refuses executable text and unknown features',()=>{
  assert.throws(()=>validate({version:'20261104-v1',candidates:[{id:'x',conditions:[{feature:'process.exit()',op:'gt',value:0}]}]}));
  assert.throws(()=>validate({version:'20261104-v1',candidates:[{id:'x',conditions:[{feature:'last5mPct',op:'eval',value:0}]}]}));
});
test('missing features abstain rather than imply confirmation',()=>assert.equal(predict({conditions:[{feature:'last5mPct',op:'gt',value:0}]},{}),false));
test('features reject future candles',()=>assert.throws(()=>features(Array.from({length:12},()=>[0,'1','2','1','2',0,100]),{askPrice:'2',bidPrice:'1.9'},100)));
test('80 percent accuracy can still lose money',()=>{const m=metric([...Array.from({length:8},()=>({grossPct:1,netPct:.7})),...Array.from({length:2},()=>({grossPct:-5,netPct:-5.3}))]);assert.equal(m.upAccuracy,.8);assert.ok(m.hypotheticalNetUsdtAt10Each<0);});
test('holdout is chronological, unlabelled cases never count as wins, promotion denied',()=>{
  const predictions=[{id:'a',up:true}],l={observations:[{version:'v1',at:FREEZE-1,predictions,outcome:{grossPct:1,netPct:.7}},{version:'v1',at:FREEZE,predictions,outcome:{grossPct:-1,netPct:-1.3}},{version:'v1',at:FREEZE+1,predictions}]};
  const r=report(l,FREEZE+2);assert.equal(r.pending,1);assert.equal(r.groups['v1:a'].discovery.n,1);assert.equal(r.groups['v1:a'].holdout.n,1);assert.equal(r.groups['v1:a'].promotion,'NOT_AUTHORIZED');
});
