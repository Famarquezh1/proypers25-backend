/**
 * validate-suppressed-signals.js
 *
 * Read-only statistical validation for suppressed signals.
 * Reads suppressed predictions from Firestore, fetches candles after the signal
 * timestamp, evaluates TP/SL first touch in 5m/10m/15m windows, and compares
 * the counterfactual outcome against emitted-signal baseline metrics.
 *
 * Outputs:
 * - backend/scripts/suppressed_validation_report.json
 * - backend/scripts/suppressed_validation_report.csv
 *
 * Usage:
 *   node backend/scripts/validate-suppressed-signals.js
 *
 * Optional env:
 *   AUDIT_DAYS=30
 *   AUDIT_MAX_DOCS=200
 *   AUDIT_CONCURRENCY=6
 */

const fs = require('fs');
const path = require('path');
const { Firestore } = require('@google-cloud/firestore');
const { fetchBinanceCandles } = require('../services/dataSources/binance');

const db = new Firestore();

const WINDOWS_MIN = [5, 10, 15];

const REPORT_JSON_PATH = path.resolve(
  process.cwd(),
  'backend/scripts/suppressed_validation_report.json'
);
const REPORT_CSV_PATH = path.resolve(
  process.cwd(),
  'backend/scripts/suppressed_validation_report.csv'
);

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

function calculateAverage(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) return null;
  return filtered.reduce((sum, v) => sum + v, 0) / filtered.length;
}

function calculatePercentile(values, percentile) {
  const filtered = values.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const idx = (percentile / 100) * (filtered.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return filtered[lo];
  const weight = idx - lo;
  return filtered[lo] * (1 - weight) + filtered[hi] * weight;
}

function normalizeOutcome(value) {
  const raw = String(value || '')
    .trim()
    .toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('WIN')) return 'WIN';
  if (raw.includes('LOSS') || raw.includes('FAIL') || raw.includes('PERD')) return 'LOSS';
  if (raw.includes('PENDING') || raw.includes('PENDIENTE')) return 'PENDING';
  if (raw.includes('AMBIG')) return 'AMBIGUOUS';
  if (raw.includes('SUPP')) return 'SUPPRESSED';
  return 'UNKNOWN';
}

function resolveSymbol(data) {
  return data.symbol || data.simbolo || data.simbolo_normalizado || null;
}

function resolveTimestamp(data) {
  return data.created_at || data.timestamp || null;
}

function resolveDirection(data) {
  const dir = String(data.direction || '').toLowerCase();
  return dir === 'up' || dir === 'down' ? dir : 'neutral';
}

function resolveEntryPrice(data) {
  return (
    toNum(data.entry_price) ??
    toNum(data.trade_plan?.entry_price) ??
    toNum(data.precio_actual) ??
    toNum(data.spot_price)
  );
}

function resolveTP(data) {
  return (
    toNum(data.tp) ??
    toNum(data.take_profit) ??
    toNum(data.trade_plan?.take_profit) ??
    toNum(data.trade_plan?.target_exit_price) ??
    toNum(data.precio_estimado) ??
    toNum(data.model_price_estimate)
  );
}

function resolveSL(data) {
  return toNum(data.sl) ?? toNum(data.stop_loss) ?? toNum(data.trade_plan?.stop_loss);
}

function resolveTimeframe(data) {
  return data.timeframe || '5m';
}

function resolveContextQuality(data) {
  return toNum(data.context_quality ?? data.event_context_filter?.context_quality);
}

function resolveEmittedOutcome(data) {
  return normalizeOutcome(
    data?.verification_outcome ||
      data?.verification?.verification_outcome ||
      data?.verification?.outcome_label ||
      data?.status
  );
}

function resolveDirectionalReturnPctEmitted(data) {
  const actualChange = toNum(data?.verification?.actual_change);
  const direction = resolveDirection(data);
  if (!Number.isFinite(actualChange) || direction === 'neutral') return null;
  return direction === 'up' ? actualChange : -actualChange;
}

function calcWinRate(rowsOrOutcomes) {
  const outcomes = rowsOrOutcomes.map((item) =>
    typeof item === 'string' ? item : normalizeOutcome(item?.result)
  );
  const classified = outcomes.filter((o) => o === 'WIN' || o === 'LOSS');
  if (!classified.length) return null;
  const wins = classified.filter((o) => o === 'WIN').length;
  return wins / classified.length;
}

function calcExpectancyFromRows(rows) {
  const wins = rows.filter((r) => r.result === 'WIN');
  const losses = rows.filter((r) => r.result === 'LOSS');
  const winRate = wins.length + losses.length > 0 ? wins.length / (wins.length + losses.length) : null;
  const avgWin = calculateAverage(wins.map((r) => r.mfe));
  const avgLoss = calculateAverage(losses.map((r) => r.mae));
  const expectancy =
    winRate != null
      ? (winRate * (avgWin || 0)) - ((1 - winRate) * (avgLoss || 0))
      : null;
  return {
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    expectancy
  };
}

function calcExpectancyFromDirectionalReturns(values) {
  const filtered = values.filter((v) => Number.isFinite(v));
  if (!filtered.length) {
    return { avg_win: null, avg_loss: null, expectancy: null, win_rate: null };
  }
  const wins = filtered.filter((v) => v > 0);
  const losses = filtered.filter((v) => v < 0).map((v) => Math.abs(v));
  const winRate = wins.length / filtered.length;
  const avgWin = calculateAverage(wins);
  const avgLoss = calculateAverage(losses);
  const expectancy = winRate * (avgWin || 0) - (1 - winRate) * (avgLoss || 0);
  return {
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    expectancy
  };
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
  return [headers.join(','), ...rows.map((row) => headers.map((h) => esc(row[h])).join(','))].join('\n');
}

async function runWithConcurrency(items, limit, worker) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const current = index++;
      try {
        results[current] = await worker(items[current], current);
      } catch (err) {
        results[current] = {
          ...items[current],
          analysis_status: 'error',
          error: err?.message || String(err)
        };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => next()));
  return results;
}

async function loadSuppressedCandidates(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await db.collection('velas_predicciones').where('signal_emitted', '==', false).limit(maxDocs).get();

  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      return {
        id: doc.id,
        symbol: resolveSymbol(data),
        timestamp: resolveTimestamp(data),
        direction: resolveDirection(data),
        entry_price: resolveEntryPrice(data),
        tp: resolveTP(data),
        sl: resolveSL(data),
        timeframe: resolveTimeframe(data),
        suppression_reason: data.suppression_reason || null,
        context_quality: resolveContextQuality(data),
        source_data: data
      };
    })
    .filter((row) => row.suppression_reason != null && row.suppression_reason !== '')
    .filter((row) => {
      const ts = toDate(row.timestamp);
      return ts && ts.getTime() >= cutoffMs;
    })
    .sort((a, b) => toDate(b.timestamp) - toDate(a.timestamp));
}

async function loadEmittedBaseline(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await db.collection('velas_predicciones').where('signal_emitted', '==', true).limit(maxDocs).get();

  const rows = snap.docs
    .map((doc) => doc.data() || {})
    .filter((data) => {
      const ts = toDate(resolveTimestamp(data));
      return ts && ts.getTime() >= cutoffMs;
    });

  const outcomes = rows.map(resolveEmittedOutcome);
  const directionalReturns = rows.map(resolveDirectionalReturnPctEmitted);
  const expectancy = calcExpectancyFromDirectionalReturns(directionalReturns);

  const mfeEmitidas = directionalReturns.map((v) => (Number.isFinite(v) ? Math.max(v, 0) : null));
  const maeEmitidas = directionalReturns.map((v) => (Number.isFinite(v) ? Math.max(-v, 0) : null));

  return {
    total_signals: rows.length,
    win_rate_emitidas: calcWinRate(outcomes),
    expectancy_emitidas: expectancy.expectancy,
    mfe_emitidas_promedio: calculateAverage(mfeEmitidas),
    mfe_emitidas_p75: calculatePercentile(mfeEmitidas, 75),
    mfe_emitidas_p90: calculatePercentile(mfeEmitidas, 90),
    mae_emitidas_promedio: calculateAverage(maeEmitidas),
    mae_emitidas_p75: calculatePercentile(maeEmitidas, 75),
    mae_emitidas_p90: calculatePercentile(maeEmitidas, 90)
  };
}

async function fetchCandlesAfterTimestamp(symbol, timeframe, timestamp) {
  const candles = await fetchBinanceCandles(symbol, timeframe);
  const t0Ms = toDate(timestamp)?.getTime();
  return (candles || [])
    .filter((c) => {
      const ts = new Date(c.timestamp).getTime();
      return Number.isFinite(ts) && Number.isFinite(t0Ms) && ts >= t0Ms;
    })
    .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
}

function candlesWithinMinutes(candlesAfter, t0Ms, minutes) {
  const endMs = t0Ms + minutes * 60 * 1000;
  return candlesAfter.filter((c) => {
    const ts = new Date(c.timestamp).getTime();
    return ts >= t0Ms && ts <= endMs;
  });
}

function evaluateTpSlFirstTouch(signal, candles) {
  let tp_touch_at = null;
  let sl_touch_at = null;
  let first_touch = 'NONE';

  for (const c of candles) {
    const high = toNum(c.high);
    const low = toNum(c.low);
    const ts = c.timestamp;

    const touchedTP =
      Number.isFinite(signal.tp) &&
      (signal.direction === 'up' ? high >= signal.tp : signal.direction === 'down' ? low <= signal.tp : false);
    const touchedSL =
      Number.isFinite(signal.sl) &&
      (signal.direction === 'up' ? low <= signal.sl : signal.direction === 'down' ? high >= signal.sl : false);

    if (touchedTP && !tp_touch_at) tp_touch_at = ts;
    if (touchedSL && !sl_touch_at) sl_touch_at = ts;

    if (touchedTP || touchedSL) {
      if (touchedTP && touchedSL) first_touch = 'AMBIGUOUS_SAME_CANDLE';
      else if (touchedTP) first_touch = 'TP';
      else first_touch = 'SL';
      break;
    }
  }

  const result = first_touch === 'TP' ? 'WIN' : first_touch === 'SL' ? 'LOSS' : 'NONE';

  return {
    result,
    tp_hit: !!tp_touch_at,
    sl_hit: !!sl_touch_at,
    first_touch,
    tp_touch_at,
    sl_touch_at
  };
}

function calculateMfe(signal, candles) {
  if (!Number.isFinite(signal.entry_price) || !candles.length) return null;
  let mfe = 0;
  for (const c of candles) {
    const high = toNum(c.high);
    const low = toNum(c.low);
    let favorableMovePct = 0;
    if (signal.direction === 'up' && Number.isFinite(high)) {
      favorableMovePct = ((high - signal.entry_price) / signal.entry_price) * 100;
    } else if (signal.direction === 'down' && Number.isFinite(low)) {
      favorableMovePct = ((signal.entry_price - low) / signal.entry_price) * 100;
    }
    if (favorableMovePct > mfe) mfe = favorableMovePct;
  }
  return mfe;
}

function calculateMae(signal, candles) {
  if (!Number.isFinite(signal.entry_price) || !candles.length) return null;
  let mae = 0;
  for (const c of candles) {
    const high = toNum(c.high);
    const low = toNum(c.low);
    let adverseMovePct = 0;
    if (signal.direction === 'up' && Number.isFinite(low)) {
      adverseMovePct = ((signal.entry_price - low) / signal.entry_price) * 100;
    } else if (signal.direction === 'down' && Number.isFinite(high)) {
      adverseMovePct = ((high - signal.entry_price) / signal.entry_price) * 100;
    }
    if (adverseMovePct > mae) mae = adverseMovePct;
  }
  return mae;
}

function timeToMovePct(signal, candles, thresholdPct) {
  if (!Number.isFinite(signal.entry_price) || !candles.length) return null;
  const startTs = new Date(candles[0].timestamp).getTime();
  for (const c of candles) {
    const high = toNum(c.high);
    const low = toNum(c.low);
    const ts = new Date(c.timestamp).getTime();
    const favorableMovePct =
      signal.direction === 'up'
        ? ((high - signal.entry_price) / signal.entry_price) * 100
        : signal.direction === 'down'
          ? ((signal.entry_price - low) / signal.entry_price) * 100
          : 0;
    if (favorableMovePct >= thresholdPct) {
      return (ts - startTs) / 1000;
    }
  }
  return null;
}

async function analyzeSuppressedSignal(signal) {
  const t0 = toDate(signal.timestamp);
  if (!t0 || !signal.symbol || signal.direction === 'neutral') {
    return { ...signal, analysis_status: 'skipped_invalid_input' };
  }

  const candlesAfter = await fetchCandlesAfterTimestamp(signal.symbol, signal.timeframe, signal.timestamp);
  if (!candlesAfter.length) {
    return { ...signal, analysis_status: 'no_candles_after_timestamp' };
  }

  const t0Ms = t0.getTime();
  const byWindow = {};

  for (const minutes of WINDOWS_MIN) {
    const candles = candlesWithinMinutes(candlesAfter, t0Ms, minutes);
    const outcome = evaluateTpSlFirstTouch(signal, candles);
    const mfe = calculateMfe(signal, candles);
    const mae = calculateMae(signal, candles);
    const time_to_tp =
      outcome.tp_touch_at && signal.timestamp
        ? (new Date(outcome.tp_touch_at).getTime() - new Date(signal.timestamp).getTime()) / 1000
        : null;
    const time_to_sl =
      outcome.sl_touch_at && signal.timestamp
        ? (new Date(outcome.sl_touch_at).getTime() - new Date(signal.timestamp).getTime()) / 1000
        : null;

    byWindow[minutes] = {
      result: outcome.result,
      reached_tp: outcome.first_touch === 'TP',
      time_to_tp,
      time_to_sl,
      tp_hit: outcome.tp_hit,
      sl_hit: outcome.sl_hit,
      first_touch: outcome.first_touch,
      mfe,
      mae,
      time_to_move_03: timeToMovePct(signal, candles, 0.3),
      time_to_move_05: timeToMovePct(signal, candles, 0.5)
    };
  }

  const result10 = byWindow[10] || {};
  return {
    prediction_id: signal.id || null,
    symbol: signal.symbol,
    timestamp: signal.timestamp,
    direction: signal.direction,
    entry_price: signal.entry_price,
    tp: signal.tp,
    sl: signal.sl,
    timeframe: signal.timeframe,
    context_quality: signal.context_quality ?? null,
    analysis_status: 'ok',
    result_5m: byWindow[5]?.result || 'NONE',
    mfe_5m: byWindow[5]?.mfe ?? null,
    mae_5m: byWindow[5]?.mae ?? null,
    result_10m: byWindow[10]?.result || 'NONE',
    tp_hit_10m: !!byWindow[10]?.tp_hit,
    sl_hit_10m: !!byWindow[10]?.sl_hit,
    first_touch_10m: byWindow[10]?.first_touch || 'NONE',
    time_to_tp: result10.time_to_tp ?? null,
    time_to_sl: result10.time_to_sl ?? null,
    time_to_move_03: result10.time_to_move_03 ?? null,
    time_to_move_05: result10.time_to_move_05 ?? null,
    result: result10.result || 'NONE',
    mfe: result10.mfe ?? null,
    mae: result10.mae ?? null,
    result_15m: byWindow[15]?.result || 'NONE',
    mfe_15m: byWindow[15]?.mfe ?? null,
    mae_15m: byWindow[15]?.mae ?? null
  };
}

function buildContextQualityBuckets(reportRows) {
  return {
    '0-20': reportRows.filter((r) => (r.context_quality ?? 0) >= 0 && (r.context_quality ?? 0) < 20),
    '20-40': reportRows.filter((r) => (r.context_quality ?? 0) >= 20 && (r.context_quality ?? 0) < 40),
    '40-60': reportRows.filter((r) => (r.context_quality ?? 0) >= 40 && (r.context_quality ?? 0) < 60),
    '60-80': reportRows.filter((r) => (r.context_quality ?? 0) >= 60 && (r.context_quality ?? 0) < 80),
    '80-100': reportRows.filter((r) => (r.context_quality ?? 0) >= 80)
  };
}

async function run(options = {}) {
  const auditDays = Math.max(1, Number(options.days || process.env.AUDIT_DAYS || 30));
  const auditMaxDocs = Math.max(1, Number(options.maxDocs || process.env.AUDIT_MAX_DOCS || 200));
  const auditConcurrency = Math.max(1, Number(options.concurrency || process.env.AUDIT_CONCURRENCY || 6));
  const writeFiles = options.writeFiles !== false;

  console.log('[validate-suppressed-signals] starting...');

  const [suppressedSignals, emittedBaseline] = await Promise.all([
    loadSuppressedCandidates(auditDays, auditMaxDocs),
    loadEmittedBaseline(auditDays, auditMaxDocs)
  ]);

  const analyzed = await runWithConcurrency(suppressedSignals, auditConcurrency, analyzeSuppressedSignal);
  const reportRows = analyzed.filter((row) => row.analysis_status === 'ok');

  const total_suppressed = reportRows.length;
  const wins = reportRows.filter((r) => r.result === 'WIN').length;
  const losses = reportRows.filter((r) => r.result === 'LOSS').length;
  const win_rate_suprimidas = wins + losses > 0 ? wins / (wins + losses) : null;
  const expectancyRows = calcExpectancyFromRows(reportRows);
  const expectancy_suprimidas = expectancyRows.expectancy;

  const mfe_promedio = calculateAverage(reportRows.map((r) => r.mfe));
  const mfe_p75 = calculatePercentile(reportRows.map((r) => r.mfe), 75);
  const mfe_p90 = calculatePercentile(reportRows.map((r) => r.mfe), 90);
  const mae_promedio = calculateAverage(reportRows.map((r) => r.mae));
  const mae_p75 = calculatePercentile(reportRows.map((r) => r.mae), 75);
  const mae_p90 = calculatePercentile(reportRows.map((r) => r.mae), 90);

  const delta_win_rate =
    emittedBaseline.win_rate_emitidas != null && win_rate_suprimidas != null
      ? emittedBaseline.win_rate_emitidas - win_rate_suprimidas
      : null;
  const delta_expectancy =
    emittedBaseline.expectancy_emitidas != null && expectancy_suprimidas != null
      ? emittedBaseline.expectancy_emitidas - expectancy_suprimidas
      : null;
  const delta_MFE =
    emittedBaseline.mfe_emitidas_promedio != null && mfe_promedio != null
      ? emittedBaseline.mfe_emitidas_promedio - mfe_promedio
      : null;
  const delta_MAE =
    emittedBaseline.mae_emitidas_promedio != null && mae_promedio != null
      ? emittedBaseline.mae_emitidas_promedio - mae_promedio
      : null;

  const lead_time_avg = calculateAverage(reportRows.map((r) => r.time_to_move_03));
  const lead_time_p50 = calculatePercentile(reportRows.map((r) => r.time_to_move_03), 50);
  const lead_time_p75 = calculatePercentile(reportRows.map((r) => r.time_to_move_03), 75);

  const groupedBySymbol = reportRows.reduce((acc, row) => {
    const symbol = row.symbol || 'UNKNOWN';
    if (!acc[symbol]) acc[symbol] = [];
    acc[symbol].push(row);
    return acc;
  }, {});

  const performanceBySymbol = Object.entries(groupedBySymbol)
    .map(([symbol, rows]) => {
      const rowExpectancy = calcExpectancyFromRows(rows);
      return {
        symbol,
        total_signals: rows.length,
        win_rate: calcWinRate(rows),
        expectancy: rowExpectancy.expectancy,
        avg_MFE: calculateAverage(rows.map((r) => r.mfe)),
        avg_MAE: calculateAverage(rows.map((r) => r.mae))
      };
    })
    .sort((a, b) => (b.expectancy ?? -Infinity) - (a.expectancy ?? -Infinity));

  const contextQualityBuckets = buildContextQualityBuckets(reportRows);
  const contextQualityByBucket = Object.entries(contextQualityBuckets).map(([bucket, rows]) => {
    const expectancy = calcExpectancyFromRows(rows);
    return {
      bucket,
      total_signals: rows.length,
      win_rate: calcWinRate(rows),
      expectancy: expectancy.expectancy,
      MFE: calculateAverage(rows.map((r) => r.mfe))
    };
  });

  const report = {
    generated_at: new Date().toISOString(),
    config: {
      audit_days: auditDays,
      audit_max_docs: auditMaxDocs,
      audit_concurrency: auditConcurrency
    },
    suppressed_summary: {
      total_suppressed,
      wins,
      losses,
      win_rate_suprimidas,
      expectancy_suprimidas,
      mfe_promedio,
      mfe_p75,
      mfe_p90,
      mae_promedio,
      mae_p75,
      mae_p90
    },
    emitted_baseline: emittedBaseline,
    comparative_analysis: {
      delta_win_rate,
      delta_expectancy,
      delta_MFE,
      delta_MAE
    },
    lead_time: {
      lead_time_avg,
      lead_time_p50,
      lead_time_p75
    },
    performance_by_symbol: performanceBySymbol,
    context_quality: {
      field_registered_count: reportRows.filter((r) => Number.isFinite(r.context_quality)).length,
      buckets: contextQualityByBucket
    },
    per_signal: reportRows
  };

  const csvRows = reportRows.map((row) => ({
    prediction_id: row.prediction_id,
    symbol: row.symbol,
    timestamp: row.timestamp,
    direction: row.direction,
    timeframe: row.timeframe,
    context_quality: row.context_quality,
    result: row.result,
    mfe: row.mfe,
    mae: row.mae,
    time_to_tp: row.time_to_tp,
    time_to_sl: row.time_to_sl,
    time_to_move_03: row.time_to_move_03,
    time_to_move_05: row.time_to_move_05
  }));

  if (writeFiles) {
    fs.writeFileSync(REPORT_JSON_PATH, JSON.stringify(report, null, 2), 'utf8');
    fs.writeFileSync(REPORT_CSV_PATH, toCsv(csvRows), 'utf8');
  }

  const top_symbols_by_edge = performanceBySymbol.slice(0, 10);

  console.log('\nSuppressed Validation Summary');
  console.table({
    total_suppressed,
    win_rate_suprimidas,
    expectancy_suprimidas,
    delta_vs_emitidas: delta_expectancy,
    lead_time_avg
  });

  console.log('\nTop Symbols By Edge');
  console.table(top_symbols_by_edge);

  if (writeFiles) {
    console.log(`\nJSON: ${REPORT_JSON_PATH}`);
    console.log(`CSV: ${REPORT_CSV_PATH}`);
  }

  return report;
}

if (require.main === module) {
  run().catch((err) => {
    console.error('Error en validate-suppressed-signals:', err);
    process.exit(1);
  });
}

module.exports = { run };
