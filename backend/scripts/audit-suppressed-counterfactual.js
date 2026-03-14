/**
 * Contrafactual audit (read-only):
 * - win_rate emitidas
 * - expectancy emitidas
 * - suprimidas sin verificacion
 * - que habria pasado si las suprimidas se operaban
 *
 * Uso:
 *   node backend/scripts/audit-suppressed-counterfactual.js
 *
 * Opcionales:
 *   AUDIT_DAYS=60
 *   AUDIT_MAX_DOCS=0
 *   AUDIT_CF_JSON=backend/scripts/audit_suppressed_counterfactual.json
 *   AUDIT_CF_CSV=backend/scripts/audit_suppressed_counterfactual.csv
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const db = new Firestore();

const AUDIT_DAYS = Math.max(1, Number(process.env.AUDIT_DAYS || 60));
const AUDIT_MAX_DOCS = Math.max(0, Number(process.env.AUDIT_MAX_DOCS || 0));
const REPORT_JSON_PATH =
  process.env.AUDIT_CF_JSON ||
  path.resolve(process.cwd(), 'backend/scripts/audit_suppressed_counterfactual.json');
const REPORT_CSV_PATH =
  process.env.AUDIT_CF_CSV ||
  path.resolve(process.cwd(), 'backend/scripts/audit_suppressed_counterfactual.csv');

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    if (d instanceof Date && Number.isFinite(d.getTime())) return d;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function pct(value) {
  if (value == null || !Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(2));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function normalizeOutcome(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS') || raw.includes('FAIL') || raw.includes('PERD')) return 'LOSS';
  if (raw.includes('PENDING') || raw.includes('PENDIENTE')) return 'PENDING';
  if (raw.includes('SUPP')) return 'SUPPRESSED';
  return 'UNKNOWN';
}

function resolveState(row) {
  if (row.signal_emitted === true) return 'emitidas';
  if (row.signal_emitted === false) return 'suprimidas';
  const status = String(row.status || '').toLowerCase();
  if (status === 'validado') return 'emitidas';
  if (status === 'suprimida') return 'suprimidas';
  return 'pendientes';
}

function resolveDirection(row) {
  const dir = String(row.direction || '').toLowerCase();
  if (dir === 'up' || dir === 'down') return dir;
  return 'neutral';
}

function resolveEmittedOutcome(row) {
  return normalizeOutcome(
    row?.verification_outcome ||
      row?.verification?.verification_outcome ||
      row?.verification?.outcome_label ||
      row?.status
  );
}

function resolveSuppressedOutcome(row) {
  return normalizeOutcome(
    row?.suppressed_verification?.counterfactual_outcome ||
      row?.verification?.suppressed_verification?.counterfactual_outcome ||
      row?.verification?.counterfactual_outcome ||
      row?.counterfactual_outcome
  );
}

// Return in % aligned to trade direction (positive = favorable)
function resolveDirectionalReturnPct(row, source) {
  const direction = resolveDirection(row);
  if (direction === 'neutral') return null;

  let actualChange = null;
  if (source === 'emitted') {
    actualChange = toNum(row?.verification?.actual_change);
  } else {
    actualChange = toNum(
      row?.suppressed_verification?.actual_change ??
        row?.verification?.suppressed_verification?.actual_change ??
        row?.verification?.actual_change
    );
  }
  if (actualChange == null) return null;

  return direction === 'up' ? actualChange : -actualChange;
}

function calcWinRate(outcomes) {
  const classified = outcomes.filter((o) => o === 'WIN' || o === 'LOSS');
  if (!classified.length) return null;
  const wins = classified.filter((o) => o === 'WIN').length;
  return wins / classified.length;
}

function calcExpectancy(returnsPct) {
  const vals = returnsPct.filter((v) => Number.isFinite(v));
  if (!vals.length) {
    return {
      avg_win: null,
      avg_loss: null,
      expectancy: null,
      win_rate: null,
      loss_rate: null
    };
  }

  const wins = vals.filter((v) => v > 0);
  const lossesAbs = vals.filter((v) => v < 0).map((v) => Math.abs(v));
  const winRate = wins.length / vals.length;
  const lossRate = lossesAbs.length / vals.length;
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLoss = lossesAbs.length ? mean(lossesAbs) : 0;
  const expectancy = winRate * avgWin - lossRate * avgLoss;

  return {
    avg_win: avgWin,
    avg_loss: avgLoss,
    expectancy,
    win_rate: winRate,
    loss_rate: lossRate
  };
}

async function loadRows(days, maxDocs) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  let q = db.collection('velas_predicciones').where('created_at', '>=', cutoff).orderBy('created_at', 'desc');
  if (maxDocs > 0) q = q.limit(maxDocs);
  const snap = await q.get();
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

function toCsv(rows) {
  if (!rows.length) return '';
  const headers = Object.keys(rows[0]);
  const esc = (v) => {
    if (v == null) return '';
    const s = String(v);
    if (s.includes('"') || s.includes(',') || s.includes('\n')) return `"${s.replace(/"/g, '""')}"`;
    return s;
  };
  return [headers.join(','), ...rows.map((r) => headers.map((h) => esc(r[h])).join(','))].join('\n');
}

async function run(opts = {}) {
  const days = Math.max(1, Number(opts.days || AUDIT_DAYS));
  const maxDocs = Math.max(0, Number(opts.maxDocs || AUDIT_MAX_DOCS));
  const writeFiles = opts.writeFiles !== false;
  const reportJsonPath = opts.reportJsonPath || REPORT_JSON_PATH;
  const reportCsvPath = opts.reportCsvPath || REPORT_CSV_PATH;

  const raw = await loadRows(days, maxDocs);
  const rows = raw.map((r) => ({
    ...r,
    created_at_dt: toDate(r.created_at || r.timestamp),
    state: resolveState(r)
  }));

  const emitted = rows.filter((r) => r.state === 'emitidas');
  const suppressed = rows.filter((r) => r.state === 'suprimidas');

  const emittedOutcomes = emitted.map(resolveEmittedOutcome);
  const emittedReturns = emitted.map((r) => resolveDirectionalReturnPct(r, 'emitted'));

  const suppressedOutcomes = suppressed.map(resolveSuppressedOutcome);
  const suppressedVerifiedMask = suppressedOutcomes.map((o) => o === 'WIN' || o === 'LOSS');
  const suppressedVerifiedRows = suppressed.filter((_, i) => suppressedVerifiedMask[i]);
  const suppressedUnverified = suppressed.length - suppressedVerifiedRows.length;
  const suppressedReturns = suppressedVerifiedRows.map((r) =>
    resolveDirectionalReturnPct(r, 'suppressed')
  );

  const winRateEmitidas = calcWinRate(emittedOutcomes);
  const expectancyEmitidas = calcExpectancy(emittedReturns);
  const winRateSuprimidas = calcWinRate(suppressedOutcomes);
  const expectancySuprimidas = calcExpectancy(suppressedReturns);

  const deltaWinRate =
    winRateEmitidas != null && winRateSuprimidas != null ? winRateEmitidas - winRateSuprimidas : null;
  const deltaExpectancy =
    expectancyEmitidas.expectancy != null && expectancySuprimidas.expectancy != null
      ? expectancyEmitidas.expectancy - expectancySuprimidas.expectancy
      : null;

  const report = {
    generated_at: new Date().toISOString(),
    window_days: days,
    source_limit_docs: maxDocs > 0 ? maxDocs : null,
    totals: {
      total_signals: rows.length,
      emitidas: emitted.length,
      suprimidas: suppressed.length,
      suprimidas_verificadas: suppressedVerifiedRows.length,
      suprimidas_sin_verificacion: suppressedUnverified
    },
    emitidas: {
      win_rate: winRateEmitidas,
      win_rate_pct: pct(winRateEmitidas),
      expectancy: expectancyEmitidas.expectancy,
      expectancy_components: expectancyEmitidas
    },
    suprimidas_contrafactual: {
      win_rate: winRateSuprimidas,
      win_rate_pct: pct(winRateSuprimidas),
      expectancy: expectancySuprimidas.expectancy,
      expectancy_components: expectancySuprimidas
    },
    utilidad_filtro: {
      delta_win_rate: deltaWinRate,
      delta_win_rate_pct_points:
        deltaWinRate == null || !Number.isFinite(deltaWinRate) ? null : Number((deltaWinRate * 100).toFixed(2)),
      delta_expectancy: deltaExpectancy
    }
  };

  const csvRows = [
    { section: 'totals', key: 'total_signals', value: report.totals.total_signals },
    { section: 'totals', key: 'emitidas', value: report.totals.emitidas },
    { section: 'totals', key: 'suprimidas', value: report.totals.suprimidas },
    { section: 'totals', key: 'suprimidas_verificadas', value: report.totals.suprimidas_verificadas },
    { section: 'totals', key: 'suprimidas_sin_verificacion', value: report.totals.suprimidas_sin_verificacion },
    { section: 'emitidas', key: 'win_rate_pct', value: report.emitidas.win_rate_pct },
    { section: 'emitidas', key: 'expectancy', value: report.emitidas.expectancy },
    { section: 'suprimidas_contrafactual', key: 'win_rate_pct', value: report.suprimidas_contrafactual.win_rate_pct },
    { section: 'suprimidas_contrafactual', key: 'expectancy', value: report.suprimidas_contrafactual.expectancy },
    { section: 'utilidad_filtro', key: 'delta_win_rate_pct_points', value: report.utilidad_filtro.delta_win_rate_pct_points },
    { section: 'utilidad_filtro', key: 'delta_expectancy', value: report.utilidad_filtro.delta_expectancy }
  ];

  if (writeFiles) {
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(reportCsvPath, toCsv(csvRows), 'utf8');
  }

  console.log('\nContrafactual suprimidas (read-only)');
  console.table({
    total_signals: report.totals.total_signals,
    emitidas: report.totals.emitidas,
    suprimidas: report.totals.suprimidas,
    suprimidas_verificadas: report.totals.suprimidas_verificadas,
    suprimidas_sin_verificacion: report.totals.suprimidas_sin_verificacion,
    win_rate_emitidas_pct: report.emitidas.win_rate_pct,
    expectancy_emitidas: report.emitidas.expectancy,
    win_rate_suprimidas_pct: report.suprimidas_contrafactual.win_rate_pct,
    expectancy_suprimidas: report.suprimidas_contrafactual.expectancy,
    delta_win_rate_pp: report.utilidad_filtro.delta_win_rate_pct_points,
    delta_expectancy: report.utilidad_filtro.delta_expectancy
  });

  if (writeFiles) {
    console.log(`\nJSON: ${reportJsonPath}`);
    console.log(`CSV: ${reportCsvPath}`);
  }

  return report;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error en audit-suppressed-counterfactual:', err);
    process.exit(1);
  });
}

module.exports = { run };

