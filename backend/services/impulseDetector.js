/**
 * IMPULSE DETECTOR v2 - PRECISION ENTRY
 *
 * Detecta INICIO de impulsos con:
 * - Entrada temprana (evita perseguir precio)
 * - Confirmación mínima
 * - Anti-overextension filter
 *
 * Diferencia vs v1:
 * - v1 esperaba 0.5% en 5m (entrada TARDÍA, loss de edge)
 * - v2 detecta 0.2% en 1m + 0.3% en 3m (entrada TEMPRANA, captura movimiento)
 */

const axios = require('axios');

const BINANCE_API = 'https://fapi.binance.com/fapi/v1';

/**
 * Fetch 1-minute candles from Binance Futures
 */
async function getKlines(symbol, interval = '1m', limit = 50) {
  try {
    const response = await axios.get(`${BINANCE_API}/klines`, {
      params: {
        symbol,
        interval,
        limit
      },
      timeout: 5000
    });

    return response.data.map(candle => ({
      time: candle[0],
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[7])
    }));
  } catch (error) {
    console.error(`[IMPULSE_DETECTOR_V2] Error fetching klines for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Calculate impulse metrics: move1m, move3m
 * Returns: { move1m, move3m } in percentage
 */
function calculateImpulse(candles) {
  if (!candles || candles.length < 4) {
    return { move1m: 0, move3m: 0 };
  }

  const last = candles[candles.length - 1];      // Current (0m)
  const prev = candles[candles.length - 2];      // 1m ago
  const prev3 = candles[candles.length - 4];     // 3m ago

  const priceNow = last.close;
  const price1m = prev.close;
  const price3m = prev3.close;

  const move1m = ((priceNow - price1m) / price1m) * 100;
  const move3m = ((priceNow - price3m) / price3m) * 100;

  return {
    move1m,
    move3m
  };
}

/**
 * IMPULSE DETECTION - V2 LOGIC
 *
 * Detects early impulses with:
 * 1. Early detection: move1m ≥ 0.2% AND move3m ≥ 0.3%
 * 2. No overextension: move3m < 0.6% (avoid chasing)
 * 3. Direction continuity: ≥2 consecutive candles in same direction
 * 4. Volume confirmation: volumeRatio ≥ 1.3x
 *
 * Returns:
 * {
 *   impulseDetected: boolean,
 *   direction: 'UP' | 'DOWN' | null,
 *   strengthScore: 0-1,
 *   move1m: number (percentage),
 *   move3m: number (percentage),
 *   volumeRatio: number,
 *   timestamp: number,
 *   reason?: string (if not detected)
 * }
 */
function detectImpulse({ candles, volumeData }) {
  if (!candles || candles.length < 4) {
    return {
      impulseDetected: false,
      direction: null,
      reason: 'Insufficient candles'
    };
  }

  const { move1m, move3m } = calculateImpulse(candles);

  const direction = move1m > 0 ? 'UP' : 'DOWN';
  const absMove1m = Math.abs(move1m);
  const absMove3m = Math.abs(move3m);

  const volumeRatio = volumeData ? (volumeData.current / volumeData.avg) : 1.0;

  // =========================
  // CRITERION 1: EARLY IMPULSE
  // =========================
  // Detect START of movement, not confirmation
  // move1m ≥ 0.2% (current 1-min momentum)
  // move3m ≥ 0.3% (3-min overall direction)

  const earlyImpulse =
    absMove1m >= 0.2 &&
    absMove3m >= 0.3;

  if (!earlyImpulse) {
    return {
      impulseDetected: false,
      direction,
      move1m: absMove1m,
      move3m: absMove3m,
      volumeRatio,
      reason: `Early impulse criteria not met: move1m=${absMove1m.toFixed(4)}% (need ≥0.2%), move3m=${absMove3m.toFixed(4)}% (need ≥0.3%)`
    };
  }

  // =========================
  // CRITERION 2: NOT OVEREXTENDED
  // =========================
  // Avoid chasing price that already moved too far
  // move3m < 0.6% (conservative safety)

  const notOverextended = absMove3m < 0.6;

  if (!notOverextended) {
    return {
      impulseDetected: false,
      direction,
      move1m: absMove1m,
      move3m: absMove3m,
      volumeRatio,
      reason: `Already overextended: move3m=${absMove3m.toFixed(4)}% (need < 0.6%)`
    };
  }

  // =========================
  // CRITERION 3: DIRECTION CONTINUITY
  // =========================
  // Confirm direction with ≥2 consecutive candles in same direction
  
  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];

  const lastCandleUp = lastCandle.close > lastCandle.open;
  const prevCandleUp = prevCandle.close > prevCandle.open;

  const sameDirection = lastCandleUp === prevCandleUp;

  if (!sameDirection) {
    return {
      impulseDetected: false,
      direction,
      move1m: absMove1m,
      move3m: absMove3m,
      volumeRatio,
      reason: `No direction continuity detected`
    };
  }

  // =========================
  // CRITERION 4: VOLUME CONFIRMATION
  // =========================
  // volumeRatio ≥ 1.3x (institutional interest)

  const volumeOk = volumeRatio >= 1.3;

  if (!volumeOk) {
    return {
      impulseDetected: false,
      direction,
      move1m: absMove1m,
      move3m: absMove3m,
      volumeRatio,
      reason: `Insufficient volume: ${volumeRatio.toFixed(2)}x (need ≥1.3x)`
    };
  }

  // =========================
  // ALL CRITERIA MET - IMPULSE DETECTED
  // =========================

  // Calculate strength score (0-1)
  // Weighted combination of metrics
  const moveScore = Math.min((absMove1m / 0.5), 1);      // 0.5% = full score
  const extensionScore = (1 - (absMove3m / 0.6));        // Inverse penalty for overextension
  const volumeScore = Math.min((volumeRatio / 2.5), 1);  // 2.5x = full score

  const strengthScore = Math.min(
    (moveScore * 0.4 + extensionScore * 0.3 + volumeScore * 0.3),
    1
  );

  return {
    impulseDetected: true,
    direction,
    strengthScore: Math.max(strengthScore, 0.6),  // Floor at 0.6 for detected impulses
    move1m: absMove1m,
    move3m: absMove3m,
    volumeRatio,
    timestamp: lastCandle.time,
    candles: {
      current_close: lastCandle.close,
      prev1m_close: prevCandle.close,
      prev3m_close: candles[candles.length - 4]?.close || 0
    }
  };
}

/**
 * Get volume data for current candle
 * Returns: { current, avg }
 */
function getVolumeData(candles) {
  if (!candles || candles.length < 20) {
    return { current: 0, avg: 1 };
  }

  const current = candles[candles.length - 1].volume;
  const avgWindow = candles.slice(-20, -1); // Last 20 excluding current
  const avg = avgWindow.reduce((sum, c) => sum + c.volume, 0) / avgWindow.length;

  return { current, avg };
}

/**
 * Main detection for single symbol
 */
async function detectSymbolImpulse(symbol) {
  try {
    const candles = await getKlines(symbol, '1m', 50);

    if (!candles || candles.length < 4) {
      return {
        impulseDetected: false,
        symbol,
        direction: null,
        reason: 'Insufficient kline data'
      };
    }

    const volumeData = getVolumeData(candles);

    const result = detectImpulse({ candles, volumeData });

    return {
      ...result,
      symbol
    };
  } catch (error) {
    console.error(`[IMPULSE_DETECTOR_V2] Error processing ${symbol}:`, error.message);
    return {
      impulseDetected: false,
      symbol,
      direction: null,
      reason: `Error: ${error.message}`
    };
  }
}

/**
 * Batch detection for multiple symbols
 */
async function detectMultipleImpulses(symbols) {
  const results = await Promise.all(symbols.map(s => detectSymbolImpulse(s)));
  return results;
}

/**
 * Get detected impulses only
 */
async function getDetectedImpulses(symbols) {
  const results = await detectMultipleImpulses(symbols);
  return results.filter(r => r.impulseDetected);
}

module.exports = {
  detectImpulse,
  detectSymbolImpulse,
  detectMultipleImpulses,
  getDetectedImpulses,
  calculateImpulse,
  getVolumeData,
  getKlines
};
