/**
 * Statistical Intelligence Audit (read-only).
 *
 * Objetivo:
 * - Medir calidad de señales emitidas/suprimidas/pendientes
 * - Estimar edge real y efecto del event_context_filter
 * - Exportar reporte en JSON + CSV sin escribir en Firestore
 *
 * Uso:
 *   node backend/scripts/audit-signal-intelligence.js
 *
 * Variables opcionales:
 *   AUDIT_DAYS=60
 *   AUDIT_REPORT_JSON=backend/scripts/audit_report.json
 *   AUDIT_REPORT_CSV=backend/scripts/audit_report.csv
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');

const firestore = new Firestore();

const AUDIT_DAYS = Math.max(1, Number(process.env.AUDIT_DAYS || 60));
const REPORT_JSON_PATH = process.env.AUDIT_REPORT_JSON || path.resolve(process.cwd(), 'backend/scripts/audit_report.json');
const REPORT_CSV_PATH = process.env.AUDIT_REPORT_CSV || path.resolve(process.cwd(), 'backend/scripts/audit_report.csv');

const toNum = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
};

const toDate = (value) => {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    if (d instanceof Date && Number.isFinite(d.getTime())) return d;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
};

const mean = (arr) => {
  if (!arr.length) return null;
  return arr.reduce((sum, v) => sum + v, 0) / arr.length;
};

const median = (arr) => percentile(arr, 50);

function percentile(arr, p) {
  if (!arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return sorted[lo];
  const w = idx - lo;
  return sorted[lo] * (1 - w) + sorted[hi] * w;
}

const pct = (value) => (value == null ? null : Number((value * 100).toFixed(2)));

function normalizeOutcome(row) {
  const raw = String(
    row?.verification_outcome ||
      row?.verification?.verification_outcome ||
      row?.verification?.outcome_label ||
      row?.verification?.result ||
      row?.resultado ||
      ''
  )
    .trim()
    .toUpperCase();

  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS') || raw.includes('FAIL') || raw.includes('PERD')) return 'LOSS';
  if (raw.includes('EXPIRED')) return 'EXPIRED';
  if (raw.includes('SUPRIMIDA') || raw.includes('SUPPRESSED')) return 'SUPPRESSED';
  if (raw.includes('PEND')) return 'PENDING';

  // Fallback por bandera booleana en verificación.
  if (typeof row?.verification?.success === 'boolean') {
    return row.verification.success ? 'WIN' : 'LOSS';
  }
  return 'UNKNOWN';
}

function normalizeSignalState(row) {
  if (row.signal_emitted === true) return 'emitidas';
  if (row.suppression_reason) return 'suprimidas';
  const status = String(row.status || '').toLowerCase();
  if (status === 'pendiente') return 'pendientes';
  if (status === 'suprimida') return 'suprimidas';
  if (status === 'validado') return 'emitidas';
  return 'pendientes';
}

function resolveDirectionalReturnPct(row) {
  // actual_change suele venir como porcentaje en velas_predicciones.verification.actual_change
  const actualChangePct = toNum(row?.verification?.actual_change, NaN);
  const direction = String(row?.direction || '').toLowerCase();
  if (!Number.isFinite(actualChangePct)) return null;

  if (direction === 'up') return actualChangePct;
  if (direction === 'down') return -actualChangePct;
  return null;
}

function resolveMfeMae(row) {
  // 1) Campos explícitos (si existen)
  const mfeExplicit =
    row?.mfe_pct ??
    row?.mfe ??
    row?.max_favorable_move_pct ??
    row?.verification?.mfe_pct ??
    row?.verification?.mfe ??
    row?.verification?.max_favorable_move_pct;
  const maeExplicit =
    row?.mae_pct ??
    row?.mae ??
    row?.max_adverse_move_pct ??
    row?.verification?.mae_pct ??
    row?.verification?.mae ??
    row?.verification?.max_adverse_move_pct;

  if (Number.isFinite(Number(mfeExplicit)) && Number.isFinite(Number(maeExplicit))) {
    return {
      mfe: Number(mfeExplicit),
      mae: Number(maeExplicit),
      source: 'explicit'
    };
  }

  // 2) Fallback proxy con retorno direccional final
  const dirReturn = resolveDirectionalReturnPct(row);
  if (!Number.isFinite(dirReturn)) {
    return { mfe: null, mae: null, source: 'missing' };
  }
  return {
    mfe: Math.max(dirReturn, 0),
    mae: Math.max(-dirReturn, 0),
    source: 'proxy_from_actual_change'
  };
}

function resolveContextScoreScaled(row) {
  const raw = toNum(row?.context_score, NaN);
  if (!Number.isFinite(raw)) return null;
  // Si está en escala 0..4, escalamos a 0..100 para bucket homogéneo.
  if (raw <= 4) return raw * 25;
  // Si ya viene 0..100 lo dejamos.
  if (raw <= 100) return raw;
  return Math.max(0, Math.min(raw, 100));
}

function resolveContextQuality(row) {
  const cq = toNum(row?.context_quality ?? row?.event_context_filter?.context_quality, NaN);
  if (Number.isFinite(cq)) return Math.max(0, Math.min(cq, 100));
  return resolveContextScoreScaled(row);
}

function resolveVolRatio(row) {
  return toNum(
    row?.volatility_expansion_ratio ?? row?.event_context_filter?.volatility_expansion_ratio,
    NaN
  );
}

function classifyRegime(row) {
  const volRatio = resolveVolRatio(row);
  const direction = String(row?.direction || '').toLowerCase();
  const dirRet = Math.abs(toNum(resolveDirectionalReturnPct(row), NaN));
  const strength = toNum(row?.impulse_metrics?.strength, NaN);
  const rangeBreak = Boolean(row?.range_break_detected ?? row?.event_context_filter?.range_break_detected);

  if (Number.isFinite(volRatio) && volRatio >= 1.2) return 'high_volatility';
  if (Number.isFinite(volRatio) && volRatio > 0 && volRatio <= 0.9) return 'low_volatility';

  if (direction !== 'neutral' && (dirRet >= 0.8 || strength >= 0.7 || rangeBreak)) return 'trend';
  return 'range';
}

function resolveLeadTimes(row) {
  // Si existieran campos exactos en futuro, se priorizan.
  const lead03Explicit = toNum(
    row?.lead_time_03_seconds ?? row?.verification?.lead_time_03_seconds ?? row?.verification?.lead_03_seconds,
    NaN
  );
  const lead05Explicit = toNum(
    row?.lead_time_05_seconds ?? row?.verification?.lead_time_05_seconds ?? row?.verification?.lead_05_seconds,
    NaN
  );
  if (Number.isFinite(lead03Explicit) || Number.isFinite(lead05Explicit)) {
    return {
      lead03: Number.isFinite(lead03Explicit) ? lead03Explicit : null,
      lead05: Number.isFinite(lead05Explicit) ? lead05Explicit : null,
      source: 'explicit'
    };
  }

  // Fallback proxy: delay hasta executed_at de verificación cuando supera umbral de movimiento final.
  const createdAt = toDate(row?.created_at || row?.timestamp);
  const executedAt = toDate(row?.verification?.executed_at);
  const dirRet = resolveDirectionalReturnPct(row);
  if (!createdAt || !executedAt || !Number.isFinite(dirRet)) {
    return { lead03: null, lead05: null, source: 'missing' };
  }
  const delaySec = (executedAt.getTime() - createdAt.getTime()) / 1000;
  return {
    lead03: Math.abs(dirRet) >= 0.3 ? delaySec : null,
    lead05: Math.abs(dirRet) >= 0.5 ? delaySec : null,
    source: 'proxy_verification_delay'
  };
}

function buildBucket(value) {
  if (value == null || !Number.isFinite(value)) return 'unknown';
  if (value < 20) return '0-20';
  if (value < 40) return '20-40';
  if (value < 60) return '40-60';
  if (value < 80) return '60-80';
  return '80-100';
}

function calcWinRate(rows) {
  const verified = rows.filter((r) => r.outcome === 'WIN' || r.outcome === 'LOSS');
  if (!verified.length) return null;
  const wins = verified.filter((r) => r.outcome === 'WIN').length;
  return wins / verified.length;
}

function calcWinRateByOutcome(rows, outcomeResolver) {
  if (!Array.isArray(rows) || !rows.length || typeof outcomeResolver !== 'function') {
    return null;
  }
  const normalized = rows
    .map((row) => outcomeResolver(row))
    .filter((outcome) => outcome === 'WIN' || outcome === 'LOSS');
  if (!normalized.length) return null;
  const wins = normalized.filter((outcome) => outcome === 'WIN').length;
  return wins / normalized.length;
}

function calcExpectancy(rows) {
  const directional = rows
    .map((r) => r.directional_return_pct)
    .filter((v) => Number.isFinite(v));
  if (!directional.length) {
    return {
      avg_win: null,
      avg_loss: null,
      expectancy: null,
      win_rate: null,
      loss_rate: null
    };
  }
  const wins = directional.filter((v) => v > 0);
  const losses = directional.filter((v) => v < 0);
  const avgWin = wins.length ? mean(wins) : 0;
  const avgLossAbs = losses.length ? Math.abs(mean(losses)) : 0;
  const winRate = wins.length / directional.length;
  const lossRate = losses.length / directional.length;
  const expectancy = winRate * avgWin - lossRate * avgLossAbs;
  return {
    avg_win: avgWin,
    avg_loss: avgLossAbs,
    expectancy,
    win_rate: winRate,
    loss_rate: lossRate
  };
}

function statsMfeMae(rows) {
  const mfe = rows.map((r) => r.mfe).filter((v) => Number.isFinite(v));
  const mae = rows.map((r) => r.mae).filter((v) => Number.isFinite(v));
  return {
    coverage_mfe: rows.length ? mfe.length / rows.length : 0,
    coverage_mae: rows.length ? mae.length / rows.length : 0,
    mfe: {
      avg: mean(mfe),
      median: median(mfe),
      p75: percentile(mfe, 75),
      p90: percentile(mfe, 90)
    },
    mae: {
      avg: mean(mae),
      median: median(mae),
      p75: percentile(mae, 75),
      p90: percentile(mae, 90)
    }
  };
}

function summarizeState(rows) {
  const total = rows.length;
  const winRate = calcWinRate(rows);
  const expectancy = calcExpectancy(rows);
  const mfeMae = statsMfeMae(rows);
  return {
    total,
    win_rate: winRate,
    expectancy,
    mfe_mae: mfeMae
  };
}

function resolveSuppressedCounterfactualOutcome(row) {
  const raw = String(
    row?.suppressed_verification?.counterfactual_outcome ||
      row?.verification?.suppressed_verification?.counterfactual_outcome ||
      row?.verification?.counterfactual_outcome ||
      row?.counterfactual_outcome ||
      ''
  )
    .trim()
    .toUpperCase();
  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS') || raw.includes('FAIL') || raw.includes('PERD')) return 'LOSS';
  return 'UNKNOWN';
}

async function loadPredictions(options = {}) {
  const days = Math.max(1, Number(options.days || AUDIT_DAYS));
  const maxDocs = Math.max(0, Number(options.maxDocs || 0));
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  if (maxDocs > 0) {
    // Modo rápido para endpoint/UI.
    const snap = await firestore.collection('velas_predicciones').orderBy('created_at', 'desc').limit(maxDocs).get();
    return snap.docs
      .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
      .filter((row) => {
        const created = toDate(row.created_at || row.timestamp);
        return created ? created >= cutoff : false;
      });
  }

  // Modo completo por ventana de días.
  const byId = new Map();

  try {
    const snap = await firestore.collection('velas_predicciones').where('created_at', '>=', cutoff).get();
    snap.docs.forEach((d) => byId.set(d.id, d));
  } catch (err) {
    console.warn('[audit-signal-intelligence] created_at query failed:', err.message);
  }

  try {
    const cutoffIso = cutoff.toISOString();
    const snapTs = await firestore.collection('velas_predicciones').where('timestamp', '>=', cutoffIso).get();
    snapTs.docs.forEach((d) => byId.set(d.id, d));
  } catch (err) {
    console.warn('[audit-signal-intelligence] timestamp query failed:', err.message);
  }

  return Array.from(byId.values()).map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function toAnalysisRow(row) {
  const outcome = normalizeOutcome(row);
  const state = normalizeSignalState(row);
  const mfeMae = resolveMfeMae(row);
  const directionalReturn = resolveDirectionalReturnPct(row);
  const lead = resolveLeadTimes(row);
  const contextScoreScaled = resolveContextScoreScaled(row);
  const contextQuality = resolveContextQuality(row);
  const regime = classifyRegime(row);

  return {
    id: row.id,
    symbol: String(row.simbolo || row.symbol || row.simbolo_normalizado || 'UNKNOWN').toUpperCase(),
    mode: String(row.execution_mode || row.mode || 'unknown').toLowerCase(),
    timeframe: row.timeframe || 'unknown',
    state,
    outcome,
    suppressed_counterfactual_outcome: resolveSuppressedCounterfactualOutcome(row),
    suppressed_verified:
      resolveSuppressedCounterfactualOutcome(row) === 'WIN' ||
      resolveSuppressedCounterfactualOutcome(row) === 'LOSS',
    signal_emitted: Boolean(row.signal_emitted),
    suppression_reason: row.suppression_reason || null,
    direction: String(row.direction || '').toLowerCase(),
    confidence: toNum(row.confianza ?? row.confidence, NaN),
    quantum_score: toNum(row.quantum_score, NaN),
    timing_score: toNum(row.timing_score, NaN),
    context_score: toNum(row.context_score, NaN),
    context_score_scaled: contextScoreScaled,
    context_quality: contextQuality,
    regime,
    directional_return_pct: directionalReturn,
    mfe: mfeMae.mfe,
    mae: mfeMae.mae,
    mfe_mae_source: mfeMae.source,
    lead_time_03_seconds: lead.lead03,
    lead_time_05_seconds: lead.lead05,
    lead_time_source: lead.source,
    created_at: toDate(row.created_at || row.timestamp)?.toISOString() || null
  };
}

function groupBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => {
    const key = keyFn(row);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(row);
  });
  return map;
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
  const lines = [headers.join(',')];
  rows.forEach((row) => {
    lines.push(headers.map((h) => esc(row[h])).join(','));
  });
  return lines.join('\n');
}

async function run(options = {}) {
  const days = Math.max(1, Number(options.days || AUDIT_DAYS));
  const maxDocs = Math.max(0, Number(options.maxDocs || 0));
  const writeFiles = options.writeFiles !== false;
  const reportJsonPath = options.reportJsonPath || REPORT_JSON_PATH;
  const reportCsvPath = options.reportCsvPath || REPORT_CSV_PATH;
  console.log('Signal Intelligence Audit (read-only)');
  const raw = await loadPredictions({ days, maxDocs });
  const rows = raw.map(toAnalysisRow);

  const byState = groupBy(rows, (r) => r.state);
  const emitted = byState.get('emitidas') || [];
  const suppressed = byState.get('suprimidas') || [];
  const pending = byState.get('pendientes') || [];

  const summaryStates = {
    emitidas: summarizeState(emitted),
    suprimidas: summarizeState(suppressed),
    pendientes: summarizeState(pending),
    global: summarizeState(rows)
  };
  const suppressedWinRateVerified = calcWinRateByOutcome(
    suppressed,
    (row) => row.suppressed_counterfactual_outcome
  );
  const suppressedVerifiedCount = suppressed.filter((row) => row.suppressed_verified).length;
  const suppressedUnverifiedCount = Math.max(0, suppressed.length - suppressedVerifiedCount);

  // 4) Lead time
  const lead03 = rows.map((r) => r.lead_time_03_seconds).filter((v) => Number.isFinite(v));
  const lead05 = rows.map((r) => r.lead_time_05_seconds).filter((v) => Number.isFinite(v));
  const leadTime = {
    method_note:
      'Si no existen timestamps explícitos de umbral, se usa proxy: delay entre created_at y verification.executed_at cuando el movimiento final supera 0.3%/0.5%.',
    threshold_03: {
      n: lead03.length,
      avg: mean(lead03),
      p50: percentile(lead03, 50),
      p75: percentile(lead03, 75)
    },
    threshold_05: {
      n: lead05.length,
      avg: mean(lead05),
      p50: percentile(lead05, 50),
      p75: percentile(lead05, 75)
    }
  };

  // 5) Performance por régimen
  const regimePerformance = {};
  for (const [regime, subset] of groupBy(rows, (r) => r.regime).entries()) {
    regimePerformance[regime] = summarizeState(subset);
  }

  // 6) Performance por símbolo
  const symbolPerformance = Array.from(groupBy(rows, (r) => r.symbol).entries()).map(([symbol, subset]) => {
    const s = summarizeState(subset);
    return {
      symbol,
      total_signals: s.total,
      win_rate: s.win_rate,
      avg_mfe: s.mfe_mae.mfe.avg,
      avg_mae: s.mfe_mae.mae.avg,
      expectancy: s.expectancy.expectancy
    };
  });
  symbolPerformance.sort((a, b) => (toNum(b.expectancy, -9999) - toNum(a.expectancy, -9999)));

  // 7) Impacto event_context_filter (emitidas vs suprimidas)
  const impact = {
    emitted: summarizeState(emitted),
    suppressed: summarizeState(suppressed),
    delta_win_rate: null,
    delta_mfe: null,
    delta_expectancy: null
  };
  if (impact.emitted.win_rate != null && impact.suppressed.win_rate != null) {
    impact.delta_win_rate = impact.emitted.win_rate - impact.suppressed.win_rate;
  }
  if (impact.emitted.mfe_mae.mfe.avg != null && impact.suppressed.mfe_mae.mfe.avg != null) {
    impact.delta_mfe = impact.emitted.mfe_mae.mfe.avg - impact.suppressed.mfe_mae.mfe.avg;
  }
  if (impact.emitted.expectancy.expectancy != null && impact.suppressed.expectancy.expectancy != null) {
    impact.delta_expectancy = impact.emitted.expectancy.expectancy - impact.suppressed.expectancy.expectancy;
  }

  // 8) Relación context_score/context_quality vs resultado
  const byContextScoreBucket = Array.from(groupBy(rows, (r) => buildBucket(r.context_score_scaled)).entries()).map(
    ([bucket, subset]) => ({
      bucket,
      total: subset.length,
      win_rate: calcWinRate(subset),
      expectancy: calcExpectancy(subset).expectancy
    })
  );
  const byContextQualityBucket = Array.from(groupBy(rows, (r) => buildBucket(r.context_quality)).entries()).map(
    ([bucket, subset]) => ({
      bucket,
      total: subset.length,
      win_rate: calcWinRate(subset),
      expectancy: calcExpectancy(subset).expectancy
    })
  );

  byContextScoreBucket.sort((a, b) => a.bucket.localeCompare(b.bucket));
  byContextQualityBucket.sort((a, b) => a.bucket.localeCompare(b.bucket));

  const report = {
    generated_at: new Date().toISOString(),
    window_days: days,
    source_limit_docs: maxDocs > 0 ? maxDocs : null,
    totals: {
      total_signals: rows.length,
      emitted: emitted.length,
      suppressed: suppressed.length,
      pending: pending.length,
      suppressed_verified: suppressedVerifiedCount,
      suppressed_unverified: suppressedUnverifiedCount
    },
    win_rates: {
      win_rate_emitidas: summaryStates.emitidas.win_rate,
      win_rate_suprimidas: suppressedWinRateVerified,
      win_rate_global: summaryStates.global.win_rate
    },
    states: summaryStates,
    lead_time: leadTime,
    regime_performance: regimePerformance,
    symbol_performance: symbolPerformance,
    event_context_filter_impact: impact,
    context_score_buckets: byContextScoreBucket,
    context_quality_buckets: byContextQualityBucket
  };

  // CSV "flat" para consumo rápido
  const csvRows = [];
  csvRows.push({
    section: 'totals',
    key: 'total_signals',
    value: report.totals.total_signals
  });
  csvRows.push({ section: 'totals', key: 'emitted', value: report.totals.emitted });
  csvRows.push({ section: 'totals', key: 'suppressed', value: report.totals.suppressed });
  csvRows.push({ section: 'totals', key: 'suppressed_verified', value: report.totals.suppressed_verified });
  csvRows.push({ section: 'totals', key: 'suppressed_unverified', value: report.totals.suppressed_unverified });
  csvRows.push({ section: 'totals', key: 'pending', value: report.totals.pending });

  csvRows.push({
    section: 'win_rates',
    key: 'win_rate_emitidas_pct',
    value: pct(report.win_rates.win_rate_emitidas)
  });
  csvRows.push({
    section: 'win_rates',
    key: 'win_rate_suprimidas_pct',
    value: pct(report.win_rates.win_rate_suprimidas)
  });
  csvRows.push({
    section: 'win_rates',
    key: 'win_rate_global_pct',
    value: pct(report.win_rates.win_rate_global)
  });

  symbolPerformance.forEach((row) => {
    csvRows.push({
      section: 'symbol_performance',
      key: row.symbol,
      total_signals: row.total_signals,
      win_rate_pct: pct(row.win_rate),
      avg_mfe_pct: row.avg_mfe,
      avg_mae_pct: row.avg_mae,
      expectancy_pct: row.expectancy
    });
  });

  byContextQualityBucket.forEach((row) => {
    csvRows.push({
      section: 'context_quality_bucket',
      key: row.bucket,
      total: row.total,
      win_rate_pct: pct(row.win_rate),
      expectancy_pct: row.expectancy
    });
  });

  if (writeFiles) {
    fs.writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(reportCsvPath, toCsv(csvRows), 'utf8');
  }

  // Resumen de consola
  console.log('\nResumen');
  console.table({
    total_signals: report.totals.total_signals,
    emitted: report.totals.emitted,
    suppressed: report.totals.suppressed,
    pending: report.totals.pending,
    win_rate_emitidas_pct: pct(report.win_rates.win_rate_emitidas),
    win_rate_suprimidas_pct: pct(report.win_rates.win_rate_suprimidas),
    win_rate_global_pct: pct(report.win_rates.win_rate_global),
    expectancy_emitidas_pct: report.states.emitidas.expectancy.expectancy,
    expectancy_global_pct: report.states.global.expectancy.expectancy
  });

  console.log('\nLead time');
  console.table({
    lead_03_n: report.lead_time.threshold_03.n,
    lead_03_avg_s: report.lead_time.threshold_03.avg,
    lead_03_p50_s: report.lead_time.threshold_03.p50,
    lead_03_p75_s: report.lead_time.threshold_03.p75,
    lead_05_n: report.lead_time.threshold_05.n,
    lead_05_avg_s: report.lead_time.threshold_05.avg,
    lead_05_p50_s: report.lead_time.threshold_05.p50,
    lead_05_p75_s: report.lead_time.threshold_05.p75
  });

  if (writeFiles) {
    console.log(`\nJSON: ${reportJsonPath}`);
    console.log(`CSV: ${reportCsvPath}`);
  }

  return report;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error en audit-signal-intelligence:', err);
    process.exit(1);
  });
}

module.exports = { run };
