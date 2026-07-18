'use strict';

const assert = require('assert');
const {
  analyzeTimeframe,
  ema,
  rsi,
  atr,
  candlePattern
} = require('../services/spotTechnicalConfirmation');
const { uniqueLatestCandidates } = require('../services/paperToRealEntryGate');

function candle(index, close, volume = 1000) {
  return {
    openTime: index,
    open: close * 0.997,
    high: close * 1.004,
    low: close * 0.994,
    close,
    volume,
    closeTime: index + 1,
    quoteVolume: close * volume
  };
}

(function run() {
  const ascending = Array.from({ length: 80 }, (_, index) => 100 + (index * 0.35));
  assert(ema(ascending, 20) > ema(ascending, 50), 'EMA20 should exceed EMA50 in an uptrend');
  assert(rsi(ascending, 14) > 50, 'RSI should be bullish in an uptrend');

  const candles = ascending.map((close, index) => candle(index, close, index === 79 ? 1800 : 1000));
  assert(atr(candles, 14) > 0, 'ATR should be positive');
  const analysis = analyzeTimeframe('15m', candles);
  assert.strictEqual(analysis.valid, true);
  assert.strictEqual(analysis.trend_bullish, true);
  assert(analysis.score >= 60, 'Healthy trend should receive a useful score');

  const engulfing = [
    { open: 10.5, close: 10, high: 10.6, low: 9.9 },
    { open: 9.9, close: 10.7, high: 10.8, low: 9.8 },
    { open: 10.7, close: 10.8, high: 10.9, low: 10.6 }
  ];
  assert(candlePattern(engulfing).names.includes('BULLISH_ENGULFING') === false, 'Pattern uses the latest two candles only');

  const unique = uniqueLatestCandidates([
    { id: 'a', scan_id: 'scan1', symbol: 'TONUSDT', opportunityScore: 91, quoteVolume24h: 2e6 },
    { id: 'b', scan_id: 'scan1', symbol: 'TONUSDT', opportunityScore: 94, quoteVolume24h: 2e6 },
    { id: 'c', scan_id: 'scan1', symbol: 'XECUSDT', opportunityScore: 92, quoteVolume24h: 3e6 },
    { id: 'd', scan_id: 'old', symbol: 'BTCUSDT', opportunityScore: 100, quoteVolume24h: 9e9 }
  ], 'scan1');
  assert.strictEqual(unique.length, 2);
  assert.strictEqual(unique[0].symbol, 'TONUSDT');
  assert.strictEqual(unique[0].id, 'b');

  console.log('spotTechnicalConfirmation tests passed');
})();
