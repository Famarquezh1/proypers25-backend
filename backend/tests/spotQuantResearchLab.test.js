'use strict';

const assert = require('assert');
const {
  featureAt,
  simulate,
  metrics,
  walkForward,
  probabilityCalibration,
  promotionEligible,
  selectGlobalChampion
} = require('../services/spotQuantResearchLab');

function candle(index, close, volume = 1000) {
  return {
    openTime: index,
    open: close * 0.999,
    high: close * 1.006,
    low: close * 0.995,
    close,
    volume,
    closeTime: index + 1,
    quoteVolume: close * volume
  };
}

(function run() {
  const candles = Array.from({ length: 420 }, (_, index) => {
    const trend = 100 + index * 0.08;
    const wave = Math.sin(index / 7) * 0.7;
    return candle(index, trend + wave, index % 20 === 0 ? 1800 : 1000);
  });

  const feature = featureAt(candles, 120);
  assert(feature, 'feature should be produced after enough history');
  assert(feature.score >= 0 && feature.score <= 100, 'score should be bounded');
  assert(feature.atrPct > 0, 'ATR percentage should be positive');

  const config = { threshold: 60, tpAtr: 1.5, slAtr: 1, timeoutBars: 24 };
  const trades = simulate(candles, config, 60, candles.length, 0.001);
  const summary = metrics(trades);
  assert(summary.trades >= 0);
  assert(summary.maxDrawdown >= 0);
  assert(Number.isFinite(summary.expectancy));

  const walk = walkForward(candles, config, 0.001);
  assert(walk.train && walk.validation && walk.test);

  const calibration = probabilityCalibration(trades);
  assert.strictEqual(calibration.samples, trades.length);
  if (calibration.brier !== null) assert(calibration.brier >= 0 && calibration.brier <= 1);

  assert.strictEqual(promotionEligible({
    walk: {
      validation: { trades: 6, expectancy: 0.002, profitFactor: 1.4, maxDrawdown: 0.04 },
      test: { trades: 7, expectancy: 0.001, profitFactor: 1.3, maxDrawdown: 0.05 }
    }
  }), true);

  assert.strictEqual(promotionEligible({
    walk: {
      validation: { trades: 6, expectancy: -0.002, profitFactor: 0.8, maxDrawdown: 0.04 },
      test: { trades: 7, expectancy: 0.001, profitFactor: 1.3, maxDrawdown: 0.05 }
    }
  }), false);

  const eligiblePreferred = selectGlobalChampion([
    { symbol: 'BTCUSDT', champion: { score: 99 }, promotion_eligible: false },
    { symbol: 'SOLUSDT', champion: { score: 94 }, promotion_eligible: true },
    { symbol: 'ETHUSDT', champion: { score: 91 }, promotion_eligible: true }
  ]);
  assert.strictEqual(eligiblePreferred.selected.symbol, 'SOLUSDT');
  assert.strictEqual(eligiblePreferred.observationChampion.symbol, 'BTCUSDT');
  assert.strictEqual(eligiblePreferred.eligibleCount, 2);
  assert.strictEqual(eligiblePreferred.selectionMode, 'BEST_ELIGIBLE');

  const observationOnly = selectGlobalChampion([
    { symbol: 'BTCUSDT', champion: { score: 99 }, promotion_eligible: false },
    { symbol: 'SOLUSDT', champion: { score: 94 }, promotion_eligible: false },
    { symbol: 'BROKENUSDT', promotion_eligible: false, error: 'failed' }
  ]);
  assert.strictEqual(observationOnly.selected.symbol, 'BTCUSDT');
  assert.strictEqual(observationOnly.eligibleCount, 0);
  assert.strictEqual(observationOnly.failedCount, 1);
  assert.strictEqual(observationOnly.selectionMode, 'OBSERVATION_ONLY');

  console.log('spotQuantResearchLab tests passed');
})();