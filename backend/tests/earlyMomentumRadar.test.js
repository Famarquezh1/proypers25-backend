'use strict';

const assert = require('assert');
const {
  analyzeEarlyMomentumCandles,
  earlyMomentumThresholds,
  evaluateEarlyMomentumCandidate,
  selectProbeCandidates
} = require('../services/spotEarlyMomentumRadar');

function buildRows({ accelerating = true } = {}) {
  const rows = [];
  let price = 1;
  const start = Date.parse('2026-08-09T12:00:00.000Z');
  for (let index = 0; index < 32; index += 1) {
    const open = price;
    if (accelerating && index >= 19 && index < 28) price *= 1.002;
    if (accelerating && index >= 28 && index < 31) price *= 1 + (0.004 + ((index - 28) * 0.001));
    const close = price;
    const quoteVolume = accelerating && index >= 28 && index < 31 ? 3200 : 1000;
    rows.push([
      start + (index * 300000),
      String(open),
      String(Math.max(open, close) * 1.001),
      String(Math.min(open, close) * 0.999),
      String(close),
      '1000',
      start + ((index + 1) * 300000) - 1,
      String(quoteVolume),
      100,
      '500',
      String(quoteVolume / 2),
      '0'
    ]);
  }
  return rows;
}

(function defaultsKeepEarlyLaneControlled() {
  const thresholds = earlyMomentumThresholds({});
  assert.strictEqual(thresholds.minimum_score, 65);
  assert.strictEqual(thresholds.maximum_price_change_24h, 18);
  assert.strictEqual(thresholds.minimum_relative_volume, 1.15);
  assert.strictEqual(thresholds.minimum_technical_score, 60);
})();

(function acceleratingClosedCandlesProduceStrongEarlySignal() {
  const metrics = analyzeEarlyMomentumCandles(buildRows());
  assert.strictEqual(metrics.valid, true);
  assert.ok(metrics.score >= 65, `score=${metrics.score}`);
  assert.ok(metrics.change_5m_pct >= 0.1, `5m=${metrics.change_5m_pct}`);
  assert.ok(metrics.change_15m_pct >= 0.5, `15m=${metrics.change_15m_pct}`);
  assert.ok(metrics.change_1h_pct >= 1, `1h=${metrics.change_1h_pct}`);
  assert.ok(metrics.relative_volume_15m >= 1.15, `rv=${metrics.relative_volume_15m}`);
  assert.ok(metrics.confirmations >= 2);
})();

(function freshLiquidMoveCanPrequalifyBeforeEighteenPercent() {
  const metrics = analyzeEarlyMomentumCandles(buildRows());
  const result = evaluateEarlyMomentumCandidate({
    symbol: 'EARLYUSDT',
    priceChange24h: 5.4,
    quoteVolume24h: 2400000,
    riskScore: 28,
    warnings: [],
    earlyMomentum: metrics
  }, { sample_size: 0, positive_rate: 0 }, {});
  assert.strictEqual(result.allowed, true, result.reasons.join(','));
})();

(function antiChaseStillRejectsAlreadyExtendedWinner() {
  const metrics = analyzeEarlyMomentumCandles(buildRows());
  const result = evaluateEarlyMomentumCandidate({
    symbol: 'CHASEUSDT',
    priceChange24h: 24,
    quoteVolume24h: 6000000,
    riskScore: 25,
    warnings: [],
    earlyMomentum: metrics
  }, null, {});
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reasons.includes('EARLY_MOVE_ALREADY_EXTENDED'));
})();

(function probeRankingIgnoresHugeAlreadyExtendedMovesAndThinPairs() {
  const selected = selectProbeCandidates([
    { symbol: 'GOODUSDT', priceChange24h: 4, quoteVolume24h: 1500000, riskScore: 30, liquidityScore: 65, impulseScore: 30, volumeChangeScore: 40, warnings: [] },
    { symbol: 'TOOLATEUSDT', priceChange24h: 45, quoteVolume24h: 9000000, riskScore: 30, liquidityScore: 80, impulseScore: 90, volumeChangeScore: 90, warnings: [] },
    { symbol: 'THINUSDT', priceChange24h: 5, quoteVolume24h: 50000, riskScore: 20, liquidityScore: 10, impulseScore: 40, volumeChangeScore: 80, warnings: [] }
  ], {});
  assert.deepStrictEqual(selected.map((item) => item.symbol), ['GOODUSDT']);
})();

(function flatCandlesDoNotCreateFalseEarlySignal() {
  const metrics = analyzeEarlyMomentumCandles(buildRows({ accelerating: false }));
  const result = evaluateEarlyMomentumCandidate({
    symbol: 'FLATUSDT',
    priceChange24h: 2,
    quoteVolume24h: 2000000,
    riskScore: 20,
    warnings: [],
    earlyMomentum: metrics
  }, null, {});
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reasons.includes('EARLY_SCORE_BELOW_THRESHOLD'));
})();

console.log('earlyMomentumRadar.test.js: PASS');
