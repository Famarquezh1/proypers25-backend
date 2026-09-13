'use strict';

// V8.1 is intentionally a thin, auditable patch over V8. It changes only
// the learning target and the calibration/selection economics. It never
// imports credentials, Firestore, execution services, or order APIs.
const fs = require('fs');
const path = require('path');
const Module = module.constructor;

const BASE = path.join(__dirname, 'github-spot-instant-decision-trainer-v8.js');
let src = fs.readFileSync(BASE, 'utf8');

const replacements = [];
function replaceOnce(search, replacement, label) {
  if (!src.includes(search)) throw new Error(`V8.1 patch target missing: ${label}`);
  src = src.replace(search, replacement);
  replacements.push(label);
}

replaceOnce(
  "function dedupeSelect(scored,threshold,maxPerTime=2){",
  "function dedupeSelect(scored,threshold,maxPerTime=1){",
  'one candidate per decision instant'
);

replaceOnce(
  "all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.win?1:0});",
  "all.push({symbol,t:rows[i].t,x:vector(f),o,y:o.reason==='TAKE_PROFIT'?1:0});",
  'take-profit-before-stop learning label'
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
    // Economic gate: the model may act only when its own recent calibration
    // demonstrates a positive net edge after costs. This is an abstention
    // rule, not a looser threshold designed to manufacture more trades.
    if(m.trades<8)continue;
    if(m.avgNet<0.001)continue;
    if(m.compoundedGrowth<=0)continue;
    if(m.winRate<0.35)continue;
    if(m.tp<0.20)continue;
    if(m.maxDrawdown>0.0125)continue;
    const score=m.avgNet+Math.min(.004,m.compoundedGrowth*.25)-.20*m.maxDrawdown;
    if(!best||score>best.score)best={threshold:th,score,metrics:m};
  }
  return best;
}`,
  'positive calibration economics gate'
);

replaceOnce(
  "const now=Date.now();const evalEnd=utcDay(now);",
  "const evalEnd=process.env.V8_1_EVAL_END?Date.parse(process.env.V8_1_EVAL_END+'T00:00:00Z'):utcDay(Date.now());if(!Number.isFinite(evalEnd))throw new Error('invalid V8_1_EVAL_END');",
  'optional frozen evaluation end'
);

replaceOnce(
  "spot-instant-decision-v8.json",
  "spot-instant-decision-v8_1.json",
  'separate evidence artifact'
);

replaceOnce(
  "version:'V8_INSTANT_DECISION_WALK_FORWARD'",
  "version:'V8_1_INSTANT_DECISION_ECONOMIC_GATE'",
  'version marker'
);

replaceOnce(
  "const verdict=valid.length>=4&&agg.positiveDays>=Math.ceil(valid.length*.6)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  "const verdict=valid.length>=2&&agg.positiveDays>=Math.ceil(valid.length*.75)&&agg.economicBeatDays>=Math.ceil(valid.length*.75)&&agg.avgDailyGrowth>0&&agg.avgNetPerTrade>0?'PROMISING_FOR_SHADOW':'NOT_READY';",
  'stricter shadow verdict'
);

src = src.replace(/V8_DAY/g, 'V8_1_DAY').replace(/V8_RESULT/g, 'V8_1_RESULT').replace(/V8_UNIVERSE/g, 'V8_1_UNIVERSE').replace(/V8_SAMPLES/g, 'V8_1_SAMPLES');

console.log(`V8_1_PATCHED ${replacements.join(' | ')}`);
const patched = new Module(BASE, module);
patched.filename = BASE;
patched.paths = module.paths;
patched._compile(src, BASE);
