'use strict';

const assert = require('assert');
const {
  scoreDiscovery,
  isTradableSpotUsdt
} = require('../services/newSpotAssetDiscovery');

(function run() {
  assert.strictEqual(isTradableSpotUsdt({
    status: 'TRADING',
    quoteAsset: 'USDT',
    isSpotTradingAllowed: true,
    permissions: ['SPOT']
  }), true);

  assert.strictEqual(isTradableSpotUsdt({
    status: 'TRADING',
    quoteAsset: 'USDT',
    isSpotTradingAllowed: false,
    permissions: []
  }), false);

  const strong = scoreDiscovery({
    ticker: {
      quoteVolume: '8000000',
      lastPrice: '0.08',
      priceChangePercent: '12'
    }
  }, {
    found: true,
    homepage: 'https://example.org',
    github: 'https://github.com/example/project',
    evidence_score: 85,
    ambiguity: 1
  }, 2);

  assert.strictEqual(strong.research_eligible, true);
  assert.strictEqual(strong.real_entry_approved, false);
  assert.strictEqual(strong.requires_backtest, true);

  const risky = scoreDiscovery({
    ticker: {
      quoteVolume: '10000',
      lastPrice: '0.0001',
      priceChangePercent: '88'
    }
  }, {
    found: false,
    evidence_score: 0,
    ambiguity: 5
  }, 1);

  assert.strictEqual(risky.research_eligible, false);
  assert(risky.risks.includes('LOW_LIQUIDITY'));
  assert(risky.risks.includes('EXTREME_24H_MOVE'));
  assert(risky.risks.includes('PROJECT_EVIDENCE_NOT_FOUND'));

  console.log('newSpotAssetDiscovery tests passed');
})();