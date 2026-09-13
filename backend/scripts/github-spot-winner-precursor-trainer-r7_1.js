'use strict';

const fs = require('fs');
const path = require('path');

const basePath = path.join(__dirname, 'github-spot-winner-precursor-trainer-r7.js');
let src = fs.readFileSync(basePath, 'utf8');

const versionNeedle = "const VERSION = 'R7-WINNER-PRECURSOR';";
const vectorNeedle = '  ].map(Number);';
if (!src.includes(versionNeedle)) throw new Error('R7 version marker not found');
if (!src.includes(vectorNeedle)) throw new Error('R7 vector normalization marker not found');

src = src.replace(versionNeedle, "const VERSION = 'R7.1-WINNER-PRECURSOR-FINITE';");
src = src.replace(
  vectorNeedle,
  '  ].map(x => Number.isFinite(Number(x)) ? Number(x) : 0);'
);

// Run the exact same frozen training design with only finite-value sanitation.
// No dates, labels, thresholds, training windows, signal caps or pass gates change.
const runner = new Function('require', 'process', '__dirname', '__filename', src);
runner(require, process, __dirname, basePath);
