'use strict';

const assert = require('assert');
const {
  candidateUtility,
  pairPenalty,
  portfolioObjective,
  greedyOptimize,
  exactQuboOptimize,
  quantumInspiredOptimize
} = require('../services/spotLocalQuboOptimizer');

function candidate(symbol, score, change, lane, volume = 50000000, trades = 120000) {
  return {
    symbol,
    price: 1,
    gem_score: score,
    gem_penalty: 0,
    price_change_24h_pct: change,
    quote_volume_24h: volume,
    trades_24h: trades,
    research_lane: lane,
    risks: [],
    gem_components: {
      liquidity: 22,
      activity: 15,
      momentum: change >= 3 && change <= 12 ? 18 : 9,
      volatility: 10,
      novelty: 5
    }
  };
}

(function utilityRewardsQuality() {
  const strong = candidate('AAAUSDT', 90, 6, 'FRESH_EARLY');
  const weak = candidate('BBBUSDT', 60, 1, 'CORE_RANKING', 6000000, 12000);
  assert(candidateUtility(strong) > candidateUtility(weak));
})();

(function pairPenaltyRewardsDiversification() {
  const a = candidate('AAAUSDT', 88, 6, 'CONSTRUCTIVE_MOMENTUM');
  const b = candidate('BBBUSDT', 87, 7, 'CONSTRUCTIVE_MOMENTUM');
  const c = candidate('CCCUSDT', 86, 2, 'FRESH_EARLY');
  assert(pairPenalty(a, b) > pairPenalty(a, c));
})();

(function exactQuboRespectsCapitalAndCardinality() {
  const candidates = [
    candidate('AAAUSDT', 92, 5, 'FRESH_EARLY'),
    candidate('BBBUSDT', 90, 6, 'CONSTRUCTIVE_MOMENTUM'),
    candidate('CCCUSDT', 88, 2, 'LIQUID_ACTIVITY'),
    candidate('DDDUSDT', 80, 8, 'CONSTRUCTIVE_MOMENTUM')
  ];
  const config = { capitalUsdt: 10, unitUsdt: 5, maxPositions: 2 };
  const result = exactQuboOptimize(candidates, config);
  assert(result.symbols.length <= 2);
  assert(result.capital_usdt <= 10);
  assert(result.objective > 0);
})();

(function exactQuboIsNeverWorseThanGreedyOnSameObjective() {
  const candidates = [
    candidate('AAAUSDT', 91, 6, 'CONSTRUCTIVE_MOMENTUM'),
    candidate('BBBUSDT', 90, 6.5, 'CONSTRUCTIVE_MOMENTUM'),
    candidate('CCCUSDT', 87, 2, 'FRESH_EARLY'),
    candidate('DDDUSDT', 86, 4, 'LIQUID_ACTIVITY')
  ];
  const config = { capitalUsdt: 15, unitUsdt: 5, maxPositions: 3 };
  const greedy = greedyOptimize(candidates, config);
  const qubo = exactQuboOptimize(candidates, config);
  assert(qubo.objective + 1e-9 >= greedy.objective);
})();

(function quantumInspiredProducesValidPortfolio() {
  const candidates = [
    candidate('AAAUSDT', 91, 6, 'FRESH_EARLY'),
    candidate('BBBUSDT', 89, 4, 'CONSTRUCTIVE_MOMENTUM'),
    candidate('CCCUSDT', 86, 2, 'LIQUID_ACTIVITY')
  ];
  const config = { capitalUsdt: 10, unitUsdt: 5, maxPositions: 2 };
  const result = quantumInspiredOptimize(candidates, config, 12345);
  assert(result.symbols.length <= 2);
  assert(result.capital_usdt <= 10);
  assert(Number.isFinite(portfolioObjective(candidates.slice(0, 2))));
})();

console.log('spotLocalQuboOptimizer tests passed');
