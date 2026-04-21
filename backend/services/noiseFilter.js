/**
 * NOISE FILTER - Phase 2
 *
 * Bloquea señales ruidosas antes de entrar en ejecución
 */

const axios = require('axios');

const BINANCE_API = 'https://fapi.binance.com/fapi/v1';

/**
 * Get 15-minute candle analysis
 */
async function get15mCandles(symbol, limit = 10) {
  try {
    const response = await axios.get(`${BINANCE_API}/klines`, {
      params: {
        symbol,
        interval: '15m',
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
    console.error(`[NOISE_FILTER] Error fetching 15m candles for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Get bid/ask spread
 */
async function getSpread(symbol) {
  try {
    const response = await axios.get(`${BINANCE_API}/ticker/bookTicker`, {
      params: { symbol },
      timeout: 5000
    });

    const bid = parseFloat(response.data.bidPrice);
    const ask = parseFloat(response.data.askPrice);
    const mid = (bid + ask) / 2;
    const spreadPct = ((ask - bid) / mid) * 100;

    return {
      bid,
      ask,
      spread_pct: spreadPct
    };
  } catch (error) {
    console.error(`[NOISE_FILTER] Error getting spread for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Calculate volatility (ATR-like)
 */
function calculateVolatility(candles) {
  if (!candles || candles.length < 2) return 0;

  let tr = 0;
  for (let i = 1; i < candles.length; i++) {
    const curr = candles[i];
    const prev = candles[i - 1];

    const h_l = curr.high - curr.low;
    const h_pc = Math.abs(curr.high - prev.close);
    const l_pc = Math.abs(curr.low - prev.close);

    const tr_i = Math.max(h_l, h_pc, l_pc);
    tr += tr_i;
  }

  const atr = tr / candles.length;
  const avgPrice = candles[candles.length - 1].close;
  return (atr / avgPrice) * 100;
}

/**
 * Main noise filter
 *
 * Returns:
 * {
 *   is_noisy: boolean,
 *   reasons: string[],
 *   metrics: {
 *     move_15m: number,
 *     volatility: number,
 *     spread: number
 *   }
 * }
 */
async function filterNoise(symbol, impulseData) {
  const reasons = [];
  const metrics = {};

  try {
    // ========== FILTER 1: 15-minute move must be ≥ 0.4% ==========
    const candles15m = await get15mCandles(symbol, 10);
    if (candles15m && candles15m.length >= 2) {
      const prev = candles15m[candles15m.length - 2];
      const curr = candles15m[candles15m.length - 1];
      const move15m = Math.abs((curr.close - prev.close) / prev.close) * 100;
      metrics.move_15m = move15m;

      if (move15m < 0.4) {
        reasons.push(`BLOCK_MOVE_15M: ${move15m.toFixed(3)}% < 0.4%`);
      }
    }

    // ========== FILTER 2: Volatility must be > 0.15% (not too low) ==========
    if (candles15m) {
      const volatility = calculateVolatility(candles15m);
      metrics.volatility = volatility;

      if (volatility < 0.15) {
        reasons.push(`BLOCK_LOW_VOLATILITY: ${volatility.toFixed(3)}% < 0.15%`);
      }
    }

    // ========== FILTER 3: Spread must be reasonable ==========
    const spreadData = await getSpread(symbol);
    if (spreadData) {
      metrics.spread = spreadData.spread_pct;

      // Typical spread is ~0.05-0.10% on high-volume pairs
      // Block if spread > 0.30% (indicates low liquidity)
      if (spreadData.spread_pct > 0.3) {
        reasons.push(`BLOCK_HIGH_SPREAD: ${spreadData.spread_pct.toFixed(3)}% > 0.30%`);
      }
    }

    return {
      is_noisy: reasons.length > 0,
      reasons,
      metrics
    };

  } catch (error) {
    console.error(`[NOISE_FILTER] Error filtering ${symbol}:`, error.message);
    return {
      is_noisy: true,
      reasons: [`ERROR: ${error.message}`],
      metrics
    };
  }
}

module.exports = {
  filterNoise,
  get15mCandles,
  getSpread,
  calculateVolatility
};
