'use strict';

const CONFIG = require('../config/spot-qubo-production-v5.json');

const METHOD = 'LOCAL_QUBO_BQM_EXACT_PRODUCTION_V5';
const HARDWARE_SCHEMA = 'BINARY_QUADRATIC_MODEL_QUBO_V1';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n(value)));
}
function round(value, digits = 8) {
  const factor = 10 ** digits;
  return Math.round(n(value) * factor) / factor;
}
function normalizedLog(value, floor = 200000, ceiling = 150000000) {
  const v = n(value);
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}

function baseUtility(candidate = {}) {
  if (Number.isFinite(Number(candidate.base_utility))) return Number(candidate.base_utility);
  const pct = n(candidate.pct);
  const qv = n(candidate.qv);
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(qv);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15;
}

function productionUtility(candidate = {}, config = CONFIG) {
  const w = config.weights || {};
  return round(
    baseUtility(candidate) * n(w.base, 0.55) +
    clamp(candidate.stable_norm) * n(w.stable, 0.05) +
    clamp(candidate.v42_norm) * n(w.v42, 0.40),
    8
  );
}

function correlation(left = [], right = []) {
  const size = Math.min(left.length, right.length);
  if (size < 8) return 0;
  const a = left.slice(-size).map(Number);
  const b = right.slice(-size).map(Number);
  const ma = a.reduce((s, x) => s + x, 0) / size;
  const mb = b.reduce((s, x) => s + x, 0) / size;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < size; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da > 0 && db > 0 ? clamp(num / Math.sqrt(da * db), -1, 1) : 0;
}

function pairPenalty(left = {}, right = {}, config = CONFIG) {
  const q = config.qubo || {};
  let penalty = 0;
  const corr = correlation(left.qubo_returns || [], right.qubo_returns || []);
  const threshold = n(q.correlation_threshold, 0.55);
  if (corr > threshold) {
    const severity = clamp((corr - threshold) / Math.max(0.0001, 1 - threshold));
    penalty += severity * n(q.correlation_penalty, 0.12);
  }
  const distance = Math.abs(n(left.pct) - n(right.pct));
  if (distance <= n(q.momentum_similarity_band_pct, 1.5)) {
    penalty += n(q.momentum_similarity_penalty, 0.02);
  }
  return round(penalty, 8);
}

function portfolioObjective(selected = [], config = CONFIG) {
  let value = selected.reduce((sum, candidate) => sum + productionUtility(candidate, config), 0);
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) value -= pairPenalty(selected[i], selected[j], config);
  }
  return round(value, 8);
}

function addLinear(model, name, value) {
  model.linear[name] = round((model.linear[name] || 0) + value, 12);
}
function pairKey(a, b) {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}
function addQuadratic(model, a, b, value) {
  const key = pairKey(a, b);
  model.quadratic[key] = round((model.quadratic[key] || 0) + value, 12);
}

function buildHardwareQubo(candidates = [], config = CONFIG) {
  const q = config.qubo || {};
  const maxCandidates = Math.max(1, Math.floor(n(q.max_candidates, 12)));
  const maxSelected = Math.max(1, Math.floor(n(q.max_selected, 3)));
  if (maxSelected > 3) throw new Error('QUBO_V5 supports max_selected <= 3 with two binary slack bits');
  const pool = candidates.slice(0, maxCandidates);
  const model = {
    schema: HARDWARE_SCHEMA,
    model_version: config.model_version,
    variables: [],
    linear: {},
    quadratic: {},
    offset: 0,
    metadata: { max_selected: maxSelected, candidate_count: pool.length }
  };

  for (let i = 0; i < pool.length; i += 1) {
    const name = `x${i}`;
    model.variables.push({ name, kind: 'candidate', symbol: pool[i].symbol });
    addLinear(model, name, -productionUtility(pool[i], config));
  }
  model.variables.push({ name: 's0', kind: 'cardinality_slack', weight: 1 });
  model.variables.push({ name: 's1', kind: 'cardinality_slack', weight: 2 });

  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) {
      addQuadratic(model, `x${i}`, `x${j}`, pairPenalty(pool[i], pool[j], config));
    }
  }

  const lambda = n(q.cardinality_penalty, 2.5);
  const K = maxSelected;
  // lambda * (sum(x_i) + s0 + 2*s1 - K)^2
  for (let i = 0; i < pool.length; i += 1) addLinear(model, `x${i}`, lambda * (1 - 2 * K));
  addLinear(model, 's0', lambda * (1 - 2 * K));
  addLinear(model, 's1', lambda * (4 - 4 * K));
  for (let i = 0; i < pool.length; i += 1) {
    for (let j = i + 1; j < pool.length; j += 1) addQuadratic(model, `x${i}`, `x${j}`, 2 * lambda);
    addQuadratic(model, `x${i}`, 's0', 2 * lambda);
    addQuadratic(model, `x${i}`, 's1', 4 * lambda);
  }
  addQuadratic(model, 's0', 's1', 4 * lambda);
  model.offset = round(lambda * K * K, 12);

  const coeffs = [...Object.values(model.linear), ...Object.values(model.quadratic)];
  const maxAbs = Math.max(1e-12, ...coeffs.map((x) => Math.abs(x)));
  const target = Math.max(1e-9, n(q.normalize_max_abs, 1));
  const scale = target / maxAbs;
  model.normalization_scale = round(scale, 12);
  model.normalized_linear = Object.fromEntries(Object.entries(model.linear).map(([k, v]) => [k, round(v * scale, 12)]));
  model.normalized_quadratic = Object.fromEntries(Object.entries(model.quadratic).map(([k, v]) => [k, round(v * scale, 12)]));
  model.normalized_offset = round(model.offset * scale, 12);
  model.metadata.coefficient_count = Object.keys(model.linear).length + Object.keys(model.quadratic).length;
  model.metadata.hardware_ready = true;
  return { model, pool };
}

function energy(model, bits) {
  let value = n(model.normalized_offset);
  for (const [name, coefficient] of Object.entries(model.normalized_linear)) value += coefficient * (bits[name] || 0);
  for (const [key, coefficient] of Object.entries(model.normalized_quadratic)) {
    const [a, b] = key.split('|');
    value += coefficient * (bits[a] || 0) * (bits[b] || 0);
  }
  return value;
}

function solveHardwareReadyQubo(candidates = [], config = CONFIG) {
  const { model, pool } = buildHardwareQubo(candidates, config);
  const names = model.variables.map((v) => v.name);
  if (names.length > 20) throw new Error(`QUBO_V5 exact local solver variable limit exceeded: ${names.length}`);
  let bestBits = null;
  let bestEnergy = Infinity;
  const states = 2 ** names.length;
  for (let mask = 0; mask < states; mask += 1) {
    const bits = {};
    for (let i = 0; i < names.length; i += 1) bits[names[i]] = (mask >> i) & 1;
    const e = energy(model, bits);
    if (e < bestEnergy - 1e-12) {
      bestEnergy = e;
      bestBits = bits;
    }
  }
  const selected = pool.filter((_, i) => bestBits && bestBits[`x${i}`] === 1);
  const maxSelected = n(config.qubo?.max_selected, 3);
  if (selected.length > maxSelected) throw new Error('QUBO_V5 cardinality constraint violated');
  return {
    method: METHOD,
    model_version: config.model_version,
    hardware_schema: HARDWARE_SCHEMA,
    hardware_ready: true,
    solver: 'LOCAL_EXACT_BINARY_ENUMERATION',
    objective: portfolioObjective(selected, config),
    energy: round(bestEnergy, 10),
    selected,
    model_stats: {
      candidate_variables: pool.length,
      total_binary_variables: names.length,
      coefficient_count: model.metadata.coefficient_count,
      normalization_scale: model.normalization_scale,
      max_selected: maxSelected
    }
  };
}

module.exports = {
  CONFIG,
  METHOD,
  HARDWARE_SCHEMA,
  baseUtility,
  productionUtility,
  correlation,
  pairPenalty,
  portfolioObjective,
  buildHardwareQubo,
  solveHardwareReadyQubo
};
