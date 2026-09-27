'use strict';

/**
 * QPU continuation dataset builder.
 *
 * Research only:
 * - reads Proypers25 signal issues from GitHub
 * - reads public Binance Spot 1m klines
 * - creates no orders
 * - uses no Binance credentials
 * - writes only local workflow output files
 *
 * Target:
 *   continuator = +3% touched before -1% after the production signal.
 */

const fs = require('fs');

const GH = 'https://api.github.com';
const BIN = 'https://api.binance.com';
const TOKEN = process.env.GITHUB_TOKEN;
const HORIZON_MIN = 240;
const MAX_ISSUES = Math.max(50, Math.min(Number(process.env.QPU_MAX_SIGNALS || 300), 500));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function json(url, headers = {}) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': 'Proypers25-QPU-Research/1.0',
          ...headers
        }
      });
      if (response.ok) return response.json();
      if (response.status === 429 || response.status >= 500) {
        await sleep(350 * (i + 1));
        continue;
      }
      throw new Error(`${response.status} ${url}`);
    } catch (error) {
      last = error;
      if (i < 4) await sleep(350 * (i + 1));
    }
  }
  throw last || new Error('fetch failed');
}

function num(text, regex) {
  const match = String(text || '').match(regex);
  return match ? Number(match[1]) : null;
}

function symbolOf(issue) {
  const match = `${issue.title || ''}\n${issue.body || ''}`.match(/\b([A-Z0-9]{2,15}USDT)\b/);
  return match?.[1] || null;
}

async function loadSignalIssues() {
  const issues = [];
  for (let page = 1; page <= 8; page++) {
    const url = `${GH}/repos/Famarquezh1/proypers25-backend/issues?state=all&per_page=100&page=${page}&sort=created&direction=desc`;
    const batch = await json(url, {
      Authorization: `Bearer ${TOKEN}`,
      'X-GitHub-Api-Version': '2022-11-28'
    });
    issues.push(...batch.filter(item => !item.pull_request));
    if (batch.length < 100) break;
  }

  return issues
    .filter(issue => /spot signal/i.test(issue.title || '') || /SPOT SIGNAL/i.test(issue.body || ''))
    .slice(0, MAX_ISSUES);
}

async function evaluateIssue(issue) {
  const symbol = symbolOf(issue);
  if (!symbol) return null;

  const signalTime = Date.parse(issue.created_at);
  if (!Number.isFinite(signalTime)) return null;

  const url = new URL(`${BIN}/api/v3/klines`);
  for (const [key, value] of Object.entries({
    symbol,
    interval: '1m',
    startTime: signalTime,
    endTime: signalTime + (HORIZON_MIN + 5) * 60000,
    limit: 500
  })) {
    url.searchParams.set(key, String(value));
  }

  const klines = await json(url);
  if (!Array.isArray(klines) || klines.length < 61) return null;

  const entry = Number(klines[0][1]);
  if (!(entry > 0)) return null;

  let mfe = -Infinity;
  let mae = Infinity;
  let first3 = null;
  let firstNeg1 = null;
  let first5 = null;
  let first10 = null;

  for (let i = 1; i < klines.length; i++) {
    const highMove = Number(klines[i][2]) / entry - 1;
    const lowMove = Number(klines[i][3]) / entry - 1;

    mfe = Math.max(mfe, highMove);
    mae = Math.min(mae, lowMove);

    if (first3 === null && highMove >= 0.03) first3 = i;
    if (first5 === null && highMove >= 0.05) first5 = i;
    if (first10 === null && highMove >= 0.10) first10 = i;
    if (firstNeg1 === null && lowMove <= -0.01) firstNeg1 = i;
  }

  const targetContinuator =
    first3 !== null &&
    (firstNeg1 === null || first3 < firstNeg1);

  const body = issue.body || '';
  const lastIndex = Math.min(HORIZON_MIN, klines.length - 1);
  const return4h = Number(klines[lastIndex][4]) / entry - 1;

  return {
    document_id: `github-issue-${issue.number}`,
    issue_number: issue.number,
    symbol,
    timestamp: new Date(signalTime).toISOString(),
    entry_price: entry,

    target_continuator: targetContinuator,
    first_plus3_min: first3,
    first_minus1_min: firstNeg1,
    first_plus5_min: first5,
    first_plus10_min: first10,

    mfe_pct: mfe * 100,
    mae_pct: mae * 100,
    return_4h_pct: return4h * 100,
    hit_plus3: mfe >= 0.03,
    hit_plus5: mfe >= 0.05,
    hit_plus10: mfe >= 0.10,

    utility: num(body, /utility[:=\s]+([\d.]+)/i),
    ignition: num(body, /ignition[:=\s]+([\d.]+)/i),
    confirm: num(body, /confirm(?:ation)?[:=\s]+([\d.]+)/i),
    extension: num(body, /extension[:=\s]+([\d.]+)/i),
    r15: num(body, /r15[:=\s]+([+-]?[\d.]+)/i),
    r60: num(body, /r60[:=\s]+([+-]?[\d.]+)/i),
    change_24h: num(body, /(?:pct|24h[^\d-]*|change[^\d-]*)[:=\s]+([+-]?\d+(?:\.\d+)?)/i)
  };
}

async function main() {
  if (!TOKEN) throw new Error('GITHUB_TOKEN is required');

  const signals = await loadSignalIssues();
  const rows = [];

  for (const issue of signals) {
    try {
      const row = await evaluateIssue(issue);
      if (row) rows.push(row);
    } catch (error) {
      console.error('[QPU_DATASET_SKIP]', issue.number, error.message);
    }
    await sleep(25);
  }

  rows.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));

  const jsonlPath = 'qpu-continuation-dataset.jsonl';
  const metadataPath = 'qpu-continuation-dataset.meta.json';
  fs.writeFileSync(
    jsonlPath,
    rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''),
    'utf8'
  );

  const continuators = rows.filter(row => row.target_continuator).length;
  const metadata = {
    ok: true,
    generated_at: new Date().toISOString(),
    research_only: true,
    source_signals: 'GitHub issues',
    market_data: 'Binance public Spot 1m klines',
    binance_credentials_used: false,
    orders_created: 0,
    signals_scanned: signals.length,
    rows: rows.length,
    continuators,
    non_continuators: rows.length - continuators,
    target_definition: '+3% before -1%',
    horizon_minutes: HORIZON_MIN,
    jsonl: jsonlPath,
    bytes: fs.statSync(jsonlPath).size
  };

  fs.writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(metadata, null, 2));
}

main().catch(error => {
  console.error('[QPU_DATASET_ERROR]', error?.stack || error);
  process.exit(1);
});
