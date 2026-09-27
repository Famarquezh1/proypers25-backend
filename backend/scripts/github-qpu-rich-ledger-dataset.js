'use strict';

const fs = require('fs');

const INPUT = process.argv[2] || 'spot-radar-rejection-ledger.json';
const OUTPUT = process.argv[3] || 'qpu-rich-ledger-dataset.jsonl';
const META = process.argv[4] || 'qpu-rich-ledger-dataset.meta.json';
const BIN = 'https://data-api.binance.vision';
const H = 240;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
  let last;
  for (let i = 0; i < 5; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'proypers25-qpu-rich-ledger/1.0' } });
      if (r.ok) return await r.json();
      if (r.status === 429 || r.status >= 500) {
        await sleep(350 * (i + 1));
        continue;
      }
      throw new Error(`HTTP_${r.status}`);
    } catch (error) {
      last = error;
      if (i < 4) await sleep(350 * (i + 1));
    }
  }
  throw last || new Error('fetch failed');
}

async function label(row) {
  const t = Date.parse(row.observed_at);
  if (!Number.isFinite(t)) return null;
  const q = new URLSearchParams({
    symbol: String(row.symbol || '').toUpperCase(),
    interval: '1m',
    startTime: String(t),
    endTime: String(t + (H + 5) * 60000),
    limit: '500'
  });
  const k = await getJson(`${BIN}/api/v3/klines?${q}`);
  if (!Array.isArray(k) || k.length < 61) return null;

  const entry = Number(row.price) > 0 ? Number(row.price) : Number(k[0][1]);
  let first3 = null, firstNeg1 = null, first5 = null, first10 = null;
  let mfe = -Infinity, mae = Infinity;

  for (let i = 1; i < k.length; i++) {
    const hi = Number(k[i][2]) / entry - 1;
    const lo = Number(k[i][3]) / entry - 1;
    mfe = Math.max(mfe, hi);
    mae = Math.min(mae, lo);
    if (first3 === null && hi >= .03) first3 = i;
    if (first5 === null && hi >= .05) first5 = i;
    if (first10 === null && hi >= .10) first10 = i;
    if (firstNeg1 === null && lo <= -.01) firstNeg1 = i;
  }

  const last = Math.min(H, k.length - 1);
  const d = row.v42_detail || null;

  return {
    source: 'spot-radar-rejection-ledger',
    observed_at: row.observed_at,
    symbol: row.symbol,
    entry_price: entry,
    pct: Number(row.pct || 0),
    qv: Number(row.qv || 0),
    utility: Number(row.utility || 0),
    base: Number(row.base || 0),
    stable: Number(row.stable || 0),
    v42: Number(row.v42 || 0),
    v42_pass_windows: Number(row.v42_pass_windows || 0),
    ignition: d ? Number(d.ignition || 0) : null,
    confirm: d ? Number(d.confirm || 0) : null,
    extension: d ? Number(d.extension || 0) : null,
    r15: d ? Number(d.r15 || 0) : null,
    r60: d ? Number(d.r60 || 0) : null,
    r24: d ? Number(d.r24 || 0) : null,
    fresh_enough: d ? d.freshEnough === true : null,
    market_regime: row.market_regime || 'UNKNOWN',
    stage: row.stage || 'UNKNOWN',
    reasons: Array.isArray(row.reasons) ? row.reasons : [],
    radar_source: row.radar_source || 'UNKNOWN',
    radar_reason: row.radar_reason || 'UNKNOWN',
    target_continuator: first3 !== null && (firstNeg1 === null || first3 < firstNeg1),
    first_plus3_min: first3,
    first_minus1_min: firstNeg1,
    first_plus5_min: first5,
    first_plus10_min: first10,
    hit_plus3: mfe >= .03,
    hit_plus5: mfe >= .05,
    hit_plus10: mfe >= .10,
    mfe_pct: mfe * 100,
    mae_pct: mae * 100,
    return_4h_pct: (Number(k[last][4]) / entry - 1) * 100
  };
}

(async () => {
  const ledger = JSON.parse(fs.readFileSync(INPUT, 'utf8'));
  const source = Array.isArray(ledger.rows) ? ledger.rows : [];
  const rows = [];
  const skipped = [];

  for (const row of source) {
    try {
      const out = await label(row);
      if (out) rows.push(out);
      else skipped.push({ symbol: row.symbol, observed_at: row.observed_at, reason: 'INSUFFICIENT_DATA' });
    } catch (error) {
      skipped.push({ symbol: row.symbol, observed_at: row.observed_at, reason: error.message });
    }
    await sleep(25);
  }

  rows.sort((a,b) => Date.parse(a.observed_at) - Date.parse(b.observed_at));
  fs.writeFileSync(OUTPUT, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''), 'utf8');

  const meta = {
    ok: true,
    research_only: true,
    no_order_created: true,
    source_rows: source.length,
    rows: rows.length,
    skipped: skipped.length,
    continuators: rows.filter(r => r.target_continuator).length,
    non_continuators: rows.filter(r => !r.target_continuator).length,
    target_definition: '+3% before -1%',
    horizon_minutes: H,
    with_v42_detail: rows.filter(r => r.ignition !== null).length,
    first_observed_at: rows[0]?.observed_at || null,
    last_observed_at: rows[rows.length-1]?.observed_at || null,
    output: OUTPUT,
    bytes: fs.statSync(OUTPUT).size,
    skipped_examples: skipped.slice(0, 10)
  };
  fs.writeFileSync(META, JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify(meta, null, 2));
})().catch(error => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
