'use strict';

const assert = require('assert');
const {
  CONFIG,
  validateAdaptiveConfig,
  METHOD,
  productionUtility,
  pairPenalty,
  buildHardwareQubo,
  solveHardwareReadyQubo
} = require('../services/spotQuboProductionV5');

function c(symbol, base, stable, v42, pct, returns) {
  return {
    symbol,
    base_utility: base,
    stable_norm: stable,
    v42_norm: v42,
    pct,
    qubo_returns: returns
  };
}

(function trainedWeightsAreProduction() {
  assert.strictEqual(CONFIG.mode, 'PRODUCTION');
  assert.deepStrictEqual(CONFIG.weights, { base: 0.55, stable: 0.05, v42: 0.40 });
})();

(function adaptiveConfigRequiresSafeProductionWeights() {
  const good = validateAdaptiveConfig({
    mode: 'PRODUCTION',
    adaptive: true,
    model_version: 'TEST',
    weights: { base: 0.50, stable: 0.10, v42: 0.40 }
  });
  assert(good);
  assert.deepStrictEqual(good.weights, { base: 0.50, stable: 0.10, v42: 0.40 });
  assert.strictEqual(validateAdaptiveConfig({ mode: 'PRODUCTION', adaptive: true, weights: { base: 0.9, stable: 0.05, v42: 0.20 } }), null);
})();

(function utilityUsesTrainedWeights() {
  const value = productionUtility(c('AAAUSDT', 0.8, 0.6, 0.9, 8, []));
  assert(Math.abs(value - (0.8 * 0.55 + 0.6 * 0.05 + 0.9 * 0.40)) < 1e-8);
})();

(function correlatedAssetsReceiveDiversificationPenalty() {
  const a = c('AAAUSDT', 0.8, 0.6, 0.9, 8, [0.01,0.02,0.01,0.03,0.01,0.02,0.01,0.03,0.02,0.01]);
  const b = c('BBBUSDT', 0.8, 0.6, 0.9, 8.5, [0.011,0.021,0.011,0.031,0.011,0.021,0.011,0.031,0.021,0.011]);
  const d = c('DDDUSDT', 0.8, 0.6, 0.9, 13, [-0.01,0.02,-0.01,0.01,-0.02,0.01,-0.01,0.02,-0.01,0.01]);
  assert(pairPenalty(a, b) > pairPenalty(a, d));
})();

(function modelIsNormalizedHardwareReadyQubo() {
  const candidates = [
    c('AAAUSDT', 0.9, 0.7, 0.95, 6, []),
    c('BBBUSDT', 0.85, 0.7, 0.94, 7, []),
    c('CCCUSDT', 0.82, 0.6, 0.93, 9, []),
    c('DDDUSDT', 0.78, 0.5, 0.91, 11, [])
  ];
  const { model } = buildHardwareQubo(candidates);
  assert.strictEqual(model.metadata.hardware_ready, true);
  assert.strictEqual(model.variables.length, candidates.length + 2);
  assert(model.variables.some((v) => v.name === 's0'));
  assert(model.variables.some((v) => v.name === 's1'));
  const coeffs = [...Object.values(model.normalized_linear), ...Object.values(model.normalized_quadratic)];
  assert(Math.max(...coeffs.map(Math.abs)) <= 1.000000000001);
})();

(function exactLocalSolverUsesSameQuboAndRespectsCardinality() {
  const candidates = Array.from({ length: 6 }, (_, i) =>
    c(`T${i}USDT`, 0.9 - i * 0.03, 0.7, 0.95 - i * 0.01, 4 + i * 2, [])
  );
  const result = solveHardwareReadyQubo(candidates);
  assert.strictEqual(result.method, METHOD);
  assert.strictEqual(result.hardware_ready, true);
  assert.strictEqual(result.solver, 'LOCAL_EXACT_BINARY_ENUMERATION');
  assert(result.selected.length >= 1);
  assert(result.selected.length <= CONFIG.qubo.max_selected);
  assert(result.model_stats.total_binary_variables === Math.min(candidates.length, CONFIG.qubo.max_candidates) + 2);
})();

console.log('spotQuboProductionV5 tests passed');
