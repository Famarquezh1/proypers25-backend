'use strict';

const fs = require('fs');
const path = require('path');

const BASE_CONFIG = require('../config/spot-qubo-production-v5.json');
const { classifyMarketRegime } = require('../services/spotMarketRegime');
const {
  classifyDecisionDetail,
  parseExitIssue,
  outcomeMetrics,
  exitQuality
} = require('./train-spot-qubo-counterfactual-v5');

const HORIZON_HOURS = Math.max(3, Math.min(24, Number(process.env.QUBO_HISTORY_HORIZON_HOURS || 6)));
const EXIT_MATCH_HOURS = Math.max(HORIZON_HOURS, Math.min(96, Number(process.env.QUBO_HISTORY_EXIT_MATCH_HOURS || 36)));
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.QUBO_HISTORY_CONCURRENCY || 8)));
const MAX_PAGES = Math.max(10, Math.min(80, Number(process.env.QUBO_HISTORY_MAX_PAGES || 30)));
const OUTPUT = process.env.QUBO_HISTORY_OUTPUT || path.join(process.cwd(), 'spot-qubo-history-backfill-report.json');
const EVIDENCE_OUTPUT = process.env.QUBO_HISTORY_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-qubo-history-backfill-evidence.json');

function n(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n(value, 0)));
}
function round(value, digits = 6) {
  const f = 10 ** digits;
  return Math.round(n(value, 0) * f) / f;
}
function mean(values = []) {
  return values.length ? values.reduce((s, x) => s + n(x, 0), 0) / values.length : 0;
}
function normalizedLog(value, floor = 200000, ceiling = 150000000) {
  const v = n(value, 0);
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}
function baseUtility(row = {}) {
  const pct = n(row.pct, 0);
  const qv = n(row.qv, 0);
  const momentum = clamp(pct / 12);
  const liquidity = normalizedLog(qv);
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum * 0.45 + liquidity * 0.30 + freshness * 0.25 - chasePenalty * 0.15;
}
function parseNumber(body, regex) {
  const match = String(body || '').match(regex);
  return match ? n(match[1]) : NaN;
}
function parseHistoricalSignal(issue = {}) {
  const title = String(issue.title || '');
  if (!/^\[SPOT SIGNAL\]/.test(title)) return null;
  const body = String(issue.body || '');
  const symbol = (body.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi) || [])[1]
    || (title.match(/^\[SPOT SIGNAL\]\s+([^\s]+USDT)\b/i) || [])[1];
  const pct = parseNumber(body, /^- Cambio 24h:\s*\+?([0-9.-]+)%/mi);
  const titlePct = n((title.match(/\+([0-9.-]+)%/) || [])[1]);
  const price = parseNumber(body, /^- Precio:\s*([0-9.eE+-]+)/mi);
  const qv = parseNumber(body, /^- Volumen quote 24h:\s*([0-9.eE+-]+)/mi);
  const utility = parseNumber(body, /^- Utility:\s*([0-9.eE+-]+)/mi);
  const v42 = parseNumber(body, /^- V4\.2 robustez:\s*\d+\/3 ventanas \| score:\s*([0-9.eE+-]+)/mi);
  const directBase = parseNumber(body, /^- QUBO features:.*base=([0-9.eE+-]+)/mi);
  const directStable = parseNumber(body, /^- QUBO features:.*stable=([0-9.eE+-]+)/mi);
  const regime = (body.match(/^- QUBO contexto:\s*regime=([^\s|]+)/mi) || [])[1] || null;
  const method = (body.match(/^- QUBO:\s*(.+)$/mi) || [])[1] || null;

  if (!symbol || !(price > 0) || !(qv > 0) || !Number.isFinite(pct) && !Number.isFinite(titlePct)) return null;
  const p = Number.isFinite(pct) ? pct : titlePct;
  const base = Number.isFinite(directBase) ? clamp(directBase) : clamp(baseUtility({ pct: p, qv }));
  let stable = Number.isFinite(directStable) ? clamp(directStable) : NaN;
  if (!Number.isFinite(stable) && Number.isFinite(utility) && Number.isFinite(v42)) {
    const w = /V5/i.test(method || body)
      ? { base: 0.55, stable: 0.05, v42: 0.40 }
      : { base: 0.40, stable: 0.15, v42: 0.45 };
    if (w.stable > 0) stable = clamp((utility - w.base * base - w.v42 * v42) / w.stable);
  }

  return {
    issue_number: Number(issue.number),
    created_at: issue.created_at,
    symbol: String(symbol).toUpperCase(),
    price,
    pct: p,
    qv,
    utility: Number.isFinite(utility) ? utility : null,
    base,
    stable: Number.isFinite(stable) ? stable : null,
    v42: Number.isFinite(v42) ? clamp(v42) : null,
    market_regime_recorded: regime ? String(regime).toUpperCase() : null,
    qubo_method: method,
    feature_complete: Number.isFinite(stable) && Number.isFinite(v42)
  };
}
function dedupeExits(exits = []) {
  const seen = new Set();
  const out = [];
  for (const exit of [...exits].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const key = exit.order_id || exit.orderId || [
      exit.symbol,
      exit.reason,
      exit.entry_price,
      exit.exit_price,
      exit.pnl_pct,
      exit.created_at
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(exit);
  }
  return out;
}
function parseExitWithOrder(issue = {}) {
  const exit = parseExitIssue(issue);
  if (!exit) return null;
  const body = String(issue.body || '');
  return {
    ...exit,
    order_id: (body.match(/orderId=([0-9]+)/i) || [])[1] || null
  };
}
function matchActualExit(signal, exits = []) {
  const start = Date.parse(signal.created_at);
  const end = start + EXIT_MATCH_HOURS * 3600000;
  return exits
    .filter((x) => x.symbol === signal.symbol)
    .filter((x) => {
      const t = Date.parse(x.created_at);
      return t >= start && t <= end;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] || null;
}
function pctBucket(pct) {
  const v = n(pct, 0);
  if (v < 4) return 'P01_04';
  if (v < 7) return 'P04_07';
  if (v < 10) return 'P07_10';
  if (v < 13) return 'P10_13';
  return 'P13_PLUS';
}
function liquidityBucket(qv) {
  const v = n(qv, 0);
  if (v < 1000000) return 'L0_1M';
  if (v < 5000000) return 'L1_5M';
  if (v < 20000000) return 'L5_20M';
  return 'L20M_PLUS';
}
function historyCellKey(row = {}) {
  return [String(row.market_regime || 'UNKNOWN').toUpperCase(), pctBucket(row.pct), liquidityBucket(row.qv)].join('|');
}
function ranks(values) {
  const sorted = values.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v);
  const out = new Array(values.length);
  for (let i = 0; i < sorted.length;) {
    let j = i + 1;
    while (j < sorted.length && sorted[j].v === sorted[i].v) j += 1;
    const r = (i + 1 + j) / 2;
    for (let k = i; k < j; k += 1) out[sorted[k].i] = r;
    i = j;
  }
  return out;
}
function correlation(a, b) {
  if (a.length !== b.length || a.length < 3) return 0;
  const ma = mean(a), mb = mean(b);
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
function spearman(scores, targets) {
  return correlation(ranks(scores), ranks(targets));
}
function weightGrid() {
  const out = [];
  for (let base = 0.25; base <= 0.700001; base += 0.05) {
    for (let stable = 0.05; stable <= 0.300001; stable += 0.05) {
      const v42 = Number((1 - base - stable).toFixed(2));
      if (v42 < 0.20 || v42 > 0.70) continue;
      out.push({ base: round(base, 2), stable: round(stable, 2), v42 });
    }
  }
  return out;
}
function coreScore(row, weights) {
  if (!row.feature_complete) return row.base;
  return row.base * weights.base + row.stable * weights.stable + row.v42 * weights.v42;
}
function trainHistoryPrior(rows = []) {
  const global = mean(rows.map((x) => x.target_pct));
  const rawCells = new Map();
  const rawRegimes = new Map();

  function add(map, key, target) {
    const item = map.get(key) || { samples: 0, sum: 0 };
    item.samples += 1;
    item.sum += n(target, 0);
    map.set(key, item);
  }

  for (const row of rows) {
    add(rawCells, historyCellKey(row), row.target_pct);
    add(rawRegimes, String(row.market_regime || 'UNKNOWN').toUpperCase(), row.target_pct);
  }

  const alphaCell = 8;
  const alphaRegime = 16;
  const cells = {};
  const regimes = {};
  const diffs = [];

  for (const [key, item] of rawCells.entries()) {
    const shrunk = (item.sum + alphaCell * global) / (item.samples + alphaCell);
    const diff = shrunk - global;
    diffs.push(Math.abs(diff));
    cells[key] = { samples: item.samples, mean_target_pct: round(item.sum / item.samples, 4), shrunk_target_pct: round(shrunk, 4), diff };
  }
  for (const [key, item] of rawRegimes.entries()) {
    const shrunk = (item.sum + alphaRegime * global) / (item.samples + alphaRegime);
    const diff = shrunk - global;
    diffs.push(Math.abs(diff));
    regimes[key] = { samples: item.samples, mean_target_pct: round(item.sum / item.samples, 4), shrunk_target_pct: round(shrunk, 4), diff };
  }

  const scale = Math.max(0.25, ...diffs);
  for (const item of Object.values(cells)) {
    item.edge = round(clamp(item.diff / scale, -1, 1), 6);
    delete item.diff;
  }
  for (const item of Object.values(regimes)) {
    item.edge = round(clamp(item.diff / scale, -1, 1), 6);
    delete item.diff;
  }

  return {
    version: 'HISTORY_PRIOR_V1',
    global_target_pct: round(global, 6),
    normalization_scale_pct: round(scale, 6),
    min_cell_samples: 4,
    cells,
    regimes
  };
}
function historyEdge(row, prior) {
  const cell = prior?.cells?.[historyCellKey(row)];
  if (cell && Number(cell.samples) >= Number(prior.min_cell_samples || 4)) return n(cell.edge, 0);
  const regime = prior?.regimes?.[String(row.market_regime || 'UNKNOWN').toUpperCase()];
  return regime ? n(regime.edge, 0) : 0;
}
function scoreWithModel(row, model) {
  return coreScore(row, model.weights) + n(model.history_strength, 0) * historyEdge(row, model.history_prior);
}
function trainHistoricalModel(trainRows, currentWeights = BASE_CONFIG.weights) {
  const prior = trainHistoryPrior(trainRows);
  const complete = trainRows.filter((x) => x.feature_complete);
  const targetsAll = trainRows.map((x) => x.target_pct);
  const grid = weightGrid();
  const strengths = [0, 0.02, 0.04, 0.06, 0.08, 0.10];
  let best = null;

  for (const weights of grid) {
    for (const strength of strengths) {
      const scores = trainRows.map((row) => coreScore(row, weights) + strength * historyEdge(row, prior));
      const rank = spearman(scores, targetsAll);
      const distance =
        (weights.base - currentWeights.base) ** 2 +
        (weights.stable - currentWeights.stable) ** 2 +
        (weights.v42 - currentWeights.v42) ** 2;
      const objective = rank - 0.08 * distance - 0.05 * strength;
      if (!best || objective > best.objective) {
        best = { weights, history_strength: strength, history_prior: prior, train_spearman: rank, objective };
      }
    }
  }

  return {
    ...best,
    train_samples: trainRows.length,
    complete_feature_train_samples: complete.length
  };
}
function topSlice(rows, scores, fraction = 0.25) {
  const count = Math.max(1, Math.floor(rows.length * fraction));
  return rows
    .map((row, i) => ({ row, score: scores[i] }))
    .sort((a, b) => b.score - a.score)
    .slice(0, count)
    .map((x) => x.row);
}
function evaluateHistoricalModel(holdoutRows, candidate, baselineWeights = BASE_CONFIG.weights) {
  const baselineScores = holdoutRows.map((row) => coreScore(row, baselineWeights));
  const candidateScores = holdoutRows.map((row) => scoreWithModel(row, candidate));
  const targets = holdoutRows.map((row) => row.target_pct);
  const baselineTop = topSlice(holdoutRows, baselineScores);
  const candidateTop = topSlice(holdoutRows, candidateScores);
  const winRate = (rows) => rows.length ? rows.filter((x) => x.first_touch_3pct_vs_5pct === 'WIN').length / rows.length : 0;
  const exitPnl = (rows) => {
    const values = rows.map((x) => x.exit_quality?.actual_pnl_pct).filter(Number.isFinite);
    return values.length ? mean(values) : null;
  };

  const baselineSpearman = spearman(baselineScores, targets);
  const candidateSpearman = spearman(candidateScores, targets);
  const baselineTopMean = mean(baselineTop.map((x) => x.target_pct));
  const candidateTopMean = mean(candidateTop.map((x) => x.target_pct));
  const baselineWin = winRate(baselineTop);
  const candidateWin = winRate(candidateTop);
  const baselineExitPnl = exitPnl(baselineTop);
  const candidateExitPnl = exitPnl(candidateTop);

  const passes =
    holdoutRows.length >= 40 &&
    candidateSpearman >= baselineSpearman + 0.015 &&
    candidateTopMean >= baselineTopMean + 0.10 &&
    candidateWin >= baselineWin - 0.03;

  return {
    holdout_samples: holdoutRows.length,
    baseline_spearman: round(baselineSpearman, 6),
    candidate_spearman: round(candidateSpearman, 6),
    spearman_delta: round(candidateSpearman - baselineSpearman, 6),
    baseline_top_quartile_target_pct: round(baselineTopMean, 4),
    candidate_top_quartile_target_pct: round(candidateTopMean, 4),
    top_quartile_target_delta_pct: round(candidateTopMean - baselineTopMean, 4),
    baseline_top_quartile_win_rate: round(baselineWin, 4),
    candidate_top_quartile_win_rate: round(candidateWin, 4),
    top_quartile_win_rate_delta: round(candidateWin - baselineWin, 4),
    baseline_top_quartile_actual_exit_pnl_pct: baselineExitPnl === null ? null : round(baselineExitPnl, 4),
    candidate_top_quartile_actual_exit_pnl_pct: candidateExitPnl === null ? null : round(candidateExitPnl, 4),
    passed_for_production: passes
  };
}
function summarizeExitHistory(exits = []) {
  const values = exits.map((x) => x.pnl_pct).filter(Number.isFinite);
  const positive = values.filter((x) => x > 0).length;
  const negative = values.filter((x) => x < 0).length;
  const flat = values.length - positive - negative;
  const reasonMap = new Map();
  for (const exit of exits) {
    const key = exit.reason || 'UNKNOWN_EXIT';
    const item = reasonMap.get(key) || { reason: key, count: 0, pnl_sum: 0 };
    item.count += 1;
    item.pnl_sum += n(exit.pnl_pct, 0);
    reasonMap.set(key, item);
  }
  return {
    unique_exit_orders: values.length,
    positive,
    negative,
    flat,
    positive_rate: values.length ? round(positive / values.length, 4) : 0,
    mean_pnl_pct: values.length ? round(mean(values), 4) : 0,
    sum_pnl_pct_unweighted: values.length ? round(values.reduce((s, x) => s + x, 0), 4) : 0,
    reasons: [...reasonMap.values()]
      .map((x) => ({ reason: x.reason, count: x.count, mean_pnl_pct: round(x.pnl_sum / x.count, 4) }))
      .sort((a, b) => b.count - a.count)
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
      'User-Agent': 'proypers25-qubo-full-history'
    }
  });
}
async function fetchPaged(urlBuilder) {
  const out = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const rows = await githubJson(urlBuilder(page));
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    if (rows.length < 100) break;
  }
  return out;
}
async function loadRepositoryHistory(repo) {
  const [rawIssues, comments] = await Promise.all([
    fetchPaged((page) => `https://api.github.com/repos/${repo}/issues?state=all&per_page=100&page=${page}&sort=created&direction=asc`),
    fetchPaged((page) => `https://api.github.com/repos/${repo}/issues/comments?per_page=100&page=${page}&sort=created&direction=asc`)
  ]);
  const issues = rawIssues.filter((x) => !x.pull_request);
  const commentsByIssue = new Map();
  for (const comment of comments) {
    const number = Number(String(comment.issue_url || '').split('/').pop());
    if (!Number.isFinite(number)) continue;
    const list = commentsByIssue.get(number) || [];
    list.push(comment);
    commentsByIssue.set(number, list);
  }
  return { issues, comments, commentsByIssue };
}
async function loadForwardBars(signal) {
  const start = Date.parse(signal.created_at);
  const end = start + HORIZON_HOURS * 3600000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(signal.symbol)}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  return fetchJson(url, { headers: { 'User-Agent': 'proypers25-qubo-full-history' } });
}
async function loadBtcHistory(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const step = 5 * 60 * 1000;
  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson(url, { headers: { 'User-Agent': 'proypers25-qubo-full-history' } });
    if (!Array.isArray(rows) || !rows.length) break;
    out.push(...rows);
    const last = n(rows[rows.length - 1][0], cursor);
    const next = last + step;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
  }
  return out;
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
async function buildFullHistoryEvidence(repo, now = Date.now()) {
  const { issues, comments, commentsByIssue } = await loadRepositoryHistory(repo);
  const signals = issues.map(parseHistoricalSignal).filter(Boolean);
  const exits = dedupeExits(issues.map(parseExitWithOrder).filter(Boolean));
  const mature = signals.filter((x) => now - Date.parse(x.created_at) >= HORIZON_HOURS * 3600000);
  if (!mature.length) return { rows: [], exits, issues, comments, signals };

  const btcBars = await loadBtcHistory(
    Math.min(...mature.map((x) => Date.parse(x.created_at))) - 24 * 3600000,
    Math.max(...mature.map((x) => Date.parse(x.created_at))) + 5 * 60 * 1000
  );

  const rows = await mapLimit(mature, CONCURRENCY, async (signal) => {
    try {
      const bars = await loadForwardBars(signal);
      const outcome = outcomeMetrics(bars, signal.price);
      if (!outcome) return null;
      const decision = classifyDecisionDetail(commentsByIssue.get(signal.issue_number) || []);
      const regime = signal.market_regime_recorded
        ? { regime: signal.market_regime_recorded, source: 'RECORDED' }
        : { ...classifyMarketRegime(btcBars, Date.parse(signal.created_at)), source: 'RECONSTRUCTED' };
      const actualExit = decision.decision === 'EXECUTED' ? matchActualExit(signal, exits) : null;
      return {
        ...signal,
        decision: decision.decision,
        decision_reason: decision.reason,
        entry_order_id: decision.order_id,
        market_regime: regime.regime || 'UNKNOWN',
        market_regime_source: regime.source,
        return_pct: outcome.return_pct,
        mfe_pct: outcome.mfe_pct,
        mae_pct: outcome.mae_pct,
        target_pct: outcome.target_pct,
        first_touch_3pct_vs_5pct: outcome.first_touch_3pct_vs_5pct,
        actual_exit: actualExit,
        exit_quality: exitQuality(actualExit, outcome)
      };
    } catch (error) {
      console.warn(`HISTORY_SAMPLE_SKIPPED issue=${signal.issue_number} symbol=${signal.symbol} reason=${error.message}`);
      return null;
    }
  });

  return { rows: rows.filter(Boolean), exits, issues, comments, signals };
}
function chronologicalSplit(rows, trainFraction = 0.75) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const minHoldout = Math.min(50, Math.max(20, Math.floor(ordered.length * 0.20)));
  const split = Math.max(1, Math.min(ordered.length - minHoldout, Math.floor(ordered.length * trainFraction)));
  return { train: ordered.slice(0, split), holdout: ordered.slice(split) };
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPOSITORY || '';
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required');

  const history = await buildFullHistoryEvidence(repo);
  if (history.rows.length < 60) throw new Error(`Insufficient historical rows: ${history.rows.length}`);

  const { train, holdout } = chronologicalSplit(history.rows);
  const learned = trainHistoricalModel(train, BASE_CONFIG.weights);
  const evaluation = evaluateHistoricalModel(holdout, learned, BASE_CONFIG.weights);
  const exitHistory = summarizeExitHistory(history.exits);

  const report = {
    ok: true,
    version: 'QUBO_V5_FULL_HISTORY_BACKFILL_2026_09_18',
    generated_at: new Date().toISOString(),
    source: 'GITHUB_SIGNAL_EXIT_HISTORY_PLUS_BINANCE_PUBLIC_KLINES',
    repository_issues_scanned: history.issues.length,
    repository_comments_scanned: history.comments.length,
    spot_signals_found: history.signals.length,
    mature_rows_reconstructed: history.rows.length,
    complete_feature_rows: history.rows.filter((x) => x.feature_complete).length,
    train_rows: train.length,
    holdout_rows: holdout.length,
    learned_model: {
      weights: learned.weights,
      history_strength: learned.history_strength,
      train_spearman: round(learned.train_spearman, 6),
      complete_feature_train_samples: learned.complete_feature_train_samples,
      history_prior: learned.history_prior
    },
    evaluation,
    exit_history: exitHistory,
    promotion_recommendation: evaluation.passed_for_production ? 'PROMOTE' : 'KEEP_CURRENT'
  };

  const evidence = {
    generated_at: report.generated_at,
    rows: history.rows.map((x) => ({
      issue_number: x.issue_number,
      created_at: x.created_at,
      symbol: x.symbol,
      decision: x.decision,
      decision_reason: x.decision_reason,
      feature_complete: x.feature_complete,
      base: round(x.base, 6),
      stable: x.stable === null ? null : round(x.stable, 6),
      v42: x.v42 === null ? null : round(x.v42, 6),
      pct: round(x.pct, 4),
      quote_volume: round(x.qv, 2),
      market_regime: x.market_regime,
      return_pct: x.return_pct,
      mfe_pct: x.mfe_pct,
      mae_pct: x.mae_pct,
      target_pct: x.target_pct,
      first_touch_3pct_vs_5pct: x.first_touch_3pct_vs_5pct,
      exit_quality: x.exit_quality
    }))
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2));

  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(JSON.stringify({
    ok: true,
    version: report.version,
    signals: report.spot_signals_found,
    reconstructed: report.mature_rows_reconstructed,
    complete_features: report.complete_feature_rows,
    train: report.train_rows,
    holdout: report.holdout_rows,
    learned_weights: report.learned_model.weights,
    history_strength: report.learned_model.history_strength,
    train_spearman: report.learned_model.train_spearman,
    evaluation: report.evaluation,
    exits: report.exit_history,
    promotion_recommendation: report.promotion_recommendation,
    memory_rss_mb: round(rssMb, 2),
    report_kb: round(fs.statSync(OUTPUT).size / 1024, 2),
    evidence_kb: round(fs.statSync(EVIDENCE_OUTPUT).size / 1024, 2)
  }));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.stack || error.message || String(error));
    process.exit(1);
  });
}

module.exports = {
  parseHistoricalSignal,
  dedupeExits,
  pctBucket,
  liquidityBucket,
  historyCellKey,
  trainHistoryPrior,
  historyEdge,
  trainHistoricalModel,
  evaluateHistoricalModel,
  chronologicalSplit,
  summarizeExitHistory
};
