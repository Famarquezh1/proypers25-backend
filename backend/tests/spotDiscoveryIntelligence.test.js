'use strict';

const assert = require('assert');
const { buildDiscoveryCandidate } = require('../services/spotDiscoveryIntelligence');

const strong = buildDiscoveryCandidate({
  symbol: 'TESTUSDT',
  price: 0.12,
  quoteVolume24h: 5000000,
  opportunityScore: 88,
  riskScore: 24,
  liquidityScore: 82,
  volumeChangeScore: 90,
  breakoutScore: 84,
  accumulationScore: 76,
  impulseScore: 86,
  category: 'BREAKOUT',
  recommendation: 'STRONG_WATCH',
  reasons: ['volume_24h_above_recent_average', 'recent_high_breakout', 'accumulation_then_impulse'],
  warnings: []
}, {
  horizons: {
    h24: { status: 'completed', hours: 24, label: '24h', variation_pct: 7, max_favorable_move_pct: 11, max_adverse_move_pct: -3 }
  }
});

assert.strictEqual(strong.symbol, 'TESTUSDT');
assert.strictEqual(strong.shadow_only, true);
assert.strictEqual(strong.status, 'HIGH_CONVICTION');
assert(strong.conviction_score >= 75);
assert(strong.validation);
assert.strictEqual(strong.validation.horizon, '24h');

const risky = buildDiscoveryCandidate({
  symbol: 'RISKUSDT',
  opportunityScore: 92,
  riskScore: 88,
  liquidityScore: 20,
  volumeChangeScore: 90,
  breakoutScore: 90,
  accumulationScore: 20,
  impulseScore: 95,
  reasons: ['strong_price_move_with_growing_volume'],
  warnings: ['high_risk_profile']
});

assert.strictEqual(risky.status, 'REJECTED_RISK');
assert.strictEqual(risky.shadow_only, true);
assert(risky.risk_score >= 75);

console.log('spot discovery intelligence tests passed');
