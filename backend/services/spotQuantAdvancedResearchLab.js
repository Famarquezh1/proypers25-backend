'use strict';

const {
  fetchKlines,
  featureAt,
  intervalToMilliseconds
} = require('./spotQuantResearchLab');

const RESULTS = 'spot_quant_research_runs';
const CHAMPIONS = 'spot_quant_champions';
const DEFAULT_HISTORY_LIMIT = 4000;
const MAX_HISTORY_LIMIT = 5000;
const DEFAULT_SYMBOLS = [
  'BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'TONUSDT',
  'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT'
];

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function std(values = []) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function metrics(trades = []) {
  const returns = trades.map((trade) => n(trade.netReturn)).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  return {
    trades: returns.length,
    winRate: returns.length ? wins.length / returns.length : 0,
    expectancy: mean(returns),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    maxDrawdown,
    netReturn: equity - 1,
    averageWin: mean(wins),
    averageLoss: mean(losses),
    returnStd: std(returns)
  };
}

function detectRegime(feature) {
  if (!feature) return 'UNKNOWN';
  const trendGap = feature.price > 0 ? (feature.ema20 - feature.ema50) / feature.price : 0;
  if (feature.volatility >= 0.012 || feature.atrPct >= 0.025) return 'HIGH_VOLATILITY';
  if (trendGap >= 0.004 && feature.price > feature.ema20) return 'UPTREND';
  if (trendGap <= -0.004 && feature.price < feature.ema20) return 'DOWNTREND';
  if (feature.volatility <= 0.004) return 'SIDEWAYS_LOW_VOL';
  return 'SIDEWAYS';
}

function strategyConfigs() {
  const configs = [];
  const exits = [
    { tpAtr: 1.4, slAtr: 0.8, timeoutBars: 18 },
    { tpAtr: 1.8, slAtr: 1.0, timeoutBars: 30 },
    { tpAtr: 2.2, slAtr: 1.1, timeoutBars: 48 }
  ];
  const families = [
    { family: 'TREND', thresholds: [64, 70], regimes: ['UPTREND', 'SIDEWAYS'] },
    { family: 'BREAKOUT', thresholds: [62, 68], regimes: ['UPTREND', 'SIDEWAYS', 'HIGH_VOLATILITY'] },
    { family: 'MOMENTUM', thresholds: [62, 68], regimes: ['UPTREND', 'SIDEWAYS'] },
    { family: 'MEAN_REVERSION', thresholds: [58, 64], regimes: ['SIDEWAYS_LOW_VOL', 'SIDEWAYS'] },
    { family: 'VOLATILITY_EXPANSION', thresholds: [62, 68], regimes: ['SIDEWAYS_LOW_VOL', 'HIGH_VOLATILITY'] }
  ];
  for (const family of families) {
    for (const threshold of family.thresholds) {
      for (const exit of exits) configs.push({ ...family, threshold, ...exit });
    }
  }
  return configs;
}

function familyScore(feature, family) {
  if (!feature) return 0;
  const trendGap = feature.price > 0 ? (feature.ema20 - feature.ema50) / feature.price : 0;
  const distanceFromEma20 = feature.ema20 > 0 ? (feature.price - feature.ema20) / feature.ema20 : 0;
  let score = 35;

  if (family === 'TREND') {
    if (feature.price > feature.ema20) score += 18;
    if (feature.ema20 > feature.ema50) score += 20;
    if (feature.rsi14 >= 50 && feature.rsi14 <= 68) score += 14;
    if (feature.momentum5 > 0 && feature.momentum5 < 0.025) score += 13;
    if (trendGap > 0.012 || feature.rsi14 > 75) score -= 18;
  } else if (family === 'BREAKOUT') {
    if (feature.breakout) score += 28;
    if (feature.volumeRelative >= 1.25) score += 20;
    if (feature.momentum5 > 0 && feature.momentum5 < 0.035) score += 14;
    if (feature.rsi14 >= 52 && feature.rsi14 <= 72) score += 10;
    if (feature.volumeRelative < 0.9 || feature.momentum5 > 0.05) score -= 20;
  } else if (family === 'MOMENTUM') {
    if (feature.momentum5 >= 0.004 && feature.momentum5 <= 0.025) score += 24;
    if (feature.rsi14 >= 54 && feature.rsi14 <= 70) score += 18;
    if (feature.volumeRelative >= 1.05) score += 14;
    if (feature.price > feature.ema20) score += 12;
    if (feature.momentum5 > 0.04 || feature.rsi14 > 76) score -= 24;
  } else if (family === 'MEAN_REVERSION') {
    if (feature.rsi14 >= 25 && feature.rsi14 <= 44) score += 25;
    if (distanceFromEma20 <= -0.004 && distanceFromEma20 >= -0.04) score += 24;
    if (feature.volatility <= 0.012) score += 12;
    if (feature.momentum5 < 0 && feature.momentum5 > -0.035) score += 10;
    if (feature.ema20 < feature.ema50 && trendGap < -0.015) score -= 22;
  } else if (family === 'VOLATILITY_EXPANSION') {
    if (feature.volumeRelative >= 1.4) score += 22;
    if (feature.volatility >= 0.004) score += 16;
    if (feature.breakout) score += 22;
    if (feature.momentum5 > 0 && feature.momentum5 <= 0.035) score += 14;
    if (feature.atrPct > 0.04 || feature.momentum5 > 0.05) score -= 22;
  }

  return clamp(score, 0, 100);
}

function simulateFamily(candles, config, startIndex, endIndex, feeRate = 0.001, slippageRate = 0.00025) {
  const trades = [];
  let index = Math.max(80, startIndex);
  while (index < endIndex - 2) {
    const feature = featureAt(candles, index);
    const regime = detectRegime(feature);
    const score = familyScore(feature, config.family);
    if (!feature || feature.atrPct <= 0 || score < config.threshold || !config.regimes.includes(regime)) {
      index += 1;
      continue;
    }

    const rawEntry = n(candles[index + 1]?.open);
    if (!(rawEntry > 0)) {
      index += 1;
      continue;
    }
    const entry = rawEntry * (1 + slippageRate);
    const tpPct = clamp(feature.atrPct * config.tpAtr, 0.004, 0.055);
    const slPct = clamp(feature.atrPct * config.slAtr, 0.003, 0.03);
    const tp = entry * (1 + tpPct);
    const sl = entry * (1 - slPct);
    const last = Math.min(endIndex - 1, index + config.timeoutBars);
    let exit = n(candles[last]?.close) * (1 - slippageRate);
    let reason = 'TIMEOUT';
    let exitIndex = last;

    for (let cursor = index + 1; cursor <= last; cursor += 1) {
      const candle = candles[cursor];
      const stopHit = candle.low <= sl;
      const profitHit = candle.high >= tp;
      if (stopHit) {
        exit = sl * (1 - slippageRate);
        reason = 'STOP_LOSS';
        exitIndex = cursor;
        break;
      }
      if (profitHit) {
        exit = tp * (1 - slippageRate);
        reason = 'TAKE_PROFIT';
        exitIndex = cursor;
        break;
      }
    }

    const grossReturn = (exit / entry) - 1;
    trades.push({
      entryIndex: index + 1,
      exitIndex,
      netReturn: grossReturn - (feeRate * 2),
      grossReturn,
      reason,
      score,
      regime,
      family: config.family
    });
    index = exitIndex + 1;
  }
  return trades;
}

function buildFolds(candleCount) {
  const start = 80;
  const usable = candleCount - start;
  if (usable < 600) return [];
  const definitions = [
    [0.50, 0.65, 0.75],
    [0.60, 0.75, 0.875],
    [0.70, 0.85, 1.00]
  ];
  return definitions.map(([trainEnd, validationEnd, testEnd], index) => ({
    id: `fold_${index + 1}`,
    trainStart: start,
    trainEnd: start + Math.floor(usable * trainEnd),
    validationStart: start + Math.floor(usable * trainEnd),
    validationEnd: start + Math.floor(usable * validationEnd),
    testStart: start + Math.floor(usable * validationEnd),
    testEnd: start + Math.floor(usable * testEnd)
  }));
}

function multiWindowWalkForward(candles, config, feeRate, slippageRate) {
  const folds = buildFolds(candles.length).map((fold) => {
    const trainTrades = simulateFamily(candles, config, fold.trainStart, fold.trainEnd, feeRate, slippageRate);
    const validationTrades = simulateFamily(candles, config, fold.validationStart, fold.validationEnd, feeRate, slippageRate);
    const testTrades = simulateFamily(candles, config, fold.testStart, fold.testEnd, feeRate, slippageRate);
    return {
      id: fold.id,
      train: metrics(trainTrades),
      validation: metrics(validationTrades),
      test: metrics(testTrades),
      validationTrades,
      testTrades
    };
  });

  const validationTrades = folds.flatMap((fold) => fold.validationTrades);
  const testTrades = folds.flatMap((fold) => fold.testTrades);
  const positiveValidationFolds = folds.filter((fold) => fold.validation.expectancy > 0 && fold.validation.profitFactor >= 1).length;
  const positiveTestFolds = folds.filter((fold) => fold.test.expectancy > 0 && fold.test.profitFactor >= 1).length;
  return {
    train: metrics(folds.flatMap((fold) => [])),
    validation: metrics(validationTrades),
    test: metrics(testTrades),
    consistency: {
      folds: folds.length,
      positive_validation_folds: positiveValidationFolds,
      positive_test_folds: positiveTestFolds,
      validation_ratio: folds.length ? positiveValidationFolds / folds.length : 0,
      test_ratio: folds.length ? positiveTestFolds / folds.length : 0
    },
    folds: folds.map(({ validationTrades: _validationTrades, testTrades: _testTrades, ...fold }) => fold),
    testTrades
  };
}

function probabilityCalibration(trades = []) {
  if (!trades.length) return { samples: 0, brier: null, calibrated: false };
  const brier = mean(trades.map((trade) => {
    const probability = clamp((n(trade.score) - 45) / 55, 0.05, 0.95);
    const outcome = trade.netReturn > 0 ? 1 : 0;
    return (probability - outcome) ** 2;
  }));
  return { samples: trades.length, brier, calibrated: trades.length >= 20 && brier <= 0.25 };
}

function objective(candidate) {
  const validation = candidate?.walk?.validation;
  const test = candidate?.walk?.test;
  const consistency = candidate?.walk?.consistency;
  if (!validation || !test || validation.trades < 5 || test.trades < 5) return -9999;
  return (
    validation.expectancy * 900 +
    test.expectancy * 1400 +
    Math.min(validation.profitFactor, 4) * 0.8 +
    Math.min(test.profitFactor, 4) * 1.2 -
    validation.maxDrawdown * 7 -
    test.maxDrawdown * 10 +
    n(consistency?.validation_ratio) * 1.2 +
    n(consistency?.test_ratio) * 1.8 +
    Math.min(test.trades, 60) / 60
  );
}

function eligibilityDiagnostic(champion) {
  const validation = champion?.walk?.validation || null;
  const test = champion?.walk?.test || null;
  const consistency = champion?.walk?.consistency || null;
  const calibration = champion?.calibration || null;
  const checks = {
    validation_min_trades: n(validation?.trades) >= 8,
    validation_expectancy_positive: n(validation?.expectancy) > 0,
    validation_profit_factor: n(validation?.profitFactor) >= 1.15,
    test_min_trades: n(test?.trades) >= 8,
    test_expectancy_positive: n(test?.expectancy) > 0,
    test_profit_factor: n(test?.profitFactor) >= 1.15,
    test_drawdown: n(test?.maxDrawdown, 1) <= 0.12,
    validation_fold_consistency: n(consistency?.positive_validation_folds) >= 2,
    test_fold_consistency: n(consistency?.positive_test_folds) >= 2,
    probability_calibrated: n(calibration?.samples) < 20 || calibration?.calibrated === true
  };
  return { eligible: Object.values(checks).every(Boolean), checks, validation, test, consistency, calibration };
}

function normalizeSymbols(input) {
  const requested = Array.isArray(input) && input.length ? [...input, ...DEFAULT_SYMBOLS] : DEFAULT_SYMBOLS;
  return [...new Set(requested
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]{2,16}USDT$/.test(symbol)))]
    .slice(0, 10);
}

async function runSymbolResearch(symbol, options = {}) {
  const interval = options.interval || '5m';
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1000, n(options.limit, DEFAULT_HISTORY_LIMIT)));
  const candles = await fetchKlines(symbol, interval, requestedLimit);
  const feeRate = clamp(n(options.feeRate, 0.001), 0, 0.01);
  const slippageRate = clamp(n(options.slippageRate, 0.00025), 0, 0.005);
  const evaluated = strategyConfigs().map((config) => {
    const walk = multiWindowWalkForward(candles, config, feeRate, slippageRate);
    const calibration = probabilityCalibration(walk.testTrades);
    const candidate = { config, walk: { ...walk, testTrades: undefined }, calibration };
    candidate.score = objective(candidate);
    candidate.eligibility = eligibilityDiagnostic(candidate);
    return candidate;
  }).sort((left, right) => right.score - left.score);

  const champion = evaluated[0] || null;
  const familyLeaders = Object.values(evaluated.reduce((acc, candidate) => {
    const family = candidate.config.family;
    if (!acc[family] || candidate.score > acc[family].score) acc[family] = candidate;
    return acc;
  }, {}));

  return {
    symbol,
    interval,
    requested_candles: requestedLimit,
    candles: candles.length,
    history_start: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
    history_end: candles.length ? new Date(candles[candles.length - 1].closeTime).toISOString() : null,
    history_duration_hours: candles.length ? (candles[candles.length - 1].closeTime - candles[0].openTime) / 3600000 : 0,
    generated_at: new Date().toISOString(),
    champion,
    eligibility: champion?.eligibility || null,
    family_leaders: familyLeaders,
    runners_up: evaluated.slice(1, 8)
  };
}

function selectGlobalChampion(results = []) {
  const valid = results
    .filter((result) => result?.champion)
    .sort((left, right) => n(right.champion?.score, -Infinity) - n(left.champion?.score, -Infinity));
  const eligible = valid.filter((result) => result.champion?.eligibility?.eligible === true);
  const selected = eligible[0] || valid[0] || null;
  return {
    selected,
    observationChampion: valid[0] || null,
    eligibleCount: eligible.length,
    validCount: valid.length,
    failedCount: Math.max(0, results.length - valid.length),
    selectionMode: eligible.length > 0 ? 'BEST_ELIGIBLE_MULTI_FAMILY' : selected ? 'OBSERVATION_ONLY_MULTI_FAMILY' : 'NONE'
  };
}

async function runQuantResearchLab(db, options = {}) {
  const symbols = normalizeSymbols(options.symbols);
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1000, n(options.limit, DEFAULT_HISTORY_LIMIT)));
  const researchOptions = { ...options, limit: requestedLimit };
  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await runSymbolResearch(symbol, researchOptions);
      result.promotion_eligible = result.champion?.eligibility?.eligible === true;
      results.push(result);
    } catch (error) {
      results.push({ symbol, error: error.message, promotion_eligible: false });
    }
  }

  const selection = selectGlobalChampion(results);
  const globalChampion = selection.selected;
  const runId = `quant_${Date.now()}`;
  const summary = {
    id: runId,
    created_at: new Date().toISOString(),
    mode: 'RESEARCH_ONLY',
    no_order_created: true,
    spot_only: true,
    history: {
      requested_candles_per_symbol: requestedLimit,
      maximum_candles_per_symbol: MAX_HISTORY_LIMIT,
      interval: researchOptions.interval || '5m',
      interval_ms: intervalToMilliseconds(researchOptions.interval || '5m')
    },
    strategy_families: ['TREND', 'BREAKOUT', 'MOMENTUM', 'MEAN_REVERSION', 'VOLATILITY_EXPANSION'],
    walk_forward_folds: 3,
    symbols,
    results,
    global_champion: globalChampion,
    observation_champion: selection.observationChampion,
    promotion_eligible: Boolean(globalChampion?.promotion_eligible),
    no_eligible_champion: selection.eligibleCount === 0,
    selected_evidence: globalChampion?.eligibility || null,
    selection: {
      mode: selection.selectionMode,
      requested_count: Array.isArray(options.symbols) ? options.symbols.length : DEFAULT_SYMBOLS.length,
      accepted_symbol_count: symbols.length,
      analyzed_count: results.length,
      valid_count: selection.validCount,
      eligible_count: selection.eligibleCount,
      failed_count: selection.failedCount,
      selected_symbol: globalChampion?.symbol || null,
      selected_family: globalChampion?.champion?.config?.family || null,
      observation_symbol: selection.observationChampion?.symbol || null
    },
    costs: {
      fee_rate: clamp(n(options.feeRate, 0.001), 0, 0.01),
      slippage_rate: clamp(n(options.slippageRate, 0.00025), 0, 0.005),
      round_trip_cost_included: true
    },
    limits_unchanged: true,
    version: 'spot_quant_lab_v5_multi_family'
  };

  await db.collection(RESULTS).doc(runId).set(summary);
  if (globalChampion) {
    await db.collection(CHAMPIONS).doc('current').set({
      ...globalChampion,
      promotion_eligible: Boolean(globalChampion.promotion_eligible),
      selection_mode: selection.selectionMode,
      eligible_candidates_count: selection.eligibleCount,
      valid_candidates_count: selection.validCount,
      no_eligible_champion: selection.eligibleCount === 0,
      observation_symbol: selection.observationChampion?.symbol || null,
      selected_at: summary.created_at,
      research_run_id: runId,
      approved_for_real: false,
      requires_runtime_gate: true,
      no_order_created: true,
      version: 'spot_quant_champion_v5_multi_family'
    }, { merge: true });
  }

  console.log(JSON.stringify({
    event: 'SPOT_QUANT_RESEARCH_RESULT',
    run_id: runId,
    symbols,
    strategy_families: summary.strategy_families,
    walk_forward_folds: summary.walk_forward_folds,
    history: summary.history,
    selection: summary.selection,
    selected_evidence: summary.selected_evidence,
    promotion_eligible: summary.promotion_eligible,
    no_eligible_champion: summary.no_eligible_champion,
    errors: results.filter((result) => result.error).map((result) => ({ symbol: result.symbol, error: result.error }))
  }));
  return summary;
}

module.exports = {
  detectRegime,
  strategyConfigs,
  familyScore,
  simulateFamily,
  buildFolds,
  multiWindowWalkForward,
  probabilityCalibration,
  eligibilityDiagnostic,
  normalizeSymbols,
  selectGlobalChampion,
  runSymbolResearch,
  runQuantResearchLab
};
