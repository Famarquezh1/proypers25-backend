'use strict';

const fs = require('fs');
const path = require('path');
const PRODUCTION_EXIT_CONFIG = require('../config/spot-exit-policy-v2.json');

const HORIZON_HOURS = Math.max(12, Math.min(36, Number(process.env.EXIT_TRAIN_HORIZON_HOURS || 24)));
const CONTEXT_HOURS = Math.max(24, Math.min(36, Number(process.env.EXIT_TRAIN_CONTEXT_HOURS || 24)));
const EXIT_MATCH_HOURS = Math.max(HORIZON_HOURS, Math.min(72, Number(process.env.EXIT_TRAIN_MATCH_HOURS || 36)));
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.EXIT_TRAIN_CONCURRENCY || 8)));
const MAX_PAGES = Math.max(10, Math.min(80, Number(process.env.EXIT_TRAIN_MAX_PAGES || 30)));
const ROUND_TRIP_FEE_PCT = Math.max(0, Math.min(0.01, Number(process.env.EXIT_TRAIN_FEE_PCT || 0.002)));
const OUTPUT = process.env.EXIT_TRAIN_OUTPUT || path.join(process.cwd(), 'spot-exit-policy-training-report.json');
const EVIDENCE_OUTPUT = process.env.EXIT_TRAIN_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-exit-policy-training-evidence.json');

const CURRENT_CORE_POLICY = Object.freeze({ ...PRODUCTION_EXIT_CONFIG.core });
const CURRENT_V61_POLICY = Object.freeze({ ...PRODUCTION_EXIT_CONFIG.v61 });


function n(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function round(value, digits = 6) {
  const factor = 10 ** digits;
  return Math.round(n(value, 0) * factor) / factor;
}
function mean(values = []) {
  return values.length ? values.reduce((sum, value) => sum + n(value, 0), 0) / values.length : 0;
}
function median(values = []) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const m = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[m] : (sorted[m - 1] + sorted[m]) / 2;
}
function percentile(values = [], p = 0.5) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}
function ret(a, b) {
  return a > 0 ? b / a - 1 : 0;
}
function parseNumber(body, regex) {
  const match = String(body || '').match(regex);
  return match ? n(match[1]) : NaN;
}
function parseSignal(issue = {}) {
  const title = String(issue.title || '');
  if (!/^\[SPOT SIGNAL\]/.test(title)) return null;
  const body = String(issue.body || '');
  const symbol = (body.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi) || [])[1]
    || (title.match(/^\[SPOT SIGNAL\]\s+([^\s]+USDT)\b/i) || [])[1];
  const signalPrice = parseNumber(body, /^- Precio:\s*([0-9.eE+-]+)/mi);
  const lane = /V10_HUNTER/i.test(body) ? 'V10_HUNTER' : 'CORE';
  if (!symbol || !(signalPrice > 0)) return null;
  return {
    issue_number: Number(issue.number),
    created_at: issue.created_at,
    symbol: String(symbol).toUpperCase(),
    signal_price: signalPrice,
    lane
  };
}
function classifyDecision(comments = []) {
  const sorted = [...comments].sort((a, b) => Date.parse(a.created_at || 0) - Date.parse(b.created_at || 0));
  for (const comment of sorted) {
    const body = String(comment.body || '');
    const orderId = (body.match(/orderId:\s*([0-9]+)/i) || [])[1] || null;
    if (/ejecut[oó] la compra Spot|compra Spot.*orderId|protecci[oó]n nativa fue armada/i.test(body)) {
      return { decision: 'EXECUTED', order_id: orderId, execution_at: comment.created_at || null };
    }
  }
  const text = sorted.map((comment) => String(comment.body || '')).join('\n');
  if (/Oportunidad descartada autom[aá]ticamente|No se compr[oó]|SIGNAL_DECLINED/i.test(text)) {
    return { decision: 'DECLINED', order_id: null, execution_at: null };
  }
  return { decision: 'UNKNOWN', order_id: null, execution_at: null };
}
function parseExit(issue = {}) {
  const title = String(issue.title || '');
  if (!/^\[SPOT EXIT\]/.test(title)) return null;
  const body = String(issue.body || '');
  const symbol = (body.match(/^- Símbolo:\s*([^\s]+USDT)\s*$/mi) || [])[1];
  const entry = parseNumber(body, /^- Entrada aprox\.:\s*([0-9.eE+-]+)/mi);
  const exit = parseNumber(body, /^- Salida aprox\.:\s*([0-9.eE+-]+)/mi);
  const pnl = parseNumber(body, /^- PnL aprox\.:\s*([+-]?[0-9.]+)%/mi);
  const reason = (body.match(/^- Motivo:\s*(.+)$/mi) || [])[1] || 'UNKNOWN_EXIT';
  const orderId = (body.match(/orderId=([0-9]+)/i) || [])[1] || null;
  if (!symbol || !Number.isFinite(pnl)) return null;
  return {
    issue_number: Number(issue.number),
    created_at: issue.created_at,
    symbol: String(symbol).toUpperCase(),
    entry_price: entry,
    exit_price: exit,
    pnl_pct: pnl,
    reason,
    order_id: orderId
  };
}
function dedupeExits(exits = []) {
  const seen = new Set();
  const out = [];
  for (const exit of [...exits].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))) {
    const key = exit.order_id || [exit.symbol, exit.reason, exit.entry_price, exit.exit_price, exit.pnl_pct, exit.created_at].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(exit);
  }
  return out;
}
function oneToOneExitMatch(signals = [], exits = []) {
  const used = new Set();
  const result = new Map();
  const orderedSignals = [...signals].sort((a, b) => Date.parse(a.execution_at || a.created_at) - Date.parse(b.execution_at || b.created_at));
  for (const signal of orderedSignals) {
    const start = Date.parse(signal.execution_at || signal.created_at);
    const end = start + EXIT_MATCH_HOURS * 3600000;
    const candidate = exits
      .filter((exit) => exit.symbol === signal.symbol)
      .filter((exit) => !used.has(exit.order_id || exit.issue_number))
      .filter((exit) => {
        const t = Date.parse(exit.created_at);
        return t >= start && t <= end;
      })
      .sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at))[0];
    if (!candidate) continue;
    const key = candidate.order_id || candidate.issue_number;
    used.add(key);
    result.set(signal.issue_number, candidate);
  }
  return result;
}
function binarySearchBarIndex(bars, timeMs) {
  let lo = 0, hi = bars.length - 1, best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const t = n(bars[mid][0], -Infinity);
    if (t <= timeMs) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
}
function legacyStop(entryPrice, high, policy) {
  const mfe = high / entryPrice - 1;
  let stop = entryPrice * (1 - policy.hard_stop_pct);
  let reason = 'HARD_STOP';
  if (mfe >= policy.break_even_trigger_pct) {
    stop = Math.max(stop, entryPrice * (1 + policy.break_even_lock_pct));
    reason = 'BREAK_EVEN';
  }
  if (mfe >= policy.trailing_trigger_pct) {
    const trailing = high * (1 - policy.trailing_distance_pct);
    if (trailing > stop) {
      stop = trailing;
      reason = 'TRAILING';
    }
  }
  return { stop, reason };
}
function v61Features(bars, index, btcBars) {
  if (index < 72) return null;
  const t = n(bars[index][0]);
  const bi = binarySearchBarIndex(btcBars, t);
  if (bi < 48) return null;
  const close = (row) => n(row[4], 0);
  const high = (row) => n(row[2], 0);
  const quote = (row) => n(row[7], 0);
  const trades = (row) => n(row[8], 0);
  const c = close(bars[index]);
  const r15 = ret(close(bars[index - 3]), c);
  const r60 = ret(close(bars[index - 12]), c);
  const priorHigh60 = Math.max(...bars.slice(index - 12, index).map(high));
  const base = mean(bars.slice(index - 72, index - 12).map(quote)) * 12;
  let q30 = 0;
  for (let k = index - 5; k <= index; k += 1) q30 += quote(bars[k]);
  const vol30 = base > 0 ? q30 / (base / 2) : 1;
  const btcR60 = ret(close(btcBars[bi - 12]), close(btcBars[bi]));
  const rs60 = r60 - btcR60;
  const breakout60 = priorHigh60 > 0 ? c / priorHigh60 - 1 : 0;
  const r24 = index >= 288 ? ret(close(bars[index - 288]), c) : 0;
  const confirm = 1.2 * breakout60 + 0.65 * rs60 + 0.35 * Math.log(Math.max(0.2, vol30))
    - 0.8 * Math.max(0, r24 - 0.10) - 0.5 * Math.max(0, r60 - 0.06);
  return { price: c, r15, r60, rs60, confirm, trades: trades(bars[index]) };
}
function maybeTightenV61({ bars, index, btcBars, entryPrice, high, currentStop, policy }) {
  if (!policy?.enabled) return currentStop;
  const f = v61Features(bars, index, btcBars);
  if (!f) return currentStop;
  const pnl = f.price / entryPrice - 1;
  const mfe = high / entryPrice - 1;
  const dd = f.price / high - 1;
  const fading = mfe >= policy.mfe && dd <= policy.dd && f.r15 <= policy.r15 && f.confirm <= policy.confirm;
  const healthy = pnl > policy.healthyPnl && f.rs60 >= policy.healthyRs && f.confirm >= policy.healthyConfirm;
  if (!fading || healthy) return currentStop;
  return Math.max(currentStop || 0, f.price * (1 - policy.gap));
}
function simulateStack(row, corePolicy = CURRENT_CORE_POLICY, v61Policy = CURRENT_V61_POLICY, feePct = ROUND_TRIP_FEE_PCT) {
  const bars = row.bars;
  const btcBars = row.btc_bars || [];
  const entryPrice = row.entry_price;
  if (!Array.isArray(bars) || !bars.length || !(entryPrice > 0)) return null;
  const entryTime = Date.parse(row.execution_at || row.created_at);
  const entryIndex = Math.max(0, binarySearchBarIndex(bars, entryTime));
  let high = entryPrice;
  let v61Stop = 0;
  let exitPrice = entryPrice;
  let reason = 'HORIZON';
  let ageHours = 0;

  for (let i = Math.max(entryIndex + 1, 1); i < bars.length; i += 1) {
    const previousIndex = i - 1;
    const previousHigh = n(bars[previousIndex][2], entryPrice);
    high = Math.max(high, previousHigh);

    v61Stop = maybeTightenV61({
      bars,
      index: previousIndex,
      btcBars,
      entryPrice,
      high,
      currentStop: v61Stop,
      policy: v61Policy
    });

    const legacy = legacyStop(entryPrice, high, corePolicy);
    const effectiveStop = Math.max(legacy.stop, v61Stop || 0);
    const stopReason = v61Stop > legacy.stop + Number.EPSILON ? 'V61_TIGHTENED_STOP' : legacy.reason;

    const rowBar = bars[i];
    const highPrice = n(rowBar[2]);
    const lowPrice = n(rowBar[3]);
    const closePrice = n(rowBar[4]);
    if (!(highPrice > 0 && lowPrice > 0 && closePrice > 0)) continue;

    ageHours = (n(rowBar[0], entryTime) - entryTime) / 3600000;
    const takeProfit = n(corePolicy.take_profit_pct, 0) > 0 ? entryPrice * (1 + corePolicy.take_profit_pct) : Infinity;

    if (lowPrice <= effectiveStop && highPrice >= takeProfit) {
      exitPrice = effectiveStop;
      reason = stopReason;
      break;
    }
    if (lowPrice <= effectiveStop) {
      exitPrice = effectiveStop;
      reason = stopReason;
      break;
    }
    if (highPrice >= takeProfit) {
      exitPrice = takeProfit;
      reason = 'TAKE_PROFIT';
      break;
    }

    high = Math.max(high, highPrice);
    const gainAtClose = closePrice / entryPrice - 1;
    if (ageHours >= corePolicy.stale_timeout_hours && gainAtClose <= corePolicy.stale_max_gain_pct) {
      exitPrice = closePrice;
      reason = 'TIMEOUT_STALE';
      break;
    }
    exitPrice = closePrice;

    if (ageHours >= HORIZON_HOURS) break;
  }

  const gross = exitPrice / entryPrice - 1;
  return {
    return_pct: gross - feePct,
    gross_return_pct: gross,
    exit_price: exitPrice,
    reason,
    age_hours: round(ageHours, 3)
  };
}
function v61Grid() {
  const policies = [];
  for (const mfe of [0.008, 0.012, 0.018, 0.025]) {
    for (const dd of [-0.008, -0.012, -0.018]) {
      for (const gap of [0.004, 0.006, 0.01]) {
        for (const r15 of [-0.002, -0.001, 0]) {
          for (const confirm of [0, 0.005, 0.015]) {
            policies.push({
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
  return policies;
}
function metrics(rows, corePolicy = CURRENT_CORE_POLICY, v61Policy = CURRENT_V61_POLICY) {
  const returns = [];
  const reasons = new Map();
  for (const row of rows) {
    const result = simulateStack(row, corePolicy, v61Policy);
    if (!result) continue;
    returns.push(result.return_pct);
    reasons.set(result.reason, (reasons.get(result.reason) || 0) + 1);
  }
  const gains = returns.filter((x) => x > 0);
  const losses = returns.filter((x) => x < 0);
  const sumGain = gains.reduce((s, x) => s + x, 0);
  const sumLoss = Math.abs(losses.reduce((s, x) => s + x, 0));
  return {
    samples: returns.length,
    mean_return_pct: round(mean(returns) * 100, 4),
    median_return_pct: round(median(returns) * 100, 4),
    positive_rate: round(returns.length ? gains.length / returns.length : 0, 4),
    profit_factor: round(sumLoss > 0 ? sumGain / sumLoss : sumGain > 0 ? 99 : 0, 4),
    p10_return_pct: round(percentile(returns, 0.10) * 100, 4),
    p90_return_pct: round(percentile(returns, 0.90) * 100, 4),
    worst_return_pct: round((returns.length ? Math.min(...returns) : 0) * 100, 4),
    best_return_pct: round((returns.length ? Math.max(...returns) : 0) * 100, 4),
    reasons: Object.fromEntries([...reasons.entries()].sort((a, b) => b[1] - a[1]))
  };
}
function objective(m) {
  return m.mean_return_pct
    + 0.15 * m.median_return_pct
    + 1.5 * m.positive_rate
    + 0.08 * Math.min(m.profit_factor, 3)
    + 0.05 * m.p10_return_pct;
}
function chronologicalSplit(rows) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.execution_at || a.created_at) - Date.parse(b.execution_at || b.created_at));
  const total = ordered.length;
  const trainEnd = Math.max(1, Math.floor(total * 0.65));
  const validationEnd = Math.max(trainEnd + 1, Math.floor(total * 0.80));
  return {
    train: ordered.slice(0, trainEnd),
    validation: ordered.slice(trainEnd, validationEnd),
    holdout: ordered.slice(validationEnd)
  };
}
function trainV61Policy(trainRows, validationRows) {
  const baselineTrain = metrics(trainRows, CURRENT_CORE_POLICY, CURRENT_V61_POLICY);
  const baselineValidation = metrics(validationRows, CURRENT_CORE_POLICY, CURRENT_V61_POLICY);

  const candidates = v61Grid()
    .map((policy) => ({ policy, train: metrics(trainRows, CURRENT_CORE_POLICY, policy) }))
    .sort((a, b) => objective(b.train) - objective(a.train))
    .slice(0, 30)
    .map((candidate) => ({ ...candidate, validation: metrics(validationRows, CURRENT_CORE_POLICY, candidate.policy) }))
    .filter((candidate) =>
      candidate.validation.mean_return_pct >= baselineValidation.mean_return_pct - 0.05 &&
      candidate.validation.positive_rate >= baselineValidation.positive_rate - 0.04
    )
    .sort((a, b) => objective(b.validation) - objective(a.validation));

  const selected = candidates[0] || {
    policy: CURRENT_V61_POLICY,
    train: baselineTrain,
    validation: baselineValidation
  };
  return { selected, baselineTrain, baselineValidation, candidates_considered: v61Grid().length };
}
function evaluateHoldout(holdoutRows, candidateV61) {
  const baseline = metrics(holdoutRows, CURRENT_CORE_POLICY, CURRENT_V61_POLICY);
  const candidate = metrics(holdoutRows, CURRENT_CORE_POLICY, candidateV61);
  const pass =
    holdoutRows.length >= 25 &&
    candidate.mean_return_pct >= baseline.mean_return_pct + 0.10 &&
    candidate.profit_factor >= Math.max(baseline.profit_factor, 0.75) &&
    candidate.positive_rate >= baseline.positive_rate - 0.03 &&
    candidate.worst_return_pct >= baseline.worst_return_pct - 0.50;

  return {
    baseline,
    candidate,
    deltas: {
      mean_return_pct: round(candidate.mean_return_pct - baseline.mean_return_pct, 4),
      median_return_pct: round(candidate.median_return_pct - baseline.median_return_pct, 4),
      positive_rate: round(candidate.positive_rate - baseline.positive_rate, 4),
      profit_factor: round(candidate.profit_factor - baseline.profit_factor, 4),
      worst_return_pct: round(candidate.worst_return_pct - baseline.worst_return_pct, 4)
    },
    passed_for_production: pass
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
      'User-Agent': 'proypers25-exit-policy-training'
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
async function loadRepoHistory(repo) {
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
async function loadSymbolBars(signal) {
  const executionTime = Date.parse(signal.execution_at || signal.created_at);
  const start = executionTime - CONTEXT_HOURS * 3600000;
  const end = executionTime + HORIZON_HOURS * 3600000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(signal.symbol)}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  return fetchJson(url, { headers: { 'User-Agent': 'proypers25-exit-policy-training' } });
}
async function loadBtcBars(startMs, endMs) {
  const rows = [];
  let cursor = startMs;
  const step = 5 * 60 * 1000;
  while (cursor < endMs) {
    const url = `https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=5m&startTime=${cursor}&endTime=${endMs}&limit=1000`;
    const page = await fetchJson(url, { headers: { 'User-Agent': 'proypers25-exit-policy-training' } });
    if (!Array.isArray(page) || !page.length) break;
    rows.push(...page);
    const last = n(page[page.length - 1][0], cursor);
    const next = last + step;
    if (next <= cursor) break;
    cursor = next;
    if (page.length < 1000) break;
  }
  return rows;
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
async function buildDataset(repo, now = Date.now()) {
  const history = await loadRepoHistory(repo);
  const exits = dedupeExits(history.issues.map(parseExit).filter(Boolean));
  const signals = history.issues.map(parseSignal).filter(Boolean);
  const executed = signals
    .filter((signal) => signal.lane === 'CORE')
    .map((signal) => ({ ...signal, ...classifyDecision(history.commentsByIssue.get(signal.issue_number) || []) }))
    .filter((signal) => signal.decision === 'EXECUTED' && signal.execution_at)
    .filter((signal) => now - Date.parse(signal.execution_at) >= HORIZON_HOURS * 3600000);

  const exitMatches = oneToOneExitMatch(executed, exits);
  const minTime = Math.min(...executed.map((x) => Date.parse(x.execution_at))) - CONTEXT_HOURS * 3600000;
  const maxTime = Math.max(...executed.map((x) => Date.parse(x.execution_at))) + HORIZON_HOURS * 3600000;
  const btcAll = await loadBtcBars(minTime, maxTime);

  const rows = await mapLimit(executed, CONCURRENCY, async (signal) => {
    try {
      const bars = await loadSymbolBars(signal);
      if (!Array.isArray(bars) || bars.length < 100) return null;
      const actualExit = exitMatches.get(signal.issue_number) || null;
      const entryPrice = actualExit && actualExit.entry_price > 0 ? actualExit.entry_price : signal.signal_price;
      const start = Date.parse(signal.execution_at) - CONTEXT_HOURS * 3600000;
      const end = Date.parse(signal.execution_at) + HORIZON_HOURS * 3600000;
      const btcBars = btcAll.filter((bar) => n(bar[0]) >= start && n(bar[0]) <= end);
      return {
        issue_number: signal.issue_number,
        created_at: signal.created_at,
        execution_at: signal.execution_at,
        symbol: signal.symbol,
        entry_price: entryPrice,
        entry_source: actualExit && actualExit.entry_price > 0 ? 'MATCHED_EXIT' : 'SIGNAL_PRICE',
        actual_exit: actualExit,
        bars,
        btc_bars: btcBars
      };
    } catch (error) {
      console.warn(`EXIT_TRAIN_SAMPLE_SKIPPED issue=${signal.issue_number} symbol=${signal.symbol} reason=${error.message}`);
      return null;
    }
  });

  return {
    rows: rows.filter(Boolean),
    exits,
    signal_count: signals.length,
    core_executed_count: executed.length,
    matched_exit_count: [...exitMatches.values()].length,
    issues_scanned: history.issues.length,
    comments_scanned: history.comments.length
  };
}
function actualExitSummary(exits) {
  const values = exits.map((x) => x.pnl_pct).filter(Number.isFinite);
  const gains = values.filter((x) => x > 0);
  const losses = values.filter((x) => x < 0);
  return {
    unique_exits: values.length,
    positive_rate: round(values.length ? gains.length / values.length : 0, 4),
    mean_pnl_pct: round(mean(values), 4),
    median_pnl_pct: round(median(values), 4),
    profit_factor: round(losses.length ? gains.reduce((s, x) => s + x, 0) / Math.abs(losses.reduce((s, x) => s + x, 0)) : 0, 4)
  };
}
async function main() {
  const repo = process.env.GITHUB_REPOSITORY || process.env.GH_REPOSITORY || '';
  if (!repo || !repo.includes('/')) throw new Error('GITHUB_REPOSITORY is required');

  const dataset = await buildDataset(repo);
  if (dataset.rows.length < 80) throw new Error(`Insufficient executed CORE history: ${dataset.rows.length}`);

  const split = chronologicalSplit(dataset.rows);
  const trained = trainV61Policy(split.train, split.validation);
  const holdout = evaluateHoldout(split.holdout, trained.selected.policy);
  const recommendation = holdout.passed_for_production ? 'PROMOTE' : 'KEEP_CURRENT';

  const report = {
    ok: true,
    version: 'SPOT_EXIT_STACK_HISTORICAL_V3_2026_09_18',
    generated_at: new Date().toISOString(),
    source: 'GITHUB_EXECUTED_CORE_SIGNALS_PLUS_BINANCE_PUBLIC_5M_KLINES',
    round_trip_fee_assumption_pct: round(ROUND_TRIP_FEE_PCT * 100, 4),
    horizon_hours: HORIZON_HOURS,
    context_hours: CONTEXT_HOURS,
    issues_scanned: dataset.issues_scanned,
    comments_scanned: dataset.comments_scanned,
    historical_signals_found: dataset.signal_count,
    executed_core_signals_found: dataset.core_executed_count,
    matched_unique_exits: dataset.matched_exit_count,
    reconstructed_core_trades: dataset.rows.length,
    train_rows: split.train.length,
    validation_rows: split.validation.length,
    holdout_rows: split.holdout.length,
    current_core_policy: CURRENT_CORE_POLICY,
    current_v61_policy: CURRENT_V61_POLICY,
    trained_v61_policy: trained.selected.policy,
    train_metrics: {
      baseline: trained.baselineTrain,
      candidate: trained.selected.train
    },
    validation_metrics: {
      baseline: trained.baselineValidation,
      candidate: trained.selected.validation
    },
    holdout_evaluation: holdout,
    candidates_considered: trained.candidates_considered,
    actual_exit_history: actualExitSummary(dataset.exits),
    promotion_recommendation: recommendation
  };

  const evidence = {
    generated_at: report.generated_at,
    rows: dataset.rows.map((row) => ({
      issue_number: row.issue_number,
      created_at: row.created_at,
      execution_at: row.execution_at,
      symbol: row.symbol,
      entry_price: row.entry_price,
      entry_source: row.entry_source,
      actual_exit_pnl_pct: row.actual_exit?.pnl_pct ?? null,
      actual_exit_reason: row.actual_exit?.reason ?? null,
      current_stack: simulateStack(row, CURRENT_CORE_POLICY, CURRENT_V61_POLICY),
      trained_stack: simulateStack(row, CURRENT_CORE_POLICY, trained.selected.policy)
    }))
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2));

  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(JSON.stringify({
    ok: true,
    version: report.version,
    reconstructed_core_trades: report.reconstructed_core_trades,
    matched_unique_exits: report.matched_unique_exits,
    train: report.train_rows,
    validation: report.validation_rows,
    holdout: report.holdout_rows,
    current_v61_policy: report.current_v61_policy,
    trained_v61_policy: report.trained_v61_policy,
    holdout_evaluation: report.holdout_evaluation,
    actual_exit_history: report.actual_exit_history,
    recommendation,
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
  CURRENT_CORE_POLICY,
  CURRENT_V61_POLICY,
  parseSignal,
  classifyDecision,
  parseExit,
  dedupeExits,
  oneToOneExitMatch,
  legacyStop,
  v61Features,
  maybeTightenV61,
  simulateStack,
  v61Grid,
  metrics,
  chronologicalSplit,
  trainV61Policy,
  evaluateHoldout
};
