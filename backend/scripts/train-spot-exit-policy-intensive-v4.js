'use strict';

const fs = require('fs');
const path = require('path');
const {
  CURRENT_CORE_POLICY,
  CURRENT_V61_POLICY,
  metrics,
  objective,
  buildDataset
} = require('./train-spot-exit-policy-v2');

const OUTPUT = process.env.EXIT_INTENSIVE_OUTPUT || path.join(process.cwd(), 'spot-exit-intensive-report.json');
const EVIDENCE_OUTPUT = process.env.EXIT_INTENSIVE_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-exit-intensive-evidence.json');

function n(value, fallback = 0) {
  const x = Number(value);
  return Number.isFinite(x) ? x : fallback;
}
function round(value, digits = 6) {
  const f = 10 ** digits;
  return Math.round(n(value) * f) / f;
}
function mean(values = []) {
  return values.length ? values.reduce((s, x) => s + n(x), 0) / values.length : 0;
}
function intensiveGrid() {
  const out = [];
  for (const mfe of [0.014, 0.018, 0.022, 0.026, 0.030]) {
    for (const dd of [-0.006, -0.008, -0.010, -0.012]) {
      for (const gap of [0.003, 0.004, 0.005, 0.006]) {
        for (const r15 of [-0.001, 0, 0.001]) {
          for (const confirm of [0.005, 0.010, 0.015, 0.020, 0.025]) {
            out.push({
              enabled: true,
              mfe,
              dd,
              gap,
              r15,
              confirm,
              healthyPnl: CURRENT_V61_POLICY.healthyPnl,
              healthyRs: CURRENT_V61_POLICY.healthyRs,
              healthyConfirm: CURRENT_V61_POLICY.healthyConfirm
            });
          }
        }
      }
    }
  }
  return out;
}
function orderedRows(rows) {
  return [...rows].sort((a, b) => Date.parse(a.execution_at || a.created_at) - Date.parse(b.execution_at || b.created_at));
}
function splitIntensive(rows) {
  const ordered = orderedRows(rows);
  const total = ordered.length;
  const holdoutStart = Math.floor(total * 0.80);
  const development = ordered.slice(0, holdoutStart);
  const holdout = ordered.slice(holdoutStart);
  const d = development.length;

  const cut1 = Math.floor(d * 0.50);
  const cut2 = Math.floor(d * 0.66);
  const cut3 = Math.floor(d * 0.83);

  const folds = [
    { name: 'WF1', rows: development.slice(cut1, cut2) },
    { name: 'WF2', rows: development.slice(cut2, cut3) },
    { name: 'WF3', rows: development.slice(cut3) }
  ].filter((x) => x.rows.length >= 15);

  return { development, holdout, folds };
}
function delta(candidate, baseline) {
  return {
    mean_return_pct: round(candidate.mean_return_pct - baseline.mean_return_pct, 4),
    median_return_pct: round(candidate.median_return_pct - baseline.median_return_pct, 4),
    positive_rate: round(candidate.positive_rate - baseline.positive_rate, 4),
    profit_factor: round(candidate.profit_factor - baseline.profit_factor, 4),
    p10_return_pct: round(candidate.p10_return_pct - baseline.p10_return_pct, 4),
    worst_return_pct: round(candidate.worst_return_pct - baseline.worst_return_pct, 4)
  };
}
function scenarioMetrics(rows, policy) {
  return {
    normal: metrics(rows, CURRENT_CORE_POLICY, policy, { feePct: 0.002, decisionStepBars: 1 }),
    fee_stress: metrics(rows, CURRENT_CORE_POLICY, policy, { feePct: 0.0035, decisionStepBars: 1 }),
    cadence_10m: metrics(rows, CURRENT_CORE_POLICY, policy, { feePct: 0.0025, decisionStepBars: 2 }),
    cadence_15m: metrics(rows, CURRENT_CORE_POLICY, policy, { feePct: 0.0025, decisionStepBars: 3 })
  };
}
function foldComparison(rows, policy) {
  const baseline = scenarioMetrics(rows, CURRENT_V61_POLICY);
  const candidate = scenarioMetrics(rows, policy);
  return {
    samples: rows.length,
    baseline,
    candidate,
    deltas: {
      normal: delta(candidate.normal, baseline.normal),
      fee_stress: delta(candidate.fee_stress, baseline.fee_stress),
      cadence_10m: delta(candidate.cadence_10m, baseline.cadence_10m),
      cadence_15m: delta(candidate.cadence_15m, baseline.cadence_15m)
    }
  };
}
function robustScore(comparisons) {
  const normalMean = mean(comparisons.map((x) => x.deltas.normal.mean_return_pct));
  const feeMean = mean(comparisons.map((x) => x.deltas.fee_stress.mean_return_pct));
  const c10Mean = mean(comparisons.map((x) => x.deltas.cadence_10m.mean_return_pct));
  const c15Mean = mean(comparisons.map((x) => x.deltas.cadence_15m.mean_return_pct));
  const positive = mean(comparisons.map((x) => x.deltas.normal.positive_rate));
  const profitFactor = mean(comparisons.map((x) => x.deltas.normal.profit_factor));
  const worstFold = Math.min(...comparisons.map((x) => x.deltas.normal.mean_return_pct));
  const worstTail = Math.min(...comparisons.map((x) => x.deltas.normal.worst_return_pct));

  const score =
    normalMean +
    0.45 * feeMean +
    0.55 * c10Mean +
    0.35 * c15Mean +
    0.60 * positive +
    0.05 * profitFactor +
    0.08 * worstFold +
    0.03 * worstTail;

  return {
    score: round(score, 6),
    avg_normal_mean_delta_pct: round(normalMean, 4),
    avg_fee_stress_mean_delta_pct: round(feeMean, 4),
    avg_cadence_10m_mean_delta_pct: round(c10Mean, 4),
    avg_cadence_15m_mean_delta_pct: round(c15Mean, 4),
    avg_positive_rate_delta: round(positive, 4),
    avg_profit_factor_delta: round(profitFactor, 4),
    worst_fold_mean_delta_pct: round(worstFold, 4),
    worst_tail_delta_pct: round(worstTail, 4)
  };
}
function developmentGate(summary) {
  return (
    summary.avg_normal_mean_delta_pct >= 0.05 &&
    summary.avg_fee_stress_mean_delta_pct >= 0 &&
    summary.avg_cadence_10m_mean_delta_pct >= 0 &&
    summary.avg_cadence_15m_mean_delta_pct >= -0.05 &&
    summary.avg_positive_rate_delta >= -0.02 &&
    summary.worst_fold_mean_delta_pct >= -0.20 &&
    summary.worst_tail_delta_pct >= -0.50
  );
}
function finalGate(holdout) {
  const d = holdout.deltas;
  return (
    holdout.samples >= 25 &&
    d.normal.mean_return_pct >= 0.08 &&
    d.fee_stress.mean_return_pct >= 0.03 &&
    d.cadence_10m.mean_return_pct >= 0.03 &&
    d.cadence_15m.mean_return_pct >= -0.05 &&
    d.normal.positive_rate >= -0.02 &&
    d.normal.profit_factor >= -0.10 &&
    d.normal.worst_return_pct >= -0.50
  );
}
function differs(a, b) {
  return ['mfe','dd','gap','r15','confirm','healthyPnl','healthyRs','healthyConfirm']
    .some((k) => n(a[k]) !== n(b[k]));
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPOSITORY || '';
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required');

  const startedAt = Date.now();
  const dataset = await buildDataset(repo);
  if (dataset.rows.length < 120) throw new Error(`Insufficient CORE history for intensive training: ${dataset.rows.length}`);

  const split = splitIntensive(dataset.rows);
  if (split.holdout.length < 25 || split.folds.length < 3) {
    throw new Error(`Insufficient chronological folds: holdout=${split.holdout.length} folds=${split.folds.length}`);
  }

  const baselineFoldEvidence = split.folds.map((fold) => ({
    name: fold.name,
    samples: fold.rows.length,
    metrics: scenarioMetrics(fold.rows, CURRENT_V61_POLICY)
  }));

  const candidates = intensiveGrid();
  const ranked = [];

  for (const policy of candidates) {
    const comparisons = split.folds.map((fold) => foldComparison(fold.rows, policy));
    const robust = robustScore(comparisons);
    if (!developmentGate(robust)) continue;
    ranked.push({ policy, robust, comparisons });
  }

  ranked.sort((a, b) => b.robust.score - a.robust.score);
  const finalists = ranked.slice(0, 12);
  let selected = null;

  for (const finalist of finalists) {
    const holdout = foldComparison(split.holdout, finalist.policy);
    const passed = finalGate(holdout);
    const item = { ...finalist, holdout, passed_for_production: passed };
    if (!selected && passed && differs(finalist.policy, CURRENT_V61_POLICY)) selected = item;
  }

  const baselineHoldout = foldComparison(split.holdout, CURRENT_V61_POLICY);
  const recommendation = selected ? 'PROMOTE' : 'KEEP_CURRENT';
  const report = {
    ok: true,
    version: 'SPOT_EXIT_INTENSIVE_V4_2026_09_19',
    generated_at: new Date().toISOString(),
    runtime_seconds: round((Date.now() - startedAt) / 1000, 2),
    source: 'ALL_RECONSTRUCTIBLE_EXECUTED_CORE_HISTORY_PLUS_BINANCE_PUBLIC_5M',
    methodology: {
      candidates_tested: candidates.length,
      development_rows: split.development.length,
      walk_forward_folds: split.folds.map((x) => ({ name: x.name, samples: x.rows.length })),
      untouched_holdout_rows: split.holdout.length,
      scenarios: {
        normal: '0.20% round-trip cost; 5m decision cadence',
        fee_stress: '0.35% round-trip cost',
        cadence_10m: '0.25% round-trip cost; V6.1 decision every 10m',
        cadence_15m: '0.25% round-trip cost; V6.1 decision every 15m'
      }
    },
    reconstructed_core_trades: dataset.rows.length,
    matched_unique_exits: dataset.matched_exit_count,
    current_policy: CURRENT_V61_POLICY,
    baseline_holdout: baselineHoldout,
    viable_development_candidates: ranked.length,
    finalists: finalists.map((x) => ({
      policy: x.policy,
      robust: x.robust,
      holdout: foldComparison(split.holdout, x.policy),
      passed_for_production: finalGate(foldComparison(split.holdout, x.policy))
    })),
    selected_policy: selected ? selected.policy : null,
    selected_development: selected ? selected.robust : null,
    selected_holdout: selected ? selected.holdout : null,
    promotion_recommendation: recommendation
  };

  const evidence = {
    generated_at: report.generated_at,
    baseline_folds: baselineFoldEvidence,
    top_development_candidates: ranked.slice(0, 30).map((x) => ({
      policy: x.policy,
      robust: x.robust,
      comparisons: x.comparisons
    }))
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2));

  console.log(JSON.stringify({
    ok: true,
    version: report.version,
    runtime_seconds: report.runtime_seconds,
    reconstructed_core_trades: report.reconstructed_core_trades,
    matched_unique_exits: report.matched_unique_exits,
    candidates_tested: report.methodology.candidates_tested,
    viable_development_candidates: report.viable_development_candidates,
    holdout_rows: report.methodology.untouched_holdout_rows,
    current_policy: report.current_policy,
    selected_policy: report.selected_policy,
    selected_development: report.selected_development,
    selected_holdout: report.selected_holdout,
    recommendation
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  intensiveGrid,
  splitIntensive,
  delta,
  scenarioMetrics,
  foldComparison,
  robustScore,
  developmentGate,
  finalGate
};
