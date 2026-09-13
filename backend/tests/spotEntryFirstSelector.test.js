'use strict';

const assert = require('assert');
const {
  ENTRY_FIRST_VERSION,
  computeEntryFirstPriority,
  prioritizeEntryFirstCandidates,
  prioritizeLane
} = require('../services/spotEntryFirstSelector');

function candidate(overrides = {}) {
  return {
    symbol: 'GOODUSDT',
    opportunityScore: 82,
    impulseScore: 80,
    breakoutScore: 75,
    accumulationScore: 70,
    liquidityScore: 85,
    volumeChangeScore: 70,
    riskScore: 25,
    priceChange24h: 7,
    priceChange7d: 18,
    quoteVolume24h: 2500000,
    category: 'MOMENTUM',
    ...overrides
  };
}

(function ranksFreshTrajectoryAheadOfParabolicRisk() {
  const good = candidate();
  const chased = candidate({
    symbol: 'CHASEUSDT',
    opportunityScore: 95,
    impulseScore: 90,
    breakoutScore: 90,
    accumulationScore: 50,
    liquidityScore: 75,
    volumeChangeScore: 80,
    riskScore: 80,
    priceChange24h: 31,
    priceChange7d: 64
  });
  const ranked = prioritizeEntryFirstCandidates([chased, good], {});
  assert.equal(ranked.enabled, true);
  assert.equal(ranked.version, ENTRY_FIRST_VERSION);
  assert.equal(ranked.candidates[0].symbol, 'GOODUSDT');
  assert(ranked.candidates[0].entry_first_score > ranked.candidates[1].entry_first_score);
  assert.equal(ranked.candidates[0].entry_first_rank, 1);
})();

(function regimeDoesNotGatePriority() {
  const unknown = candidate({ symbol: 'UNKNOWNUSDT', regime: 'UNKNOWN' });
  const range = candidate({ symbol: 'RANGEUSDT', regime: 'RANGE' });
  const a = computeEntryFirstPriority(unknown, {});
  const b = computeEntryFirstPriority(range, {});
  assert.equal(a.entry_first_score, b.entry_first_score);
})();

(function sparseFeaturesFallBackTowardProductionScore() {
  const sparse = { symbol: 'SPARSEUSDT', opportunityScore: 88, quoteVolume24h: 3000000 };
  const result = computeEntryFirstPriority(sparse, {});
  assert(result.feature_coverage < 0.5);
  assert(result.entry_first_score > 50);
  assert(result.entry_first_score <= 88);
})();

(function disabledModePreservesExistingOrder() {
  const first = candidate({ symbol: 'FIRSTUSDT', opportunityScore: 60 });
  const second = candidate({ symbol: 'SECONDUSDT', opportunityScore: 95 });
  const ranked = prioritizeEntryFirstCandidates([first, second], { entry_first_enabled: false });
  assert.equal(ranked.enabled, false);
  assert.equal(ranked.candidates[0].symbol, 'FIRSTUSDT');
  assert.equal(ranked.candidates[1].symbol, 'SECONDUSDT');
})();

(function lanePrioritizationIsSoftRankingOnly() {
  const high = candidate({ symbol: 'HIGHUSDT' });
  const low = candidate({ symbol: 'LOWUSDT', riskScore: 70, priceChange24h: 25 });
  const ranked = prioritizeEntryFirstCandidates([low, high], {}).candidates;
  const lane = prioritizeLane(ranked, true);
  assert.deepEqual(lane.map((row) => row.symbol), ['HIGHUSDT', 'LOWUSDT']);
  assert.equal(lane.length, 2, 'ENTRY-first must not remove candidates; existing gates decide admission');
})();

console.log('spotEntryFirstSelector tests: OK');
