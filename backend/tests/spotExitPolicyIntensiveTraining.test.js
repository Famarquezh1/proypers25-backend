'use strict';

const assert = require('assert');
const {
  intensiveGrid,
  splitIntensive,
  robustScore,
  developmentGate,
  finalGate
} = require('../scripts/train-spot-exit-policy-intensive-v4');

(function gridIsIntensiveButBounded() {
  const grid = intensiveGrid();
  assert.strictEqual(grid.length, 1200);
  assert(grid.some((p) => p.mfe === 0.018 && p.dd === -0.008 && p.gap === 0.004 && p.r15 === 0 && p.confirm === 0.015));
})();

(function chronologicalSplitHasThreeDevelopmentFoldsAndUntouchedHoldout() {
  const rows = Array.from({ length: 170 }, (_, i) => ({
    execution_at: new Date(Date.UTC(2026, 8, 1) + i * 3600000).toISOString()
  }));
  const split = splitIntensive(rows);
  assert.strictEqual(split.holdout.length, 34);
  assert.strictEqual(split.folds.length, 3);
  assert(split.folds.every((f) => f.rows.length >= 15));
  assert(Date.parse(split.development.at(-1).execution_at) < Date.parse(split.holdout[0].execution_at));
})();

(function robustGateRequiresCrossScenarioImprovement() {
  const good = {
    avg_normal_mean_delta_pct: 0.2,
    avg_fee_stress_mean_delta_pct: 0.15,
    avg_cadence_10m_mean_delta_pct: 0.1,
    avg_cadence_15m_mean_delta_pct: 0.05,
    avg_positive_rate_delta: 0.03,
    avg_profit_factor_delta: 0.2,
    worst_fold_mean_delta_pct: 0.01,
    worst_tail_delta_pct: 0
  };
  assert(developmentGate(good));
  assert(!developmentGate({ ...good, avg_cadence_10m_mean_delta_pct: -0.1 }));
})();

(function finalGateKeepsTailRiskBounded() {
  const deltas = {
    normal: { mean_return_pct: 0.2, positive_rate: 0.02, profit_factor: 0.1, worst_return_pct: 0 },
    fee_stress: { mean_return_pct: 0.15 },
    cadence_10m: { mean_return_pct: 0.12 },
    cadence_15m: { mean_return_pct: 0.02 }
  };
  assert(finalGate({ samples: 34, deltas }));
  assert(!finalGate({ samples: 34, deltas: { ...deltas, normal: { ...deltas.normal, worst_return_pct: -0.8 } } }));
})();

(function robustScoreRewardsConsistentImprovement() {
  const c = [{
    deltas: {
      normal: { mean_return_pct: 0.2, positive_rate: 0.03, profit_factor: 0.2, worst_return_pct: 0 },
      fee_stress: { mean_return_pct: 0.15 },
      cadence_10m: { mean_return_pct: 0.1 },
      cadence_15m: { mean_return_pct: 0.08 }
    }
  },{
    deltas: {
      normal: { mean_return_pct: 0.1, positive_rate: 0.01, profit_factor: 0.1, worst_return_pct: 0 },
      fee_stress: { mean_return_pct: 0.08 },
      cadence_10m: { mean_return_pct: 0.05 },
      cadence_15m: { mean_return_pct: 0.03 }
    }
  }];
  const r = robustScore(c);
  assert(r.score > 0);
  assert(r.worst_fold_mean_delta_pct >= 0.1);
})();

console.log('spot intensive exit-policy training tests passed');
