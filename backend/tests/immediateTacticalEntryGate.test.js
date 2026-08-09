'use strict';

const assert = require('assert');
const {
  tacticalThresholds,
  buildLaneCandidatePools,
  evaluateTacticalMomentumCandidate
} = require('../services/paperToRealEntryGate');

function candidate(overrides = {}) {
  return {
    symbol: 'GEMUSDT',
    opportunityScore: 72,
    quoteVolume24h: 2500000,
    priceChange24h: 6.5,
    impulseScore: 34,
    liquidityScore: 72,
    riskScore: 32,
    category: 'NEW_OR_LOW_PRICE',
    warnings: [],
    ...overrides
  };
}

(function tacticalThresholdDoesNotInheritStandardPaperThreshold() {
  const thresholds = tacticalThresholds({ min_opportunity_score: 95 });
  assert.strictEqual(thresholds.minimum_score, 68);
  assert.strictEqual(thresholds.minimum_impulse_score, 30);
  assert.strictEqual(thresholds.minimum_technical_score, 65);
})();

(function tacticalPoolSurvivesConservativeStandardFilters() {
  const gem = candidate();
  const pools = buildLaneCandidatePools([gem], {
    min_opportunity_score: 95,
    allowed_categories: ['BREAKOUT', 'MOMENTUM', 'ACCUMULATION']
  });
  assert.strictEqual(pools.standard.length, 0);
  assert.strictEqual(pools.tactical.length, 1);
  assert.strictEqual(pools.tactical[0].symbol, 'GEMUSDT');
})();

(function freshLiquidLowPriceCandidateCanReachTechnicalConfirmationImmediately() {
  const result = evaluateTacticalMomentumCandidate(candidate(), { sample_size: 0, positive_rate: 0 }, {
    min_opportunity_score: 95
  });
  assert.strictEqual(result.allowed, true, result.reasons.join(','));
})();

(function antiChaseGuardStillBlocksExtendedMove() {
  const result = evaluateTacticalMomentumCandidate(candidate({ priceChange24h: 23 }), null, {});
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reasons.includes('TACTICAL_MOVE_ALREADY_EXTENDED'));
})();

(function riskGuardStillBlocksDangerousCandidate() {
  const result = evaluateTacticalMomentumCandidate(candidate({ riskScore: 80 }), null, {});
  assert.strictEqual(result.allowed, false);
  assert.ok(result.reasons.includes('TACTICAL_RISK_TOO_HIGH'));
})();

console.log('immediateTacticalEntryGate.test.js: PASS');
