'use strict';

const fs = require('fs');
const path = require('path');

const HORIZON_HOURS = Math.max(12, Math.min(36, Number(process.env.EXIT_TRAIN_HORIZON_HOURS || 24)));
const EXIT_MATCH_HOURS = Math.max(HORIZON_HOURS, Math.min(72, Number(process.env.EXIT_TRAIN_MATCH_HOURS || 36)));
const CONCURRENCY = Math.max(1, Math.min(10, Number(process.env.EXIT_TRAIN_CONCURRENCY || 8)));
const MAX_PAGES = Math.max(10, Math.min(80, Number(process.env.EXIT_TRAIN_MAX_PAGES || 30)));
const ROUND_TRIP_FEE_PCT = Math.max(0, Math.min(0.01, Number(process.env.EXIT_TRAIN_FEE_PCT || 0.002)));
const OUTPUT = process.env.EXIT_TRAIN_OUTPUT || path.join(process.cwd(), 'spot-exit-policy-training-report.json');
const EVIDENCE_OUTPUT = process.env.EXIT_TRAIN_EVIDENCE_OUTPUT || path.join(process.cwd(), 'spot-exit-policy-training-evidence.json');

const CURRENT_CORE_POLICY = Object.freeze({
  hard_stop_pct: 0.05,
  break_even_trigger_pct: 0.05,
  break_even_lock_pct: 0.002,
  trailing_trigger_pct: 0.08,
  trailing_distance_pct: 0.06,
  stale_timeout_hours: 18,
  stale_max_gain_pct: 0.005,
  take_profit_pct: 0
});

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
  const text = comments.map((comment) => String(comment.body || '')).join('\n');
  const orderId = (text.match(/orderId:\s*([0-9]+)/i) || [])[1] || null;
  if (/ejecut[oó] la compra Spot|compra Spot.*orderId|protecci[oó]n nativa fue armada/i.test(text)) {
    return { decision: 'EXECUTED', order_id: orderId };
  }
  if (/Oportunidad descartada autom[aá]ticamente|No se compr[oó]|SIGNAL_DECLINED/i.test(text)) {
    return { decision: 'DECLINED', order_id: null };
  }
  return { decision: 'UNKNOWN', order_id: null };
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
function matchExit(signal, exits = []) {
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
function simulatePolicy(bars, entryPrice, policy, feePct = ROUND_TRIP_FEE_PCT) {
  if (!Array.isArray(bars) || !bars.length || !(entryPrice > 0)) return null;
  let high = entryPrice;
  let exitPrice = entryPrice;
  let reason = 'HORIZON';
  let ageHours = 0;

  for (let i = 0; i < bars.length; i += 1) {
    const row = bars[i];
    const openTime = n(row[0]);
    const highPrice = n(row[2]);
    const lowPrice = n(row[3]);
    const closePrice = n(row[4]);
    if (!(highPrice > 0 && lowPrice > 0 && closePrice > 0)) continue;
    ageHours = i * 5 / 60;

    // Use only the high known before this candle to set protection.
    // This avoids look-ahead from an unknown intrabar high/low ordering.
    const mfe = high / entryPrice - 1;
    let stop = entryPrice * (1 - policy.hard_stop_pct);
    let stopReason = 'HARD_STOP';
    if (mfe >= policy.break_even_trigger_pct) {
      stop = Math.max(stop, entryPrice * (1 + policy.break_even_lock_pct));
      stopReason = 'BREAK_EVEN';
    }
    if (mfe >= policy.trailing_trigger_pct) {
      const trailingStop = high * (1 - policy.trailing_distance_pct);
      if (trailingStop > stop) {
        stop = trailingStop;
        stopReason = 'TRAILING';
      }
    }

    const takeProfit = n(policy.take_profit_pct, 0) > 0 ? entryPrice * (1 + policy.take_profit_pct) : Infinity;

    // Conservative ordering when both are touched inside the same 5m candle.
    if (lowPrice <= stop && highPrice >= takeProfit) {
      exitPrice = stop;
      reason = stopReason;
      break;
    }
    if (lowPrice <= stop) {
      exitPrice = stop;
      reason = stopReason;
      break;
    }
    if (highPrice >= takeProfit) {
      exitPrice = takeProfit;
      reason = 'TAKE_PROFIT';
      break;
    }

    // Only after surviving the candle does its high become available for
    // the next candle's break-even/trailing decision.
    high = Math.max(high, highPrice);

    const gainAtClose = closePrice / entryPrice - 1;
    if (ageHours >= policy.stale_timeout_hours && gainAtClose <= policy.stale_max_gain_pct) {
      exitPrice = closePrice;
      reason = 'TIMEOUT_STALE';
      break;
    }

    exitPrice = closePrice;
    if (!Number.isFinite(openTime)) continue;
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
function policyGrid() {
  const policies = [];
  for (const hard of [0.025, 0.035, 0.05]) {
    for (const beTrigger of [0.025, 0.04, 0.05]) {
      for (const beLock of [0.001, 0.003]) {
        for (const trailTrigger of [0.04, 0.06, 0.08]) {
          for (const trailDistance of [0.02, 0.035, 0.05, 0.06]) {
            if (trailDistance >= trailTrigger + 0.015) continue;
            for (const timeout of [9, 12, 18]) {
              for (const takeProfit of [0, 0.04, 0.06]) {
                policies.push({
                  hard_stop_pct: hard,
                  break_even_trigger_pct: beTrigger,
                  break_even_lock_pct: beLock,
                  trailing_trigger_pct: trailTrigger,
                  trailing_distance_pct: trailDistance,
                  stale_timeout_hours: timeout,
                  stale_max_gain_pct: 0.005,
                  take_profit_pct: takeProfit
                });
              }
            }
          }
        }
      }
    }
  }
  return policies;
}
function metrics(rows, policy) {
  const returns = [];
  const reasons = new Map();
  for (const row of rows) {
    const result = simulatePolicy(row.bars, row.entry_price, policy);
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
  return (
    m.mean_return_pct +
    0.15 * m.median_return_pct +
    1.5 * m.positive_rate +
    0.08 * Math.min(m.profit_factor, 3) +
    0.05 * m.p10_return_pct
  );
}
function chronologicalSplit(rows) {
  const ordered = [...rows].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const nRows = ordered.length;
  const trainEnd = Math.max(1, Math.floor(nRows * 0.65));
  const validationEnd = Math.max(trainEnd + 1, Math.floor(nRows * 0.80));
  return {
    train: ordered.slice(0, trainEnd),
    validation: ordered.slice(trainEnd, validationEnd),
    holdout: ordered.slice(validationEnd)
  };
}
function trainPolicy(trainRows, validationRows) {
  const baselineTrain = metrics(trainRows, CURRENT_CORE_POLICY);
  const baselineValidation = metrics(validationRows, CURRENT_CORE_POLICY);
  const candidates = policyGrid()
    .map((policy) => ({ policy, train: metrics(trainRows, policy) }))
    .sort((a, b) => objective(b.train) - objective(a.train))
    .slice(0, 30)
    .map((candidate) => ({
      ...candidate,
      validation: metrics(validationRows, candidate.policy)
    }))
    .filter((candidate) =>
      candidate.validation.mean_return_pct >= baselineValidation.mean_return_pct - 0.05 &&
      candidate.validation.positive_rate >= baselineValidation.positive_rate - 0.04
    )
    .sort((a, b) => objective(b.validation) - objective(a.validation));

  const selected = candidates[0] || {
    policy: CURRENT_CORE_POLICY,
    train: baselineTrain,
    validation: baselineValidation
  };
  return { selected, baselineTrain, baselineValidation, candidates_considered: policyGrid().length };
}
function evaluateHoldout(holdoutRows, candidatePolicy) {
  const baseline = metrics(holdoutRows, CURRENT_CORE_POLICY);
  const candidate = metrics(holdoutRows, candidatePolicy);
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
async function loadBars(signal) {
  const start = Date.parse(signal.created_at);
  const end = start + HORIZON_HOURS * 3600000;
  const url = `https://data-api.binance.vision/api/v3/klines?symbol=${encodeURIComponent(signal.symbol)}&interval=5m&startTime=${start}&endTime=${end}&limit=1000`;
  return fetchJson(url, { headers: { 'User-Agent': 'proypers25-exit-policy-training' } });
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
  const mature = signals
    .filter((signal) => signal.lane === 'CORE')
    .filter((signal) => now - Date.parse(signal.created_at) >= HORIZON_HOURS * 3600000)
    .map((signal) => ({
      ...signal,
      decision: classifyDecision(history.commentsByIssue.get(signal.issue_number) || [])
    }))
    .filter((signal) => signal.decision.decision === 'EXECUTED');

  const rows = await mapLimit(mature, CONCURRENCY, async (signal) => {
    try {
      const bars = await loadBars(signal);
      if (!Array.isArray(bars) || bars.length < 24) return null;
      const actualExit = matchExit(signal, exits);
      const entryPrice = actualExit && actualExit.entry_price > 0 ? actualExit.entry_price : signal.signal_price;
      return {
        issue_number: signal.issue_number,
        created_at: signal.created_at,
        symbol: signal.symbol,
        entry_price: entryPrice,
        entry_source: actualExit && actualExit.entry_price > 0 ? 'MATCHED_EXIT' : 'SIGNAL_PRICE',
        actual_exit: actualExit,
        bars
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
    core_executed_count: mature.length,
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
  const trained = trainPolicy(split.train, split.validation);
  const holdout = evaluateHoldout(split.holdout, trained.selected.policy);
  const recommendation = holdout.passed_for_production ? 'PROMOTE' : 'KEEP_CURRENT';

  const report = {
    ok: true,
    version: 'SPOT_EXIT_POLICY_HISTORICAL_V2_2026_09_18',
    generated_at: new Date().toISOString(),
    source: 'GITHUB_EXECUTED_CORE_SIGNALS_PLUS_BINANCE_PUBLIC_5M_KLINES',
    round_trip_fee_assumption_pct: round(ROUND_TRIP_FEE_PCT * 100, 4),
    horizon_hours: HORIZON_HOURS,
    issues_scanned: dataset.issues_scanned,
    comments_scanned: dataset.comments_scanned,
    historical_signals_found: dataset.signal_count,
    executed_core_signals_found: dataset.core_executed_count,
    reconstructed_core_trades: dataset.rows.length,
    train_rows: split.train.length,
    validation_rows: split.validation.length,
    holdout_rows: split.holdout.length,
    current_policy: CURRENT_CORE_POLICY,
    trained_policy: trained.selected.policy,
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
      symbol: row.symbol,
      entry_price: row.entry_price,
      entry_source: row.entry_source,
      actual_exit_pnl_pct: row.actual_exit?.pnl_pct ?? null,
      actual_exit_reason: row.actual_exit?.reason ?? null,
      current_policy: simulatePolicy(row.bars, row.entry_price, CURRENT_CORE_POLICY),
      trained_policy: simulatePolicy(row.bars, row.entry_price, trained.selected.policy)
    }))
  };

  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  fs.writeFileSync(EVIDENCE_OUTPUT, JSON.stringify(evidence, null, 2));

  const rssMb = process.memoryUsage().rss / 1024 / 1024;
  console.log(JSON.stringify({
    ok: true,
    version: report.version,
    reconstructed_core_trades: report.reconstructed_core_trades,
    train: report.train_rows,
    validation: report.validation_rows,
    holdout: report.holdout_rows,
    current_policy: report.current_policy,
    trained_policy: report.trained_policy,
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
  parseSignal,
  classifyDecision,
  parseExit,
  dedupeExits,
  matchExit,
  simulatePolicy,
  policyGrid,
  metrics,
  chronologicalSplit,
  trainPolicy,
  evaluateHoldout
};
