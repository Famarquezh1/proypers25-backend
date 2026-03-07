/**
 * Event Context Filter (opcional y auditable).
 * No altera scoring engines ni quality gate existente; actua como capa previa adicional.
 */

const ATR_SHORT_PERIOD = 5;
const ATR_MEDIUM_PERIOD = 10;
const ATR_LONG_PERIOD = 20;
const RANGE_LOOKBACK = 6;
const VOLUME_LOOKBACK = 20;
const COMPRESSION_FACTOR = 0.65;
const MIN_RELATIVE_VOLUME = 1.6;
const MIN_VOLUME_ACCELERATION = 1.15;
const MIN_VOLATILITY_EXPANSION_RATIO = 1.2;

const stats = {
  checked: 0,
  passed: 0,
  blocked: 0,
  observed: 0
};

function safeNum(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function clampCandles(candles) {
  return (Array.isArray(candles) ? candles : []).filter((c) => {
    const open = safeNum(c?.open);
    const high = safeNum(c?.high);
    const low = safeNum(c?.low);
    const close = safeNum(c?.close);
    const volume = safeNum(c?.volume);
    return open > 0 && high > 0 && low > 0 && close > 0 && volume >= 0;
  });
}

function trueRange(curr, prevClose) {
  const high = safeNum(curr?.high);
  const low = safeNum(curr?.low);
  if (!prevClose || prevClose <= 0) {
    return high - low;
  }
  return Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose));
}

function average(values) {
  if (!values.length) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function computeEma(values, period) {
  const normalized = (Array.isArray(values) ? values : [])
    .map((v) => safeNum(v))
    .filter((v) => v > 0);
  if (normalized.length < period) return null;
  const seed = average(normalized.slice(0, period));
  const multiplier = 2 / (period + 1);
  let ema = seed;
  for (let i = period; i < normalized.length; i += 1) {
    ema = normalized[i] * multiplier + ema * (1 - multiplier);
  }
  return ema;
}

function computeAtr(candles, period) {
  if (!candles.length || candles.length < period + 1) return null;
  const tr = [];
  for (let i = candles.length - period; i < candles.length; i += 1) {
    const prevClose = safeNum(candles[i - 1]?.close);
    tr.push(trueRange(candles[i], prevClose));
  }
  return average(tr);
}

function detectVolatilityCompression(candles) {
  const normalized = clampCandles(candles);
  const atrShort = computeAtr(normalized, ATR_SHORT_PERIOD);
  const atrLong = computeAtr(normalized, ATR_LONG_PERIOD);
  if (!atrShort || !atrLong) {
    return {
      detected: false,
      atr_short: atrShort,
      atr_long: atrLong,
      enough_data: false
    };
  }
  return {
    detected: atrShort < atrLong * COMPRESSION_FACTOR,
    atr_short: atrShort,
    atr_long: atrLong,
    enough_data: true
  };
}

function detectVolatilityExpansion(candles) {
  const normalized = clampCandles(candles);
  const atrShort = computeAtr(normalized, ATR_SHORT_PERIOD);
  const atrMedium = computeAtr(normalized, ATR_MEDIUM_PERIOD);
  const atrLong = computeAtr(normalized, ATR_LONG_PERIOD);
  if (!atrShort || !atrMedium || !atrLong) {
    return {
      detected: false,
      atr_short: atrShort,
      atr_medium: atrMedium,
      atr_long: atrLong,
      volatility_expansion_ratio: null,
      enough_data: false
    };
  }

  const volatilityExpansionRatio = atrMedium > 0 ? atrShort / atrMedium : 0;
  return {
    detected: volatilityExpansionRatio > MIN_VOLATILITY_EXPANSION_RATIO,
    atr_short: atrShort,
    atr_medium: atrMedium,
    atr_long: atrLong,
    volatility_expansion_ratio: volatilityExpansionRatio,
    enough_data: true
  };
}

function detectRangeBreak(candles, direction, currentPrice) {
  const normalized = clampCandles(candles);
  if (normalized.length < RANGE_LOOKBACK + 1) {
    return {
      detected: false,
      recent_high: null,
      recent_low: null,
      enough_data: false
    };
  }

  const recent = normalized.slice(-RANGE_LOOKBACK - 1, -1);
  const recentHigh = Math.max(...recent.map((c) => safeNum(c.high)));
  const recentLow = Math.min(...recent.map((c) => safeNum(c.low)));
  const price = safeNum(currentPrice) || safeNum(normalized[normalized.length - 1]?.close);

  let detected = false;
  if (direction === 'up') detected = price > recentHigh;
  if (direction === 'down') detected = price < recentLow;

  return {
    detected,
    recent_high: recentHigh,
    recent_low: recentLow,
    current_price: price,
    enough_data: true
  };
}

function detectVolumeConfirmation(candles) {
  const normalized = clampCandles(candles);
  if (normalized.length < VOLUME_LOOKBACK + 1) {
    return {
      detected: false,
      relative_volume: null,
      volume_acceleration: null,
      enough_data: false
    };
  }
  const recent = normalized.slice(-(VOLUME_LOOKBACK + 1));
  const emaVol20 = computeEma(recent.map((c) => safeNum(c.volume)), VOLUME_LOOKBACK);
  const currentVol = safeNum(normalized[normalized.length - 1]?.volume);
  const prevVol = safeNum(normalized[normalized.length - 2]?.volume);
  const relativeVolume = emaVol20 > 0 ? currentVol / emaVol20 : 0;
  const volumeAcceleration = prevVol > 0 ? currentVol / prevVol : 0;
  return {
    detected:
      relativeVolume > MIN_RELATIVE_VOLUME &&
      volumeAcceleration > MIN_VOLUME_ACCELERATION,
    relative_volume: relativeVolume,
    volume_acceleration: volumeAcceleration,
    current_volume: currentVol,
    ema_volume_20: emaVol20,
    prev_volume: prevVol,
    enough_data: true
  };
}

function evaluateEventContextFilter({ candles, direction, currentPrice, mode = 'enforce' }) {
  const compression = detectVolatilityCompression(candles);
  const rangeBreak = detectRangeBreak(candles, direction, currentPrice);
  const volumeConfirmation = detectVolumeConfirmation(candles);
  const volatilityExpansion = detectVolatilityExpansion(candles);

  const contextScore =
    (compression.detected ? 1 : 0) +
    (rangeBreak.detected ? 1 : 0) +
    (volumeConfirmation.detected ? 1 : 0) +
    (volatilityExpansion.detected ? 1 : 0);

  const allowEvent = contextScore >= 2;
  const filterMode = mode === 'observe' ? 'observe' : 'enforce';
  const wouldBlockEvent = !allowEvent;

  stats.checked += 1;
  if (allowEvent) {
    stats.passed += 1;
  } else {
    stats.blocked += 1;
  }
  if (filterMode === 'observe') {
    stats.observed += 1;
  }

  return {
    compression_detected: compression.detected,
    range_break_detected: rangeBreak.detected,
    volume_confirmation: volumeConfirmation.detected,
    volatility_expansion_detected: volatilityExpansion.detected,
    context_score: contextScore,
    allow_event: allowEvent,
    would_block_event: wouldBlockEvent,
    event_context_filter_mode: filterMode,
    relative_volume: volumeConfirmation.relative_volume,
    volume_acceleration: volumeConfirmation.volume_acceleration,
    volatility_expansion_ratio: volatilityExpansion.volatility_expansion_ratio,
    metrics: {
      event_context_total_checked: stats.checked,
      event_context_passed: stats.passed,
      event_context_blocked: stats.blocked,
      event_context_observed: stats.observed,
      context_pass_rate: stats.checked > 0 ? stats.passed / stats.checked : 0
    },
    details: {
      compression,
      range_break: rangeBreak,
      volume_confirmation: volumeConfirmation,
      volatility_expansion: volatilityExpansion
    }
  };
}

module.exports = {
  detectVolatilityCompression,
  detectVolatilityExpansion,
  detectRangeBreak,
  detectVolumeConfirmation,
  evaluateEventContextFilter
};
