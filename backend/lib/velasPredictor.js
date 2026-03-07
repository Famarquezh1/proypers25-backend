const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

// Compute RSI using Wilder smoothing.
function computeRSI(closes, period) {
  if (!Array.isArray(closes) || closes.length < period + 1) {
    return Array.isArray(closes) ? new Array(closes.length).fill(null) : [];
  }

  const rsi = new Array(closes.length).fill(null);
  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) {
      gains += delta;
    } else {
      losses += Math.abs(delta);
    }
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  rsi[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < closes.length; i += 1) {
    const delta = closes[i] - closes[i - 1];
    const gain = delta > 0 ? delta : 0;
    const loss = delta < 0 ? Math.abs(delta) : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    rsi[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }

  return rsi;
}

// Compute EMA for a series of values.
function computeEMA(values, period) {
  if (!Array.isArray(values) || values.length === 0) {
    return [];
  }
  const ema = new Array(values.length).fill(null);
  const multiplier = 2 / (period + 1);
  let prev = values[0];
  ema[0] = prev;
  for (let i = 1; i < values.length; i += 1) {
    const value = values[i];
    prev = value * multiplier + prev * (1 - multiplier);
    ema[i] = prev;
  }
  return ema;
}

// Filter candles and build feature arrays for indicator calculation.
function buildFeatures(candles) {
  if (!Array.isArray(candles)) {
    return { candles: [], closes: [], volumes: [] };
  }

  const filtered = [];
  let previousClose = null;
  for (const candle of candles) {
    if (!candle) continue;
    const open = Number(candle.open);
    const high = Number(candle.high);
    const low = Number(candle.low);
    const close = Number(candle.close);
    const volume = Number(candle.volume);

    if (![open, high, low, close].every((v) => Number.isFinite(v))) {
      continue;
    }
    if (!Number.isFinite(volume) || volume === 0) {
      continue;
    }
    if (previousClose != null) {
      const gap = Math.abs((open - previousClose) / previousClose);
      if (gap > 0.05) {
        continue;
      }
    }

    filtered.push({
      timestamp: candle.timestamp,
      open,
      high,
      low,
      close,
      volume
    });
    previousClose = close;
  }

  const closes = filtered.map((c) => c.close);
  const volumes = filtered.map((c) => c.volume);

  return { candles: filtered, closes, volumes };
}

function lastNonNull(list) {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] != null) {
      return list[i];
    }
  }
  return null;
}

function previousNonNull(list) {
  let foundLast = false;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (list[i] == null) {
      continue;
    }
    if (!foundLast) {
      foundLast = true;
      continue;
    }
    return list[i];
  }
  return null;
}

async function predictFromCandles(symbol, candles, options = {}) {
  const timeframe = options.timeframe || null;

  const { candles: filtered, closes, volumes } = buildFeatures(candles);
  const MIN_CANDLES = 50;
  if (filtered.length < MIN_CANDLES) {
    return {
      symbol,
      timeframe,
      prob_up: 0.5,
      prob_down: 0.5,
      confidence: 0.1,
      signal: 'neutral',
      indicators_snapshot: {}
    };
  }

  const rsiSeries = computeRSI(closes, 14);
  const ema10Series = computeEMA(closes, 10);
  const ema50Series = computeEMA(closes, 50);

  const lastCandle = filtered[filtered.length - 1];
  const open = lastCandle.open;
  const close = lastCandle.close;
  const high = lastCandle.high;
  const low = lastCandle.low;

  // Feature thresholds can be tuned here (body threshold, RSI ranges, volume factor).
  const cuerpo_relativo = open ? (close - open) / open : 0;
  const mecha_superior_relativa = open ? (high - Math.max(open, close)) / open : 0;
  const mecha_inferior_relativa = open ? (Math.min(open, close) - low) / open : 0;

  const rsi = lastNonNull(rsiSeries);
  const rsiPrev = previousNonNull(rsiSeries);
  const ema10 = lastNonNull(ema10Series);
  const ema50 = lastNonNull(ema50Series);

  const volumeWindow = volumes.slice(-20);
  const volumeAvg = volumeWindow.length
    ? volumeWindow.reduce((sum, value) => sum + value, 0) / volumeWindow.length
    : 0;
  const volumen_relativo = volumeAvg ? lastCandle.volume / volumeAvg : 0;

  // Bull/Bear strength scores based on simple candle-derived indicators.
  let fuerza_alcista = 0;
  let fuerza_bajista = 0;

  const bodyBull = cuerpo_relativo > 0.002;
  const bodyBear = cuerpo_relativo < -0.002;

  const rsiBull = rsi != null && rsiPrev != null && rsi >= 35 && rsi <= 55 && rsi > rsiPrev;
  const rsiBear = rsi != null && rsiPrev != null && rsi >= 45 && rsi <= 70 && rsi < rsiPrev;

  const emaBull = ema10 != null && ema50 != null && ema10 > ema50;
  const emaBear = ema10 != null && ema50 != null && ema10 < ema50;

  const volumeHot = volumen_relativo > 1;

  if (bodyBull) fuerza_alcista += 1;
  if (rsiBull) fuerza_alcista += 1;
  if (emaBull) fuerza_alcista += 1;
  if (volumeHot) fuerza_alcista += 1;

  if (bodyBear) fuerza_bajista += 1;
  if (rsiBear) fuerza_bajista += 1;
  if (emaBear) fuerza_bajista += 1;
  if (volumeHot) fuerza_bajista += 1;

  const diff = fuerza_alcista - fuerza_bajista;
  const threshold = Number.isFinite(options.signal_threshold) ? options.signal_threshold : 1.2;

  let signal = 'neutral';
  if (diff > threshold) {
    signal = 'up';
  } else if (-diff > threshold) {
    signal = 'down';
  }

  const totalStrength = fuerza_alcista + fuerza_bajista;
  const prob_up = totalStrength ? fuerza_alcista / totalStrength : 0.5;
  const prob_down = totalStrength ? fuerza_bajista / totalStrength : 0.5;

  // Confidence blends strength difference and indicator alignment.
  const alignmentCount =
    signal === 'up'
      ? fuerza_alcista
      : signal === 'down'
      ? fuerza_bajista
      : Math.max(fuerza_alcista, fuerza_bajista);
  const alignmentScore = clamp(alignmentCount / 4, 0, 1);
  const diffScore = clamp(Math.abs(diff) / 4, 0, 1);
  let confidence = clamp(0.35 + diffScore * 0.4 + alignmentScore * 0.25, 0.05, 0.95);
  if (signal === 'neutral') {
    confidence = clamp(confidence * 0.6, 0.05, 0.7);
  }

  return {
    symbol,
    timeframe,
    prob_up: Number(prob_up.toFixed(4)),
    prob_down: Number(prob_down.toFixed(4)),
    confidence: Number(confidence.toFixed(4)),
    signal,
    indicators_snapshot: {
      rsi: rsi != null ? Number(rsi.toFixed(2)) : null,
      ema10: ema10 != null ? Number(ema10.toFixed(4)) : null,
      ema50: ema50 != null ? Number(ema50.toFixed(4)) : null,
      volumen_relativo: Number(volumen_relativo.toFixed(4)),
      cuerpo_relativo: Number(cuerpo_relativo.toFixed(4)),
      mecha_superior_relativa: Number(mecha_superior_relativa.toFixed(4)),
      mecha_inferior_relativa: Number(mecha_inferior_relativa.toFixed(4))
    }
  };
}

module.exports = {
  predictFromCandles
};
