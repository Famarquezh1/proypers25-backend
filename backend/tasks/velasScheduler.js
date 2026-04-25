const db = require('../firebase-admin-config');
const { FieldValue } = require('firebase-admin/firestore');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const {
  FETCH_TIMEOUT_MS,
  BINANCE_CONCURRENCY_LIMIT,
  getBinanceConcurrencySnapshot
} = require('../services/dataSources/binance');
const {
  ACTIVE_SYMBOLS,
  getTopBinanceFuturesSymbols
} = require('../services/market/binanceSymbols');
const prediccionVelas = require('../scripts/prediccionVelas');
const verificarPrediccionVelas = require('../scripts/verificacionVelas');
const { run: runLearning } = require('../scripts/learning/learnFromCandleOutcomes');
const { run: runAudit } = require('../scripts/audit-predictive-certainty');
const { refreshSignalIntelligenceDashboardSnapshot } = require('../lib/signalIntelligenceDashboard');
const { predictFromCandles } = require('../lib/velasPredictor');
const { runBinancePositionManagerCycle } = require('../lib/binancePositionManager');
const { warmExchangeInfoCache } = require('../lib/binanceFuturesExecutor');
const { processImpulseSignals } = require('../services/impulseExecutionEngine');
const { syncOperationalMarketObservation, getMarketSnapshot } = require('../services/market/marketStreamWorker');
const { reapStaleProcessingIntents } = require('../services/execution/intentWatchdog');
const { reapStalePendingPredictions } = require('../services/execution/pendingPredictionWatchdog');
const { runExploitationEngine } = require('../engines/exploitation_engine');
const { computeAdaptiveProfile, persistAdaptiveProfile } = require('../engines/adaptive_memory');
const {
  FETCH_BUFFER,
  selectPredictionConfigs,
  recordSymbolOutcome
} = require('../lib/predictionSymbolRuntime');
const {
  detectSymbolImpulse,
  getDetectedImpulses,
  calculateImpulse,
  getVolumeData,
  getKlines
} = require('../services/impulseDetector');

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
const PREDICTION_TIMEOUT_MS = Math.max(25000, Number(process.env.PREDICTION_TIMEOUT_MS || 25000));
const SCAN_CONCURRENCY = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 10));
const SCAN_SYMBOL_TIMEOUT_MS = Math.max(
  PREDICTION_TIMEOUT_MS,
  Number(process.env.SCAN_SYMBOL_TIMEOUT_MS || PREDICTION_TIMEOUT_MS)
);
const PREALERT_MAX_SYMBOLS = Math.max(
  1,
  Math.min(ACTIVE_SYMBOLS.length, Number(process.env.PREALERT_MAX_SYMBOLS || ACTIVE_SYMBOLS.length))
);
const PREALERT_SCAN_CONCURRENCY = Math.max(1, Number(process.env.PREALERT_SCAN_CONCURRENCY || 5));
const PREALERT_SYMBOL_TIMEOUT_MS = Math.max(
  PREDICTION_TIMEOUT_MS,
  Number(process.env.PREALERT_SYMBOL_TIMEOUT_MS || PREDICTION_TIMEOUT_MS)
);
const PREALERT_CYCLE_TIMEOUT_MS = Math.max(30000, Number(process.env.PREALERT_CYCLE_TIMEOUT_MS || 90000));
const PREALERT_WATCHDOG_TIMEOUT_MS = Math.max(
  5000,
  Math.min(30000, Number(process.env.PREALERT_WATCHDOG_TIMEOUT_MS || 10000))
);
const PREALERT_EXCHANGE_WARM_TIMEOUT_MS = Math.max(
  5000,
  Math.min(30000, Number(process.env.PREALERT_EXCHANGE_WARM_TIMEOUT_MS || 10000))
);
const PREALERT_MARKET_SYNC_TIMEOUT_MS = Math.max(
  5000,
  Math.min(30000, Number(process.env.PREALERT_MARKET_SYNC_TIMEOUT_MS || 15000))
);
const QUALITY_REPORT_DAYS = Math.max(1, Number(process.env.QUALITY_REPORT_DAYS || 30));
const COHERENCE_WINDOW_DAYS = Math.max(1, Number(process.env.COHERENCE_WINDOW_DAYS || 7));
const COHERENCE_MAX_POSITIONS = Math.max(20, Number(process.env.COHERENCE_MAX_POSITIONS || 250));
const EXPLOITATION_ENGINE_ENABLED =
  String(process.env.EXPLOITATION_ENGINE_ENABLED || 'false').toLowerCase() === 'true';
const ADAPTIVE_MEMORY_ENABLED =
  String(process.env.ADAPTIVE_MEMORY_ENABLED || 'false').toLowerCase() === 'true';
const EXIT_INTELLIGENCE_ENABLED =
  String(process.env.EXIT_INTELLIGENCE_ENABLED || 'false').toLowerCase() === 'true';
const QUALITY_GATE_AUDIT_ENABLED =
  String(process.env.QUALITY_GATE_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const PREALERTS_PROFILING_ENABLED =
  String(process.env.PREALERTS_PROFILING_ENABLED || 'false').toLowerCase() === 'true';
const PROFILING_FETCH_ENABLED =
  String(process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() === 'true';
const SCHEDULER_AUDIT_ENABLED =
  String(process.env.SCHEDULER_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const DIAGNOSTIC_MODE =
  String(process.env.DIAGNOSTIC_MODE || 'false').toLowerCase() === 'true';

function resolvePrealertProducerConcurrency(requestedConcurrency) {
  const requested = Math.max(1, Number(requestedConcurrency) || PREALERT_SCAN_CONCURRENCY);
  const safeByPool = Math.max(1, Math.ceil(BINANCE_CONCURRENCY_LIMIT / 2));
  return Math.min(requested, safeByPool);
}

function logPrealertProducerConsumer(payload = {}) {
  if (!PREALERTS_PROFILING_ENABLED) {
    return;
  }
  console.log('[PREALERT_PRODUCER_CONSUMER]', {
    ...payload,
    ...getBinanceConcurrencySnapshot()
  });
}

const nowIso = () => new Date().toISOString();

function classifyLatencyBucket(durationMs) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return null;
  if (durationMs < 500) return 'normal';
  if (durationMs < 2000) return 'medio';
  if (durationMs < 5000) return 'lento';
  return 'critico';
}

const pendingRecordSymbolOutcomeTasks = new Set();

async function recordSymbolOutcomeWithTiming(db, symbol, outcome = {}) {
  const startedAtMs = Date.now();
  try {
    await recordSymbolOutcome(db, symbol, outcome);
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const bucket = classifyLatencyBucket(durationMs);
    if (PROFILING_FETCH_ENABLED) {
      console.log('[RECORD_SYMBOL_OUTCOME_TIMING]', {
        symbol,
        duration_ms: durationMs,
        success: true,
        bucket
      });
    }
    return {
      duration_ms: durationMs,
      bucket,
      success: true
    };
  } catch (err) {
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    const bucket = classifyLatencyBucket(durationMs);
    console.error('[RECORD_SYMBOL_OUTCOME_TIMING]', {
      symbol,
      duration_ms: durationMs,
      success: false,
      bucket,
      error: err?.message || String(err)
    });
    throw err;
  }
}

function scheduleRecordSymbolOutcome(db, symbol, outcome = {}) {
  const task = recordSymbolOutcomeWithTiming(db, symbol, outcome)
    .catch(() => null)
    .finally(() => {
      pendingRecordSymbolOutcomeTasks.delete(task);
    });
  pendingRecordSymbolOutcomeTasks.add(task);
  return {
    deferred: true,
    pending: true,
    pending_tasks: pendingRecordSymbolOutcomeTasks.size,
    mode: 'async_background'
  };
}

let lastPredictionCycleMetrics = null;
let preAlertRunCounter = 0;
const PREALERT_HISTORY_LIMIT = Math.max(10, Number(process.env.PREALERT_HISTORY_LIMIT || 48));
const preAlertRuntime = {
  running: false,
  active_run_id: null,
  last_started_at: null,
  last_finished_at: null,
  last_duration_ms: null,
  last_error: null,
  history: []
};

function recordPreAlertHistory(entry = {}) {
  preAlertRuntime.history.unshift(entry);
  if (preAlertRuntime.history.length > PREALERT_HISTORY_LIMIT) {
    preAlertRuntime.history = preAlertRuntime.history.slice(0, PREALERT_HISTORY_LIMIT);
  }
}

function summarizeLatencySeries(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) {
    return {
      total_runs: 0,
      avg_ms: null,
      p95_ms: null,
      max_ms: null
    };
  }
  const sorted = [...finite].sort((a, b) => a - b);
  const avgMs = finite.reduce((sum, value) => sum + value, 0) / finite.length;
  const p95Index = Math.max(0, Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1));
  return {
    total_runs: finite.length,
    avg_ms: Number(avgMs.toFixed(2)),
    p95_ms: Number(sorted[p95Index].toFixed(2)),
    max_ms: Number(sorted[sorted.length - 1].toFixed(2))
  };
}

function finiteOrNull(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function createSymbolTaskContext(symbol, timeframe, cycleType) {
  return {
    id: `${cycleType}:${symbol}:${timeframe}:${Date.now()}`,
    symbol,
    timeframe,
    cycle_type: cycleType,
    cancelled_tasks_count: 0,
    cancelled_tasks: [],
    stage: 'running',
    timed_out: false,
    cancellation_reason: null
  };
}

function logSymbolCancelled(taskContext) {
  if (!taskContext?.timed_out) {
    return;
  }
  console.warn('[SYMBOL_CANCELLED]', {
    symbol: taskContext.symbol,
    reason: taskContext.cancellation_reason || 'timeout',
    stage: taskContext.stage === 'queued' ? 'queued' : 'running',
    cancelled_tasks_count: Number(taskContext.cancelled_tasks_count || 0)
  });
}

function logPredictionTimeoutAdjusted(symbol, timeoutMs) {
  console.log('[PREDICTION_TIMEOUT_ADJUSTED]', {
    symbol: symbol || null,
    timeout_ms: Number(timeoutMs) || PREDICTION_TIMEOUT_MS
  });
}

function logTimeoutExpanded() {
  console.log('[TIMEOUT_EXPANDED]', {
    prediction_timeout_ms: PREDICTION_TIMEOUT_MS,
    fetch_timeout_ms: FETCH_TIMEOUT_MS
  });
}

function getPreAlertRuntimeMetrics() {
  const durations = preAlertRuntime.history
    .map((item) => Number(item?.duration_ms))
    .filter(Number.isFinite);
  return {
    running: preAlertRuntime.running,
    active_run_id: preAlertRuntime.active_run_id,
    last_started_at: preAlertRuntime.last_started_at,
    last_finished_at: preAlertRuntime.last_finished_at,
    last_duration_ms: preAlertRuntime.last_duration_ms,
    last_error: preAlertRuntime.last_error,
    pending_symbol_outcomes: pendingRecordSymbolOutcomeTasks.size,
    latency: summarizeLatencySeries(durations),
    recent_runs: preAlertRuntime.history.slice(0, 10)
  };
}

function logPrealertStageTiming(runId, stage, startedAtMs, extra = {}) {
  const durationMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
  const payload = {
    run_id: runId,
    stage,
    duration_ms: durationMs,
    ...extra
  };
  console.log('[PREALERT_STAGE_TIMING]', payload);
  return durationMs;
}

function buildQualityGateAudit(signalResult = {}, config = {}) {
  const decision =
    signalResult?.decision_post_learning ||
    signalResult?.decision_pre_learning ||
    signalResult?.event_context_filter?.decision ||
    signalResult ||
    {};
  const confidence = Number(signalResult?.confidence ?? signalResult?.confianza ?? decision?.confidence ?? null);
  const quantumScore = Number(signalResult?.quantum_score ?? signalResult?.quantumScore ?? decision?.quantum_score ?? null);
  const timingScore = Number(signalResult?.timing_score ?? signalResult?.timingScore ?? decision?.timing_score ?? null);
  const stability = Number(signalResult?.stability ?? decision?.stability ?? null);
  const contextQuality = decision?.context_quality ?? decision?.contextQuality ?? null;
  const contextScore = decision?.context_score ?? decision?.contextScore ?? null;

  const required = {
    confidence: Number(signalResult?.min_confidence ?? decision?.min_confidence ?? null),
    quantum: Number(signalResult?.min_quantum ?? decision?.min_quantum ?? null),
    timing: Number(signalResult?.min_timing ?? decision?.min_timing ?? null),
    stability: Number(signalResult?.min_stability ?? decision?.min_stability ?? null),
    context: Number(signalResult?.min_context_score ?? decision?.min_context_score ?? null)
  };

  const checks = {
    confidence_ok: {
      value: Number.isFinite(confidence) ? confidence : null,
      required: Number.isFinite(required.confidence) ? required.confidence : null,
      passed: required.confidence == null ? null : confidence >= required.confidence
    },
    quantum_ok: {
      value: Number.isFinite(quantumScore) ? quantumScore : null,
      required: Number.isFinite(required.quantum) ? required.quantum : null,
      passed: required.quantum == null ? null : quantumScore >= required.quantum
    },
    timing_ok: {
      value: Number.isFinite(timingScore) ? timingScore : null,
      required: Number.isFinite(required.timing) ? required.timing : null,
      passed: required.timing == null ? null : timingScore >= required.timing
    },
    stability_ok: {
      value: Number.isFinite(stability) ? stability : null,
      required: Number.isFinite(required.stability) ? required.stability : null,
      passed: required.stability == null ? null : stability >= required.stability
    },
    context_ok: {
      value: Number.isFinite(contextScore) ? contextScore : null,
      required: Number.isFinite(required.context) ? required.context : null,
      passed: required.context == null ? null : Number(contextScore) >= required.context
    }
  };

  const failed = Object.entries(checks)
    .filter(([, value]) => value.passed === false)
    .map(([key]) => key.replace('_ok', ''));

  return {
    symbol: signalResult?.symbol || config?.symbol || null,
    timestamp: new Date().toISOString(),
    passed: Boolean(decision?.quality_gate_passed ?? signalResult?.quality_gate_passed ?? signalResult?.signal_emitted),
    confidence,
    quantum_score: quantumScore,
    timing_score: timingScore,
    stability,
    execution_mode: signalResult?.execution_mode || config?.execution_mode || null,
    checks,
    failed_checks: failed,
    suppression_reason: decision?.suppression_reason || signalResult?.suppression_reason || null,
    gate_reason: decision?.gate_reason || decision?.reason || null,
    context_quality: contextQuality
  };
}

function buildQualityGateInputTrace(signalResult = {}, config = {}) {
  const decision =
    signalResult?.decision_post_learning ||
    signalResult?.decision_pre_learning ||
    signalResult?.event_context_filter?.decision ||
    signalResult ||
    {};

  const rawInput = {
    symbol: signalResult?.symbol || config?.symbol || null,
    confidence: signalResult?.confidence ?? decision?.confidence ?? null,
    confidence_score: signalResult?.confidence_score ?? decision?.confidence_score ?? null,
    quantum: signalResult?.quantum ?? decision?.quantum ?? null,
    quantum_score: signalResult?.quantum_score ?? signalResult?.quantumScore ?? decision?.quantum_score ?? null,
    timing: signalResult?.timing ?? decision?.timing ?? null,
    timing_score: signalResult?.timing_score ?? signalResult?.timingScore ?? decision?.timing_score ?? null,
    stability: signalResult?.stability ?? decision?.stability ?? null,
    direction: signalResult?.direction ?? decision?.direction ?? null,
    impulse: signalResult?.impulse ?? decision?.impulse ?? null,
    context_quality: decision?.context_quality ?? decision?.contextQuality ?? null,
    context_score: decision?.context_score ?? decision?.contextScore ?? null,
    min_confidence: signalResult?.min_confidence ?? decision?.min_confidence ?? null,
    min_quantum: signalResult?.min_quantum ?? decision?.min_quantum ?? null,
    min_timing: signalResult?.min_timing ?? decision?.min_timing ?? null,
    min_stability: signalResult?.min_stability ?? decision?.min_stability ?? null,
    min_context_score: signalResult?.min_context_score ?? decision?.min_context_score ?? null
  };

  const evaluatedFields = {
    confidence: rawInput.confidence ?? rawInput.confidence_score ?? null,
    quantum: rawInput.quantum ?? rawInput.quantum_score ?? null,
    timing: rawInput.timing ?? rawInput.timing_score ?? null,
    stability: rawInput.stability ?? null,
    direction: rawInput.direction ?? null,
    impulse: rawInput.impulse ?? null,
    context_quality: rawInput.context_quality ?? null,
    context_score: rawInput.context_score ?? null,
    min_confidence: rawInput.min_confidence ?? null,
    min_quantum: rawInput.min_quantum ?? null,
    min_timing: rawInput.min_timing ?? null,
    min_stability: rawInput.min_stability ?? null,
    min_context_score: rawInput.min_context_score ?? null
  };

  const gateReason = decision?.gate_reason || decision?.reason || signalResult?.gate_reason || null;
  const missingFieldsDetected = (() => {
    if (!gateReason || typeof gateReason !== 'string' || !gateReason.startsWith('missing:')) return [];
    return gateReason
      .replace('missing:', '')
      .split(',')
      .map((field) => field.trim())
      .filter(Boolean);
  })();

  const presentFields = Object.fromEntries(
    Object.entries(evaluatedFields).map(([key, value]) => [key, value !== null && value !== undefined])
  );

  return {
    symbol: rawInput.symbol,
    timestamp: new Date().toISOString(),
    gate_reason: gateReason,
    raw_input: rawInput,
    evaluated_fields: evaluatedFields,
    present_fields: presentFields,
    missing_fields_detected: missingFieldsDetected,
    decision_keys: Object.keys(decision || {})
  };
}

function createTimeoutError(timeoutMs, label) {
  const error = new Error(`timeout after ${timeoutMs}ms (${label})`);
  error.code = 'OPERATION_TIMEOUT';
  error.timeout_ms = timeoutMs;
  error.label = label;
  return error;
}

async function withTimeout(promiseOrFactory, timeoutMs, label, options = {}) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      const timeoutError = createTimeoutError(timeoutMs, label);
      if (typeof options?.onTimeout === 'function') {
        try {
          options.onTimeout(timeoutError);
        } catch (callbackError) {
          console.warn('[TIMEOUT_HANDLER_FAILED]', callbackError?.message || callbackError);
        }
      }
      reject(timeoutError);
    }, timeoutMs);
  });
  try {
    const taskPromise =
      typeof promiseOrFactory === 'function'
        ? Promise.resolve().then(() => promiseOrFactory())
        : Promise.resolve(promiseOrFactory);
    return await Promise.race([taskPromise, timeoutPromise]);
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
    const requestedSymbols = maxSymbols ? maxSymbols + FETCH_BUFFER : undefined;
    const symbols = await getTopBinanceFuturesSymbols({ maxSymbols: requestedSymbols });
    if (Array.isArray(symbols) && symbols.length > 0) {
      const dynamicConfig = buildDynamicPredictionConfig(symbols);
      const selected = await selectPredictionConfigs(db, dynamicConfig, { maxSymbols });
      console.log('[CRON] active symbols loaded', {
        active_symbols: ACTIVE_SYMBOLS,
        symbols_total: dynamicConfig.length,
        symbols_selected: selected.configs.length,
        cooldown_excluded: selected.summary.cooldown_excluded,
        scan_concurrency: SCAN_CONCURRENCY
      });
      return selected;
    }
    console.warn('[CRON] active symbols empty, using PREDICTION_CONFIG fallback');
  } catch (err) {
    console.warn('[CRON] active symbols unavailable, using PREDICTION_CONFIG fallback', err.message);
  }
  const fallbackConfigs = Array.isArray(PREDICTION_CONFIG) ? PREDICTION_CONFIG : [];
  const selected = await selectPredictionConfigs(db, fallbackConfigs, { maxSymbols });
  return selected;
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
  const requestedCycleConcurrency = Math.max(1, Number(options.concurrency || SCAN_CONCURRENCY));
  const cycleConcurrency =
    cycleType === 'prealert_cycle'
      ? resolvePrealertProducerConcurrency(requestedCycleConcurrency)
      : requestedCycleConcurrency;
  const progressState =
    options?.progressState && typeof options.progressState === 'object' ? options.progressState : null;
  const symbolTimeoutMs = Math.max(
    PREDICTION_TIMEOUT_MS,
    Number(options.symbolTimeoutMs || 0) ||
      (cycleType === 'prealert_cycle' ? PREALERT_SYMBOL_TIMEOUT_MS : SCAN_SYMBOL_TIMEOUT_MS)
  );
  const includeFeatureModel =
    options.includeFeatureModel == null ? FEATURE_VELAS_MODEL_ENABLED : Boolean(options.includeFeatureModel);
  const includeCoherence =
    options.includeCoherence == null ? cycleType !== 'prealert_cycle' : Boolean(options.includeCoherence);

  logTimeoutExpanded();
  const startedAt = nowIso();
  const cycleStartedMs = Date.now();
  console.log('[CRON] runPredictionCycle started', { startedAt, cycleType });
  const loadSymbolsStartedAtMs = Date.now();
  const predictionSelection = await resolvePredictionConfig({ maxSymbols });
  const loadSymbolsMs = Math.max(0, Date.now() - loadSymbolsStartedAtMs);
  const predictionConfig = Array.isArray(predictionSelection?.configs)
    ? predictionSelection.configs
    : Array.isArray(predictionSelection)
      ? predictionSelection
      : [];

  // [DEBUG] Critical: Check if predictionConfig is empty
  console.log('[CRON] predictionConfig resolved', {
    symbols_count: predictionConfig.length,
    prediction_selection_type: typeof predictionSelection,
    prediction_selection_keys: predictionSelection ? Object.keys(predictionSelection) : [],
    first_symbol: predictionConfig[0]?.symbol || null,
    load_symbols_ms: loadSymbolsMs,
    cycle_type: cycleType
  });

  const predictionSelectorSummary = predictionSelection?.summary || {
    cooldown_enabled: false,
    prioritization_enabled: false,
    requested_symbols: predictionConfig.length,
    fetched_symbols: predictionConfig.length,
    eligible_symbols: predictionConfig.length,
    cooldown_excluded: 0,
    cooldown_excluded_symbols: []
  };
  let processedOk = 0;
  let failed = 0;
  let signalsEmitted = 0;
  let signalsSuppressed = 0;
  let shadowObserveEmitted = 0;
  let shadowEnforceEmitted = 0;
  let shadowWouldBlock = 0;
  const suppressionReasons = {};
  const failureReasons = {};

  let totalPredictionMs = 0;
  let maxPredictionMs = 0;
  let minPredictionMs = Number.POSITIVE_INFINITY;
  let slowestSymbol = null;
  let fastestSymbol = null;
  let qualityGateSuppressed = 0;
  let lowConfidenceSuppressed = 0;

  if (cycleType === 'prealert_cycle') {
    logPrealertProducerConsumer({
      phase: 'cycle_start',
      symbols_produced: predictionConfig.length,
      scan_concurrency: requestedCycleConcurrency,
      effective_scan_concurrency: cycleConcurrency,
      binance_concurrency_limit: BINANCE_CONCURRENCY_LIMIT
    });
  }

  await mapWithConcurrency(predictionConfig, cycleConcurrency, async (config) => {
    const symbol = config?.symbol || 'n/a';
    const timeframe = config?.timeframe || 'n/a';
    const symbolStartedAtMs = Date.now();
    const symbolAbortController = new AbortController();
    const symbolTaskContext = createSymbolTaskContext(symbol, timeframe, cycleType);
    let symbolSuccess = false;
    let result = null;
    let recordSymbolOutcomeTiming = null;
    let symbolCancelledLogged = false;
    try {
      logPredictionTimeoutAdjusted(symbol, symbolTimeoutMs);
      result = await withTimeout(
        () =>
          prediccionVelas({
            ...config,
            monto: 1000,
            signal: symbolAbortController.signal,
            taskContext: symbolTaskContext
          }),
        symbolTimeoutMs,
        `${symbol} ${timeframe}`,
        {
          onTimeout: (timeoutError) => {
            symbolTaskContext.timed_out = true;
            symbolTaskContext.cancellation_reason = 'timeout';
            symbolAbortController.abort(timeoutError);
          }
        }
      );
      const symbolDurationMs = Math.max(0, Date.now() - symbolStartedAtMs);
      processedOk += 1;
      symbolSuccess = true;

      // [SIGNAL_EMISSION_DIAGNOSTIC] - Detect why signals are/aren't emitting
      const diagnosticSignalInfo = {
        symbol,
        timeframe: config?.timeframe,
        execution_mode: config?.execution_mode,
        prediction_generated: !!result,
        has_recomendacion: !!result?.recomendacion,
        signal_emitted: result?.signal_emitted,
        status: result?.status,
        suppression_reason: result?.suppression_reason,
        direction: result?.direction,
        confidence: result?.confidence || result?.post_learning_scores?.confidence,
        quantum_score: result?.quantum || result?.post_learning_scores?.quantum_score,
        timing_score: result?.timing || result?.post_learning_scores?.timing_score,
        gate_info: {
          pre_event_gate_pass: result?.decision_pre_learning?.quality_gate_passed,
          pre_event_gate_reason: result?.decision_pre_learning?.gate_reason,
          event_context_filter_enabled: result?.event_context_filter?.enabled,
          event_context_allow: result?.event_context_filter?.allow_event,
          context_filter_would_block: result?.event_context_filter?.shadow?.would_block_event
        },
        execution_info: {
          binance_execution_attempted: result?.binance_execution?.attempted,
          binance_execution_executed: result?.binance_execution?.executed,
          binance_execution_reason: result?.binance_execution?.reason
        }
      };
      console.log('[SIGNAL_EMISSION_DIAGNOSTIC]', JSON.stringify(diagnosticSignalInfo));

      // [SIGNAL_DECISION] - Detailed signal decision analysis
      const actualConfidence = result?.confidence || result?.post_learning_scores?.confidence || 0;
      const actualQuantum = result?.quantum || result?.post_learning_scores?.quantum_score || 0;
      const actualTiming = result?.timing || result?.post_learning_scores?.timing_score || 0;
      const classification = result?.direction === 'up' ? 'up' : result?.direction === 'down' ? 'down' : 'neutral';

      // Simulate decision with relaxed thresholds for diagnostic
      const relaxedConfidenceThreshold = 0.5;
      const relaxedQuantumThreshold = 0.5;
      const wouldEmitIfRelaxed =
        !result?.suppression_reason &&
        actualConfidence >= relaxedConfidenceThreshold &&
        actualQuantum >= relaxedQuantumThreshold;

      const signalDecision = {
        symbol,
        timeframe: config?.timeframe,
        prediction: classification,
        confidence: Number(actualConfidence.toFixed(4)),
        quantum_score: Number(actualQuantum.toFixed(4)),
        timing_score: Number(actualTiming.toFixed(4)),
        classification: classification,
        passed_quality_gate: result?.decision_pre_learning?.quality_gate_passed ?? null,
        suppressed_reason: result?.suppression_reason || 'none',
        signal_emitted: result?.signal_emitted || false,
        diagnostic_mode_enabled: DIAGNOSTIC_MODE,
        would_emit_if_relaxed: wouldEmitIfRelaxed,
        relaxed_thresholds: {
          confidence_min: relaxedConfidenceThreshold,
          quantum_min: relaxedQuantumThreshold,
          actual_confidence: Number(actualConfidence.toFixed(4)),
          actual_quantum: Number(actualQuantum.toFixed(4))
        }
      };
      console.log('[SIGNAL_DECISION]', JSON.stringify(signalDecision));

      if (DIAGNOSTIC_MODE && wouldEmitIfRelaxed && !result?.signal_emitted) {
        console.log('[DIAGNOSTIC_WOULD_EMIT]', JSON.stringify({
          symbol,
          reason: `Would emit with relaxed thresholds (confidence=${actualConfidence.toFixed(2)}, quantum=${actualQuantum.toFixed(2)})`,
          current_suppression: result?.suppression_reason,
          confidence_gap: Number((actualConfidence - (result?.post_learning_scores?.confidence_threshold || 0.6)).toFixed(4)),
          quantum_gap: Number((actualQuantum - (result?.post_learning_scores?.quantum_threshold || 0.6)).toFixed(4))
        }));
      }

      if (result?.signal_emitted) {
        signalsEmitted += 1;
      } else {
        signalsSuppressed += 1;
        const reason = result?.suppression_reason || result?.decision_post_learning?.suppression_reason;
        if (reason) {
          suppressionReasons[reason] = (suppressionReasons[reason] || 0) + 1;
        }
        if (reason === 'quality_gate') qualityGateSuppressed += 1;
        if (reason === 'low_confidence') lowConfidenceSuppressed += 1;
      }
      if (QUALITY_GATE_AUDIT_ENABLED) {
        const audit = buildQualityGateAudit(result, config);
        console.log('[QUALITY_GATE_AUDIT]', JSON.stringify(audit));
        const inputTrace = buildQualityGateInputTrace(result, config);
        console.log('[QUALITY_GATE_INPUT_TRACE]', JSON.stringify(inputTrace));
      }
      const shadow = result?.event_context_filter?.shadow;
      if (shadow?.signal_emitted_observe) shadowObserveEmitted += 1;
      if (shadow?.signal_emitted_enforce) shadowEnforceEmitted += 1;
      if (shadow?.would_block_event) shadowWouldBlock += 1;
      recordSymbolOutcomeTiming = scheduleRecordSymbolOutcome(db, symbol, { ok: true, cycleType });
      console.log('[CRON] prediction ok', { symbol, timeframe, status: result?.status || 'unknown' });
    } catch (err) {
      failed += 1;
      const reason = String(err?.message || 'unknown_error');
      if (symbolTaskContext.timed_out) {
        logSymbolCancelled(symbolTaskContext);
        symbolCancelledLogged = true;
      }
      failureReasons[symbol] = reason;
      if (reason.includes('timeout after')) {
        console.warn('[PREDICTION_TIMEOUT_SOFT]', {
          symbol,
          timeout_ms: symbolTimeoutMs,
          skipped: true
        });
      }
      recordSymbolOutcomeTiming = scheduleRecordSymbolOutcome(db, symbol, {
        ok: false,
        cycleType,
        failureType: 'technical',
        error: reason,
        errorCode: err?.code || err?.status || null
      });
      console.error('[CRON] prediction failed', { symbol, timeframe, error: err.message });
    } finally {
      if (symbolTaskContext.timed_out && !symbolCancelledLogged) {
        logSymbolCancelled(symbolTaskContext);
      }
      const symbolDurationMs = Math.max(0, Date.now() - symbolStartedAtMs);
      if (progressState) {
        progressState.symbols_processed = Number(progressState.symbols_processed || 0) + 1;
        progressState.last_symbol = symbol;
        progressState.last_symbol_duration_ms = symbolDurationMs;
      }
      totalPredictionMs += symbolDurationMs;
      maxPredictionMs = Math.max(maxPredictionMs, symbolDurationMs);
      if (symbolDurationMs < minPredictionMs) {
        minPredictionMs = symbolDurationMs;
        fastestSymbol = symbol;
      }
      if (symbolDurationMs >= maxPredictionMs) {
        slowestSymbol = symbol;
      }
      if (PROFILING_FETCH_ENABLED && cycleType === 'prealert_cycle') {
        const pipelineTotalMs = finiteOrNull(result?.profiling?.pipeline?.total_ms);
        console.log('[PREALERT_SYMBOL_TIMING]', {
          symbol,
          total_ms: pipelineTotalMs ?? symbolDurationMs,
          fetch_ms: finiteOrNull(result?.profiling?.pipeline?.fetch_ms),
          prediction_ms: finiteOrNull(result?.profiling?.pipeline?.prediction_ms),
          gate_ms: finiteOrNull(result?.profiling?.pipeline?.gate_ms),
          post_process_ms: finiteOrNull(result?.profiling?.pipeline?.post_process_ms),
          prealert_ms: finiteOrNull(result?.profiling?.pipeline?.prealert_ms),
          spot_fetch_ms: finiteOrNull(result?.profiling?.pipeline?.spot_fetch_ms),
          binance_latency_ms: finiteOrNull(result?.profiling?.pipeline?.binance_latency_ms),
          fallback_ms: finiteOrNull(result?.profiling?.pipeline?.fallback_ms),
          record_symbol_outcome_ms: finiteOrNull(recordSymbolOutcomeTiming?.duration_ms),
          record_symbol_outcome_bucket: recordSymbolOutcomeTiming?.bucket || null,
          record_symbol_outcome_success: recordSymbolOutcomeTiming?.success ?? null,
          record_symbol_outcome_mode: recordSymbolOutcomeTiming?.mode || null,
          record_symbol_outcome_pending: recordSymbolOutcomeTiming?.pending ?? false,
          post_prediction_gap_ms:
            pipelineTotalMs == null ? null : Math.max(0, symbolDurationMs - pipelineTotalMs),
          success: symbolSuccess
        });
      }
      console.log('[PREDICTION_SYMBOL_TIMING]', {
        symbol,
        duration_ms: symbolDurationMs,
        record_symbol_outcome_ms: finiteOrNull(recordSymbolOutcomeTiming?.duration_ms),
        record_symbol_outcome_bucket: recordSymbolOutcomeTiming?.bucket || null,
        record_symbol_outcome_mode: recordSymbolOutcomeTiming?.mode || null,
        record_symbol_outcome_pending: recordSymbolOutcomeTiming?.pending ?? false,
        success: symbolSuccess
      });
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
  const failureReasonsTop = Object.entries(failureReasons)
    .slice(0, 10)
    .map(([symbol, reason]) => ({ symbol, reason }));
  const cycleDurationMs = Date.now() - cycleStartedMs;
  if (cycleType === 'prealert_cycle') {
    logPrealertProducerConsumer({
      phase: 'cycle_end',
      symbols_produced: predictionConfig.length,
      processed_ok: processedOk,
      failed,
      scan_concurrency: requestedCycleConcurrency,
      effective_scan_concurrency: cycleConcurrency,
      binance_concurrency_limit: BINANCE_CONCURRENCY_LIMIT
    });
  }
  if (PREALERTS_PROFILING_ENABLED && cycleType === 'prealert_cycle') {
    const avgPredictionMs = predictionConfig.length ? totalPredictionMs / predictionConfig.length : 0;
    console.log('[PREALERTS_TIMING]', JSON.stringify({
      cycle_id: `${cycleType}_${cycleStartedMs}`,
      total_duration_ms: cycleDurationMs,
      phases: {
        load_symbols_ms: loadSymbolsMs,
        fetch_market_data_ms: null,
        compute_indicators_ms: null,
        prediction_loop_ms: totalPredictionMs,
        quality_gate_ms: null,
        cooldown_filter_ms: null,
        signal_emit_ms: cycleDurationMs
      },
      symbols_processed: predictionConfig.length,
      signals_generated: signalsEmitted,
      signals_suppressed: signalsSuppressed,
      avg_symbol_ms: Number(avgPredictionMs.toFixed(2)),
      max_symbol_ms: maxPredictionMs,
      slowest_symbol: slowestSymbol,
      fastest_symbol: fastestSymbol,
      fastest_symbol_ms: Number.isFinite(minPredictionMs) ? Number(minPredictionMs.toFixed(2)) : null
    }));
  }
  let coherence = null;
  if (includeCoherence) {
    try {
      coherence = await buildBinanceCoherenceSnapshot();
    } catch (err) {
      console.warn('[CRON] coherence snapshot failed', err.message);
    }
  }

  // [SUPPRESSION_SUMMARY] - Final diagnostic of why signals weren't emitted
  const emitRate = processedOk > 0 ? Number((signalsEmitted / processedOk * 100).toFixed(2)) : 0;
  const suppressionRate = processedOk > 0 ? Number((signalsSuppressed / processedOk * 100).toFixed(2)) : 0;

  console.log('[SUPPRESSION_SUMMARY]', JSON.stringify({
    cycle_type: cycleType,
    signals_emitted: signalsEmitted,
    signals_suppressed: signalsSuppressed,
    emit_rate_pct: emitRate,
    suppression_rate_pct: suppressionRate,
    suppression_breakdown: {
      quality_gate: qualityGateSuppressed,
      low_confidence: lowConfidenceSuppressed,
      event_context: suppressionReasons['event_context'] || 0,
      cooldown: predictionSelectorSummary.cooldown_excluded || 0
    },
    suppression_reasons_all: suppressionReasons,
    total_processed: processedOk,
    total_failed: failed,
    emit_rate_pct: emitRate,
    predefined_configs_count: predictionConfig.length,
    diagnostic_mode_enabled: DIAGNOSTIC_MODE
  }));

  if (DIAGNOSTIC_MODE) {
    console.log('[DIAGNOSTIC_CYCLE_ANALYSIS]', JSON.stringify({
      cycle_type: cycleType,
      analysis: {
        prediction_coverage: Number((processedOk / predictionConfig.length * 100).toFixed(2)),
        emission_rate: emitRate,
        suppression_breakdown_pct: {
          quality_gate: processedOk > 0 ? Number((qualityGateSuppressed / signalsSuppressed * 100).toFixed(1)) : 0,
          low_confidence: processedOk > 0 ? Number((lowConfidenceSuppressed / signalsSuppressed * 100).toFixed(1)) : 0,
          other: suppressionReasons ? Object.keys(suppressionReasons).filter(r => r !== 'quality_gate' && r !== 'low_confidence').length : 0
        }
      },
      recommendation: emitRate < 5 ? 'TOO_RESTRICTIVE - Consider relaxing thresholds' : emitRate > 50 ? 'TOO_PERMISSIVE - Consider tightening thresholds' : 'NORMAL'
    }));
  }

  const cycleMetrics = {
    source: cycleType,
    created_at: nowIso(),
    symbols_total: predictionConfig.length,
    symbols_requested: predictionSelectorSummary.requested_symbols,
    symbols_fetched: predictionSelectorSummary.fetched_symbols,
    symbols_eligible: predictionSelectorSummary.eligible_symbols,
    symbols_excluded_cooldown: predictionSelectorSummary.cooldown_excluded,
    processed_ok: processedOk,
    failed,
    signals_emitted: signalsEmitted,
    signals_suppressed: signalsSuppressed,
    shadow_observe_emitted: shadowObserveEmitted,
    shadow_enforce_emitted: shadowEnforceEmitted,
    shadow_would_block: shadowWouldBlock,
    cycle_duration_ms: cycleDurationMs,
    coherence_enabled: includeCoherence,
    suppression_reasons_top: suppressionReasonsTop,
    suppression_breakdown: {
      quality_gate: qualityGateSuppressed,
      low_confidence: lowConfidenceSuppressed
    },
    prediction_runtime_selector: predictionSelectorSummary,
    failure_reasons_top: failureReasonsTop,
    coherence
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

  if (EXPLOITATION_ENGINE_ENABLED) {
    try {
      const adaptiveProfile = ADAPTIVE_MEMORY_ENABLED
        ? await computeAdaptiveProfile(db, { window: Number(process.env.ADAPTIVE_MEMORY_WINDOW || 80) })
        : null;
      if (adaptiveProfile && ADAPTIVE_MEMORY_ENABLED) {
        await persistAdaptiveProfile(db, adaptiveProfile, { source: cycleType });
      }
      const exploitationSummary = await runExploitationEngine({
        db,
        adaptiveProfile: adaptiveProfile || {},
        marketSnapshotProvider: (signal) => getMarketSnapshot(signal?.symbol || signal?.simbolo || ''),
        exitIntelligenceEnabled: EXIT_INTELLIGENCE_ENABLED
      });
      console.log('[EXPLOITATION_ENGINE] updated', {
        source: cycleType,
        total: exploitationSummary?.total || 0
      });
    } catch (err) {
      console.warn('[EXPLOITATION_ENGINE] failed', err?.message || err);
    }
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

function normalizeOutcome(value) {
  const raw = String(value || '').trim().toUpperCase();
  if (!raw) return 'UNKNOWN';
  if (raw.includes('LUCKY_WIN') || raw === 'WIN' || raw === 'VALID_WIN') return 'WIN';
  if (raw.includes('LOSS') || raw.includes('FAIL')) return 'LOSS';
  if (raw.includes('BREAKEVEN') || raw.includes('BE')) return 'BREAKEVEN';
  if (raw.includes('PENDING') || raw.includes('PENDIENTE')) return 'PENDING';
  if (raw.includes('SUPPRESSED') || raw.includes('SUPRIMIDA')) return 'SUPPRESSED';
  return raw;
}

function extractPredictionOutcome(predictionData) {
  if (!predictionData) return 'UNKNOWN';
  return normalizeOutcome(
    predictionData?.verification_outcome ||
      predictionData?.verification?.verification_outcome ||
      predictionData?.verification?.outcome_label ||
      predictionData?.status
  );
}

function pickCreatedMs(row) {
  const raw = row?.opened_at || row?.created_at || row?.updated_at || null;
  if (!raw) return 0;
  if (typeof raw?.toDate === 'function') return raw.toDate().getTime();
  const ms = new Date(raw).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

function pickDelaySeconds(row) {
  const raw =
    row?.execution_audit?.delay_seconds ??
    row?.executionAudit?.delay_seconds ??
    row?.execution_audit?.delaySeconds ??
    null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

function pickLateEntry(row) {
  const raw = row?.execution_audit?.is_late_entry;
  return raw === true;
}

async function buildBinanceCoherenceSnapshot() {
  const cutoffMs = Date.now() - COHERENCE_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const snapshot = await db.collection('binance_open_positions').orderBy('created_at', 'desc').limit(COHERENCE_MAX_POSITIONS).get();
  const rows = snapshot.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => pickCreatedMs(row) >= cutoffMs);

  const closed = rows.filter((row) => String(row?.status || '').toLowerCase() === 'closed');
  const withExchange = closed
    .map((row) => ({
      row,
      exchangeOutcome: normalizeOutcome(row?.win_exchange)
    }))
    .filter((item) => ['WIN', 'LOSS', 'BREAKEVEN'].includes(item.exchangeOutcome));

  let comparable = 0;
  let matches = 0;
  let mismatches = 0;
  let modelWins = 0;
  let exchangeWins = 0;
  let lateEntries = 0;
  let knownLateEntries = 0;
  let delayCount = 0;
  let delaySum = 0;

  for (const item of withExchange) {
    const predId = item.row?.prediction_id;
    let modelOutcome = 'UNKNOWN';
    if (predId) {
      try {
        const predDoc = await db.collection('velas_predicciones').doc(predId).get();
        if (predDoc.exists) {
          modelOutcome = extractPredictionOutcome(predDoc.data() || {});
        }
      } catch (_) {
        modelOutcome = 'UNKNOWN';
      }
    }

    const exchangeOutcome = item.exchangeOutcome;
    if (modelOutcome === 'WIN') modelWins += 1;
    if (exchangeOutcome === 'WIN') exchangeWins += 1;

    if (['WIN', 'LOSS'].includes(modelOutcome) && ['WIN', 'LOSS'].includes(exchangeOutcome)) {
      comparable += 1;
      if (modelOutcome === exchangeOutcome) {
        matches += 1;
      } else {
        mismatches += 1;
      }
    }

    const delay = pickDelaySeconds(item.row);
    if (Number.isFinite(delay)) {
      delayCount += 1;
      delaySum += delay;
    }
    if (item.row?.execution_audit && Object.prototype.hasOwnProperty.call(item.row.execution_audit, 'is_late_entry')) {
      knownLateEntries += 1;
      if (pickLateEntry(item.row)) lateEntries += 1;
    }
  }

  const coherenceRate = comparable > 0 ? matches / comparable : 0;
  const avgDelaySeconds = delayCount > 0 ? delaySum / delayCount : 0;
  const lateEntryRate = knownLateEntries > 0 ? lateEntries / knownLateEntries : 0;

  return {
    window_days: COHERENCE_WINDOW_DAYS,
    inspected_positions: rows.length,
    closed_positions: closed.length,
    comparable_signals: comparable,
    matches,
    mismatches,
    coherence_rate: Number(coherenceRate.toFixed(4)),
    model_win_rate: comparable > 0 ? Number((modelWins / comparable).toFixed(4)) : 0,
    exchange_win_rate: comparable > 0 ? Number((exchangeWins / comparable).toFixed(4)) : 0,
    avg_delay_seconds: Number(avgDelaySeconds.toFixed(3)),
    late_entries: lateEntries,
    known_late_entries: knownLateEntries,
    late_entry_rate: Number(lateEntryRate.toFixed(4))
  };
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

function buildPreAlertForceAbortPayload(runState, reason, extra = {}) {
  return {
    run_id: runState?.run_id || null,
    reason: reason || 'unknown',
    duration_ms: Math.max(0, Date.now() - Number(runState?.started_at_ms || Date.now())),
    symbols_processed: Number(runState?.progress?.symbols_processed || 0),
    active_stage: runState?.active_stage || null,
    ...extra
  };
}

function finalizePreAlertRun(runState, outcome = {}) {
  if (!runState || runState.finalized) {
    return {
      duration_ms: Math.max(0, Date.now() - Number(runState?.started_at_ms || Date.now())),
      finished_at: preAlertRuntime.last_finished_at || nowIso(),
      already_finalized: true
    };
  }

  runState.finalized = true;
  const durationMs = Math.max(0, Date.now() - Number(runState.started_at_ms || Date.now()));
  const finishedAt = nowIso();
  const isOk = outcome.ok === true;
  const errorMessage = isOk ? null : String(outcome.error || outcome.reason || 'unknown_error');

  preAlertRuntime.last_duration_ms = durationMs;
  preAlertRuntime.last_finished_at = finishedAt;
  preAlertRuntime.last_error = errorMessage;

  const historyEntry = {
    run_id: runState.run_id,
    ok: isOk,
    started_at: runState.started_at,
    finished_at: finishedAt,
    duration_ms: durationMs,
    stage_timings: runState.stage_timings
  };

  if (Object.prototype.hasOwnProperty.call(outcome, 'exchange_info_warm')) {
    historyEntry.exchange_info_warm = outcome.exchange_info_warm || null;
  }
  if (Object.prototype.hasOwnProperty.call(outcome, 'prediction_metrics')) {
    historyEntry.prediction_metrics = outcome.prediction_metrics || null;
  }
  if (!isOk) {
    historyEntry.error = errorMessage;
  }
  if (outcome.aborted) {
    historyEntry.aborted = true;
  }

  recordPreAlertHistory(historyEntry);

  if (outcome.aborted) {
    console.error('[PREALERT_FORCE_ABORT]', {
      ...buildPreAlertForceAbortPayload(runState, outcome.reason, {
        error: errorMessage
      })
    });
  }

  return {
    duration_ms: durationMs,
    finished_at: finishedAt
  };
}

async function runPreAlertCycle(options = {}) {
  if (preAlertRuntime.running) {
    if (SCHEDULER_AUDIT_ENABLED) {
      console.log('[PREALERTS_SCHEDULER_AUDIT]', JSON.stringify({
        cycle_id: `prealert_skip_${Date.now()}`,
        scheduled_time: new Date().toISOString(),
        actual_start_time: null,
        delay_ms: null,
        skipped: true,
        reason: 'already_running'
      }));
    }
    return {
      ok: false,
      skipped: true,
      reason: 'already_running',
      active_run_id: preAlertRuntime.active_run_id
    };
  }

  const runId = `prealert_${++preAlertRunCounter}_${Date.now()}`;
  const cycleStartedAtMs = Date.now();
  const cycleTimeoutMs = Math.max(
    PREALERT_SYMBOL_TIMEOUT_MS,
    Number(options.cycleTimeoutMs || 0) || PREALERT_CYCLE_TIMEOUT_MS
  );
  const stageTimings = {};
  const progress = {
    symbols_processed: 0,
    last_symbol: null,
    last_symbol_duration_ms: null
  };
  const runState = {
    run_id: runId,
    started_at_ms: cycleStartedAtMs,
    started_at: new Date(cycleStartedAtMs).toISOString(),
    stage_timings: stageTimings,
    progress,
    active_stage: 'boot',
    finalized: false
  };
  preAlertRuntime.running = true;
  preAlertRuntime.active_run_id = runId;
  preAlertRuntime.last_started_at = runState.started_at;
  preAlertRuntime.last_finished_at = null;
  preAlertRuntime.last_duration_ms = null;
  preAlertRuntime.last_error = null;
  if (SCHEDULER_AUDIT_ENABLED) {
    console.log('[PREALERTS_SCHEDULER_AUDIT]', JSON.stringify({
      cycle_id: runId,
      scheduled_time: preAlertRuntime.last_started_at,
      actual_start_time: preAlertRuntime.last_started_at,
      delay_ms: 0,
      skipped: false,
      reason: null
    }));
  }

  try {
    return await withTimeout(
      async () => {
        let exchangeWarmSummary = null;

        runState.active_stage = 'watchdogs';
        const watchdogStartedAtMs = Date.now();
        const [processingWatchdog, pendingWatchdog] = await Promise.allSettled([
          withTimeout(() => reapStaleProcessingIntents(db), PREALERT_WATCHDOG_TIMEOUT_MS, `${runId} processing_watchdog`),
          withTimeout(() => reapStalePendingPredictions(db), PREALERT_WATCHDOG_TIMEOUT_MS, `${runId} pending_watchdog`)
        ]);
        stageTimings.watchdogs_ms = logPrealertStageTiming(runId, 'watchdogs', watchdogStartedAtMs, {
          processing_watchdog_ok: processingWatchdog.status === 'fulfilled',
          pending_watchdog_ok: pendingWatchdog.status === 'fulfilled',
          processing_reaped:
            processingWatchdog.status === 'fulfilled' ? Number(processingWatchdog.value?.reaped || 0) : 0,
          pending_resolved:
            pendingWatchdog.status === 'fulfilled' ? Number(pendingWatchdog.value?.resolved || 0) : 0
        });
        if (processingWatchdog.status === 'fulfilled' && processingWatchdog.value?.reaped > 0) {
          console.warn('[CRON] stale processing intents reaped', processingWatchdog.value);
        } else if (processingWatchdog.status === 'rejected') {
          console.warn(
            '[CRON] stale processing watchdog failed',
            processingWatchdog.reason?.message || processingWatchdog.reason
          );
        }
        if (pendingWatchdog.status === 'rejected') {
          console.warn('[CRON] pending watchdog failed', pendingWatchdog.reason?.message || pendingWatchdog.reason);
        }

        runState.active_stage = 'exchange_info_warm';
        const warmExchangeStartedAtMs = Date.now();
        try {
          exchangeWarmSummary = await withTimeout(
            () => warmExchangeInfoCache(),
            PREALERT_EXCHANGE_WARM_TIMEOUT_MS,
            `${runId} exchange_info_warm`
          );
        } catch (err) {
          console.warn('[CRON] exchange info warm cache failed', err.message);
        }
        stageTimings.exchange_info_warm_ms = logPrealertStageTiming(runId, 'exchange_info_warm', warmExchangeStartedAtMs, {
          warmed: Boolean(exchangeWarmSummary?.warmed),
          symbols_total: Number(exchangeWarmSummary?.symbols_total || 0)
        });

        const marketSyncPromise = (async () => {
          runState.active_stage = 'market_stream_sync';
          const marketSyncStartedAtMs = Date.now();
          try {
            const summary = await withTimeout(
              () => syncOperationalMarketObservation(db),
              PREALERT_MARKET_SYNC_TIMEOUT_MS,
              `${runId} market_stream_sync`
            );
            stageTimings.market_stream_sync_ms = logPrealertStageTiming(runId, 'market_stream_sync', marketSyncStartedAtMs, {
              observed_symbols: Array.isArray(summary?.observed_symbols) ? summary.observed_symbols.length : 0,
              active_streams: Array.isArray(summary?.active_streams) ? summary.active_streams.length : 0
            });
            return summary;
          } catch (err) {
            stageTimings.market_stream_sync_ms = logPrealertStageTiming(runId, 'market_stream_sync', marketSyncStartedAtMs, {
              ok: false,
              error: err.message
            });
            console.warn('[CRON] market stream sync failed', err.message);
            return null;
          }
        })();

        runState.active_stage = 'signal_emit';
        const signalEmitStartedAtMs = Date.now();
        const remainingSignalBudgetMs = Math.max(
          PREALERT_SYMBOL_TIMEOUT_MS,
          cycleTimeoutMs - (Date.now() - cycleStartedAtMs) - 5000
        );
        await withTimeout(
          () =>
            runPredictionCycle({
              cycleType: 'prealert_cycle',
              maxSymbols: PREALERT_MAX_SYMBOLS,
              concurrency: PREALERT_SCAN_CONCURRENCY,
              symbolTimeoutMs: PREALERT_SYMBOL_TIMEOUT_MS,
              includeFeatureModel: false,
              includeCoherence: false,
              progressState: progress
            }),
          remainingSignalBudgetMs,
          `${runId} signal_emit`
        );
        if (runState.finalized) {
          return {
            ok: false,
            aborted: true,
            run_id: runId,
            duration_ms: preAlertRuntime.last_duration_ms,
            reason: 'already_finalized'
          };
        }
        stageTimings.signal_emit_ms = logPrealertStageTiming(runId, 'signal_emit', signalEmitStartedAtMs, {
          emitted: Number(lastPredictionCycleMetrics?.signals_emitted || 0),
          suppressed: Number(lastPredictionCycleMetrics?.signals_suppressed || 0),
          failed: Number(lastPredictionCycleMetrics?.failed || 0)
        });

        runState.active_stage = 'market_stream_sync_wait';
        await marketSyncPromise;
        if (runState.finalized) {
          return {
            ok: false,
            aborted: true,
            run_id: runId,
            duration_ms: preAlertRuntime.last_duration_ms,
            reason: 'already_finalized'
          };
        }

        runState.active_stage = 'finalizing';
        const finalized = finalizePreAlertRun(runState, {
          ok: true,
          exchange_info_warm: exchangeWarmSummary || null,
          prediction_metrics: lastPredictionCycleMetrics || null
        });
        if (finalized.already_finalized) {
          return {
            ok: false,
            aborted: true,
            run_id: runId,
            duration_ms: preAlertRuntime.last_duration_ms,
            reason: 'already_finalized'
          };
        }
        stageTimings.total_ms = finalized.duration_ms;

        if (SCHEDULER_AUDIT_ENABLED) {
          console.log('[CYCLE_AUDIT_SUMMARY]', JSON.stringify({
            cycle_id: runId,
            duration_ms: finalized.duration_ms,
            symbols_total: Number(lastPredictionCycleMetrics?.symbols_total || 0),
            signals_emitted: Number(lastPredictionCycleMetrics?.signals_emitted || 0),
            signals_suppressed: Number(lastPredictionCycleMetrics?.signals_suppressed || 0),
            suppression_breakdown: {
              quality_gate: Number(lastPredictionCycleMetrics?.suppression_breakdown?.quality_gate || 0),
              low_confidence: Number(lastPredictionCycleMetrics?.suppression_breakdown?.low_confidence || 0),
              cooldown: Number(lastPredictionCycleMetrics?.prediction_runtime_selector?.cooldown_excluded || 0)
            },
            cooldown_excluded: Number(lastPredictionCycleMetrics?.prediction_runtime_selector?.cooldown_excluded || 0),
            quality_gate_fail_rate: (() => {
              const suppressed = Number(lastPredictionCycleMetrics?.signals_suppressed || 0);
              if (!suppressed) return 0;
              const qualityGate = Number(lastPredictionCycleMetrics?.suppression_breakdown?.quality_gate || 0);
              return Number((qualityGate / suppressed).toFixed(4));
            })(),
            avg_signal_emit_ms: stageTimings.signal_emit_ms || null
          }));
        }

        return {
          ok: true,
          run_id: runId,
          duration_ms: finalized.duration_ms,
          stage_timings: stageTimings,
          prediction_metrics: lastPredictionCycleMetrics || null,
          exchange_info_warm: exchangeWarmSummary || null
        };
      },
      cycleTimeoutMs,
      `${runId} total_cycle`
    );
  } catch (err) {
    const isTimeout = err?.code === 'OPERATION_TIMEOUT';
    const finalized = finalizePreAlertRun(runState, {
      ok: false,
      aborted: isTimeout,
      reason: isTimeout ? 'cycle_timeout' : 'cycle_error',
      error: err?.message || err,
      prediction_metrics: lastPredictionCycleMetrics || null
    });
    stageTimings.total_ms = finalized.duration_ms;
    if (isTimeout) {
      return {
        ok: false,
        aborted: true,
        run_id: runId,
        duration_ms: finalized.duration_ms,
        reason: 'cycle_timeout',
        stage_timings: stageTimings,
        symbols_processed: Number(progress.symbols_processed || 0),
        prediction_metrics: lastPredictionCycleMetrics || null
      };
    }
    throw err;
  } finally {
    if (preAlertRuntime.active_run_id === runId) {
      preAlertRuntime.running = false;
      preAlertRuntime.active_run_id = null;
    }
  }
}

async function runBinanceManagerCycle() {
  try {
    const watchdog = await reapStaleProcessingIntents(db);
    if (watchdog.reaped > 0) {
      console.warn('[CRON] stale processing intents reaped', watchdog);
    }
  } catch (err) {
    console.warn('[CRON] stale processing watchdog failed', err.message);
  }
  try {
    await syncOperationalMarketObservation(db);
  } catch (err) {
    console.warn('[CRON] market stream sync failed', err.message);
  }
  const summary = await runBinancePositionManagerCycle(db);
  console.log('[CRON] runBinanceManagerCycle finished', summary);
}

async function runVerificationCycle() {
  const startedAt = nowIso();
  console.log('[CRON] runVerificationCycle started', startedAt);
  let verified = 0;
  let skipped = 0;
  let failed = 0;
  let suppressedBackfilled = 0;
  let pendingResolved = 0;

  try {
    const pendingWatchdog = await reapStalePendingPredictions(db);
    pendingResolved = Number(pendingWatchdog?.resolved || 0);
  } catch (err) {
    console.warn('[CRON] pending watchdog failed', err.message);
  }

  let pendingSnapshot;
  let suppressedSnapshot;
  try {
    pendingSnapshot = await db
      .collection('velas_predicciones')
      .where('status', '==', 'pendiente')
      .limit(50)
      .get();
    suppressedSnapshot = await db
      .collection('velas_predicciones')
      .where('status', '==', 'suprimida')
      .limit(50)
      .get();
  } catch (err) {
    console.error('[CRON] verification query failed', err.message);
    return;
  }

  const cutoff = Date.now() - MIN_VERIFICATION_AGE_SECONDS * 1000;

  const docs = [...pendingSnapshot.docs, ...suppressedSnapshot.docs];

  for (const doc of docs) {
    const data = doc.data();
    const status = String(data.status || '').toLowerCase();
    const isSuppressed = data.signal_emitted === false || status === 'suprimida';
    const hasSuppressedVerification = Boolean(
      data?.suppressed_verification?.counterfactual_outcome ||
        data?.verification?.suppressed_verification?.counterfactual_outcome ||
        data?.verification?.counterfactual_outcome ||
        data?.counterfactual_outcome
    );

    const createdAt = data.created_at || data.timestamp;
    const createdMs = createdAt ? new Date(createdAt).getTime() : 0;
    if (status === 'pendiente' && createdMs && createdMs > cutoff) {
      skipped += 1;
      continue;
    }
    if (status === 'pendiente' && data.completed_at) {
      skipped += 1;
      continue;
    }
    if (isSuppressed && hasSuppressedVerification) {
      skipped += 1;
      continue;
    }
    try {
      await verificarPrediccionVelas(doc.id);
      verified += 1;
      if (isSuppressed) {
        suppressedBackfilled += 1;
      }
    } catch (err) {
      failed += 1;
      console.error('[CRON] verification failed', doc.id, err.message);
    }
  }

  console.log('[CRON] runVerificationCycle finished', {
    total: docs.length,
    pending_total: pendingSnapshot.size,
    suppressed_total: suppressedSnapshot.size,
    pending_resolved: pendingResolved,
    verified,
    suppressed_backfilled: suppressedBackfilled,
    skipped,
    failed
  });
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

async function runImpulseCycle(options = {}) {
  const startedAt = nowIso();
  const cycleStartedMs = Date.now();
  const acceptedImpulses = [];
  console.log('[IMPULSE_CYCLE] Started at', startedAt);

  try {
    // Get list of symbols to monitor
    const symbols = ACTIVE_SYMBOLS.slice(0, 25); // Top 25 symbols
    console.log(`[IMPULSE_CYCLE] Scanning ${symbols.length} symbols for impulses`);

    let detectedCount = 0;
    const detectedImpulses = [];

    // Batch detect impulses
    for (const symbol of symbols) {
      try {
        const result = await detectSymbolImpulse(symbol);

        if (result.impulseDetected) {
          detectedCount++;
          const detectedImpulse = {
            symbol: result.symbol,
            direction: result.direction,
            move1m: result.move1m,
            move3m: result.move3m,
            volumeRatio: result.volumeRatio,
            strengthScore: result.strengthScore,
            entry_price: result.candles?.current_close ?? null,
            timestamp: result.timestamp
          };
          detectedImpulses.push(detectedImpulse);

          const qualityScore = Number((result.strengthScore ?? 0).toFixed(4));
          if (qualityScore >= 0.02) {
            const acceptedImpulse = {
              ...detectedImpulse,
              qualityScore,
              entry_price: result.candles?.current_close ?? null,
              confidence: Math.max(0.65, Number((0.6 + ((result.strengthScore ?? 0) * 0.3)).toFixed(3))),
              strength_score: result.strengthScore,
              signal_type: 'IMPULSE',
              status: 'PENDING_EXECUTION',
              created_at: FieldValue.serverTimestamp(),
              created_at_ms: Date.now()
            };

            acceptedImpulses.push(acceptedImpulse);
          }

          console.log(`[IMPULSE_CYCLE] ✓ IMPULSE DETECTED: ${symbol}`, {
            direction: result.direction,
            move1m_pct: result.move1m.toFixed(4),
            move3m_pct: result.move3m.toFixed(4),
            volume_ratio: result.volumeRatio.toFixed(2),
            strength_score: result.strengthScore.toFixed(2)
          });
        } else if (options.debug) {
          console.log(`[IMPULSE_CYCLE] ✗ ${symbol}: ${result.reason || 'No impulse'}`);
        }
      } catch (err) {
        console.error(`[IMPULSE_CYCLE] Error processing ${symbol}:`, err.message);
      }
    }

    if (acceptedImpulses.length === 0 && detectedImpulses.length > 0) {
      const fallback = detectedImpulses[0];
      const forcedImpulse = {
        ...fallback,
        qualityScore: Number((fallback.strengthScore ?? 0).toFixed(4)),
        entry_price: fallback.entry_price,
        confidence: Math.max(0.65, Number((0.6 + ((fallback.strengthScore ?? 0) * 0.3)).toFixed(3))),
        strength_score: fallback.strengthScore,
        signal_type: 'IMPULSE',
        status: 'PENDING_EXECUTION',
        forced: true,
        created_at: FieldValue.serverTimestamp(),
        created_at_ms: Date.now()
      };

      console.log('[FORCED_TRADE]', {
        symbol: fallback.symbol,
        reason: 'validation_mode'
      });

      acceptedImpulses.push(forcedImpulse);
    }

    if (acceptedImpulses.length > 0) {
      const batch = db.batch();
      for (const acceptedImpulse of acceptedImpulses) {
        const docRef = db.collection('high_conviction_impulse_signals').doc();
        batch.set(docRef, acceptedImpulse);
      }
      await batch.commit();

      console.log('[IMPULSE_EXECUTION_TRIGGERED]', {
        accepted_count: acceptedImpulses.length,
        forced_count: acceptedImpulses.filter((impulse) => impulse.forced).length
      });

      const executedTrades = await processImpulseSignals();
      for (const trade of executedTrades) {
        console.log('[REAL_TRADE_EXECUTED]', {
          symbol: trade.symbol,
          direction: trade.direction,
          trade_id: trade.trade_id,
          forced: Boolean(trade.forced),
          timestamp: new Date().toISOString()
        });
      }
    }

    const durationMs = Date.now() - cycleStartedMs;
    console.log(`[IMPULSE_CYCLE] Completed in ${durationMs}ms`, {
      symbols_scanned: symbols.length,
      impulses_detected: detectedCount,
      impulses_accepted: acceptedImpulses.length,
      detected_impulses: detectedImpulses.map(i => `${i.symbol}(${i.direction})`)
    });

    return {
      success: true,
      impulses_detected: detectedCount,
      impulses_accepted: acceptedImpulses.length,
      detected_impulses: detectedImpulses,
      duration_ms: durationMs
    };

  } catch (err) {
    const durationMs = Date.now() - cycleStartedMs;
    console.error('[IMPULSE_CYCLE] Failed', {
      error: err.message,
      duration_ms: durationMs
    });
    return {
      success: false,
      error: err.message,
      duration_ms: durationMs
    };
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

      try {
        const dashboardSnapshot = await refreshSignalIntelligenceDashboardSnapshot();
        console.log('[CRON][SIGNAL_INTEL] dashboard snapshot updated', {
          generated_at: dashboardSnapshot?.generated_at || null,
          total_signals: dashboardSnapshot?.intelligence?.report?.totals?.total_signals ?? null
        });
      } catch (err) {
        console.warn('[CRON] signal intelligence dashboard snapshot failed', err.message);
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
  runAuditCycle,
  runImpulseCycle,
  getPreAlertRuntimeMetrics
};
