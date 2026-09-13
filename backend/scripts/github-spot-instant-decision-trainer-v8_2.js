'use strict';

// V8.2 fixes the cadence mismatch found in V8: training samples are now built
// every 5m bar (not every third bar / 15m). It keeps economic calibration but
// avoids the zero-trade behavior of the TP-only V8.1 label.
const fs = require('fs');
const path = require('path');
const Module = module.constructor;

const BASE = path.join(__dirname, 'github-spot-instant-decision-trainer-v8.js');
let src = fs.readFileSync(BASE, 'utf8');

function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) throw new Error(`V8.2 patch target missing: ${label}`);
  src = src.replace(search, replacement);
}

replaceOnce(
  "const THRESHOLDS = [0.52, 0.56, 0.60, 0.64, 0.68, 0.72];",
  "const THRESHOLDS = [0.52, 0.56, 0.60, 0.64, 0.68, 0.72, 0.76, 0.80];",
  'high precision thresholds'
);

replaceOnce(
  "function dedupeSelect(scored,threshold,maxPerTime=2){",
  "function dedupeSelect(scored,threshold,maxPerTime=1){",
  'one candidate per 5m instant'
);

replaceOnce(
  "for(let i=WARM;i<rows.length-HOLD_BARS-2;i+=3){",
  "for(let i=WARM;i<rows.length-HOLD_BARS-2;i+=1){",
  'true 5m training cadence'
);

replaceOnce(
  "all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.win?1:0});",
  "all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.net>=0.005?1:0});",
  'meaningful positive trade label'
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
    if(m.trades<6)continue;
    // Require a real, recent edge after costs but do not demand a TP-only regime.
    if(m.avgNet<0.0005)continue;
    if(m.compoundedGrowth<=0)continue;
    if(m.winRate<0.35)continue;
    if(m.maxDrawdown>0.015)continue;
    const score=m.avgNet+Math.min(.004,m.compoundedGrowth*.25)-.18*m.maxDrawdown+Math.min(.002,m.tp*.004);
    if(!best||score>best.score)best={threshold:th,score,metrics:m};
  }
  return best;
}`,
  'balanced economic calibration gate'
);

replaceOnce(
  "spot-instant-decision-v8.json",
  "spot-instant-decision-v8_2.json",
  'separate evidence artifact'
);

replaceOnce(
  "version:'V8_INSTANT_DECISION_WALK_FORWARD'",
  "version:'V8_2_TRUE_5M_INSTANT_DECISION'",
  'version marker'
);

replaceOnce(
  "const verdict=valid.length>=4&&agg.positiveDays>=Math.ceil(valid.length*.6)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  "const verdict=valid.length>=2&&agg.positiveDays>=Math.ceil(valid.length*.70)&&agg.economicBeatDays>=Math.ceil(valid.length*.70)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  'economic shadow verdict'
);

src = src
  .replace(/V8_DAY/g, 'V8_2_DAY')
  .replace(/V8_RESULT/g, 'V8_2_RESULT')
  .replace(/V8_UNIVERSE/g, 'V8_2_UNIVERSE')
  .replace(/V8_SAMPLES/g, 'V8_2_SAMPLES');

console.log('V8_2_PATCHED true_5m | label_net_ge_0.5pct | one_per_instant | economic_gate');
const patched = new Module(BASE, module);
patched.filename = BASE;
patched.paths = module.paths;
patched._compile(src, BASE);
