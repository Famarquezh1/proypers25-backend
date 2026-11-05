'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {validate,predict,features,metric,report,FREEZE}=require('./collector.cjs');
test('spread budget is prospective, strict, and independent of momentum',()=>{
  const p=validate(require('./proposals.json')),c=p.candidates.find(c=>c.id==='spread-budget-reference');
  assert.ok(c);assert.equal(predict(c,{spreadPct:.099,last5mPct:-1}),true);
  assert.equal(predict(c,{spreadPct:.1}),false);assert.equal(predict(c,{spreadPct:.101}),false);
  assert.equal(predict(c,{}),false);assert.equal(predict(c,{spreadPct:NaN}),false);
});
test('monetary totals reconcile gains, losses, fixed costs and abstentions',()=>{
  const predictions=[{id:'core-reference',up:true},{id:'spread-budget-reference',up:false}];
  const rows=[{grossPct:1,netPct:.7},{grossPct:-2,netPct:-2.3}];
  const r=report({observations:rows.map((outcome,i)=>({version:'old',at:FREEZE-2+i,predictions,outcome}))},FREEZE);
  const m=r.groups['old:core-reference'].discovery;
  assert.ok(Math.abs(m.hypotheticalNetGainsUsdtAt10Each-.07)<1e-12);
  assert.ok(Math.abs(m.hypotheticalAbsoluteNetLossesUsdtAt10Each-.23)<1e-12);
  assert.ok(Math.abs(m.assumedCostsUsdtAt10Each-.06)<1e-12);
  assert.ok(Math.abs(m.hypotheticalNetUsdtAt10Each+.16)<1e-12);
  assert.equal(r.groups['old:spread-budget-reference'].discovery.n,0);
  assert.equal(r.groups['old:spread-budget-reference'].discovery.upAccuracy,null);
});
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
