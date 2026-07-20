'use strict';

const {
  fetchKlines,
  featureAt,
  intervalToMilliseconds
} = require('./spotQuantResearchLab');

const RESULTS = 'spot_quant_research_runs';
const CHAMPIONS = 'spot_quant_champions';
const DEFAULT_HISTORY_LIMIT = 5000;
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
  return Math.max(min, Math.min(max, n(value)));
}

function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function median(values = []) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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
    medianReturn: median(returns),
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
  if (feature.volatility >= 0.015 || feature.atrPct >= 0.03) return 'HIGH_VOLATILITY';
  if (trendGap >= 0.004 && feature.price > feature.ema20) return 'UPTREND';
  if (trendGap <= -0.004 && feature.price < feature.ema20) return 'DOWNTREND';
  if (feature.volatility <= 0.0045) return 'SIDEWAYS_LOW_VOL';
  return 'SIDEWAYS';
}

function strategyConfigs() {
  const exits = [
    { tpAtr: 1.8, slAtr: 0.9, timeoutBars: 24, cooldownBars: 6 },
    { tpAtr: 2.2, slAtr: 1.0, timeoutBars: 36, cooldownBars: 8 },
    { tpAtr: 2.6, slAtr: 1.15, timeoutBars: 48, cooldownBars: 10 }
  ];
  const families = [
    { family: 'TREND', thresholds: [76, 82], regimes: ['UPTREND'] },
    { family: 'BREAKOUT', thresholds: [78, 84], regimes: ['UPTREND', 'SIDEWAYS'] },
    { family: 'MOMENTUM', thresholds: [78, 84], regimes: ['UPTREND'] },
    { family: 'MEAN_REVERSION', thresholds: [80, 86], regimes: ['SIDEWAYS_LOW_VOL', 'SIDEWAYS'] }
  ];
  return families.flatMap((family) => family.thresholds.flatMap((threshold) =>
    exits.map((exit) => ({ ...family, threshold, ...exit }))
  ));
}

function familyScore(feature, family) {
  if (!feature) return 0;
  const trendGap = feature.price > 0 ? (feature.ema20 - feature.ema50) / feature.price : 0;
  const distance20 = feature.ema20 > 0 ? (feature.price - feature.ema20) / feature.ema20 : 0;
  let score = 10;

  if (family === 'TREND') {
    if (feature.price > feature.ema20) score += 22;
    if (feature.ema20 > feature.ema50) score += 24;
    if (trendGap >= 0.003 && trendGap <= 0.015) score += 18;
    if (feature.rsi14 >= 52 && feature.rsi14 <= 66) score += 16;
    if (feature.momentum5 >= 0.002 && feature.momentum5 <= 0.018) score += 14;
    if (feature.volumeRelative >= 1.0) score += 8;
    if (feature.rsi14 > 72 || feature.momentum5 > 0.03) score -= 28;
  } else if (family === 'BREAKOUT') {
    if (feature.breakout) score += 34;
    if (feature.volumeRelative >= 1.5) score += 24;
    if (feature.momentum5 >= 0.004 && feature.momentum5 <= 0.025) score += 18;
    if (feature.rsi14 >= 54 && feature.rsi14 <= 69) score += 14;
    if (feature.price > feature.ema20) score += 10;
    if (feature.volumeRelative < 1.15 || feature.momentum5 > 0.035) score -= 35;
  } else if (family === 'MOMENTUM') {
    if (feature.momentum5 >= 0.005 && feature.momentum5 <= 0.02) score += 30;
    if (feature.rsi14 >= 55 && feature.rsi14 <= 67) score += 24;
    if (feature.volumeRelative >= 1.15) score += 18;
    if (feature.price > feature.ema20 && feature.ema20 > feature.ema50) score += 20;
    if (feature.rsi14 > 72 || feature.momentum5 > 0.03) score -= 35;
  } else if (family === 'MEAN_REVERSION') {
    if (feature.rsi14 >= 28 && feature.rsi14 <= 39) score += 30;
    if (distance20 <= -0.008 && distance20 >= -0.035) score += 30;
    if (feature.volatility <= 0.01) score += 18;
    if (feature.momentum5 < 0 && feature.momentum5 >= -0.025) score += 14;
    if (trendGap < -0.012 || feature.atrPct > 0.025) score -= 40;
  }

  return clamp(score, 0, 100);
}

function confirmationPass(candles, signalIndex, feature, family) {
  const confirmation = candles[signalIndex + 1];
  if (!confirmation) return false;
  const open = n(confirmation.open);
  const close = n(confirmation.close);
  const high = n(confirmation.high);
  const low = n(confirmation.low);
  if (!(open > 0 && close > 0 && high >= low)) return false;
  const body = (close - open) / open;
  const range = (high - low) / open;
  if (range <= 0 || range > 0.06) return false;

  if (family === 'MEAN_REVERSION') {
    return close > open && close >= n(feature.price) * 0.998;
  }
  return close > open && body >= 0.0005 && close >= n(feature.price);
}

function simulateFamily(candles, config, startIndex, endIndex, feeRate = 0.001, slippageRate = 0.00025) {
  const trades = [];
  const roundTripCost = feeRate * 2 + slippageRate * 2;
  let index = Math.max(100, startIndex);

  while (index < endIndex - 3) {
    const feature = featureAt(candles, index);
    const regime = detectRegime(feature);
    const score = familyScore(feature, config.family);
    if (!feature || feature.atrPct <= 0 || feature.atrPct > 0.04 || score < config.threshold ||
        !config.regimes.includes(regime) || !confirmationPass(candles, index, feature, config.family)) {
      index += 1;
      continue;
    }

    const rawEntry = n(candles[index + 2]?.open);
    if (!(rawEntry > 0)) {
      index += 1;
      continue;
    }

    const entry = rawEntry * (1 + slippageRate);
    const tpPct = clamp(feature.atrPct * config.tpAtr, 0.008, 0.05);
    const slPct = clamp(feature.atrPct * config.slAtr, 0.004, 0.024);
    if (tpPct / slPct < 1.65 || tpPct <= roundTripCost * 2.2) {
      index += 1;
      continue;
    }

    const tp = entry * (1 + tpPct);
    const initialStop = entry * (1 - slPct);
    const breakevenTrigger = entry * (1 + slPct * 0.9);
    const last = Math.min(endIndex - 1, index + 2 + config.timeoutBars);
    let exit = n(candles[last]?.close) * (1 - slippageRate);
    let reason = 'TIMEOUT';
    let exitIndex = last;
    let stop = initialStop;

    for (let cursor = index + 2; cursor <= last; cursor += 1) {
      const candle = candles[cursor];
      if (n(candle.high) >= breakevenTrigger) stop = Math.max(stop, entry * (1 + roundTripCost * 0.25));
      const stopHit = n(candle.low) <= stop;
      const profitHit = n(candle.high) >= tp;
      if (stopHit) {
        exit = stop * (1 - slippageRate);
        reason = stop > initialStop ? 'BREAKEVEN_PROTECT' : 'STOP_LOSS';
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

    const grossReturn = exit / entry - 1;
    trades.push({
      entryIndex: index + 2,
      exitIndex,
      netReturn: grossReturn - feeRate * 2,
      grossReturn,
      reason,
      score,
      regime,
      family: config.family,
      rewardRisk: tpPct / slPct
    });
    index = exitIndex + config.cooldownBars;
  }
  return trades;
}

function buildFolds(candleCount) {
  const start = 100;
  const usable = candleCount - start;
  if (usable < 1000) return [];
  const definitions = [
    [0.42, 0.56, 0.67],
    [0.52, 0.66, 0.77],
    [0.62, 0.76, 0.88],
    [0.72, 0.86, 1.00]
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
  const validationExpectancies = folds.map((fold) => fold.validation.expectancy);
  const testExpectancies = folds.map((fold) => fold.test.expectancy);
  const positiveValidationFolds = folds.filter((fold) => fold.validation.trades >= 3 && fold.validation.expectancy > 0 && fold.validation.profitFactor >= 1.05).length;
  const positiveTestFolds = folds.filter((fold) => fold.test.trades >= 3 && fold.test.expectancy > 0 && fold.test.profitFactor >= 1.05).length;

  return {
    validation: metrics(validationTrades),
    test: metrics(testTrades),
    consistency: {
      folds: folds.length,
      positive_validation_folds: positiveValidationFolds,
      positive_test_folds: positiveTestFolds,
      validation_ratio: folds.length ? positiveValidationFolds / folds.length : 0,
      test_ratio: folds.length ? positiveTestFolds / folds.length : 0,
      median_validation_expectancy: median(validationExpectancies),
      median_test_expectancy: median(testExpectancies),
      test_expectancy_std: std(testExpectancies)
    },
    folds: folds.map(({ validationTrades: _v, testTrades: _t, ...fold }) => fold),
    testTrades
  };
}

function probabilityCalibration(trades = []) {
  if (!trades.length) return { samples: 0, brier: null, calibrated: false };
  const brier = mean(trades.map((trade) => {
    const probability = clamp((n(trade.score) - 60) / 40, 0.05, 0.9);
    const outcome = trade.netReturn > 0 ? 1 : 0;
    return (probability - outcome) ** 2;
  }));
  return { samples: trades.length, brier, calibrated: trades.length >= 24 && brier <= 0.24 };
}

function objective(candidate) {
  const validation = candidate?.walk?.validation;
  const test = candidate?.walk?.test;
  const consistency = candidate?.walk?.consistency;
  if (!validation || !test || validation.trades < 10 || test.trades < 10) return -9999;
  const samplePenalty = Math.max(0, 24 - Math.min(validation.trades, test.trades)) * 0.08;
  return (
    validation.expectancy * 1200 +
    test.expectancy * 1800 +
    Math.min(validation.profitFactor, 3) * 0.7 +
    Math.min(test.profitFactor, 3) * 1.3 +
    n(consistency?.validation_ratio) * 1.5 +
    n(consistency?.test_ratio) * 2.2 +
    n(consistency?.median_test_expectancy) * 900 -
    n(consistency?.test_expectancy_std) * 800 -
    validation.maxDrawdown * 8 -
    test.maxDrawdown * 12 -
    samplePenalty
  );
}

function eligibilityDiagnostic(champion) {
  const validation = champion?.walk?.validation || null;
  const test = champion?.walk?.test || null;
  const consistency = champion?.walk?.consistency || null;
  const calibration = champion?.calibration || null;
  const checks = {
    validation_min_trades: n(validation?.trades) >= 14,
    validation_expectancy_positive: n(validation?.expectancy) >= 0.00035,
    validation_profit_factor: n(validation?.profitFactor) >= 1.18,
    validation_median_positive: n(validation?.medianReturn) > 0,
    test_min_trades: n(test?.trades) >= 14,
    test_expectancy_positive: n(test?.expectancy) >= 0.00035,
    test_profit_factor: n(test?.profitFactor) >= 1.18,
    test_drawdown: n(test?.maxDrawdown, 1) <= 0.10,
    validation_fold_consistency: n(consistency?.positive_validation_folds) >= 3,
    test_fold_consistency: n(consistency?.positive_test_folds) >= 3,
    median_test_expectancy_positive: n(consistency?.median_test_expectancy) > 0,
    expectation_stability: n(consistency?.test_expectancy_std, 1) <= 0.006,
    probability_calibrated: n(calibration?.samples) < 24 || calibration?.calibrated === true
  };
  return { eligible: Object.values(checks).every(Boolean), checks, validation, test, consistency, calibration };
}

function normalizeSymbols(input) {
  const requested = Array.isArray(input) && input.length ? input : DEFAULT_SYMBOLS;
  return [...new Set(requested
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]{2,16}USDT$/.test(symbol)))]
    .slice(0, 12);
}

async function runSymbolResearch(symbol, options = {}) {
  const interval = options.interval || '5m';
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1500, n(options.limit, DEFAULT_HISTORY_LIMIT)));
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
    runners_up: evaluated.slice(1, 6)
  };
}

function selectGlobalChampion(results = []) {
  const valid = results.filter((result) => result?.champion && n(result.champion.score, -9999) > -9999)
    .sort((left, right) => n(right.champion?.score, -Infinity) - n(left.champion?.score, -Infinity));
  const eligible = valid.filter((result) => result.champion?.eligibility?.eligible === true);
  const selected = eligible[0] || valid[0] || null;
  return {
    selected,
    observationChampion: valid[0] || null,
    eligibleCount: eligible.length,
    validCount: valid.length,
    failedCount: Math.max(0, results.length - valid.length),
    selectionMode: eligible.length ? 'BEST_ELIGIBLE_PRODUCTIVE' : selected ? 'OBSERVATION_ONLY_PRODUCTIVE' : 'NONE'
  };
}

async function runQuantResearchLab(db, options = {}) {
  const symbols = normalizeSymbols(options.symbols);
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(1500, n(options.limit, DEFAULT_HISTORY_LIMIT)));
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
    strategy_families: ['TREND', 'BREAKOUT', 'MOMENTUM', 'MEAN_REVERSION'],
    walk_forward_folds: 4,
    safeguards: {
      confirmation_candle: true,
      cooldown_between_trades: true,
      minimum_reward_risk: 1.65,
      breakeven_protection: true,
      fees_and_slippage_included: true
    },
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
    version: 'spot_quant_lab_v6_productive'
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
      version: 'spot_quant_champion_v6_productive'
    }, { merge: true });
  }

  console.log(JSON.stringify({
    event: 'SPOT_QUANT_RESEARCH_RESULT',
    run_id: runId,
    version: summary.version,
    symbols,
    strategy_families: summary.strategy_families,
    walk_forward_folds: summary.walk_forward_folds,
    safeguards: summary.safeguards,
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
  confirmationPass,
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
