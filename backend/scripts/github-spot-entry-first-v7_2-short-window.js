'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const TARGET = path.join(__dirname, 'github-spot-entry-first-v7_2.js');
let src = fs.readFileSync(TARGET, 'utf8');

const destructureMarker = 'REGIMES, INTERVAL, STEP, DAY, WARM, FWD, PURGE, COOLDOWN, COST, DAYS, POOL_SIZE, MIN_QV,';
const destructureReplacement = 'REGIMES, INTERVAL, STEP, DAY, WARM, FWD, PURGE, COOLDOWN, COST, DAYS: LEGACY_DAYS, POOL_SIZE, MIN_QV,';
if (!src.includes(destructureMarker)) {
  throw new Error('ENTRY-first short-window runner could not locate DAYS destructuring marker');
}
src = src.replace(destructureMarker, destructureReplacement);

const insertionMarker = '} = b;\n\nconst PORTFOLIO_CFG = {';
const insertionReplacement = `} = b;\n\nconst DAYS = Math.max(1, Math.min(14, Number(process.env.TRAIN_LOOKBACK_DAYS || 14)));\n\nconst PORTFOLIO_CFG = {`;
if (!src.includes(insertionMarker)) {
  throw new Error('ENTRY-first short-window runner could not locate local configuration marker');
}
src = src.replace(insertionMarker, insertionReplacement);

const compiled = new Module(TARGET, module);
compiled.filename = TARGET;
compiled.paths = Module._nodeModulePaths(path.dirname(TARGET));
compiled._compile(src, TARGET);
