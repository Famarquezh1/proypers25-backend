'use strict';

const assert = require('assert');
const {
  MAX_RESEARCH_SYMBOLS,
  isProductiveResearchCandidate,
  selectProductiveResearchCandidates
} = require('../services/spotGemRadar');

function asset(symbol, overrides = {}) {
  return {
    symbol,
    gem_score: 70,
    quote_volume_24h: 20000000,
    trades_24h: 80000,
    price_change_24h_pct: 7,
    age_days: 120,
    risks: [],
    research_eligible: true,
    real_entry_approved: false,
    ...overrides
  };
}

const ranked = [
  asset('CORE1USDT', { gem_score: 92, price_change_24h_pct: 8 }),
  asset('CORE2USDT', { gem_score: 91, price_change_24h_pct: 9 }),
  asset('CORE3USDT', { gem_score: 90, price_change_24h_pct: 10 }),
  asset('CORE4USDT', { gem_score: 89, price_change_24h_pct: 11 }),
  asset('FRESH1USDT', { gem_score: 64, price_change_24h_pct: 1.6, research_eligible: false }),
  asset('FRESH2USDT', { gem_score: 63, price_change_24h_pct: 2.3, research_eligible: false }),
  asset('FRESH3USDT', { gem_score: 62, price_change_24h_pct: 3.1, research_eligible: false }),
  asset('ACTIVEUSDT', { gem_score: 69, trades_24h: 450000, quote_volume_24h: 120000000 }),
  asset('NEWUSDT', { gem_score: 68, age_days: 4, price_change_24h_pct: 4.2 }),
  asset('MOMENTUMUSDT', { gem_score: 72, price_change_24h_pct: 6.5 }),
  asset('EXTRAUSDT', { gem_score: 71, price_change_24h_pct: 5.5 }),
  asset('BADRISKUSDT', { gem_score: 85, price_change_24h_pct: 2.2, research_eligible: false, risks: ['EXCESSIVE_INTRADAY_RANGE'] }),
  asset('LOWLIQUSDT', { gem_score: 84, quote_volume_24h: 1000000, price_change_24h_pct: 2.0, research_eligible: false })
];

assert.strictEqual(MAX_RESEARCH_SYMBOLS, 10);
assert.strictEqual(isProductiveResearchCandidate(ranked.find((item) => item.symbol === 'FRESH1USDT')), true);
assert.strictEqual(isProductiveResearchCandidate(ranked.find((item) => item.symbol === 'BADRISKUSDT')), false);
assert.strictEqual(isProductiveResearchCandidate(ranked.find((item) => item.symbol === 'LOWLIQUSDT')), false);

const selected = selectProductiveResearchCandidates(ranked, 10);
assert.strictEqual(selected.length, 10);
assert.strictEqual(new Set(selected.map((item) => item.symbol)).size, selected.length);
assert(selected.some((item) => item.symbol === 'FRESH1USDT'));
assert(selected.some((item) => item.research_lane === 'FRESH_EARLY'));
assert(selected.some((item) => item.research_exploration_only === true));
assert(!selected.some((item) => item.symbol === 'BADRISKUSDT'));
assert(!selected.some((item) => item.symbol === 'LOWLIQUSDT'));
assert(selected.every((item) => item.real_entry_approved === false));

const constrained = selectProductiveResearchCandidates(ranked, 4);
assert.strictEqual(constrained.length, 4);
assert(constrained.some((item) => item.research_lane === 'FRESH_EARLY'));
assert.strictEqual(new Set(constrained.map((item) => item.symbol)).size, constrained.length);

console.log('spotGemRadarProductiveSelection.test.js PASS');
