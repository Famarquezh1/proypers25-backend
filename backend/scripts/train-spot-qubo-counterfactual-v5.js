'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const BASE_CONFIG = require('../config/spot-qubo-production-v5.json');
const { classifyMarketRegime } = require('../services/spotMarketRegime');
const MAX_SIGNALS = Math.max(40, Math.min(200, Number(process.env.QUBO_CF_MAX_SIGNALS || 160)));
const HORIZON_HOURS = Math.max(3, Math.min(24, Number(process.env.QUBO_CF_HORIZON_HOURS || 6)));
const CONCURRENCY = Math.max(1, Math.min(8, Number(process.env.QUBO_CF_CONCURRENCY || 5)));
const MIN_SAMPLES = Math.max(16, Math.min(80, Number(process.env.QUBO_CF_MIN_SAMPLES || 24)));
const EXIT_MATCH_HOURS = Math.max(HORIZON_HOURS, Math.min(72, Number(process.env.QUBO_CF_EXIT_MATCH_HOURS || 24)));
const REGIME_MIN_SAMPLES = Math.max(12, Math.min(40, Number(process.env.QUBO_CF_REGIME_MIN_SAMPLES || 18)));
const OUTPUT = process.env.QUBO_CF_OUTPUT || path.join(process.cwd(), 'spot-qubo-adaptive-v5.json');
const EVIDENCE_OUTPUT = process.env.QUBO_CF_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-qubo-counterfactual-evidence.json');
const PREAPPROVAL_LEDGER = process.env.QUBO_PREAPPROVAL_LEDGER || '';
const MAX_PREAPPROVAL_SAMPLES = Math.max(0, Math.min(100, Number(process.env.QUBO_CF_MAX_PREAPPROVAL_SAMPLES || 60)));

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
    qubo_method: qmethod,
    sample_source: 'SPOT_SIGNAL_ISSUE'
  };
}

function parsePreapprovalRejection(row = {}) {
  const symbol = String(row.symbol || '').toUpperCase();
  const price = n(row.price);
  const pct = n(row.pct, 0);
  const qv = n(row.qv, 0);
  const createdAt = String(row.observed_at || row.created_at || '');
  if (!symbol.endsWith('USDT') || !(price > 0) || !createdAt || !Number.isFinite(Date.parse(createdAt))) return null;
  return {
    issue_number: null,
    created_at: createdAt,
    symbol,
    price,
    pct,
    qv,
    utility: n(row.utility, 0),
    base: clamp(row.base),
    stable: clamp(row.stable),
    v42: clamp(row.v42),
    qubo_method: 'RADAR_PRE_APPROVAL_COUNTERFACTUAL',
    sample_source: 'RADAR_PRE_APPROVAL',
    preapproval_stage: String(row.stage || 'PRE_APPROVAL'),
    preapproval_reasons: Array.isArray(row.reasons) ? row.reasons.map((value) => String(value || '')).filter(Boolean) : []
  };
}

function loadPreapprovalLedger() {
  if (!PREAPPROVAL_LEDGER || MAX_PREAPPROVAL_SAMPLES <= 0 || !fs.existsSync(PREAPPROVAL_LEDGER)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(PREAPPROVAL_LEDGER, 'utf8'));
    return (Array.isArray(parsed?.rows) ? parsed.rows : [])
      .map(parsePreapprovalRejection)
      .filter(Boolean)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
      .slice(0, MAX_PREAPPROVAL_SAMPLES);
  } catch (error) {
    console.warn(`PREAPPROVAL_LEDGER_UNAVAILABLE reason=${error.message || error}`);
    return [];
  }
}

function classifyDecisionDetail(comments = []) {
  const text = comments.map((comment) => String(comment.body || '')).join('\n');
  const orderId = (text.match(/orderId:\s*([0-9]+)/i) || [])[1] || null;
  if (/ejecut[oó] la compra Spot|compra Spot.*orderId|protecci[oó]n nativa fue armada/i.test(text)) {
    return { decision: 'EXECUTED', reason: 'EXECUTED', order_id: orderId };
  }
  if (/Oportunidad descartada autom[aá]ticamente|No se compr[oó]|SIGNAL_DECLINED/i.test(text)) {
    const reason = (text.match(/Motivo:\s*([^\r\n]+)/i) || [])[1] || 'DECLINED_UNSPECIFIED';
    return { decision: 'DECLINED', reason: reason.trim().slice(0, 180), order_id: null };
  }
  if (/problema t[eé]cnico|No asumir compra/i.test(text)) {
    return { decision: 'TECHNICAL', reason: 'TECHNICAL_FAILURE', order_id: null };
  }
  return { decision: 'UNKNOWN', reason: 'UNKNOWN', order_id: null };
}
function classifyDecision(comments = []) {
  return classifyDecisionDetail(comments).decision;
}
function parseExitIssue(issue = {}) {
  const body = String(issue.body || '');
  const symbol = (body.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi) || [])[1];
  const reason = (body.match(/^- Motivo:\s*(.+)$/mi) || [])[1] || null;
  const entry = parseNumber(body, /^- Entrada aprox\.:\s*([0-9.eE+-]+)/mi);
  const exit = parseNumber(body, /^- Salida aprox\.:\s*([0-9.eE+-]+)/mi);
  const pnl = parseNumber(body, /^- PnL aprox\.:\s*([+-]?[0-9.]+)%/mi);
  if (!symbol || !Number.isFinite(pnl)) return null;
  return { issue_number: issue.number, created_at: issue.created_at, symbol, reason, entry_price: entry, exit_price: exit, pnl_pct: pnl };
}

function matchActualExit(signal, exits = []) {
  const start = Date.parse(signal.created_at);
  const end = start + EXIT_MATCH_HOURS * 3600000;
  return exits
    .filter((exit) => exit.symbol === signal.symbol)
    .filter((exit) => {
      const t = Date.parse(exit.created_at);
      return t >= start && t <= end;
    })
    .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0] || null;
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
function exitQuality(actualExit, outcome) {
  if (!actualExit || !outcome) return null;
  const capture = outcome.mfe_pct > 0.05 ? actualExit.pnl_pct / outcome.mfe_pct : null;
  return {
    reason: actualExit.reason || 'UNKNOWN_EXIT',
    actual_pnl_pct: round(actualExit.pnl_pct, 4),
    capture_ratio: capture === null ? null : round(Math.max(-2, Math.min(2, capture)), 4),
    regret_vs_mfe_pct: round(outcome.mfe_pct - actualExit.pnl_pct, 4)
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
function trainRegimeWeights(rows, globalWeights) {
  const out = {};
  const regimes = [...new Set(rows.map((row) => row.market_regime).filter((x) => x && x !== 'UNKNOWN'))];
  for (const regime of regimes) {
    const subset = rows.filter((row) => row.market_regime === regime);
    if (subset.length < REGIME_MIN_SAMPLES) continue;
    const trained = trainAdaptiveWeights(subset, globalWeights);
    out[regime] = {
      samples: subset.length,
      promoted: trained.promoted,
      reason: trained.reason,
      weights: trained.promoted ? trained.weights : globalWeights,
      candidate_weights: trained.candidate_weights || globalWeights,
      current_holdout_spearman: trained.current_holdout_spearman,
      candidate_holdout_spearman: trained.candidate_holdout_spearman
    };
  }
  return out;
}

function summarizeRejectionReasons(rows) {
  const map = new Map();
  for (const row of rows.filter((x) => x.decision === 'DECLINED')) {
    const key = String(row.decision_reason || 'DECLINED_UNSPECIFIED').slice(0, 180);
    const item = map.get(key) || { reason: key, samples: 0, missed_wins: 0, avoided_losses: 0, target_sum: 0 };
    item.samples += 1;
    if (row.first_touch_3pct_vs_5pct === 'WIN') item.missed_wins += 1;
    if (row.first_touch_3pct_vs_5pct === 'LOSS') item.avoided_losses += 1;
    item.target_sum += n(row.target_pct, 0);
    map.set(key, item);
  }
  return [...map.values()]
    .map((item) => ({ ...item, mean_target_pct: round(item.target_sum / Math.max(1, item.samples), 4) }))
    .sort((a, b) => b.samples - a.samples || b.missed_wins - a.missed_wins)
    .slice(0, 20);
}

function summarizeRegimes(rows) {
  const map = new Map();
  for (const row of rows) {
    const key = row.market_regime || 'UNKNOWN';
    const item = map.get(key) || { regime: key, samples: 0, wins: 0, target_sum: 0 };
    item.samples += 1;
    if (row.first_touch_3pct_vs_5pct === 'WIN') item.wins += 1;
    item.target_sum += n(row.target_pct, 0);
    map.set(key, item);
  }
  return [...map.values()].map((item) => ({
    regime: item.regime,
    samples: item.samples,
    win_rate: round(item.wins / Math.max(1, item.samples), 4),
    mean_target_pct: round(item.target_sum / Math.max(1, item.samples), 4)
  }));
}

function summarizeDecisions(rows) {
  const count = (predicate) => rows.filter(predicate).length;
  return {
    executed: count((x) => x.decision === 'EXECUTED'),
    declined: count((x) => x.decision === 'DECLINED'),
    preapproval_declined: count((x) => x.decision === 'DECLINED' && x.sample_source === 'RADAR_PRE_APPROVAL'),
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
  return classifyDecisionDetail(Array.isArray(comments) ? comments : []);
}
async function loadExitIssues(repo) {
  const query = encodeURIComponent(`repo:${repo} is:issue in:title "[SPOT EXIT]"`);
  const items = [];
  for (let page = 1; page <= 4 && items.length < 300; page += 1) {
    const data = await githubJson(`https://api.github.com/search/issues?q=${query}&sort=created&order=desc&per_page=100&page=${page}`);
    for (const issue of data.items || []) items.push(issue);
    if (!(data.items || []).length) break;
  }
  return items.map(parseExitIssue).filter(Boolean);
}
async function loadBtcHistory(startMs, endMs) {
  const out = [];
  let cursor = startMs;
  const step = 5 * 60 * 1000;
  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const rows = await fetchJson(url, { headers: { 'User-Agent': 'proypers25-qubo-counterfactual-learning' } });
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
  const matureIssues = issues
    .map(parseSignal)
    .filter(Boolean)
    .filter((signal) => now - Date.parse(signal.created_at) >= horizonMs);
  const maturePreapproval = loadPreapprovalLedger()
    .filter((signal) => now - Date.parse(signal.created_at) >= horizonMs);
  const mature = [...matureIssues, ...maturePreapproval];

  if (!mature.length) return [];
  const [exits, btcBars] = await Promise.all([
    loadExitIssues(repo),
    loadBtcHistory(
      Math.min(...mature.map((x) => Date.parse(x.created_at))) - 24 * 3600000,
      Math.max(...mature.map((x) => Date.parse(x.created_at))) + 5 * 60 * 1000
    )
  ]);

  const rows = await mapLimit(mature, CONCURRENCY, async (signal) => {
    try {
      const decisionPromise = signal.sample_source === 'RADAR_PRE_APPROVAL'
        ? Promise.resolve({
          decision: 'DECLINED',
          reason: `PRE_APPROVAL:${signal.preapproval_stage}:${(signal.preapproval_reasons || []).join('+') || 'UNSPECIFIED'}`,
          order_id: null
        })
        : loadDecision(repo, signal.issue_number);
      const [decisionDetail, bars] = await Promise.all([
        decisionPromise,
        loadForwardBars(signal)
      ]);
      if (!['EXECUTED', 'DECLINED'].includes(decisionDetail.decision)) return null;
      const outcome = outcomeMetrics(bars, signal.price);
      if (!outcome) return null;
      const regime = classifyMarketRegime(btcBars, Date.parse(signal.created_at));
      const actualExit = decisionDetail.decision === 'EXECUTED' ? matchActualExit(signal, exits) : null;
      return {
        ...signal,
        decision: decisionDetail.decision,
        decision_reason: decisionDetail.reason,
        entry_order_id: decisionDetail.order_id,
        sample_source: signal.sample_source || 'SPOT_SIGNAL_ISSUE',
        preapproval_stage: signal.preapproval_stage || null,
        preapproval_reasons: signal.preapproval_reasons || [],
        market_regime: regime.regime,
        market_regime_detail: {
          r1h: round(regime.r1h, 6),
          r4h: round(regime.r4h, 6),
          r24h: round(regime.r24h, 6),
          vol4h: round(regime.vol4h, 6)
        },
        actual_exit: actualExit,
        exit_quality: exitQuality(actualExit, outcome),
        ...outcome
      };
    } catch (error) {
      console.warn(`COUNTERFACTUAL_SAMPLE_SKIPPED issue=${signal.issue_number} symbol=${signal.symbol} reason=${error.message}`);
      return null;
    }
  });
  return rows.filter(Boolean);
}

function writeResults(rows, trained) {
  const decisionSummary = summarizeDecisions(rows);
  const rejectionReasonStats = summarizeRejectionReasons(rows);
  const regimeStats = summarizeRegimes(rows);
  const regimeTraining = trainRegimeWeights(rows, trained.weights);
  const regimeWeights = Object.fromEntries(Object.entries(regimeTraining).filter(([, value]) => value.promoted).map(([key, value]) => [key, value.weights]));
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
      includes_preapproval_declined: true,
      max_preapproval_samples: MAX_PREAPPROVAL_SAMPLES,
      preapproval_samples: rows.filter((row) => row.sample_source === 'RADAR_PRE_APPROVAL').length,
      excludes_technical_failures: true,
      promotion_reason: trained.reason,
      current_train_spearman: trained.current_train_spearman,
      candidate_train_spearman: trained.candidate_train_spearman,
      current_holdout_spearman: trained.current_holdout_spearman,
      candidate_holdout_spearman: trained.candidate_holdout_spearman,
      candidate_weights: trained.candidate_weights || trained.weights,
      decision_summary: decisionSummary,
      rejection_reason_stats: rejectionReasonStats,
      regime_stats: regimeStats,
      regime_training: regimeTraining,
      exit_quality_samples: rows.filter((row) => row.exit_quality).length
    },
    weights: trained.weights,
    regime_weights: regimeWeights,
    qubo: BASE_CONFIG.qubo
  };
  const evidence = {
    generated_at: new Date().toISOString(),
    horizon_hours: HORIZON_HOURS,
    bounded_history: MAX_SIGNALS,
    rows: rows.map((row) => ({
      issue_number: row.issue_number,
      created_at: row.created_at,
      sample_source: row.sample_source || 'SPOT_SIGNAL_ISSUE',
      preapproval_stage: row.preapproval_stage || null,
      preapproval_reasons: row.preapproval_reasons || [],
      symbol: row.symbol,
      decision: row.decision,
      decision_reason: row.decision_reason,
      market_regime: row.market_regime,
      market_regime_detail: row.market_regime_detail,
      base: round(row.base, 6),
      stable: round(row.stable, 6),
      v42: round(row.v42, 6),
      return_pct: row.return_pct,
      mfe_pct: row.mfe_pct,
      mae_pct: row.mae_pct,
      target_pct: row.target_pct,
      first_touch_3pct_vs_5pct: row.first_touch_3pct_vs_5pct,
      actual_exit: row.actual_exit,
      exit_quality: row.exit_quality
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
    regime_weights: model.regime_weights,
    regime_stats: model.training.regime_stats,
    top_rejection_reasons: model.training.rejection_reason_stats.slice(0, 5),
    exit_quality_samples: model.training.exit_quality_samples,
    bounded_history: MAX_SIGNALS,
    max_preapproval_samples: MAX_PREAPPROVAL_SAMPLES,
    preapproval_samples: model.training.preapproval_samples,
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
  parsePreapprovalRejection,
  classifyDecision,
  classifyDecisionDetail,
  parseExitIssue,
  matchActualExit,
  exitQuality,
  firstTouchOutcome,
  outcomeMetrics,
  spearman,
  trainAdaptiveWeights,
  trainRegimeWeights,
  summarizeDecisions,
  summarizeRejectionReasons,
  summarizeRegimes
};
