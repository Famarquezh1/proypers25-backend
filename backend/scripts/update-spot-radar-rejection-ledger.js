'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_ROWS = 120;
const DEFAULT_DEDUPE_MINUTES = 30;

function readJson(file, fallback) {
  try {
    if (!file || !fs.existsSync(file)) return fallback;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function normalizeReasons(reasons) {
  return [...new Set((Array.isArray(reasons) ? reasons : [reasons])
    .map((value) => String(value || '').trim())
    .filter(Boolean))]
    .sort();
}

function rowKey(row = {}) {
  return [
    String(row.symbol || '').toUpperCase(),
    String(row.stage || 'PRE_APPROVAL'),
    normalizeReasons(row.reasons).join('+')
  ].join('|');
}

function updateLedger(previous = {}, scan = {}, observedAt = new Date().toISOString(), options = {}) {
  const maxRows = Math.max(20, Math.min(300, Number(options.maxRows || DEFAULT_MAX_ROWS)));
  const dedupeMinutes = Math.max(5, Math.min(180, Number(options.dedupeMinutes || DEFAULT_DEDUPE_MINUTES)));
  const dedupeMs = dedupeMinutes * 60 * 1000;
  const nowMs = Date.parse(observedAt);
  const prior = Array.isArray(previous?.rows) ? previous.rows.filter((row) => row && row.symbol) : [];
  const incoming = Array.isArray(scan?.learning_rejections) ? scan.learning_rejections : [];
  const rows = [...prior];

  for (const item of incoming) {
    const symbol = String(item?.symbol || '').toUpperCase();
    const price = Number(item?.price || 0);
    if (!symbol || !(price > 0)) continue;
    const normalized = {
      observed_at: observedAt,
      symbol,
      price,
      pct: Number(item?.pct || 0),
      qv: Number(item?.qv || 0),
      utility: Number(item?.utility || 0),
      base: Number(item?.base || 0),
      stable: Number(item?.stable || 0),
      v42: Number(item?.v42 || 0),
      v42_pass_windows: Number(item?.v42_pass_windows || 0),
      market_regime: String(item?.market_regime || 'UNKNOWN'),
      stage: String(item?.stage || 'PRE_APPROVAL'),
      reasons: normalizeReasons(item?.reasons),
      radar_source: String(scan?.source || 'UNKNOWN'),
      radar_reason: String(scan?.reason || (scan?.notify === true ? 'SIGNAL_SELECTED' : 'NO_SIGNAL'))
    };
    const key = rowKey(normalized);
    const duplicate = rows.some((row) => {
      if (rowKey(row) !== key) return false;
      const previousMs = Date.parse(row.observed_at || 0);
      return Number.isFinite(nowMs) && Number.isFinite(previousMs) && nowMs - previousMs >= 0 && nowMs - previousMs < dedupeMs;
    });
    if (!duplicate) rows.push(normalized);
  }

  rows.sort((a, b) => Date.parse(b.observed_at || 0) - Date.parse(a.observed_at || 0));
  return {
    version: 'SPOT_RADAR_REJECTION_LEDGER_V1',
    updated_at: observedAt,
    max_rows: maxRows,
    dedupe_minutes: dedupeMinutes,
    rows: rows.slice(0, maxRows)
  };
}

function main() {
  const scanPath = process.argv[2];
  const previousPath = process.argv[3];
  const outputPath = process.argv[4] || path.join(process.cwd(), 'spot-radar-rejection-ledger.json');
  if (!scanPath) throw new Error('scan path is required');
  const scan = readJson(scanPath, {});
  const previous = readJson(previousPath, {});
  const observedAt = process.env.RADAR_OBSERVED_AT || new Date().toISOString();
  const ledger = updateLedger(previous, scan, observedAt, {
    maxRows: process.env.RADAR_REJECTION_LEDGER_MAX_ROWS || DEFAULT_MAX_ROWS,
    dedupeMinutes: process.env.RADAR_REJECTION_DEDUPE_MINUTES || DEFAULT_DEDUPE_MINUTES
  });
  fs.writeFileSync(outputPath, JSON.stringify(ledger, null, 2));
  console.log(JSON.stringify({ ok: true, rows: ledger.rows.length, added_from_scan: Array.isArray(scan.learning_rejections) ? scan.learning_rejections.length : 0, output: outputPath }));
}

if (require.main === module) {
  try { main(); } catch (error) { console.error(error.stack || error.message || String(error)); process.exit(1); }
}

module.exports = { normalizeReasons, rowKey, updateLedger };
