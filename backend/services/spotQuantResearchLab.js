'use strict';

const axios = require('axios');

const BINANCE_API = 'https://api.binance.com';
const RESULTS = 'spot_quant_research_runs';
const CHAMPIONS = 'spot_quant_champions';

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
  const m = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - m) ** 2)));
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const alpha = 2 / (period + 1);
  let current = mean(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) current = values[i] * alpha + current * (1 - alpha);
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
  })).filter((row) => row.close > 0 && row.high > 0 && row.low > 0);
}

async function fetchKlines(symbol, interval = '5m', limit = 1000) {
  const response = await axios.get(`${BINANCE_API}/api/v3/klines`, {
    params: { symbol, interval, limit: Math.min(1000, Math.max(100, limit)) },
    timeout: 12000
  });
  return parseKlines(response.data || []);
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
  const thresholds = [66, 72, 78];
  const tpMultipliers = [1.5, 2, 2.5];
  const slMultipliers = [0.8, 1, 1.2];
  const timeouts = [12, 24, 36];
  for (const threshold of thresholds) {
    for (const tpAtr of tpMultipliers) {
      for (const slAtr of slMultipliers) {
        for (const timeoutBars of timeouts) configs.push({ threshold, tpAtr, slAtr, timeoutBars });
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
    const netReturn = grossReturn - (feeRate * 2);
    trades.push({ entryIndex: index + 1, exitIndex, netReturn, grossReturn, reason, score: feature.score });
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
  return (value.expectancy * 1000) + Math.min(value.profitFactor, 4) - (value.maxDrawdown * 8) + Math.min(value.trades, 30) / 30;
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

async function runSymbolResearch(symbol, options = {}) {
  const interval = options.interval || '5m';
  const candles = await fetchKlines(symbol, interval, n(options.limit, 1000));
  const feeRate = clamp(n(options.feeRate, 0.001), 0, 0.01);
  const evaluated = candidateConfigs().map((config) => {
    const walk = walkForward(candles, config, feeRate);
    const score = objective(walk.validation) + objective(walk.test) * 1.5;
    const testTrades = simulate(candles, config, 60 + Math.floor((candles.length - 60) * 0.8), candles.length, feeRate);
    return { config, walk, calibration: probabilityCalibration(testTrades), score };
  }).sort((a, b) => b.score - a.score);

  return {
    symbol,
    interval,
    candles: candles.length,
    generated_at: new Date().toISOString(),
    champion: evaluated[0] || null,
    runners_up: evaluated.slice(1, 5)
  };
}

function promotionEligible(champion) {
  const test = champion?.walk?.test;
  const validation = champion?.walk?.validation;
  if (!test || !validation) return false;
  return validation.trades >= 5 && test.trades >= 5 &&
    validation.expectancy > 0 && test.expectancy > 0 &&
    validation.profitFactor >= 1.15 && test.profitFactor >= 1.15 &&
    test.maxDrawdown <= 0.12;
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
  const symbols = [...new Set((options.symbols || ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'TONUSDT'])
    .map((symbol) => String(symbol).toUpperCase()).filter((symbol) => /^[A-Z0-9]{5,20}USDT$/.test(symbol)))]
    .slice(0, 10);
  const results = [];
  for (const symbol of symbols) {
    try {
      const result = await runSymbolResearch(symbol, options);
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
    symbols,
    results,
    global_champion: globalChampion,
    observation_champion: selection.observationChampion,
    promotion_eligible: Boolean(globalChampion?.promotion_eligible),
    no_eligible_champion: selection.eligibleCount === 0,
    selection: {
      mode: selection.selectionMode,
      analyzed_count: results.length,
      valid_count: selection.validCount,
      eligible_count: selection.eligibleCount,
      failed_count: selection.failedCount,
      selected_symbol: globalChampion?.symbol || null,
      observation_symbol: selection.observationChampion?.symbol || null
    },
    limits_unchanged: true,
    version: 'spot_quant_lab_v2'
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
      version: 'spot_quant_champion_v2'
    }, { merge: true });
  }
  return summary;
}

module.exports = {
  fetchKlines,
  featureAt,
  simulate,
  metrics,
  walkForward,
  probabilityCalibration,
  promotionEligible,
  selectGlobalChampion,
  runSymbolResearch,
  runQuantResearchLab
};