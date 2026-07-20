'use strict';

const assert = require('assert');
const {
  detectRegime,
  strategyConfigs,
  familyScore,
  simulateFamily,
  buildFolds,
  multiWindowWalkForward,
  eligibilityDiagnostic,
  normalizeSymbols,
  selectGlobalChampion
} = require('../services/spotQuantAdvancedResearchLab');

function candle(index, close, volume = 1000) {
  return {
    openTime: index * 300000,
    open: close * 0.999,
    high: close * 1.006,
    low: close * 0.994,
    close,
    volume,
    closeTime: (index + 1) * 300000,
    quoteVolume: close * volume
  };
}

(function run() {
  const candles = Array.from({ length: 1200 }, (_, index) => {
    const trend = 100 + index * 0.025;
    const wave = Math.sin(index / 13) * 0.8;
    return candle(index, trend + wave, index % 30 === 0 ? 2200 : 1000);
  });

  const configs = strategyConfigs();
  assert.ok(configs.length >= 20);
  assert.ok(new Set(configs.map((item) => item.family)).size >= 5);

  const feature = require('../services/spotQuantResearchLab').featureAt(candles, 200);
  assert.ok(feature);
  assert.ok(['UPTREND', 'SIDEWAYS', 'SIDEWAYS_LOW_VOL', 'HIGH_VOLATILITY', 'DOWNTREND'].includes(detectRegime(feature)));
  assert.ok(familyScore(feature, 'TREND') >= 0 && familyScore(feature, 'TREND') <= 100);

  const trendConfig = configs.find((item) => item.family === 'TREND');
  const trades = simulateFamily(candles, trendConfig, 80, candles.length, 0.001, 0.00025);
  assert.ok(Array.isArray(trades));

  const folds = buildFolds(candles.length);
  assert.strictEqual(folds.length, 3);
  const walk = multiWindowWalkForward(candles, trendConfig, 0.001, 0.00025);
  assert.strictEqual(walk.consistency.folds, 3);
  assert.ok(walk.validation.trades >= 0);
  assert.ok(walk.test.trades >= 0);

  const eligible = eligibilityDiagnostic({
    walk: {
      validation: { trades: 20, expectancy: 0.002, profitFactor: 1.4, maxDrawdown: 0.05 },
      test: { trades: 22, expectancy: 0.0015, profitFactor: 1.3, maxDrawdown: 0.06 },
      consistency: { positive_validation_folds: 2, positive_test_folds: 2 }
    },
    calibration: { samples: 22, calibrated: true, brier: 0.2 }
  });
  assert.strictEqual(eligible.eligible, true);

  const blocked = eligibilityDiagnostic({
    walk: {
      validation: { trades: 20, expectancy: -0.001, profitFactor: 0.8, maxDrawdown: 0.05 },
      test: { trades: 22, expectancy: 0.0015, profitFactor: 1.3, maxDrawdown: 0.06 },
      consistency: { positive_validation_folds: 1, positive_test_folds: 2 }
    },
    calibration: { samples: 22, calibrated: true, brier: 0.2 }
  });
  assert.strictEqual(blocked.eligible, false);

  assert.deepStrictEqual(
    normalizeSymbols(['btcusdt', 'ETHUSDT']),
    ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT', 'TONUSDT', 'BNBUSDT', 'ADAUSDT', 'DOGEUSDT', 'LINKUSDT', 'AVAXUSDT']
  );

  const selection = selectGlobalChampion([
    { symbol: 'BTCUSDT', champion: { score: 99, eligibility: { eligible: false } } },
    { symbol: 'LINKUSDT', champion: { score: 90, eligibility: { eligible: true } } }
  ]);
  assert.strictEqual(selection.selected.symbol, 'LINKUSDT');
  assert.strictEqual(selection.selectionMode, 'BEST_ELIGIBLE_MULTI_FAMILY');

  console.log('spotQuantAdvancedResearchLab tests passed');
})();
