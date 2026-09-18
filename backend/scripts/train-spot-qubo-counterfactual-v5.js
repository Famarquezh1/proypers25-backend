'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_CONFIG = require('../config/spot-qubo-production-v5.json');
const MAX_SIGNALS = Math.max(40, Math.min(200, Number(process.env.QUBO_CF_MAX_SIGNALS || 160)));
const HORIZON_HOURS = Math.max(3, Math.min(24, Number(process.env.QUBO_CF_HORIZON_HOURS || 6)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.QUBO_CF_CONCURRENCY || 5)));
const MIN_SAMPLES = Math.max(16, Math.min(80, Number(process.env.QUBO_CF_MIN_SAMPLES || 24)));
const OUTPUT = process.env.QUBO_CF_OUTPUT || path.join(process.cwd(), 'spot-qubo-adaptive-v5.json');
const EVIDENCE_OUTPUT = process.env.QUBO_CF_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-qubo-counterfactual-evidence.json');

function n(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n(value, 0)));
}
function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(n(value, 0) * factor) / factor;
}
function normalizedLog(value, floor = 200000, ceiling = 150000000) {
  const v = n(value, 0);
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}
function baseUtility(row = {}) {
  const pct = n(row.pct, 0);
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(row.qv);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15;
}
function parseNumber(body, regex) {
  const match = String(body || '').match(regex);
  return match ? n(match[1]) : NaN;
}
function parseSignal(issue = {}) {
  const body = String(issue.body || '');
  if (!/V4\.2/i.test(body) || !/QUBO/i.test(body) || /V10_HUNTER/i.test(body)) return null;
  const symbol = (body.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi) || [])[1];
  const price = parseNumber(body, /^- Precio:\s*([0-9.eE+-]+)/mi);
  const pct = parseNumber(body, /^- Cambio 24h:\s*\+?([0-9.-]+)%/mi);
  const qv = parseNumber(body, /^- Volumen quote 24h:\s*([0-9.eE+-]+)/mi);
  const utility = parseNumber(body, /^- Utility:\s*([0-9.eE+-]+)/mi);
  const v42Norm = parseNumber(body, /^- V4\.2 robustez:\s*\d+\/3 ventanas \| score:\s*([0-9.eE+-]+)/mi);
  const directBase = parseNumber(body, /^- QUBO features:.*base=([0-9.eE+-]+)/mi);
  const directStable = parseNumber(body, /^- QUBO features:.*stable=([0-9.eE+-]+)/mi);
  const qmethod = (body.match(/^- QUBO:\s*(.+)$/mi) || [])[1] || '';
  if (!symbol || !(price > 0) || !Number.isFinite(pct) || !(qv > 0) || !Number.isFinite(utility) || !Number.isFinite(v42Norm)) return null;
  const base = Number.isFinite(directBase) ? clamp(directBase) : clamp(baseUtility({ pct, qv }));
  let stable = Number.isFinite(directStable) ? clamp(directStable) : NaN;
  if (!Number.isFinite(stable)) {
    const weights = /V5/i.test(qmethod)
      ? { base: 0.55, stable: 0.05, v42: 0.40 }
      : { base: 0.40, stable: 0.15, v42: 0.45 };
    stable = weights.stable > 0
      ? clamp((utility - weights.base * base - weights.v42 * v42Norm) / weights.stable)
      : 0.5;
  }
  return {
    issue_number: issue.number,
    created_at: issue.created_at,
    symbol,
    price,
    pct,
    qv,
    utility,
    base,
    stable,
    v42: clamp(v42Norm),
    qubo_method: qmethod
  };
}
function classifyDecision(comments = []) {
  const text = comments.map((comment) => String(comment.body || '')).join('\n');
  if (/ejecut[oó] la compra Spot|compra Spot.*orderId|protecci[oó]n nativa fue armada/i.test(text)) return 'EXECUTED';
  if (/Oportunidad descartada autom[aá]ticamente|No se compr[oó]|SIGNAL_DECLINED/i.test(text)) return 'DECLINED';
  if (/problema t[eé]cnico|No asumir compra/i.test(text)) return 'TECHNICAL';
  return 'UNKNOWN';
}
function firstTouchOutcome(bars, entry, tpPct = 0.03, slPct = 0.05) {
  const tp = entry * (1 + tpPct);
  const sl = entry * (1 - slPct);
  for (const bar of bars) {
    const high = n(bar[2]);
    const low = n(bar[3]);
    if (!(high > 0) || !(low > 0)) continue;
    if (low <= sl && high >= tp) return 'LOSS'; // conservative same-candle ordering
    if (low <= sl) return 'LOSS';
    if (high >= tp) return 'WIN';
  }
  return 'NONE';
}
function outcomeMetrics(bars, entry) {
  if (!Array.isArray(bars) || !bars.length || !(entry > 0)) return null;
  let high = entry;
  let low = entry;
  let close = entry;
  for (const bar of bars) {
    high = Math.max(high, n(bar[2], high));
    low = Math.min(low, n(bar[3], low));
    close = n(bar[4], close);
  }
  const retPct = (close / entry - 1) * 100;
  const mfePct = (high / entry - 1) * 100;
  const maePct = (low / entry - 1) * 100;
  const targetPct = 0.45 * retPct + 0.40 * mfePct + 0.15 * maePct;
  return {
    return_pct: round(retPct, 4),
    mfe_pct: round(mfePct, 4),
    mae_pct: round(maePct, 4),
    target_pct: round(targetPct, 4),
    first_touch_3pct_vs_5pct: firstTouchOutcome(bars, entry)
  };
}
function ranks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const rank = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) out[sorted[k].i] = rank;
    i = j;
  }
  return out;
}
function correlation(a, b) {
  if (a.length !== b.length || a.length < 3) return 0;
  const ma = a.reduce((s, x) => s + x, 0) / a.length;
  const mb = b.reduce((s, x) => s + x, 0) / b.length;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < a.length; i += 1) {
    const xa = a[i] - ma;
    const xb = b[i] - mb;
    num += xa * xb;
    da += xa * xa;
    db += xb * xb;
  }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : 0;
}
function spearman(rows, weights) {
  if (!rows.length) return 0;
  const scores = rows.map((row) => row.base * weights.base + row.stable * weights.stable + row.v42 * weights.v42);
  const targets = rows.map((row) => row.target_pct);
  return correlation(ranks(scores), ranks(targets));
}
function weightGrid() {
  const rows = [];
  for (let base = 0.30; base <= 0.700001; base += 0.05) {
    for (let stable = 0.05; stable <= 0.300001; stable += 0.05) {
      const v42 = Number((1 - base - stable).toFixed(2));
      if (v42 < 0.20 || v42 > 0.65) continue;
      rows.push({ base: Number(base.toFixed(2)), stable: Number(stable.toFixed(2)), v42 });
    }
  }
  return rows;
}
function trainAdaptiveWeights(rows, current = BASE_CONFIG.weights) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  if (ordered.length < MIN_SAMPLES) {
    return {
      promoted: false,
      reason: 'INSUFFICIENT_MATURE_COUNTERFACTUAL_SAMPLES',
      weights: current,
      samples: ordered.length,
      train_samples: 0,
      holdout_samples: 0,
      current_holdout_spearman: 0,
      candidate_holdout_spearman: 0
    };
  }
  const split = Math.max(12, Math.min(ordered.length - 6, Math.floor(ordered.length * 0.70)));
  const train = ordered.slice(0, split);
  const holdout = ordered.slice(split);
  const regularization = 0.12;
  let best = { weights: current, objective: -Infinity, train_spearman: spearman(train, current) };
  for (const weights of weightGrid()) {
    const rank = spearman(train, weights);
    const distance =
      (weights.base - current.base) ** 2 +
      (weights.stable - current.stable) ** 2 +
      (weights.v42 - current.v42) ** 2;
    const objective = rank - regularization * distance;
    if (objective > best.objective) best = { weights, objective, train_spearman: rank };
  }
  const currentHoldout = spearman(holdout, current);
  const candidateHoldout = spearman(holdout, best.weights);
  const promote =
    holdout.length >= 6 &&
    candidateHoldout >= currentHoldout + 0.02 &&
    candidateHoldout >= 0.05;
  return {
    promoted: promote,
    reason: promote ? 'RECENT_HOLDOUT_IMPROVED' : 'HOLDOUT_DID_NOT_JUSTIFY_WEIGHT_CHANGE',
    weights: promote ? best.weights : current,
    candidate_weights: best.weights,
    samples: ordered.length,
    train_samples: train.length,
    holdout_samples: holdout.length,
    current_train_spearman: round(spearman(train, current), 6),
    candidate_train_spearman: round(best.train_spearman, 6),
    current_holdout_spearman: round(currentHoldout, 6),
    candidate_holdout_spearman: round(candidateHoldout, 6)
  };
}
function summarizeDecisions(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  return {
    executed: count((x) => x.decision === 'EXECUTED'),
    declined: count((x) => x.decision === 'DECLINED'),
    executed_counterfactual_wins: count((x) => x.decision === 'EXECUTED' && x.first_touch_3pct_vs_5pct === 'WIN'),
    declined_missed_wins: count((x) => x.decision === 'DECLINED' && x.first_touch_3pct_vs_5pct === 'WIN'),
    declined_avoided_losses: count((x) => x.decision === 'DECLINED' && x.first_touch_3pct_vs_5pct === 'LOSS')
  };
}
async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status} ${url}: ${body.message || body.msg || body.raw || ''}`);
  return body;
}
async function githubJson(url) {
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || '';
  if (!token) throw new Error('GH_TOKEN is required');
  return fetchJson(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'proypers25-qubo-counterfactual-learning'
    }
  });
}
async function loadSignalIssues(repo) {
  const query = encodeURIComponent(`repo:${repo} is:issue in:title "[SPOT SIGNAL]"`);
  const items = [];
  for (let page = 1; page <= 4 && items.length < MAX_SIGNALS; page += 1) {
    const data = await githubJson(`https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=100&page=${page}`);
    for (const issue of data.items || []) {
      if (items.length >= MAX_SIGNALS) break;
      items.push(issue);
    }
    if (!(data.items || []).length) break;
  }
  return items;
}
async function loadDecision(repo, number) {
  const comments = await githubJson(`https://api.github.com/repos/${repo}/issues/${number}/comments?per_page=100`);
  return classifyDecision(Array.isArray(comments) ? comments : []);
}
async function loadForwardBars(signal) {
  const start = Date.parse(signal.created_at);
  const end = start + HORIZON_HOURS * 3600000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(signal.symbol)}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  return fetchJson(url, { headers: { 'User-Agent': 'proypers25-qubo-counterfactual-learning' } });
}
async function mapLimit(items, limit, mapper) {
  const out = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor++;
      if (index >= items.length) return;
      out[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return out;
}
async function buildEvidence(repo, now = Date.now()) {
  const issues = await loadSignalIssues(repo);
  const horizonMs = HORIZON_HOURS * 3600000;
  const mature = issues
    .map(parseSignal)
    .filter(Boolean)
    .filter((signal) => now - Date.parse(signal.created_at) >= horizonMs);

  const rows = await mapLimit(mature, CONCURRENCY, async (signal) => {
    try {
      const [decision, bars] = await Promise.all([
        loadDecision(repo, signal.issue_number),
        loadForwardBars(signal)
      ]);
      if (!['EXECUTED', 'DECLINED'].includes(decision)) return null;
      const outcome = outcomeMetrics(bars, signal.price);
      if (!outcome) return null;
      return { ...signal, decision, ...outcome };
    } catch (error) {
      console.warn(`COUNTERFACTUAL_SAMPLE_SKIPPED issue=${signal.issue_number} symbol=${signal.symbol} reason=${error.message}`);
      return null;
    }
  });
  return rows.filter(Boolean);
}
function writeResults(rows, trained) {
  const decisionSummary = summarizeDecisions(rows);
  const model = {
    model_version: `QUBO_V5_ADAPTIVE_COUNTERFACTUAL_${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 12)}`,
    mode: 'PRODUCTION',
    adaptive: true,
    adaptive_state: trained.promoted ? 'PROMOTED' : 'LEARNED_NO_WEIGHT_CHANGE',
    source_model_version: BASE_CONFIG.model_version,
    trained_at: new Date().toISOString(),
    training: {
      method: 'bounded_counterfactual_forward_outcome_holdout',
      horizon_hours: HORIZON_HOURS,
      max_signal_history: MAX_SIGNALS,
      samples: trained.samples,
      train_samples: trained.train_samples,
      holdout_samples: trained.holdout_samples,
      includes_executed: true,
      includes_declined: true,
      excludes_technical_failures: true,
      promotion_reason: trained.reason,
      current_train_spearman: trained.current_train_spearman,
      candidate_train_spearman: trained.candidate_train_spearman,
      current_holdout_spearman: trained.current_holdout_spearman,
      candidate_holdout_spearman: trained.candidate_holdout_spearman,
      candidate_weights: trained.candidate_weights || trained.weights,
      decision_summary: decisionSummary
    },
    weights: trained.weights,
    qubo: BASE_CONFIG.qubo
  };
  const evidence = {
    generated_at: new Date().toISOString(),
    horizon_hours: HORIZON_HOURS,
    bounded_history: MAX_SIGNALS,
    rows: rows.map((row) => ({
      issue_number: row.issue_number,
      created_at: row.created_at,
      symbol: row.symbol,
      decision: row.decision,
      base: round(row.base, 6),
      stable: round(row.stable, 6),
      v42: round(row.v42, 6),
      return_pct: row.return_pct,
      mfe_pct: row.mfe_pct,
      mae_pct: row.mae_pct,
      target_pct: row.target_pct,
      first_touch_3pct_vs_5pct: row.first_touch_3pct_vs_5pct
    }))
  };
  fs.writeFileSync(OUTPUT, JSON.stringify(model, null, 2));
  fs.writeFileSync(EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2));
  return { model, evidence };
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPOSITORY || '';
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required');
  const rows = await buildEvidence(repo);
  const trained = trainAdaptiveWeights(rows, BASE_CONFIG.weights);
  const { model } = writeResults(rows, trained);
  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  const outputKb = fs.statSync(OUTPUT).size / 1024;
  const evidenceKb = fs.statSync(EVIDENCE_OUTPUT).size / 1024;
  console.log(JSON.stringify({
    ok: true,
    model_version: model.model_version,
    adaptive_state: model.adaptive_state,
    samples: trained.samples,
    weights: model.weights,
    candidate_weights: trained.candidate_weights || trained.weights,
    current_holdout_spearman: trained.current_holdout_spearman,
    candidate_holdout_spearman: trained.candidate_holdout_spearman,
    decisions: model.training.decision_summary,
    bounded_history: MAX_SIGNALS,
    horizon_hours: HORIZON_HOURS,
    memory_rss_mb: round(rssMb, 2),
    model_kb: round(outputKb, 2),
    evidence_kb: round(evidenceKb, 2)
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  baseUtility,
  parseSignal,
  classifyDecision,
  firstTouchOutcome,
  outcomeMetrics,
  spearman,
  trainAdaptiveWeights,
  summarizeDecisions
};
