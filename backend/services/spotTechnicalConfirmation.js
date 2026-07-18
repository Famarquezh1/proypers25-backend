'use strict';

const axios = require('axios');

const BINANCE_BASE = 'https://api.binance.com';
const DEFAULT_INTERVALS = ['5m', '15m', '1h'];

function finite(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ema(values, period) {
  if (!Array.isArray(values) || values.length < period) return null;
  const multiplier = 2 / (period + 1);
  let result = average(values.slice(0, period));
  for (let index = period; index < values.length; index += 1) {
    result = ((values[index] - result) * multiplier) + result;
  }
  return result;
}

function rsi(values, period = 14) {
  if (!Array.isArray(values) || values.length <= period) return null;
  let gains = 0;
  let losses = 0;
  for (let index = values.length - period; index < values.length; index += 1) {
    const change = values[index] - values[index - 1];
    if (change >= 0) gains += change;
    else losses += Math.abs(change);
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + (avgGain / avgLoss)));
}

function atr(candles, period = 14) {
  if (!Array.isArray(candles) || candles.length <= period) return null;
  const ranges = [];
  for (let index = candles.length - period; index < candles.length; index += 1) {
    const candle = candles[index];
    const previousClose = candles[index - 1].close;
    ranges.push(Math.max(
      candle.high - candle.low,
      Math.abs(candle.high - previousClose),
      Math.abs(candle.low - previousClose)
    ));
  }
  return average(ranges);
}

function standardDeviation(values) {
  if (!values.length) return 0;
  const mean = average(values);
  return Math.sqrt(average(values.map((value) => (value - mean) ** 2)));
}

function parseKlines(rows) {
  return (rows || []).map((row) => ({
    openTime: finite(row[0]),
    open: finite(row[1]),
    high: finite(row[2]),
    low: finite(row[3]),
    close: finite(row[4]),
    volume: finite(row[5]),
    closeTime: finite(row[6]),
    quoteVolume: finite(row[7])
  })).filter((candle) => candle.close > 0 && candle.high > 0 && candle.low > 0);
}

async function fetchCandles(symbol, interval, limit = 220) {
  const response = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
    params: { symbol, interval, limit },
    timeout: 10000
  });
  return parseKlines(response.data);
}

function candlePattern(candles) {
  if (candles.length < 3) return { bullish: false, bearish: false, names: [] };
  const current = candles[candles.length - 1];
  const previous = candles[candles.length - 2];
  const body = Math.abs(current.close - current.open);
  const range = Math.max(current.high - current.low, Number.EPSILON);
  const lowerWick = Math.min(current.open, current.close) - current.low;
  const bullishEngulfing = current.close > current.open && previous.close < previous.open &&
    current.open <= previous.close && current.close >= previous.open;
  const hammer = current.close >= current.open && lowerWick >= body * 2 && body / range <= 0.45;
  const bearishEngulfing = current.close < current.open && previous.close > previous.open &&
    current.open >= previous.close && current.close <= previous.open;
  const names = [];
  if (bullishEngulfing) names.push('BULLISH_ENGULFING');
  if (hammer) names.push('HAMMER');
  if (bearishEngulfing) names.push('BEARISH_ENGULFING');
  return { bullish: bullishEngulfing || hammer, bearish: bearishEngulfing, names };
}

function analyzeTimeframe(interval, candles) {
  if (candles.length < 60) {
    return { interval, valid: false, reason: 'INSUFFICIENT_CANDLES' };
  }
  const closes = candles.map((candle) => candle.close);
  const last = candles[candles.length - 1];
  const recent20 = closes.slice(-20);
  const ema20 = ema(closes, 20);
  const ema50 = ema(closes, 50);
  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macd = ema12 !== null && ema26 !== null ? ema12 - ema26 : null;
  const rsi14 = rsi(closes, 14);
  const atr14 = atr(candles, 14);
  const middle = average(recent20);
  const deviation = standardDeviation(recent20);
  const upperBand = middle + (2 * deviation);
  const lowerBand = middle - (2 * deviation);
  const quoteVolume = candles.slice(-20).reduce((sum, candle) => sum + candle.quoteVolume, 0);
  const typicalVolume = average(candles.slice(-20, -1).map((candle) => candle.quoteVolume));
  const relativeVolume = typicalVolume > 0 ? last.quoteVolume / typicalVolume : 0;
  const vwapDenominator = candles.slice(-20).reduce((sum, candle) => sum + candle.volume, 0);
  const vwap = vwapDenominator > 0
    ? candles.slice(-20).reduce((sum, candle) => sum + (((candle.high + candle.low + candle.close) / 3) * candle.volume), 0) / vwapDenominator
    : null;
  const pattern = candlePattern(candles);
  const trendBullish = ema20 !== null && ema50 !== null && last.close > ema20 && ema20 > ema50;
  const momentumPositive = macd !== null && macd > 0 && rsi14 !== null && rsi14 >= 48 && rsi14 <= 70;
  const volumeConfirmed = relativeVolume >= 1.05;
  const aboveVwap = vwap !== null && last.close >= vwap;
  const overextended = rsi14 !== null && (rsi14 > 76 || last.close > upperBand * 1.01);
  const volatilityPct = atr14 && last.close > 0 ? (atr14 / last.close) * 100 : null;

  let score = 0;
  if (trendBullish) score += 30;
  if (momentumPositive) score += 25;
  if (volumeConfirmed) score += 15;
  if (aboveVwap) score += 15;
  if (pattern.bullish) score += 10;
  if (!overextended) score += 5;
  if (pattern.bearish) score -= 15;
  if (overextended) score -= 25;
  score = Math.max(0, Math.min(100, score));

  return {
    interval,
    valid: true,
    score,
    close: last.close,
    ema20,
    ema50,
    rsi14,
    macd,
    atr14,
    atr_pct: volatilityPct,
    bollinger_upper: upperBand,
    bollinger_lower: lowerBand,
    vwap,
    relative_volume: relativeVolume,
    quote_volume_20_candles: quoteVolume,
    trend_bullish: trendBullish,
    momentum_positive: momentumPositive,
    volume_confirmed: volumeConfirmed,
    above_vwap: aboveVwap,
    overextended,
    candle_patterns: pattern.names
  };
}

async function evaluateSpotTechnicalConfirmation(symbol, config = {}) {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized.endsWith('USDT')) {
    return { allowed: false, symbol: normalized, reasons: ['INVALID_USDT_SYMBOL'], timeframes: [] };
  }
  const intervals = Array.isArray(config.paper_real_technical_intervals) && config.paper_real_technical_intervals.length
    ? config.paper_real_technical_intervals.slice(0, 4)
    : DEFAULT_INTERVALS;
  const minimumScore = Math.max(0, finite(config.paper_real_min_technical_score, 65));
  const minimumConfirmations = Math.max(1, finite(config.paper_real_min_timeframe_confirmations, 2));
  const reasons = [];

  const results = await Promise.all(intervals.map(async (interval) => {
    try {
      return analyzeTimeframe(interval, await fetchCandles(normalized, interval));
    } catch (error) {
      return { interval, valid: false, reason: error.response?.data?.msg || error.message };
    }
  }));

  const valid = results.filter((item) => item.valid);
  const confirmations = valid.filter((item) => item.score >= minimumScore && item.trend_bullish && !item.overextended);
  const aggregateScore = valid.length ? average(valid.map((item) => item.score)) : 0;
  if (valid.length !== intervals.length) reasons.push('TECHNICAL_DATA_INCOMPLETE');
  if (confirmations.length < minimumConfirmations) reasons.push('INSUFFICIENT_TIMEFRAME_CONFIRMATION');
  if (aggregateScore < minimumScore) reasons.push('TECHNICAL_SCORE_BELOW_THRESHOLD');
  if (valid.some((item) => item.overextended)) reasons.push('MOVE_OVEREXTENDED');
  if (!valid.some((item) => item.volume_confirmed)) reasons.push('VOLUME_NOT_CONFIRMED');

  return {
    allowed: reasons.length === 0,
    symbol: normalized,
    score: Number(aggregateScore.toFixed(2)),
    confirmations: confirmations.length,
    required_confirmations: minimumConfirmations,
    minimum_score: minimumScore,
    reasons,
    timeframes: results,
    generated_at: new Date().toISOString(),
    source: 'binance_public_klines',
    version: 'spot_technical_confirmation_v1',
    no_order_created: true
  };
}

module.exports = {
  analyzeTimeframe,
  evaluateSpotTechnicalConfirmation,
  ema,
  rsi,
  atr,
  candlePattern
};
