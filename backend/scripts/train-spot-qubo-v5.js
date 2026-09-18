'use strict';

const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const snapshot = JSON.parse(fs.readFileSync(path.join(root, 'config', 'spot-qubo-training-snapshot-v5.json'), 'utf8'));
const production = JSON.parse(fs.readFileSync(path.join(root, 'config', 'spot-qubo-production-v5.json'), 'utf8'));

function clamp(v, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(v) || 0)); }
function normalizedLog(value, floor = 200000, ceiling = 150000000) {
  const v = Number(value) || 0;
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}
function baseUtility(row) {
  const pct = Number(row.pct) || 0;
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(row.qv);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15;
}
function stableFromObserved(row, base) {
  return clamp((Number(row.utility) - 0.40 * base - 0.45 * Number(row.v42_norm)) / 0.15);
}
function ranks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const result = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) result[sorted[k].i] = rank;
    i = j;
  }
  return result;
}
function correlation(a, b) {
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xa = a[i] - ma, xb = b[i] - mb;
    num += xa * xb; da += xa * xa; db += xb * xb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function spearman(a, b) { return correlation(ranks(a), ranks(b)); }

const rows = snapshot.records.map((row) => {
  const base = baseUtility(row);
  return { ...row, base, stable: stableFromObserved(row, base) };
});
const pnl = rows.map((row) => Number(row.realized_pnl_pct));
const prior = [0.40, 0.15, 0.45];
const regularization = 0.35;
let best = null;
for (let base = 0.40; base <= 0.550001; base += 0.05) {
  for (let stable = 0.05; stable <= 0.150001; stable += 0.05) {
    const v42 = Number((1 - base - stable).toFixed(2));
    if (v42 < 0.30) continue;
    const scores = rows.map((row) => row.base * base + row.stable * stable + Number(row.v42_norm) * v42);
    const rankCorrelation = spearman(scores, pnl);
    const distance = (base - prior[0]) ** 2 + (stable - prior[1]) ** 2 + (v42 - prior[2]) ** 2;
    const objective = rankCorrelation - regularization * distance;
    const candidate = { base: Number(base.toFixed(2)), stable: Number(stable.toFixed(2)), v42, rank_correlation: rankCorrelation, regularized_objective: objective };
    if (!best || candidate.regularized_objective > best.regularized_objective) best = candidate;
  }
}
const result = {
  model_version: production.model_version,
  samples: rows.length,
  method: 'regularized_pair_ranking_grid',
  weights: { base: best.base, stable: best.stable, v42: best.v42 },
  rank_correlation: Number(best.rank_correlation.toFixed(6)),
  regularized_objective: Number(best.regularized_objective.toFixed(6))
};
console.log(JSON.stringify(result));
if (process.argv.includes('--verify')) {
  const expected = production.weights;
  for (const key of ['base', 'stable', 'v42']) {
    if (Math.abs(Number(expected[key]) - Number(result.weights[key])) > 1e-9) {
      throw new Error(`QUBO_V5_TRAINING_DRIFT ${key}: config=${expected[key]} trained=${result.weights[key]}`);
    }
  }
  if (rows.length !== Number(production.training.samples)) throw new Error('QUBO_V5_TRAINING_SAMPLE_COUNT_DRIFT');
}
