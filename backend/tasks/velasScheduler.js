const db = require('../firebase-admin-config');
const { FieldValue } = require('firebase-admin/firestore');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const { getTopBinanceFuturesSymbols } = require('../services/market/binanceSymbols');
const prediccionVelas = require('../scripts/prediccionVelas');
const verificarPrediccionVelas = require('../scripts/verificacionVelas');
const { run: runLearning } = require('../scripts/learning/learnFromCandleOutcomes');
const { run: runAudit } = require('../scripts/audit-predictive-certainty');
const { predictFromCandles } = require('../lib/velasPredictor');
const { runBinancePositionManagerCycle } = require('../lib/binancePositionManager');

const DEFAULT_PREDICTION_CONFIG = [
  { symbol: 'BTC-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'ETH-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'DOGE-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'HBAR-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'SOL-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'ADA-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'XRP-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'BNB-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'AVAX-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'LINK-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'MATIC-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'DOT-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'LTC-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'BCH-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'TRX-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'SHIB-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'TON-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'NEAR-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'ATOM-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'ICP-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'XLM-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'OP-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'ARB-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'INJ-USD', timeframe: '5m', execution_mode: 'event_driven' },
  { symbol: 'APT-USD', timeframe: '5m', execution_mode: 'event_driven' }
];

const PREDICTION_CONFIG = (() => {
  const raw = process.env.PREDICTION_CONFIG;
  if (!raw) {
    return DEFAULT_PREDICTION_CONFIG;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error('PREDICTION_CONFIG must be a JSON array');
    }
    return parsed;
  } catch (err) {
    console.warn('[CRON] Invalid PREDICTION_CONFIG, using default', err.message);
    return DEFAULT_PREDICTION_CONFIG;
  }
})();

const MIN_VERIFICATION_AGE_SECONDS = 60;
// FEATURE_VELAS_MODEL_ENABLED toggles the feature-based candle model (writes to velas_probabilities).
const FEATURE_VELAS_MODEL_ENABLED = process.env.FEATURE_VELAS_MODEL_ENABLED === 'true';
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 10));
const SCAN_SYMBOL_TIMEOUT_MS = Math.max(5000, Number(process.env.SCAN_SYMBOL_TIMEOUT_MS || 45000));
const PREALERT_MAX_SYMBOLS = Math.max(1, Number(process.env.PREALERT_MAX_SYMBOLS || 20));
const PREALERT_SCAN_CONCURRENCY = Math.max(1, Number(process.env.PREALERT_SCAN_CONCURRENCY || 6));
const QUALITY_REPORT_DAYS = Math.max(1, Number(process.env.QUALITY_REPORT_DAYS || 30));

const nowIso = () => new Date().toISOString();
let lastPredictionCycleMetrics = null;

async function withTimeout(promise, timeoutMs, label) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`timeout after ${timeoutMs}ms (${label})`));
    }, timeoutMs);
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function mapWithConcurrency(items, concurrency, mapper) {
  if (!Array.isArray(items) || items.length === 0) {
    return;
  }
  const maxWorkers = Math.max(1, Math.min(Number(concurrency) || 1, items.length));
  let index = 0;

  async function worker() {
    while (index < items.length) {
      const currentIndex = index;
      index += 1;
      await mapper(items[currentIndex], currentIndex);
    }
  }

  const workers = Array.from({ length: maxWorkers }, () => worker());
  await Promise.all(workers);
}

function buildDynamicPredictionConfig(symbols) {
  const base =
    PREDICTION_CONFIG.find((item) => item?.timeframe && item?.execution_mode) || {
      timeframe: '5m',
      execution_mode: 'event_driven'
    };

  return symbols.map((symbol) => ({
    symbol,
    timeframe: base.timeframe || '5m',
    execution_mode: base.execution_mode || 'event_driven'
  }));
}

async function resolvePredictionConfig(options = {}) {
  const maxSymbols = Number(options.maxSymbols || 0) || undefined;
  try {
    const symbols = await getTopBinanceFuturesSymbols({ maxSymbols });
    if (Array.isArray(symbols) && symbols.length > 0) {
      const dynamicConfig = buildDynamicPredictionConfig(symbols);
      console.log('[CRON] dynamic symbols loaded', {
        symbols_total: dynamicConfig.length,
        scan_concurrency: SCAN_CONCURRENCY
      });
      return dynamicConfig;
    }
    console.warn('[CRON] dynamic symbols empty, using PREDICTION_CONFIG fallback');
  } catch (err) {
    console.warn('[CRON] dynamic symbols unavailable, using PREDICTION_CONFIG fallback', err.message);
  }
  return PREDICTION_CONFIG;
}

async function runFeatureBasedVelasPredictions(database, predictionConfig) {
  const uniqueKeys = new Set();
  const runs = Array.isArray(predictionConfig) ? predictionConfig : [];

  for (const config of runs) {
    const symbol = config.symbol;
    const timeframe = config.timeframe || '5m';
    if (!symbol) {
      continue;
    }
    const key = `${symbol}-${timeframe}`;
    if (uniqueKeys.has(key)) {
      continue;
    }
    uniqueKeys.add(key);

    try {
      const candles = await fetchCandles(symbol, timeframe);
      const prediction = await predictFromCandles(symbol, candles, { timeframe });
      await database.collection('velas_probabilities').add({
        symbol: prediction.symbol,
        timeframe: prediction.timeframe,
        prob_up: prediction.prob_up,
        prob_down: prediction.prob_down,
        confidence: prediction.confidence,
        signal: prediction.signal,
        indicators_snapshot: prediction.indicators_snapshot,
        created_at: FieldValue.serverTimestamp(),
        mode: 'feature_model_v1'
      });
    } catch (err) {
      console.error('[CRON] feature model failed', { symbol, timeframe, error: err.message });
    }
  }
}

async function runPredictionCycle(options = {}) {
  const cycleType = options.cycleType || 'prediction_cycle';
  const maxSymbols = Number(options.maxSymbols || 0) || undefined;
  const cycleConcurrency = Math.max(1, Number(options.concurrency || SCAN_CONCURRENCY));
  const includeFeatureModel =
    options.includeFeatureModel == null ? FEATURE_VELAS_MODEL_ENABLED : Boolean(options.includeFeatureModel);

  const startedAt = nowIso();
  const cycleStartedMs = Date.now();
  console.log('[CRON] runPredictionCycle started', { startedAt, cycleType });
  const predictionConfig = await resolvePredictionConfig({ maxSymbols });
  let processedOk = 0;
  let failed = 0;
  let signalsEmitted = 0;
  let signalsSuppressed = 0;
  let shadowObserveEmitted = 0;
  let shadowEnforceEmitted = 0;
  let shadowWouldBlock = 0;
  const suppressionReasons = {};

  await mapWithConcurrency(predictionConfig, cycleConcurrency, async (config) => {
    const symbol = config?.symbol || 'n/a';
    const timeframe = config?.timeframe || 'n/a';
    try {
      const result = await withTimeout(
        prediccionVelas({ ...config, monto: 1000 }),
        SCAN_SYMBOL_TIMEOUT_MS,
        `${symbol} ${timeframe}`
      );
      processedOk += 1;
      if (result?.signal_emitted) {
        signalsEmitted += 1;
      } else {
        signalsSuppressed += 1;
        const reason = result?.suppression_reason || result?.decision_post_learning?.suppression_reason;
        if (reason) {
          suppressionReasons[reason] = (suppressionReasons[reason] || 0) + 1;
        }
      }
      const shadow = result?.event_context_filter?.shadow;
      if (shadow?.signal_emitted_observe) shadowObserveEmitted += 1;
      if (shadow?.signal_emitted_enforce) shadowEnforceEmitted += 1;
      if (shadow?.would_block_event) shadowWouldBlock += 1;
      console.log('[CRON] prediction ok', { symbol, timeframe, status: result?.status || 'unknown' });
    } catch (err) {
      failed += 1;
      console.error('[CRON] prediction failed', { symbol, timeframe, error: err.message });
    }
  });

  if (includeFeatureModel) {
    try {
      await runFeatureBasedVelasPredictions(db, predictionConfig);
    } catch (err) {
      console.error('[CRON] feature model cycle failed', err.message);
    }
  }

  const suppressionReasonsTop = Object.entries(suppressionReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  const cycleDurationMs = Date.now() - cycleStartedMs;
  const cycleMetrics = {
    source: cycleType,
    created_at: nowIso(),
    symbols_total: predictionConfig.length,
    processed_ok: processedOk,
    failed,
    signals_emitted: signalsEmitted,
    signals_suppressed: signalsSuppressed,
    shadow_observe_emitted: shadowObserveEmitted,
    shadow_enforce_emitted: shadowEnforceEmitted,
    shadow_would_block: shadowWouldBlock,
    cycle_duration_ms: cycleDurationMs,
    suppression_reasons_top: suppressionReasonsTop
  };
  lastPredictionCycleMetrics = cycleMetrics;

  console.log('[CRON] runPredictionCycle finished', {
    ...cycleMetrics
  });

  try {
    await db.collection('velas_monitoring_snapshots').add(cycleMetrics);
  } catch (err) {
    console.warn('[CRON] monitoring snapshot store failed', err.message);
  }
}

function parseCreatedAtMs(data) {
  const raw = data?.created_at || data?.timestamp || null;
  if (!raw) return 0;
  if (typeof raw?.toDate === 'function') {
    return raw.toDate().getTime();
  }
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function toOutcomeKey(data) {
  const raw =
    data?.verification_outcome ||
    data?.verification?.verification_outcome ||
    data?.verification?.result ||
    data?.verification?.outcome_label ||
    null;
  return raw ? String(raw).toUpperCase() : 'UNKNOWN';
}

function toDateKeyUtc(dateMs) {
  const d = new Date(dateMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

async function buildDailyQualityReport() {
  const nowMs = Date.now();
  const cutoffMs = nowMs - QUALITY_REPORT_DAYS * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('velas_predicciones').limit(3000).get();
  const rows = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => {
      const createdMs = parseCreatedAtMs(row);
      return createdMs && createdMs >= cutoffMs;
    });

  const total = rows.length;
  const verified = rows.filter((row) => toOutcomeKey(row) !== 'UNKNOWN');
  const emittedVerified = verified.filter(
    (row) => row.signal_emitted === true && ['WIN', 'LOSS', 'LUCKY_WIN'].includes(toOutcomeKey(row))
  );
  const suppressedVerified = verified.filter(
    (row) => row.signal_emitted === false && ['WIN', 'LOSS', 'LUCKY_WIN', 'SUPPRESSED'].includes(toOutcomeKey(row))
  );

  const winsEmitted = emittedVerified.filter((row) => ['WIN', 'LUCKY_WIN'].includes(toOutcomeKey(row))).length;
  const lossesEmitted = emittedVerified.filter((row) => toOutcomeKey(row) === 'LOSS').length;
  const winRateEmitted = emittedVerified.length ? (winsEmitted / emittedVerified.length) * 100 : 0;

  const winsSuppressed = suppressedVerified.filter((row) => ['WIN', 'LUCKY_WIN'].includes(toOutcomeKey(row))).length;
  const lossesSuppressed = suppressedVerified.filter((row) => toOutcomeKey(row) === 'LOSS').length;
  const suppressedWinLossBase = winsSuppressed + lossesSuppressed;
  const winRateSuppressed = suppressedWinLossBase ? (winsSuppressed / suppressedWinLossBase) * 100 : null;

  const byDay = {};
  for (const row of emittedVerified) {
    const key = toDateKeyUtc(parseCreatedAtMs(row));
    if (!byDay[key]) byDay[key] = { total: 0, wins: 0, losses: 0 };
    byDay[key].total += 1;
    if (['WIN', 'LUCKY_WIN'].includes(toOutcomeKey(row))) byDay[key].wins += 1;
    if (toOutcomeKey(row) === 'LOSS') byDay[key].losses += 1;
  }
  const dayKeys = Object.keys(byDay).sort();

  const report = {
    source: 'quality_daily_report',
    created_at: nowIso(),
    window_days: QUALITY_REPORT_DAYS,
    totals: {
      total_rows: total,
      verified_rows: verified.length,
      emitted_verified_main: emittedVerified.length,
      suppressed_verified: suppressedVerified.length,
      excluded_non_verified: total - verified.length
    },
    main_study: {
      definition: 'signal_emitted=true AND verification_outcome in [WIN,LOSS,LUCKY_WIN]',
      wins: winsEmitted,
      losses: lossesEmitted,
      win_rate: Number(winRateEmitted.toFixed(2))
    },
    suppressed_block: {
      definition: 'signal_emitted=false AND verification_outcome in [WIN,LOSS,LUCKY_WIN,SUPPRESSED]',
      wins: winsSuppressed,
      losses: lossesSuppressed,
      win_rate: winRateSuppressed == null ? null : Number(winRateSuppressed.toFixed(2))
    },
    daily_main_series: dayKeys.map((day) => ({
      day,
      total: byDay[day].total,
      wins: byDay[day].wins,
      losses: byDay[day].losses,
      win_rate: byDay[day].total ? Number(((byDay[day].wins / byDay[day].total) * 100).toFixed(2)) : 0
    }))
  };

  return report;
}

async function runPreAlertCycle() {
  await runPredictionCycle({
    cycleType: 'prealert_cycle',
    maxSymbols: PREALERT_MAX_SYMBOLS,
    concurrency: PREALERT_SCAN_CONCURRENCY,
    includeFeatureModel: false
  });
  try {
    const managerSummary = await runBinancePositionManagerCycle(db);
    console.log('[CRON] binance position manager', managerSummary);
  } catch (err) {
    console.warn('[CRON] binance position manager failed', err.message);
  }
}

async function runBinanceManagerCycle() {
  const summary = await runBinancePositionManagerCycle(db);
  console.log('[CRON] runBinanceManagerCycle finished', summary);
}

async function runVerificationCycle() {
  const startedAt = nowIso();
  console.log('[CRON] runVerificationCycle started', startedAt);
  let verified = 0;
  let skipped = 0;
  let failed = 0;

  let snapshot;
  try {
    snapshot = await db.collection('velas_predicciones').where('status', '==', 'pendiente').limit(50).get();
  } catch (err) {
    console.error('[CRON] verification query failed', err.message);
    return;
  }

  const cutoff = Date.now() - MIN_VERIFICATION_AGE_SECONDS * 1000;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    const createdAt = data.created_at || data.timestamp;
    const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
    if (createdMs && createdMs > cutoff) {
      skipped += 1;
      continue;
    }
    if (data.completed_at) {
      skipped += 1;
      continue;
    }
    if (data.signal_emitted === false) {
      skipped += 1;
      continue;
    }
    try {
      await verificarPrediccionVelas(doc.id);
      verified += 1;
    } catch (err) {
      failed += 1;
      console.error('[CRON] verification failed', doc.id, err.message);
    }
  }

  console.log('[CRON] runVerificationCycle finished', { total: snapshot.size, verified, skipped, failed });
}

async function runLearningCycle() {
  const startedAt = nowIso();
  console.log('[CRON] runLearningCycle started', startedAt);
  try {
    const result = await runLearning();
    console.log('[CRON] runLearningCycle finished', result || { ok: true });
  } catch (err) {
    console.error('[CRON] runLearningCycle failed', err.message);
  }
}

async function runAuditCycle() {
  const startedAt = nowIso();
  console.log('[CRON] runAuditCycle started', startedAt);
  try {
    const summary = await runAudit();
    if (summary) {
      if (summary.global?.win_rate != null) {
        console.log('[CRON][AUDIT] certainty update', {
          win_rate: Number(summary.global.win_rate.toFixed(2)),
          strict_win_rate: Number((summary.global.strict_win_rate ?? 0).toFixed(2)),
          loss_rate: Number((summary.global.loss_rate ?? 0).toFixed(2)),
          classification: summary.classification || 'n/a'
        });
      } else {
        console.log('[CRON] runAuditCycle summary', summary.classification || summary);
      }
      try {
        await db.collection('velas_audit_snapshots').add({
          created_at: nowIso(),
          summary
        });
      } catch (err) {
        console.warn('[CRON] audit snapshot store failed', err.message);
      }

      try {
        await db.collection('velas_monitoring_snapshots').add({
          source: 'audit_cycle',
          created_at: nowIso(),
          audit: {
            classification: summary.classification || 'n/a',
            global: summary.global || null,
            totals: summary.totals || null
          },
          prediction_cycle: lastPredictionCycleMetrics
        });
      } catch (err) {
        console.warn('[CRON] monitoring audit snapshot store failed', err.message);
      }

      try {
        const dailyReport = await buildDailyQualityReport();
        const dayKey = toDateKeyUtc(Date.now());
        await db.collection('velas_daily_quality_reports').doc(dayKey).set(dailyReport, { merge: true });
        await db.collection('velas_monitoring_snapshots').add({
          source: 'quality_daily_report',
          created_at: nowIso(),
          quality_daily_report: {
            window_days: dailyReport.window_days,
            totals: dailyReport.totals,
            main_study: dailyReport.main_study,
            suppressed_block: dailyReport.suppressed_block
          }
        });
        console.log('[CRON][QUALITY] daily report updated', {
          day: dayKey,
          emitted_verified_main: dailyReport?.totals?.emitted_verified_main ?? 0,
          win_rate_main: dailyReport?.main_study?.win_rate ?? 0,
          suppressed_verified: dailyReport?.totals?.suppressed_verified ?? 0
        });
      } catch (err) {
        console.warn('[CRON] daily quality report failed', err.message);
      }
    }
  } catch (err) {
    console.error('[CRON] runAuditCycle failed', err.message);
  }
}

module.exports = {
  runPredictionCycle,
  runPreAlertCycle,
  runBinanceManagerCycle,
  runVerificationCycle,
  runLearningCycle,
  runAuditCycle
};
