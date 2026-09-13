'use strict';

// Production hardening wrapper around the existing autonomous executor.
// It keeps CORE behavior intact while respecting the configured Spot limits:
// 15 USDT max per acquisition, 40 USDT total managed capital, 2 positions max.
// V10_HUNTER keeps the stop used by its causal training.
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
  'const MIN_USDT = 5;\nconst MAX_USDT = 15;\nconst MAX_TOTAL_CAPITAL_USDT = 40;\nconst MAX_OPEN_POSITIONS = 2;\nconst DUPLICATE_POSITION_USDT = 15;\nconst V10_HARD_STOP_PCT = 0.012;',
  'position limits'
);

patch(
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT')\n  ]);",
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars, openOrders] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT'),\n    signed(base, 'GET', '/api/v3/openOrders')\n  ]);",
  'managed position inventory'
);

patch(
  "if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) decline(`${SYMBOL} is not active Spot TRADING`);",
  "if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) decline(`${SYMBOL} is not active Spot TRADING`);\n  const managedOpenOrders = (Array.isArray(openOrders) ? openOrders : []).filter((order) => String(order.clientOrderId || '').startsWith('proypers-gh-protect-'));\n  const managedSymbols = new Set(managedOpenOrders.map((order) => String(order.symbol || '').toUpperCase()).filter(Boolean));\n  if (!managedSymbols.has(SYMBOL) && managedSymbols.size >= MAX_OPEN_POSITIONS) decline(`Managed Spot position limit reached (${managedSymbols.size}/${MAX_OPEN_POSITIONS})`);",
  'max managed positions'
);

patch(
  "const usdtFree = freeBalance(account, 'USDT'); const quoteOrderQty = Math.min(MAX_USDT, Math.floor(usdtFree * fraction * 100) / 100);",
  "const usdtFree = freeBalance(account, 'USDT'); const quoteOrderQty = Math.min(MAX_USDT, Math.floor(usdtFree * fraction * 100) / 100);\n  const managedCapitalEstimate = managedOpenOrders.reduce((sum, order) => { const qty = Number(order.origQty || 0); const stop = Number(order.stopPrice || 0); return sum + (qty > 0 && stop > 0 ? (qty * stop) / 0.95 : 0); }, 0);\n  if (managedCapitalEstimate + quoteOrderQty > MAX_TOTAL_CAPITAL_USDT) decline(`Managed Spot capital limit would be exceeded (${(managedCapitalEstimate + quoteOrderQty).toFixed(2)} > ${MAX_TOTAL_CAPITAL_USDT} USDT)`);",
  'max managed capital'
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
