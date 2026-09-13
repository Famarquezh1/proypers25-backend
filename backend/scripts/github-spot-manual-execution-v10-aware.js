'use strict';

// Production hardening wrapper around the existing autonomous executor.
// It keeps CORE behavior intact while enforcing the project-wide 10 USDT cap
// and giving V10_HUNTER the stop used by its causal training.
const fs = require('fs');
const path = require('path');

const sourcePath = path.join(__dirname, 'github-spot-manual-execution.js');
let source = fs.readFileSync(sourcePath, 'utf8');

function patch(from, to, label) {
  if (!source.includes(from)) throw new Error(`EXECUTOR_PATCH_REFUSED ${label}`);
  source = source.replace(from, to);
}

patch(
  "let SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';",
  "let SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';\nconst SIGNAL_LANE = String(process.env.SIGNAL_LANE || 'CORE').toUpperCase();",
  'signal lane'
);

patch(
  'const MIN_USDT = 10;\nconst MAX_USDT = 100;',
  'const MIN_USDT = 5;\nconst MAX_USDT = 10;\nconst DUPLICATE_POSITION_USDT = 10;\nconst V10_HARD_STOP_PCT = 0.012;',
  'position limits'
);

patch(
  "const stopPrice = floorToStep(entryPrice * (1 - HARD_STOP_PCT), priceFilter.tickSize); if (!(stopPrice > 0)) throw new Error(`stop price invalid for ${SYMBOL}`);",
  "const hardStopPct = SIGNAL_LANE === 'V10_HUNTER' ? V10_HARD_STOP_PCT : HARD_STOP_PCT; const stopPrice = floorToStep(entryPrice * (1 - hardStopPct), priceFilter.tickSize); if (!(stopPrice > 0)) throw new Error(`stop price invalid for ${SYMBOL}`);",
  'lane stop'
);

patch(
  "if (existingAssetQty > 0 && existingAssetQty * currentPrice >= MIN_USDT) decline(`${info.baseAsset} already has >= ${MIN_USDT} USDT equivalent balance; duplicate acquisition blocked`);",
  "if (existingAssetQty > 0 && existingAssetQty * currentPrice >= DUPLICATE_POSITION_USDT) decline(`${info.baseAsset} already has >= ${DUPLICATE_POSITION_USDT} USDT equivalent balance; duplicate acquisition blocked`);",
  'duplicate threshold'
);

patch(
  "newClientOrderId: `proypers-gh-${Date.now()}`",
  "newClientOrderId: `${SIGNAL_LANE === 'V10_HUNTER' ? 'proypers-gh-v10' : 'proypers-gh'}-${Date.now()}`",
  'lane client id'
);

patch(
  "console.log(`APPROVED_V61 symbol=${SYMBOL} signal_pct=${SIGNAL_PCT}",
  "console.log(`APPROVED_V61 lane=${SIGNAL_LANE} symbol=${SYMBOL} signal_pct=${SIGNAL_PCT}",
  'audit lane'
);

eval(source);
