'use strict';

const axios = require('axios');

const BINANCE_API = 'https://api.binance.com';
const RESULTS = 'spot_quant_research_runs';
const CHAMPIONS = 'spot_quant_champions';
const DEFAULT_HISTORY_LIMIT = 3000;
const MAX_HISTORY_LIMIT = 5000;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}

function std(values) {
  if (values.length < 2) return 0;
  const average = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - average) ** 2)));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    current = values[i] * alpha + current * (1 - alpha);
  }
  return current;
}

function rsi(values, period = 14) {
  if (values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let i = values.length - period; i < values.length; i += 1) {
    const delta = values[i] - values[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  if (losses === 0) return 100;
  const rs = (gains / period) / (losses / period);
  return 100 - (100 / (1 + rs));
}

function atr(candles, period = 14) {
  if (candles.length <= period) return null;
  const ranges = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const previous = candles[i - 1].close;
    ranges.push(Math.max(
      candles[i].high - candles[i].low,
      Math.abs(candles[i].high - previous),
      Math.abs(candles[i].low - previous)
    ));
  }
  return mean(ranges);
}

function parseKlines(rows) {
  return rows.map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7])
  })).filter((row) => row.close > 0 && row.high > 0 && row.low > 0 && Number.isFinite(row.openTime));
}

function intervalToMilliseconds(interval = '5m') {
  const match = String(interval).match(/^(\d+)([mhdw])$/i);
  if (!match) return 5 * 60 * 1000;
  const value = Math.max(1, Number(match[1]));
  const unit = match[2].toLowerCase();
  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
    w: 7 * 24 * 60 * 60 * 1000
  };
  return value * multipliers[unit];
}

async function fetchKlines(symbol, interval = '5m', limit = DEFAULT_HISTORY_LIMIT) {
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(100, Math.floor(n(limit, DEFAULT_HISTORY_LIMIT))));
  const rowsByOpenTime = new Map();
  let endTime;
  let requests = 0;

  while (rowsByOpenTime.size < requestedLimit && requests < Math.ceil(requestedLimit / 1000) + 1) {
    const batchLimit = Math.min(1000, requestedLimit - rowsByOpenTime.size);
    const params = { symbol, interval, limit: Math.max(1, batchLimit) };
    if (endTime) params.endTime = endTime;

    const response = await axios.get(`${BINANCE_API}/api/v3/klines`, {
      params,
      timeout: 15000
    });
    const batch = parseKlines(response.data || []);
    requests += 1;
    if (!batch.length) break;

    for (const candle of batch) rowsByOpenTime.set(candle.openTime, candle);
    const oldestOpenTime = batch[0].openTime;
    if (!Number.isFinite(oldestOpenTime) || oldestOpenTime <= 0) break;
    endTime = oldestOpenTime - 1;
    if (batch.length < batchLimit) break;
  }

  return Array.from(rowsByOpenTime.values())
    .sort((left, right) => left.openTime - right.openTime)
    .slice(-requestedLimit);
}

function featureAt(candles, index) {
  const history = candles.slice(Math.max(0, index - 80), index + 1);
  const closes = history.map((candle) => candle.close);
  const volumes = history.map((candle) => candle.quoteVolume || candle.volume);
  if (closes.length < 55) return null;

  const price = closes[closes.length - 1];
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(history, 14);
  const volumeMean = mean(volumes.slice(-21, -1));
  const volumeRelative = volumeMean > 0 ? volumes[volumes.length - 1] / volumeMean : 0;
  const returns = closes.slice(-21).map((close, i, array) => i ? (close / array[i - 1]) - 1 : 0).slice(1);
  const volatility = std(returns);
  const breakoutHigh = Math.max(...history.slice(-21, -1).map((candle) => candle.high));
  const momentum5 = closes.length >= 6 ? (price / closes[closes.length - 6]) - 1 : 0;

  let score = 50;
  if (price > ema20) score += 10;
  if (ema20 > ema50) score += 12;
  if (rsi14 >= 52 && rsi14 <= 68) score += 10;
  if (volumeRelative >= 1.25) score += 10;
  if (price > breakoutHigh) score += 12;
  if (momentum5 > 0 && momentum5 < 0.025) score += 6;
  if (rsi14 > 76) score -= 18;
  if (atr14 && price > 0 && atr14 / price > 0.04) score -= 10;
  if (momentum5 > 0.04) score -= 15;

  return {
    score: clamp(score, 0, 100),
    price,
    ema20,
    ema50,
    rsi14,
    atrPct: atr14 && price ? atr14 / price : 0,
    volumeRelative,
    volatility,
    momentum5,
    breakout: price > breakoutHigh
  };
}

function candidateConfigs() {
  const configs = [];
  for (const threshold of [66, 72, 78]) {
    for (const tpAtr of [1.5, 2, 2.5]) {
      for (const slAtr of [0.8, 1, 1.2]) {
        for (const timeoutBars of [12, 24, 36, 48]) {
          configs.push({ threshold, tpAtr, slAtr, timeoutBars });
        }
      }
    }
  }
  return configs;
}

function simulate(candles, config, startIndex, endIndex, feeRate = 0.001) {
  const trades = [];
  let index = Math.max(60, startIndex);
  while (index < endIndex - 2) {
    const feature = featureAt(candles, index);
    if (!feature || feature.score < config.threshold || feature.atrPct <= 0) {
      index += 1;
      continue;
    }

    const entry = candles[index + 1].open;
    const tpPct = clamp(feature.atrPct * config.tpAtr, 0.004, 0.06);
    const slPct = clamp(feature.atrPct * config.slAtr, 0.003, 0.035);
    const tp = entry * (1 + tpPct);
    const sl = entry * (1 - slPct);
    const last = Math.min(endIndex - 1, index + config.timeoutBars);
    let exit = candles[last].close;
    let reason = 'TIMEOUT';
    let exitIndex = last;

    for (let cursor = index + 1; cursor <= last; cursor += 1) {
      const candle = candles[cursor];
      if (candle.low <= sl) {
        exit = sl;
        reason = 'STOP_LOSS';
        exitIndex = cursor;
        break;
      }
      if (candle.high >= tp) {
        exit = tp;
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
      score: feature.score
    });
    index = exitIndex + 1;
  }
  return trades;
}

function metrics(trades) {
  const returns = trades.map((trade) => trade.netReturn);
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
    trades: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    expectancy: mean(returns),
    profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    maxDrawdown,
    netReturn: equity - 1,
    averageWin: mean(wins),
    averageLoss: mean(losses)
  };
}

function objective(value) {
  if (!value || value.trades < 5) return -999;
  return (value.expectancy * 1000) + Math.min(value.profitFactor, 4) -
    (value.maxDrawdown * 8) + Math.min(value.trades, 30) / 30;
}

function walkForward(candles, config, feeRate) {
  const usableStart = 60;
  const usable = candles.length - usableStart;
  const trainEnd = usableStart + Math.floor(usable * 0.6);
  const validationEnd = usableStart + Math.floor(usable * 0.8);
  return {
    train: metrics(simulate(candles, config, usableStart, trainEnd, feeRate)),
    validation: metrics(simulate(candles, config, trainEnd, validationEnd, feeRate)),
    test: metrics(simulate(candles, config, validationEnd, candles.length, feeRate))
  };
}

function probabilityCalibration(trades) {
  if (!trades.length) return { samples: 0, brier: null, calibrated: false };
  const brier = mean(trades.map((trade) => {
    const probability = clamp((trade.score - 50) / 50, 0.05, 0.95);
    const outcome = trade.netReturn > 0 ? 1 : 0;
    return (probability - outcome) ** 2;
  }));
  return { samples: trades.length, brier, calibrated: trades.length >= 20 && brier <= 0.25 };
}

function buildEligibilityDiagnostic(champion) {
  const validation = champion?.walk?.validation || null;
  const test = champion?.walk?.test || null;
  const checks = {
    validation_min_trades: n(validation?.trades) >= 5,
    validation_expectancy_positive: n(validation?.expectancy) > 0,
    validation_profit_factor: n(validation?.profitFactor) >= 1.15,
    test_min_trades: n(test?.trades) >= 5,
    test_expectancy_positive: n(test?.expectancy) > 0,
    test_profit_factor: n(test?.profitFactor) >= 1.15,
    test_drawdown: n(test?.maxDrawdown, 1) <= 0.12
  };
  return {
    eligible: Object.values(checks).every(Boolean),
    checks,
    validation,
    test,
    calibration: champion?.calibration || null
  };
}

async function runSymbolResearch(symbol, options = {}) {
  const interval = options.interval || '5m';
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(100, n(options.limit, DEFAULT_HISTORY_LIMIT)));
  const candles = await fetchKlines(symbol, interval, requestedLimit);
  const feeRate = clamp(n(options.feeRate, 0.001), 0, 0.01);
  const evaluated = candidateConfigs().map((config) => {
    const walk = walkForward(candles, config, feeRate);
    const score = objective(walk.validation) + objective(walk.test) * 1.5;
    const testStart = 60 + Math.floor((candles.length - 60) * 0.8);
    const testTrades = simulate(candles, config, testStart, candles.length, feeRate);
    return { config, walk, calibration: probabilityCalibration(testTrades), score };
  }).sort((a, b) => b.score - a.score);

  const champion = evaluated[0] || null;
  return {
    symbol,
    interval,
    requested_candles: requestedLimit,
    candles: candles.length,
    history_start: candles[0] ? new Date(candles[0].openTime).toISOString() : null,
    history_end: candles.length ? new Date(candles[candles.length - 1].closeTime).toISOString() : null,
    history_duration_hours: candles.length ? ((candles[candles.length - 1].closeTime - candles[0].openTime) / 3600000) : 0,
    generated_at: new Date().toISOString(),
    champion,
    eligibility: buildEligibilityDiagnostic(champion),
    runners_up: evaluated.slice(1, 5)
  };
}

function promotionEligible(champion) {
  return buildEligibilityDiagnostic(champion).eligible;
}

function normalizeSymbols(input) {
  const requested = Array.isArray(input) && input.length
    ? input
    : ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'TONUSDT'];
  return [...new Set(requested
    .map((symbol) => String(symbol || '').trim().toUpperCase())
    .filter((symbol) => /^[A-Z0-9]{2,16}USDT$/.test(symbol)))]
    .slice(0, 10);
}

function selectGlobalChampion(results = []) {
  const valid = results
    .filter((result) => result?.champion)
    .sort((a, b) => n(b.champion?.score, -Infinity) - n(a.champion?.score, -Infinity));
  const eligible = valid.filter((result) => result.promotion_eligible === true);
  const selected = eligible[0] || valid[0] || null;
  return {
    selected,
    observationChampion: valid[0] || null,
    eligibleCount: eligible.length,
    validCount: valid.length,
    failedCount: Math.max(0, results.length - valid.length),
    selectionMode: eligible.length > 0 ? 'BEST_ELIGIBLE' : selected ? 'OBSERVATION_ONLY' : 'NONE'
  };
}

async function runQuantResearchLab(db, options = {}) {
  const symbols = normalizeSymbols(options.symbols);
  const requestedLimit = Math.min(MAX_HISTORY_LIMIT, Math.max(100, n(options.limit, DEFAULT_HISTORY_LIMIT)));
  const researchOptions = { ...options, limit: requestedLimit };
  const results = [];

  for (const symbol of symbols) {
    try {
      const result = await runSymbolResearch(symbol, researchOptions);
      result.promotion_eligible = promotionEligible(result.champion);
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
    symbols,
    results,
    global_champion: globalChampion,
    observation_champion: selection.observationChampion,
    promotion_eligible: Boolean(globalChampion?.promotion_eligible),
    no_eligible_champion: selection.eligibleCount === 0,
    selected_evidence: globalChampion?.eligibility || null,
    selection: {
      mode: selection.selectionMode,
      requested_count: Array.isArray(options.symbols) ? options.symbols.length : 5,
      accepted_symbol_count: symbols.length,
      analyzed_count: results.length,
      valid_count: selection.validCount,
      eligible_count: selection.eligibleCount,
      failed_count: selection.failedCount,
      selected_symbol: globalChampion?.symbol || null,
      observation_symbol: selection.observationChampion?.symbol || null
    },
    limits_unchanged: true,
    version: 'spot_quant_lab_v4'
  };

  await db.collection(RESULTS).doc(runId).set(summary);
  if (globalChampion) {
    await db.collection(CHAMPIONS).doc('current').set({
      ...globalChampion,
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
      version: 'spot_quant_champion_v4'
    }, { merge: true });
  }

  console.log(JSON.stringify({
    event: 'SPOT_QUANT_RESEARCH_RESULT',
    run_id: runId,
    symbols,
    history: summary.history,
    selection: summary.selection,
    selected_evidence: summary.selected_evidence,
    promotion_eligible: summary.promotion_eligible,
    no_eligible_champion: summary.no_eligible_champion,
    errors: results.filter((result) => result.error).map((result) => ({
      symbol: result.symbol,
      error: result.error
    }))
  }));

  return summary;
}

module.exports = {
  fetchKlines,
  intervalToMilliseconds,
  featureAt,
  simulate,
  metrics,
  walkForward,
  probabilityCalibration,
  buildEligibilityDiagnostic,
  promotionEligible,
  normalizeSymbols,
  selectGlobalChampion,
  runSymbolResearch,
  runQuantResearchLab
};
