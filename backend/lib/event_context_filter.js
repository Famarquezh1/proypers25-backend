/**
 * Event Context Filter (opcional y auditable).
 * No altera scoring engines ni quality gate existente; actua como capa previa adicional.
 */

const ATR_SHORT_PERIOD = 5;
const ATR_MEDIUM_PERIOD = 10;
const ATR_LONG_PERIOD = 20;
const RANGE_LOOKBACK = 6;
const VOLUME_LOOKBACK = 20;
const BREAK_EFFICIENCY_LOOKBACK = 6;
const VOLUME_PERSISTENCE_LOOKBACK = 3;
const MIN_VOLUME_PERSISTENCE_RELATIVE = 1.4;
const COMPRESSION_FACTOR = 0.65;
const MIN_RELATIVE_VOLUME = 1.6;
const MIN_VOLUME_ACCELERATION = 1.15;
const MIN_VOLATILITY_EXPANSION_RATIO = 1.2;
const EPS = 1e-9;

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

function clamp01(v) {
  if (!Number.isFinite(v)) return 0;
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  return v;
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

function computeAtrAtIndex(candles, period, endIndex) {
  if (!Array.isArray(candles) || endIndex < period || endIndex >= candles.length) return null;
  const tr = [];
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const prevClose = safeNum(candles[i - 1]?.close);
    tr.push(trueRange(candles[i], prevClose));
  }
  return average(tr);
}

function computeCompressionMetrics(candles, compressionCheck) {
  const normalized = clampCandles(candles);
  if (!normalized.length || !compressionCheck?.enough_data) {
    return {
      compression_duration: 0,
      compression_tightness: null,
      compression_energy: 0,
      avg_true_range_compression: null
    };
  }

  let duration = 0;
  const compressionTrueRanges = [];
  for (let i = normalized.length - 1; i >= ATR_LONG_PERIOD; i -= 1) {
    const atrShortAtI = computeAtrAtIndex(normalized, ATR_SHORT_PERIOD, i);
    const atrLongAtI = computeAtrAtIndex(normalized, ATR_LONG_PERIOD, i);
    if (!atrShortAtI || !atrLongAtI) break;
    const compressed = atrShortAtI < atrLongAtI * COMPRESSION_FACTOR;
    if (!compressed) break;
    duration += 1;
    const prevClose = safeNum(normalized[i - 1]?.close);
    compressionTrueRanges.push(trueRange(normalized[i], prevClose));
  }

  const avgTrCompression = average(compressionTrueRanges);
  const atrLong = safeNum(compressionCheck?.atr_long);
  const compressionTightness = atrLong > 0 ? avgTrCompression / atrLong : null;
  const compressionEnergy = avgTrCompression * duration;

  return {
    compression_duration: duration,
    compression_tightness: compressionTightness,
    compression_energy: compressionEnergy,
    avg_true_range_compression: avgTrCompression || null
  };
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

function computeBreakEfficiency(candles, lookback = BREAK_EFFICIENCY_LOOKBACK) {
  const normalized = clampCandles(candles);
  if (normalized.length < lookback + 1) {
    return {
      break_efficiency: null,
      net_move_last_n: null,
      total_range_last_n: null,
      enough_data: false
    };
  }
  const recent = normalized.slice(-lookback);
  const first = recent[0];
  const last = recent[recent.length - 1];
  const netMove = Math.abs(safeNum(last?.close) - safeNum(first?.close));
  const totalRange = recent.reduce((sum, c) => sum + Math.max(0, safeNum(c?.high) - safeNum(c?.low)), 0);
  const breakEfficiency = totalRange > 0 ? netMove / totalRange : 0;
  return {
    break_efficiency: breakEfficiency,
    net_move_last_n: netMove,
    total_range_last_n: totalRange,
    enough_data: true
  };
}

function computeCloseLocationValue(candles, direction) {
  const normalized = clampCandles(candles);
  if (!normalized.length) {
    return { close_location_value: null, enough_data: false };
  }
  const last = normalized[normalized.length - 1];
  const high = safeNum(last?.high);
  const low = safeNum(last?.low);
  const close = safeNum(last?.close);
  const range = Math.max(EPS, high - low);
  if (direction === 'down') {
    return { close_location_value: clamp01((high - close) / range), enough_data: true };
  }
  if (direction === 'up') {
    return { close_location_value: clamp01((close - low) / range), enough_data: true };
  }
  return { close_location_value: clamp01((close - low) / range), enough_data: true };
}

function computeWickImbalance(candles, direction) {
  const normalized = clampCandles(candles);
  if (!normalized.length) {
    return { wick_imbalance: null, opposite_wick_length: null, candle_range: null, enough_data: false };
  }
  const last = normalized[normalized.length - 1];
  const open = safeNum(last?.open);
  const close = safeNum(last?.close);
  const high = safeNum(last?.high);
  const low = safeNum(last?.low);
  const upperWick = Math.max(0, high - Math.max(open, close));
  const lowerWick = Math.max(0, Math.min(open, close) - low);
  const candleRange = Math.max(EPS, high - low);

  let oppositeWick = Math.max(upperWick, lowerWick);
  if (direction === 'up') oppositeWick = lowerWick;
  if (direction === 'down') oppositeWick = upperWick;

  return {
    wick_imbalance: clamp01(oppositeWick / candleRange),
    opposite_wick_length: oppositeWick,
    candle_range: candleRange,
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

function computeVolumePersistence(candles) {
  const normalized = clampCandles(candles);
  if (normalized.length < VOLUME_LOOKBACK + VOLUME_PERSISTENCE_LOOKBACK) {
    return {
      volume_persistence_count: 0,
      volume_persistence_score: 0,
      enough_data: false
    };
  }

  let count = 0;
  for (let i = normalized.length - VOLUME_PERSISTENCE_LOOKBACK; i < normalized.length; i += 1) {
    const window = normalized.slice(Math.max(0, i - VOLUME_LOOKBACK + 1), i + 1);
    const emaVol20 = computeEma(window.map((c) => safeNum(c.volume)), VOLUME_LOOKBACK);
    if (!emaVol20 || emaVol20 <= 0) continue;
    const relativeVolume = safeNum(normalized[i]?.volume) / emaVol20;
    if (relativeVolume > MIN_VOLUME_PERSISTENCE_RELATIVE) {
      count += 1;
    }
  }

  return {
    volume_persistence_count: count,
    volume_persistence_score: clamp01(count / VOLUME_PERSISTENCE_LOOKBACK),
    enough_data: true
  };
}

function computeVolatilitySlope(candles) {
  const normalized = clampCandles(candles);
  if (normalized.length < ATR_SHORT_PERIOD + 2) {
    return {
      volatility_slope: null,
      atr_short_current: null,
      atr_short_prev: null,
      enough_data: false
    };
  }
  const atrShortCurrent = computeAtr(normalized, ATR_SHORT_PERIOD);
  const atrShortPrev = computeAtr(normalized.slice(0, -1), ATR_SHORT_PERIOD);
  const slope = safeNum(atrShortCurrent) - safeNum(atrShortPrev);
  return {
    volatility_slope: slope,
    atr_short_current: atrShortCurrent,
    atr_short_prev: atrShortPrev,
    enough_data: true
  };
}

function computeExpansionImbalance(candles, direction, rangeBreak, compressionMetrics) {
  const normalized = clampCandles(candles);
  if (!normalized.length) {
    return {
      expansion_impulse: null,
      expansion_imbalance: null
    };
  }
  const lastClose = safeNum(normalized[normalized.length - 1]?.close);
  let priceMoveSinceBreak = 0;
  if (direction === 'up' && safeNum(rangeBreak?.recent_high) > 0) {
    priceMoveSinceBreak = lastClose - safeNum(rangeBreak.recent_high);
  } else if (direction === 'down' && safeNum(rangeBreak?.recent_low) > 0) {
    priceMoveSinceBreak = safeNum(rangeBreak.recent_low) - lastClose;
  } else {
    const recent = normalized.slice(-BREAK_EFFICIENCY_LOOKBACK);
    const first = recent[0];
    priceMoveSinceBreak = Math.abs(lastClose - safeNum(first?.close));
  }

  const recentAtr = computeAtr(normalized, ATR_SHORT_PERIOD) || computeAtr(normalized, ATR_MEDIUM_PERIOD) || 0;
  const expansionImpulse = recentAtr > 0 ? Math.abs(priceMoveSinceBreak) / recentAtr : 0;

  const compressionEnergy = safeNum(compressionMetrics?.compression_energy);
  const atrLong = computeAtr(normalized, ATR_LONG_PERIOD) || 0;
  const normalizedCompressionEnergy = atrLong > 0 ? compressionEnergy / atrLong : compressionEnergy;
  const expansionImbalance = expansionImpulse / Math.max(normalizedCompressionEnergy, EPS);

  return {
    price_move_since_break: priceMoveSinceBreak,
    recent_atr: recentAtr,
    expansion_impulse: expansionImpulse,
    normalized_compression_energy: normalizedCompressionEnergy,
    expansion_imbalance: expansionImbalance
  };
}

function computeContextQuality({
  compressionMetrics,
  breakEfficiencyMetrics,
  volumePersistenceMetrics,
  volatilitySlopeMetrics,
  closeLocationMetrics,
  wickMetrics,
  rangeBreak
}) {
  const compressionDurationScore = clamp01(safeNum(compressionMetrics?.compression_duration) / 12);
  const breakEfficiencyScore = clamp01(safeNum(breakEfficiencyMetrics?.break_efficiency));
  const volumePersistenceScore = clamp01(safeNum(volumePersistenceMetrics?.volume_persistence_score));

  const atrShortCurrent = Math.max(EPS, safeNum(volatilitySlopeMetrics?.atr_short_current));
  const volatilitySlopeRaw = safeNum(volatilitySlopeMetrics?.volatility_slope);
  const volatilitySlopeScore = clamp01(volatilitySlopeRaw / (atrShortCurrent * 0.25));
  const closeLocationScore = clamp01(safeNum(closeLocationMetrics?.close_location_value));
  const wickImbalance = clamp01(safeNum(wickMetrics?.wick_imbalance));

  const weighted =
    compressionDurationScore * 0.2 +
    breakEfficiencyScore * 0.3 +
    volumePersistenceScore * 0.2 +
    volatilitySlopeScore * 0.15 +
    closeLocationScore * 0.15;

  let penalty = 0;
  if (wickImbalance > 0.45) {
    penalty += clamp01((wickImbalance - 0.45) / 0.55) * 0.35;
  }
  const fakeBreakout = Boolean(rangeBreak?.detected) && breakEfficiencyScore < 0.2;
  if (fakeBreakout) {
    penalty += 0.25;
  }

  return {
    context_quality: Math.max(0, Math.min(100, (weighted - penalty) * 100)),
    fake_breakout_detected: fakeBreakout
  };
}

function evaluateEventContextFilter({ candles, direction, currentPrice, mode = 'enforce' }) {
  const compression = detectVolatilityCompression(candles);
  const rangeBreak = detectRangeBreak(candles, direction, currentPrice);
  const volumeConfirmation = detectVolumeConfirmation(candles);
  const volatilityExpansion = detectVolatilityExpansion(candles);
  const compressionMetrics = computeCompressionMetrics(candles, compression);
  const breakEfficiencyMetrics = computeBreakEfficiency(candles);
  const closeLocationMetrics = computeCloseLocationValue(candles, direction);
  const wickMetrics = computeWickImbalance(candles, direction);
  const volumePersistenceMetrics = computeVolumePersistence(candles);
  const volatilitySlopeMetrics = computeVolatilitySlope(candles);
  const expansionMetrics = computeExpansionImbalance(candles, direction, rangeBreak, compressionMetrics);

  const quality = computeContextQuality({
    compressionMetrics,
    breakEfficiencyMetrics,
    volumePersistenceMetrics,
    volatilitySlopeMetrics,
    closeLocationMetrics,
    wickMetrics,
    rangeBreak
  });

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
    compression_duration: compressionMetrics.compression_duration,
    compression_tightness: compressionMetrics.compression_tightness,
    break_efficiency: breakEfficiencyMetrics.break_efficiency,
    close_location_value: closeLocationMetrics.close_location_value,
    wick_imbalance: wickMetrics.wick_imbalance,
    volume_persistence_score: volumePersistenceMetrics.volume_persistence_score,
    volatility_slope: volatilitySlopeMetrics.volatility_slope,
    compression_energy: compressionMetrics.compression_energy,
    expansion_imbalance: expansionMetrics.expansion_imbalance,
    context_quality: quality.context_quality,
    fake_breakout_detected: quality.fake_breakout_detected,
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
      volatility_expansion: volatilityExpansion,
      compression_metrics: compressionMetrics,
      break_efficiency_metrics: breakEfficiencyMetrics,
      close_location_metrics: closeLocationMetrics,
      wick_metrics: wickMetrics,
      volume_persistence_metrics: volumePersistenceMetrics,
      volatility_slope_metrics: volatilitySlopeMetrics,
      expansion_metrics: expansionMetrics
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
