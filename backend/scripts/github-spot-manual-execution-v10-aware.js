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
const { runLocalPretradeGuard } = require('../services/localPretradeGuard');
const { classifySpotAsset } = require('../services/spotAssetClassification');
const { resolveConvictionPosition, LEVERAGED_POSITION_USDT } = require('../services/spotConvictionSizing');
const { estimateAccountEquityUsdt, estimateManagedExposureUsdt, resolveGrowthPosition } = require('../services/spotGrowthEngine');
const { minimumProtectedQuoteUsdt } = require('../services/spotNativeProtectionPolicy');

const LEVERAGED_GITHUB_MAX_USDT = LEVERAGED_POSITION_USDT;
const LEVERAGED_GITHUB_MIN_V61_SCORE = 0.4487136592494857;
const LEVERAGED_HARD_STOP_PCT = 0.03;
const LEVERAGED_NATIVE_PROTECTION_MAX_USDT = 6;
const EARLY_CONFIRMATION_MAX_USDT = 15;
const EARLY_CONFIRMATION_MIN_V61_SCORE = 0.65;

const sourcePath = path.join(__dirname, 'github-spot-manual-execution.js');
let source = fs.readFileSync(sourcePath, 'utf8');
source = source.replace(/\r\n/g, '\n');

function patch(from, to, label) {
  if (!source.includes(from)) throw new Error(`EXECUTOR_PATCH_REFUSED ${label}`);
  source = source.replace(from, to);
}

patch(
  "let SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';",
  "let SIGNAL_CREATED_AT = process.env.SIGNAL_CREATED_AT || '';\nconst SIGNAL_LANE = String(process.env.SIGNAL_LANE || 'CORE').toUpperCase();\nconst SIGNAL_MICROFLOW_SCORE = Number(process.env.SIGNAL_MICROFLOW_SCORE || NaN);\nconst SIGNAL_MICROFLOW_CUT = Number(process.env.SIGNAL_MICROFLOW_CUT || NaN);\nconst SIGNAL_MICROFLOW_MARGIN = Number(process.env.SIGNAL_MICROFLOW_MARGIN || NaN);\nconst SIGNAL_MICROFLOW_MARGIN_CUT = Number(process.env.SIGNAL_MICROFLOW_MARGIN_CUT || NaN);\nconst SIGNAL_CALIBRATION_WIN_RATE = Number(process.env.SIGNAL_CALIBRATION_WIN_RATE || NaN);",
  'signal lane'
);

patch(
  'const MIN_USDT = 10;\nconst MAX_USDT = 100;',
  'const MIN_USDT = 5;\nconst MAX_USDT = 70;\nconst DUPLICATE_POSITION_USDT = 15;\nconst V10_HARD_STOP_PCT = 0.012;',
  'entry sizing'
);

patch(
  "if (!API_KEY || !API_SECRET) technicalFail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');",
  "if (!API_KEY || !API_SECRET) technicalFail('BINANCE_API_KEY/BINANCE_SECRET_KEY missing in GitHub Actions Secrets');\n  if (SYMBOL === 'XECUSDT') decline('XEC historical holding is exit-only; new XEC entries are disabled');",
  'XEC exit-only entry block'
);

patch(
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT')\n  ]);",
  "const [ticker, account, restrictions, exchangeInfo, symbolBars, btcBars, openOrders, allPrices] = await Promise.all([\n    request(base, `/api/v3/ticker/24hr?symbol=${encodeURIComponent(SYMBOL)}`),\n    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),\n    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),\n    request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(SYMBOL)}`),\n    fiveMinuteBars(base, SYMBOL), fiveMinuteBars(base, 'BTCUSDT'),\n    signed(base, 'GET', '/api/v3/openOrders').catch((error) => { console.warn(`ENTRY_GATE_OPEN_ORDERS_UNAVAILABLE ${error.message || error}`); return []; }),\n    request(base, '/api/v3/ticker/price').catch((error) => { console.warn(`GROWTH_ENGINE_PRICES_UNAVAILABLE ${error.message || error}`); return []; })\n  ]);",
  'managed position inventory'
);

patch(
  'const score = v61EntryScore(symbolBars, btcBars); const fraction = positionFraction(score);',
  "const score = v61EntryScore(symbolBars, btcBars);\n  const v42Quality = v42QualityFromBars(symbolBars, btcBars);\n  const managedPositions = (Array.isArray(openOrders) ? openOrders : [])\n    .filter((order) => String(order.clientOrderId || '').startsWith('proypers-gh-protect-'))\n    .map((order) => ({ symbol: String(order.symbol || '').toUpperCase(), openedAt: Number(order.time || order.updateTime || 0) }))\n    .filter((position) => position.symbol);\n  const peerSymbols = [];\n  for (const position of [...managedPositions].sort((a, b) => b.openedAt - a.openedAt)) {\n    if (!position.symbol || position.symbol === SYMBOL || peerSymbols.includes(position.symbol)) continue;\n    peerSymbols.push(position.symbol);\n    if (peerSymbols.length >= 6) break;\n  }\n  const peerCorrelations = (await Promise.all(peerSymbols.map(async (peerSymbol) => {\n    try {\n      const peerBars = await fiveMinuteBars(base, peerSymbol);\n      const correlation = returnCorrelationFromBars(symbolBars, peerBars, 24);\n      return Number.isFinite(correlation) ? { symbol: peerSymbol, correlation } : null;\n    } catch (error) {\n      console.warn(`ENTRY_GATE_CORRELATION_UNAVAILABLE ${peerSymbol} ${error.message || error}`);\n      return null;\n    }\n  }))).filter(Boolean);\n  const entryGate = evaluateSpotEntryBurstGate({ lane: SIGNAL_LANE, symbol: SYMBOL, currentPct, managedPositions, v42Quality, peerCorrelations });\n  if (!entryGate.allow) decline(`Entry gate blocked: ${entryGate.reason}`);\n  const fraction = positionFraction(score);",
  'selective anti-overentry gate'
);

patch(
  "const usdtFree = freeBalance(account, 'USDT'); const quoteOrderQty = Math.min(MAX_USDT, Math.floor(usdtFree * fraction * 100) / 100);",
  "const assetClassification = classifySpotAsset(SYMBOL);\n  if (assetClassification.is_leveraged && (!Number.isFinite(score) || score < LEVERAGED_GITHUB_MIN_V61_SCORE)) decline(`Leveraged tokenized asset requires stronger entry score (${Number.isFinite(score) ? score.toFixed(6) : 'unavailable'} < ${LEVERAGED_GITHUB_MIN_V61_SCORE})`);\n  const usdtFree = freeBalance(account, 'USDT');\n  const convictionSizing = resolveConvictionPosition({ lane: SIGNAL_LANE, v61Score: score, v42PassCount: v42Quality.passCount, v42Norm: v42Quality.norm, microflowScore: SIGNAL_MICROFLOW_SCORE, microflowCut: SIGNAL_MICROFLOW_CUT, microflowMargin: SIGNAL_MICROFLOW_MARGIN, microflowMarginCut: SIGNAL_MICROFLOW_MARGIN_CUT, calibrationWinRate: SIGNAL_CALIBRATION_WIN_RATE, usdtFree, baseFraction: fraction, isLeveraged: assetClassification.is_leveraged });\n  const earlyConfirmation = SIGNAL_LANE === 'CORE' && entryGate.code === 'EARLY_CONFIRMATION_ADMITTED';\n  if (earlyConfirmation && assetClassification.is_leveraged) decline('Early confirmation is disabled for leveraged/tokenized assets');\n  if (earlyConfirmation && (!Number.isFinite(score) || score < EARLY_CONFIRMATION_MIN_V61_SCORE)) decline(`Early confirmation requires V6.1 score >= ${EARLY_CONFIRMATION_MIN_V61_SCORE} (got ${Number.isFinite(score) ? score.toFixed(6) : 'unavailable'})`);\n  if (SIGNAL_LANE === 'CORE' && convictionSizing.tier === 'NORMAL' && !earlyConfirmation) decline('CORE real entry requires HIGH or EXCEPTIONAL conviction');\n  const growthEquityUsdt = estimateAccountEquityUsdt(account, allPrices);\n  const growthManagedExposureUsdt = estimateManagedExposureUsdt(openOrders, allPrices);\n  const growthSizing = resolveGrowthPosition({ lane: SIGNAL_LANE, tier: convictionSizing.tier, equityUsdt: growthEquityUsdt, usdtFree, managedExposureUsdt: growthManagedExposureUsdt, baseQuoteOrderQty: convictionSizing.quote_order_qty, isLeveraged: assetClassification.is_leveraged });\n  let quoteOrderQty = Math.min(MAX_USDT, growthSizing.quote_order_qty);\n  if (earlyConfirmation) quoteOrderQty = Math.min(EARLY_CONFIRMATION_MAX_USDT, quoteOrderQty);\n  if (SIGNAL_LANE === 'CORE' && growthSizing.enabled && quoteOrderQty < MIN_USDT) decline(`Growth engine portfolio cap/reserve blocked entry (equity=${growthEquityUsdt}, exposure=${growthManagedExposureUsdt}, free=${usdtFree})`);\n  const laneStopPctForNativeFloor = SIGNAL_LANE === 'V10_HUNTER' ? V10_HARD_STOP_PCT : HARD_STOP_PCT;\n  const effectiveStopPctForNativeFloor = assetClassification.is_leveraged ? Math.min(laneStopPctForNativeFloor, LEVERAGED_HARD_STOP_PCT) : laneStopPctForNativeFloor;\n  const nativeProtectionFloor = minimumProtectedQuoteUsdt(info, effectiveStopPctForNativeFloor, { stopLimitGapPct: STOP_LIMIT_GAP_PCT });\n  if (assetClassification.is_leveraged) {\n    if (!nativeProtectionFloor.ok) decline(`Native stop unavailable for leveraged/tokenized asset: ${nativeProtectionFloor.reason}`);\n    if (nativeProtectionFloor.quote_floor_usdt > LEVERAGED_NATIVE_PROTECTION_MAX_USDT) decline(`Native stop requires ${nativeProtectionFloor.quote_floor_usdt} USDT, above leveraged protection ceiling ${LEVERAGED_NATIVE_PROTECTION_MAX_USDT}`);\n    if (quoteOrderQty < nativeProtectionFloor.quote_floor_usdt) {\n      const reserveProtectedFree = Math.max(0, usdtFree - convictionSizing.reserve_usdt);\n      if (nativeProtectionFloor.quote_floor_usdt > reserveProtectedFree) decline(`Insufficient reserve-safe USDT for native-protected leveraged entry (need ${nativeProtectionFloor.quote_floor_usdt})`);\n      quoteOrderQty = nativeProtectionFloor.quote_floor_usdt;\n      console.log(`NATIVE_PROTECTION_SIZING symbol=${SYMBOL} floor_usdt=${nativeProtectionFloor.quote_floor_usdt} min_notional=${nativeProtectionFloor.min_notional_usdt} stop_pct=${effectiveStopPctForNativeFloor}`);\n    }\n  }\n  console.log(`GROWTH_ENGINE_V1 lane=${SIGNAL_LANE} tier=${convictionSizing.tier} early_confirmation=${earlyConfirmation} equity_usdt=${growthEquityUsdt} exposure_usdt=${growthManagedExposureUsdt} reserve_usdt=${growthSizing.reserve_usdt ?? convictionSizing.reserve_usdt} tier_cap_usdt=${growthSizing.tier_cap_usdt ?? convictionSizing.cap_usdt} quote_order_qty=${quoteOrderQty} reason=${growthSizing.reason}`)",
  'conviction-aware sizing'
);

patch(
  "const stopPrice = floorToStep(entryPrice * (1 - HARD_STOP_PCT), priceFilter.tickSize); if (!(stopPrice > 0)) throw new Error(`stop price invalid for ${SYMBOL}`);",
  "const classifiedForProtection = classifySpotAsset(SYMBOL); const laneHardStopPct = SIGNAL_LANE === 'V10_HUNTER' ? V10_HARD_STOP_PCT : HARD_STOP_PCT; const hardStopPct = classifiedForProtection.is_leveraged ? Math.min(laneHardStopPct, LEVERAGED_HARD_STOP_PCT) : laneHardStopPct; const stopPrice = floorToStep(entryPrice * (1 - hardStopPct), priceFilter.tickSize); if (!(stopPrice > 0)) throw new Error(`stop price invalid for ${SYMBOL}`);",
  'lane and leveraged stop'
);

patch(
  "if (existingAssetQty > 0 && existingAssetQty * currentPrice >= MIN_USDT) decline(`${info.baseAsset} already has >= ${MIN_USDT} USDT equivalent balance; duplicate acquisition blocked`);",
  "const duplicateThresholdUsdt = assetClassification.is_leveraged ? LEVERAGED_GITHUB_MAX_USDT : DUPLICATE_POSITION_USDT; if (existingAssetQty > 0 && existingAssetQty * currentPrice >= duplicateThresholdUsdt) decline(`${info.baseAsset} already has >= ${duplicateThresholdUsdt} USDT equivalent balance; duplicate acquisition blocked`);",
  'duplicate threshold'
);

patch(
  "newClientOrderId: `proypers-gh-${Date.now()}`",
  "newClientOrderId: `${SIGNAL_LANE === 'V10_HUNTER' ? 'proypers-gh-v10' : 'proypers-gh'}-${Date.now()}`",
  'lane client id'
);

patch(
  "console.log(`APPROVED_V61 symbol=${SYMBOL} signal_pct=${SIGNAL_PCT}",
  "const localGuard = await runLocalPretradeGuard({ base, symbol: SYMBOL, signalPrice: SIGNAL_PRICE, currentPrice, lane: SIGNAL_LANE });\n  if (!localGuard.allow) decline(`Local microvalidation blocked: ${localGuard.reason}`);\n  console.log(`LOCAL_PRETRADE_OK symbol=${SYMBOL} lane=${SIGNAL_LANE} code=${localGuard.code} samples=${localGuard.metrics.samples} end_return=${Number(localGuard.metrics.endReturnPct || 0).toFixed(6)} peak_to_end=${Number(localGuard.metrics.peakToEndPct || 0).toFixed(6)} spread=${Number(localGuard.metrics.lastSpreadPct || 0).toFixed(6)} continuation_score=${Number(localGuard.metrics.continuationScore || 0).toFixed(6)} continuation_pass=${localGuard.metrics.continuationPass === true} latency_ms=${Number(localGuard.metrics.latencyMs || 0).toFixed(0)} manipulation_risk=${Number(localGuard.metrics.manipulationRisk || 0).toFixed(3)} manipulation_band=${localGuard.metrics.manipulationBand || 'UNKNOWN'} manipulation_reason=${String(localGuard.metrics.manipulationReason || 'none').replace(/\\s+/g, '_')}`);\n  console.log(`APPROVED_V61 lane=${SIGNAL_LANE} entry_gate=${entryGate.code} conviction_tier=${convictionSizing.tier} conviction_cap_usdt=${convictionSizing.cap_usdt} reserve_usdt=${convictionSizing.reserve_usdt} v42_pass=${v42Quality.passCount} v42_norm=${Number(v42Quality.norm || 0).toFixed(6)} asset_class=${assetClassification.asset_class} leverage=${assetClassification.leverage_multiple} symbol=${SYMBOL} signal_pct=${SIGNAL_PCT}",
  'local microvalidation and audit'
);

eval(source);
