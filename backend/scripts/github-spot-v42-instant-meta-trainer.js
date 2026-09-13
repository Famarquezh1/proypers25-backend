'use strict';

// Research-only meta learner over the existing production V4.2 admission gate.
// It does not alter production, credentials, Firestore or order execution.
const fs = require('fs');
const path = require('path');
const Module = module.constructor;

const BASE = path.join(__dirname, 'github-spot-instant-decision-trainer-v8.js');
let src = fs.readFileSync(BASE, 'utf8');

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) throw new Error(`V4.2 meta patch target missing: ${label}`);
  src = src.replace(search, replacement);
}

replaceOnce(
  "const THRESHOLDS = [0.52, 0.56, 0.60, 0.64, 0.68, 0.72];",
  "const THRESHOLDS = [0.52, 0.56, 0.60, 0.64, 0.68, 0.72, 0.76, 0.80];",
  'meta thresholds'
);

replaceOnce(
  "const FEATURE_NAMES = ['r5','r15','r30','r60','r240','r24','logVol15','logVol30','logTradeAccel','breakout60','breakout240','rs60','rs240','compression','btc60','btc240'];",
  "const FEATURE_NAMES = ['r5','r15','r30','r60','r240','r24','logVol15','logVol30','logTradeAccel','breakout60','breakout240','rs60','rs240','compression','btc60','btc240','ignition','confirm','extension','v42norm','passCount'];",
  'V4.2 meta features'
);

replaceOnce(
`function candidate(f){
  if(f.qv24<MIN_QV)return false;
  if(f.r24<=-0.06||f.r24>=0.14||f.r60>=0.085||f.r15>=0.05)return false;
  // Event trigger: some fresh activity must exist; avoids training on every quiet bar.
  return f.r15>0.0015||f.breakout60>-0.001||f.logVol15>Math.log(1.15)||f.logTradeAccel>Math.log(1.12)||f.rs60>0.002;
}

function vector(f){return FEATURE_NAMES.map(k=>clamp(k==='compression'?Math.log(Math.max(.2,f[k])):f[k],-4,4));}`,
`const V42_THRESHOLDS = [
  {i:0.904010256302157,c:0.30262335308700017,e:0.0333071863419859},
  {i:0.7912647052581232,c:0.36672756172128707,e:0.029510140018270917},
  {i:1.6626658194027173,c:0.43305908219072103,e:0.019614079751271593}
];
function v42Meta(f){
  const ignition=.9*f.logVol15+.65*f.logTradeAccel+.65*f.r15+.35*f.breakout60;
  const confirm=1.2*f.breakout60+.65*f.rs60+.35*f.logVol30-.8*Math.max(0,f.r24-.10)-.5*Math.max(0,f.r60-.06);
  const extension=1.15*f.rs60+.75*f.rs240+.35*f.r30+.25*f.breakout240-.45*Math.max(0,f.r24-.12);
  const freshEnough=f.r24<.18&&f.r60<.10&&f.r15<.06;
  const passCount=freshEnough?V42_THRESHOLDS.filter(th=>ignition>=th.i&&confirm>=th.c&&extension>=th.e).length:0;
  const mid=V42_THRESHOLDS[1];
  const ign=Math.max(0,Math.min(1,.5+(ignition-mid.i)/2));
  const con=Math.max(0,Math.min(1,.5+(confirm-mid.c)/.8));
  const ext=Math.max(0,Math.min(1,.5+(extension-mid.e)/.12));
  const v42norm=Math.max(0,Math.min(1,(passCount/3)*.55+ign*.20+con*.15+ext*.10));
  return {ignition,confirm,extension,passCount,v42norm,freshEnough};
}
function candidate(f){
  if(f.qv24<MIN_QV||f.r24<.01||f.r24>=.18)return false;
  const m=v42Meta(f);
  return m.freshEnough&&m.passCount>=2;
}
function vector(f){const z={...f,...v42Meta(f)};return FEATURE_NAMES.map(k=>clamp(k==='compression'?Math.log(Math.max(.2,z[k])):z[k],-4,4));}`,
  'production V4.2 2/3 admission and meta features'
);

replaceOnce(
  "function dedupeSelect(scored,threshold,maxPerTime=2){",
  "function dedupeSelect(scored,threshold,maxPerTime=1){",
  'one selected candidate per instant'
);

replaceOnce(
  "for(let i=WARM;i<rows.length-HOLD_BARS-2;i+=3){",
  "for(let i=WARM;i<rows.length-HOLD_BARS-2;i+=1){",
  'true 5m cadence'
);

replaceOnce(
  "all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.win?1:0});",
  "{const vm=v42Meta(f);all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.net>=0.005?1:0,baseScore:vm.v42norm,passCount:vm.passCount});}",
  'economic label and V4.2 baseline score'
);

replaceOnce(
`function chooseThreshold(cal,model){
  const scored=cal.map(r=>({...r,p:model.predict(r.x)}));let best=null;
  for(const th of THRESHOLDS){const sel=dedupeSelect(scored,th);const m=metrics(sel);if(m.trades<8)continue;const score=m.avgNet-.35*m.maxDrawdown+Math.min(.003,m.compoundedGrowth*.2);if(!best||score>best.score)best={threshold:th,score,metrics:m};}
  return best;
}`,
`function chooseThreshold(cal,model){
  const scored=cal.map(r=>({...r,p:model.predict(r.x)}));let best=null;
  for(const th of THRESHOLDS){
    const sel=dedupeSelect(scored,th);const m=metrics(sel);
    if(m.trades<5)continue;
    if(m.avgNet<=0||m.compoundedGrowth<=0)continue;
    if(m.winRate<0.34)continue;
    if(m.maxDrawdown>.018)continue;
    const score=m.avgNet+Math.min(.004,m.compoundedGrowth*.25)-.15*m.maxDrawdown;
    if(!best||score>best.score)best={threshold:th,score,metrics:m};
  }
  return best;
}`,
  'positive recent calibration only'
);

replaceOnce(
  "const baseline=metrics(dedupeSelect(scored.map(r=>({...r,p:.999})),.5));",
  "const baseline=metrics(dedupeSelect(scored.map(r=>({...r,p:r.baseScore})),.5));",
  'V4.2 baseline ranking'
);

replaceOnce(
  "spot-instant-decision-v8.json",
  "spot-v42-instant-meta-training.json",
  'meta artifact'
);

replaceOnce(
  "version:'V8_INSTANT_DECISION_WALK_FORWARD'",
  "version:'V42_INSTANT_META_WALK_FORWARD_V1'",
  'meta version'
);

replaceOnce(
  "const verdict=valid.length>=4&&agg.positiveDays>=Math.ceil(valid.length*.6)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  "const verdict=valid.length>=2&&agg.positiveDays>=Math.ceil(valid.length*.70)&&agg.economicBeatDays>=Math.ceil(valid.length*.70)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  'meta verdict'
);

src = src
  .replace(/V8_DAY/g,'V42_META_DAY')
  .replace(/V8_RESULT/g,'V42_META_RESULT')
  .replace(/V8_UNIVERSE/g,'V42_META_UNIVERSE')
  .replace(/V8_SAMPLES/g,'V42_META_SAMPLES');

console.log('V42_META_PATCHED production_gate_2of3 | true_5m | net_label | one_per_instant');
const patched = new Module(BASE, module);
patched.filename = BASE;
patched.paths = module.paths;
patched._compile(src, BASE);
