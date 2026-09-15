'use strict';

// Production hardening wrapper around the existing autonomous executor.
// It keeps CORE behavior intact while removing artificial caps on the number
// of managed Spot positions and total managed Spot capital.
// Per-acquisition sizing, duplicate protection, Spot-only safety and stops remain intact.
// A selective CORE entry gate now throttles only bursty, extended or correlated entries.
// V10_HUNTER keeps the stop used by its causal training and otherwise remains unchanged.
const fs = require('fs');
const path = require('path');
const {
  v42QualityFromBars,
  returnCorrelationFromBars,
  evaluateSpotEntryBurstGate
} = require('../services/spotEntryBurstGate');

const sourcePath = path.join(__dirname, 'github-spot-manual-execution.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/\r\n/g, '\n');

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
  'const MIN_USDT = 5;\nconst MAX_USDT = 15;\nconst DUPLICATE_POSITION_USDT = 15;\nconst V10_HARD_STOP_PCT = 0.012;',
  'entry sizing'
);

patch(
  "if (!API_KEY || !API_SECRET) technicalFail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');",
  "if (!API_KEY || !API_SECRET) technicalFail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');\n  if (SYMBOL === 'XECUSDT') decline('XEC historical holding is exit-only; new XEC entries are disabled');",
  'XEC exit-only entry block'
);

patch(
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT')\n  ]);",
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars, openOrders] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT'),\n    signed(base, 'GET', '/api/v3/openOrders').catch((error) => { console.warn(`ENTRY_GATE_OPEN_ORDERS_UNAVAILABLE ${error.message || error}`); return []; })\n  ]);",
  'managed position inventory'
);

patch(
  'const score = v61EntryScore(symbolBars, btcBars); const fraction = positionFraction(score);',
  "const score = v61EntryScore(symbolBars, btcBars);\n  const v42Quality = v42QualityFromBars(symbolBars, btcBars);\n  const managedPositions = (Array.isArray(openOrders) ? openOrders : [])\n    .filter((order) => String(order.clientOrderId || '').startsWith('proypers-gh-protect-'))\n    .map((order) => ({ symbol: String(order.symbol || '').toUpperCase(), openedAt: Number(order.time || order.updateTime || 0) }))\n    .filter((position) => position.symbol);\n  const peerSymbols = [];\n  for (const position of [...managedPositions].sort((a, b) => b.openedAt - a.openedAt)) {\n    if (!position.symbol || position.symbol === SYMBOL || peerSymbols.includes(position.symbol)) continue;\n    peerSymbols.push(position.symbol);\n    if (peerSymbols.length >= 6) break;\n  }\n  const peerCorrelations = (await Promise.all(peerSymbols.map(async (peerSymbol) => {\n    try {\n      const peerBars = await fiveMinuteBars(base, peerSymbol);\n      const correlation = returnCorrelationFromBars(symbolBars, peerBars, 24);\n      return Number.isFinite(correlation) ? { symbol: peerSymbol, correlation } : null;\n    } catch (error) {\n      console.warn(`ENTRY_GATE_CORRELATION_UNAVAILABLE ${peerSymbol} ${error.message || error}`);\n      return null;\n    }\n  }))).filter(Boolean);\n  const entryGate = evaluateSpotEntryBurstGate({ lane: SIGNAL_LANE, symbol: SYMBOL, currentPct, managedPositions, v42Quality, peerCorrelations });\n  if (!entryGate.allow) decline(`Entry gate blocked: ${entryGate.reason}`);\n  const fraction = positionFraction(score);",
  'selective anti-overentry gate'
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
  "console.log(`APPROVED_V61 lane=${SIGNAL_LANE} entry_gate=${entryGate.code} v42_pass=${v42Quality.passCount} v42_norm=${Number(v42Quality.norm || 0).toFixed(6)} symbol=${SYMBOL} signal_pct=${SIGNAL_PCT}",
  'audit lane and gate'
);

eval(source);
