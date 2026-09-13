'use strict';

// Surgical correction for V10: its report declared a 5m decision cadence,
// while the historical sample loop advanced 3 x 5m bars (15m). Keep the
// model, labels, calibration, exits and costs unchanged; only use every 5m bar.
const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'github-spot-microflow-trainer-v10.js');
let source = fs.readFileSync(sourcePath, 'utf8');
const target = 'for(let i=v.WARM;i<rows.length-38;i+=3)';
if (!source.includes(target)) {
  throw new Error('V10 15m cadence target missing; refusing an unverified patch');
}
source = source.replace(target, 'for(let i=v.WARM;i<rows.length-38;i++)');
source = source.replace("version:'V10_TAKER_FLOW_RELATIVE_WINNER'", "version:'V10_TAKER_FLOW_RELATIVE_WINNER_TRUE_5M'");
source = source.replace('productionMutation:false,causal:true', 'productionMutation:false,causal:true,sourceCadenceMinutes:5');

// Direct eval preserves the original module directory, so V10 continues to
// import the exact same V8 feature base. This file never touches production.
eval(source);
