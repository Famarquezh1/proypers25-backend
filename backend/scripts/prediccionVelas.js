const yahooFinance = require('yahoo-finance2').default;
const db = require('../firebase-admin-config');
const { fetchBinanceSpot, BINANCE_FAIL_FAST_TIMEOUT_MS } = require('../services/dataSources/binance');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const {
  addAbortListener,
  raceWithSignal,
  registerTaskCancellation,
  resolveAbortError,
  throwIfAborted
} = require('../lib/abortUtils');
const { applyLearningAdjustments, preloadLearningConfig } = require('../lib/learningConfig');
const { evaluateEventContextFilter } = require('../lib/event_context_filter');
const { adjustExecutionTargets } = require('../lib/context_execution_adjuster');
const { executeSignalTrade } = require('../lib/binanceFuturesExecutor');
const {
  shouldSendManualPreAlert,
  sendManualPreAlertNotification,
  shouldEmitHighConvictionSignal,
  registerHighConvictionSignal,
  sendHighConvictionNotification
} = require('../lib/highConvictionSignals');
const { syncPredictionExecutionState } = require('../services/execution/predictionExecutionSync');

const timeframes = {
  '1m': 1,
  '5m': 5,
  '15m': 15,
  '30m': 30,
  '1h': 60,
  '4h': 240
};
const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || null;
const ENABLE_BINANCE = process.env.ENABLE_BINANCE === 'true';

const randomBetween = (min, max) => Number((Math.random() * (max - min) + min).toFixed(4));
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const LEARNING_MODE = process.env.LEARNING_MODE || 'observe';
const LEARNING_LOG = process.env.LEARNING_LOG === 'true';
const EVENT_CONTEXT_FILTER_ENABLED = process.env.EVENT_CONTEXT_FILTER_ENABLED === 'true';
const EVENT_CONTEXT_FILTER_MODE =
  (process.env.EVENT_CONTEXT_FILTER_MODE || 'observe').toLowerCase() === 'enforce'
    ? 'enforce'
    : 'observe';
const CONTEXT_EXECUTION_ADJUSTMENT_ENABLED =
  process.env.CONTEXT_EXECUTION_ADJUSTMENT_ENABLED === 'true';
const EXTERNAL_DATA_TIMEOUT_MS = Math.max(2000, Number(process.env.EXTERNAL_DATA_TIMEOUT_MS || 8000));
const PREDICCION_VERBOSE_LOGS = process.env.PREDICCION_VERBOSE_LOGS === 'true';
const ALLOW_NEUTRAL_EXPERIMENT =
  String(process.env.ALLOW_NEUTRAL_EXPERIMENT || 'false').toLowerCase() === 'true';
const QUALITY_GATE_AUDIT_ENABLED =
  String(process.env.QUALITY_GATE_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const MANUAL_PREALERT_ALLOW_SUPPRESSED =
  String(process.env.MANUAL_PREALERT_ALLOW_SUPPRESSED || 'false').toLowerCase() === 'true';
const PROFILING_FETCH_ENABLED =
  String(process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() === 'true';
const ENTRY_WINDOW_SECONDS = Math.max(5, Math.min(35, Number(process.env.ENTRY_WINDOW_SECONDS || 30)));
const PREDICTION_RUNTIME_CACHE_TTL_MS = Math.max(
  2000,
  Number(process.env.PREDICTION_RUNTIME_CACHE_TTL_MS || 15000)
);
const EARLY_EXECUTION_ENABLED = String(process.env.EARLY_EXECUTION_ENABLED || 'true').toLowerCase() !== 'false';
const EARLY_EXECUTION_MIN_CONFIDENCE = Math.max(
  0.85,
  Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_CONFIDENCE || 0.97))
);
const EARLY_EXECUTION_MIN_QUANTUM = Math.max(
  0.75,
  Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_QUANTUM || 0.86))
);
const EARLY_EXECUTION_MIN_TIMING = Math.max(
  0.7,
  Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_TIMING || 0.85))
);
const EARLY_EXECUTION_MIN_STABILITY = Math.max(
  0.7,
  Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_STABILITY || 0.84))
);
const spotPriceCache = new Map();
const inflightSpotRequests = new Map();
const trainingStatsCache = new Map();

function pricePrecision(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return 2;
  }
  if (n >= 100) return 2;
  if (n >= 1) return 4;
  return 6;
}

function roundPrice(value, referenceValue = value) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return n;
  }
  const decimals = pricePrecision(referenceValue);
  return Number(n.toFixed(decimals));
}

function normalizeSymbol(symbol) {
  if (!symbol) {
    return symbol;
  }
  const normalized = symbol.toUpperCase().replace('/', '-');
  if (
    normalized === 'BTC-USD' ||
    normalized === 'BTCUSD' ||
    normalized === 'BTC/USDT' ||
    normalized === 'BTCUSDT'
  ) {
    return 'BTC-USDT';
  }
  return normalized;
}

function registerExternalCancellation(options = {}, stage = 'running', callType = 'other') {
  registerTaskCancellation(options?.taskContext, {
    stage,
    scope: 'external_fetch',
    call_type: callType
  });
}

function withExternalTimeout(promiseFactory, label, options = {}) {
  let timeoutId;
  let removeAbortListener = () => {};
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timeout after ${EXTERNAL_DATA_TIMEOUT_MS}ms`)),
      EXTERNAL_DATA_TIMEOUT_MS
    );
  });
  const abortPromise = new Promise((_, reject) => {
    removeAbortListener = addAbortListener(options?.signal, () => {
      removeAbortListener();
      registerExternalCancellation(options, 'running', options?.callType || 'other');
      reject(resolveAbortError(options?.signal, `${label} cancelled`, 'OPERATION_ABORTED'));
    });
  });
  return Promise.race([
    Promise.resolve().then(() => {
      throwIfAborted(options?.signal, `${label} cancelled`, 'OPERATION_ABORTED');
      return promiseFactory();
    }),
    timeoutPromise,
    abortPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
    removeAbortListener();
  });
}

function elapsedMs(startedAtMs) {
  return Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
}

function createBinanceTraceId(symbol, timeframe, origin = 'spot_fetch') {
  return `${origin}:${String(symbol || 'unknown').toUpperCase()}:${String(timeframe || '5m')}:${Date.now()}`;
}

function sumFinite(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return Number(finite.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function getSpotFetchTimingState(options = {}, symbol, timeframe) {
  if (!options?.profiling || typeof options.profiling !== 'object') {
    return null;
  }
  if (!options.profiling.spot_fetch || typeof options.profiling.spot_fetch !== 'object') {
    options.profiling.spot_fetch = {};
  }
  const state = options.profiling.spot_fetch;
  state.symbol = symbol;
  state.timeframe = timeframe;
  if (!Array.isArray(state.fallback_chain)) {
    state.fallback_chain = [];
  }
  if (state.cache_hit == null) {
    state.cache_hit = false;
  }
  return state;
}

function publishSpotFetchTiming(state, options = {}) {
  if (!state) {
    return;
  }
  const payload = {
    symbol: state.symbol,
    timeframe: state.timeframe,
    spot_fetch_ms: Number.isFinite(Number(state.spot_fetch_ms)) ? Number(state.spot_fetch_ms) : null,
    source: state.source || 'unknown',
    binance_attempted: Boolean(state.binance_attempted),
    binance_success: Boolean(state.binance_success),
    binance_latency_ms: Number.isFinite(Number(state.binance_latency_ms))
      ? Number(state.binance_latency_ms)
      : null,
    fallback_ms: Number.isFinite(Number(state.fallback_ms)) ? Number(state.fallback_ms) : null,
    fallback_chain: [...(state.fallback_chain || [])],
    fallback_chain_length: Array.isArray(state.fallback_chain) ? state.fallback_chain.length : 0,
    cache_hit: Boolean(state.cache_hit)
  };
  if (options?.profiling && typeof options.profiling === 'object') {
    options.profiling.spot_fetch = payload;
  }
  if (PROFILING_FETCH_ENABLED) {
    console.log('[SPOT_FETCH_TIMING]', payload);
  }
}

function markSpotFallback(state) {
  if (!state) {
    return;
  }
  if (state.fallback_started_at_ms == null) {
    state.fallback_started_at_ms = Date.now();
  }
}

function shouldUseYahooSpotFallback(timeframe) {
  return String(timeframe || '').toLowerCase() !== '5m';
}

function logSpotFetchFailFast(symbol, timeframe, fallbackUsed, decisionTimeMs, timeoutMs) {
  console.warn('[FETCH_FAIL_FAST]', {
    symbol,
    timeframe,
    stage: 'spot',
    binance_timeout_ms: Number(timeoutMs) || BINANCE_FAIL_FAST_TIMEOUT_MS,
    fallback_used: fallbackUsed,
    decision_time_ms: Number(decisionTimeMs) || 0
  });
}

function resolveSpotFallbackSource(timeframe) {
  if (shouldUseYahooSpotFallback(timeframe)) {
    return 'yahoo';
  }
  if (ALPHA_VANTAGE_KEY) {
    return 'alpha_vantage';
  }
  return 'candles_close';
}

function sanitizeForFirestore(value) {
  if (value === undefined) return null;
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeForFirestore(item));
  }
  if (value && typeof value === 'object') {
    return Object.entries(value).reduce((acc, [key, nestedValue]) => {
      acc[key] = sanitizeForFirestore(nestedValue);
      return acc;
    }, {});
  }
  return value;
}

function compactDecisionLog(label, payload) {
  console.log(label, {
    symbol: payload?.symbol,
    timeframe: payload?.timeframe,
    signal_emitted: payload?.signal_emitted,
    quality_gate_passed: payload?.quality_gate_passed,
    gate_reason: payload?.gate_reason,
    suppression_reason: payload?.suppression_reason,
    context_score: payload?.event_context_filter?.context_score ?? null,
    context_quality: payload?.event_context_filter?.context_quality ?? null,
    allow_event: payload?.event_context_filter?.allow_event ?? null,
    would_block_event: payload?.event_context_filter?.would_block_event ?? null
  });
}

function launchDetached(task, label) {
  setImmediate(() => {
    Promise.resolve()
      .then(task)
      .catch((err) => {
        console.warn(label, err?.message || err);
      });
  });
}

function buildQueuedBinanceExecution(sourceProfile) {
  return {
    attempted: false,
    executed: false,
    dry_run: false,
    queued: true,
    reason: 'queued_for_execution',
    source_profile: sourceProfile || 'unknown',
    updated_at: new Date().toISOString()
  };
}

function buildDefaultContextFilter(overrides = {}) {
  return {
    compression_detected: false,
    range_break_detected: false,
    volume_confirmation: false,
    volatility_expansion_detected: false,
    context_score: 0,
    context_quality: null,
    allow_event: true,
    would_block_event: false,
    event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
    relative_volume: null,
    volume_acceleration: null,
    volatility_expansion_ratio: null,
    structural_context_score: null,
    volatility_context_score: null,
    volume_flow_context_score: null,
    liquidity_context_score: null,
    context_layer_breakdown: null,
    compression_duration: 0,
    compression_tightness: null,
    break_efficiency: null,
    close_location_value: null,
    wick_imbalance: null,
    volume_persistence_score: null,
    volatility_slope: null,
    compression_energy: 0,
    expansion_impulse: null,
    expansion_imbalance: null,
    fake_breakout_penalty: null,
    fake_breakout_detected: false,
    liquidity_trap_risk: null,
    session_microstructure_score: null,
    structural_break_acceptance: null,
    metrics: null,
    details: null,
    ...overrides
  };
}

async function fetchAlphaVantageSpot(symbol, options = {}) {
  throwIfAborted(options?.signal, `AlphaVantage spot cancelled for ${symbol}`, 'OPERATION_ABORTED');
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('AlphaVantage key missing');
  }
  const cleanSymbol = symbol.replace('-', '').replace('/', '');
  const url = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(
    cleanSymbol
  )}&apikey=${ALPHA_VANTAGE_KEY}`;
  const controller = new AbortController();
  const removeAbortListener = addAbortListener(options?.signal, () => {
    registerExternalCancellation(options, 'running', 'spot');
    controller.abort(resolveAbortError(options?.signal, `AlphaVantage spot cancelled for ${symbol}`, 'OPERATION_ABORTED'));
  });
  const timer = setTimeout(() => controller.abort(), EXTERNAL_DATA_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const data = await response.json();
    const quote = data['Global Quote'];
  if (!quote) {
    throw new Error('AlphaVantage no devolviÃ³ cotizaciÃ³n');
  }
  const price = Number(quote['05. price']);
  if (!price) {
    throw new Error('AlphaVantage sin precio vÃ¡lido');
  }
  return price;
  } catch (error) {
    if (options?.signal?.aborted) {
      throw resolveAbortError(options.signal, `AlphaVantage spot cancelled for ${symbol}`, 'OPERATION_ABORTED');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

async function obtenerSpotPrice(symbol, timeframe = '5m', options = {}) {
  throwIfAborted(options?.signal, `Spot fetch cancelled for ${symbol}`, 'OPERATION_ABORTED');
  const spotTiming = getSpotFetchTimingState(options, symbol, timeframe);
  const spotStartedAtMs = Date.now();
  if (!symbol) {
    throw new Error('SÃ­mbolo requerido para spot price');
  }

  if (ENABLE_BINANCE) {
    if (spotTiming) {
      spotTiming.binance_attempted = true;
      spotTiming.fallback_chain.push('binance');
    }
    const binanceStartedAtMs = Date.now();
    try {
      const price = await fetchBinanceSpot(symbol, {
        timeoutMs: BINANCE_FAIL_FAST_TIMEOUT_MS,
        retryOnTimeout: false,
        signal: options?.signal,
        taskContext: options?.taskContext,
        trace: {
          symbol,
          call_type: 'spot',
          origin: 'spot_fetch',
          trace_id: createBinanceTraceId(symbol, timeframe, 'spot_fetch')
        }
      });
      if (spotTiming) {
        spotTiming.binance_success = true;
        spotTiming.binance_latency_ms = elapsedMs(binanceStartedAtMs);
        spotTiming.source = 'binance';
        spotTiming.spot_fetch_ms = elapsedMs(spotStartedAtMs);
        spotTiming.fallback_ms = 0;
      }
      console.log('[BINANCE] spot fetch ok', { symbol, price });
      publishSpotFetchTiming(spotTiming, options);
      return { price, source: 'binance' };
    } catch (error) {
      if (spotTiming) {
        spotTiming.binance_latency_ms = elapsedMs(binanceStartedAtMs);
        markSpotFallback(spotTiming);
      }
      if (error?.status === 429) {
        console.warn('[BINANCE] spot fetch failed -> reason: rate_limited');
      } else {
        console.warn('[BINANCE] spot fetch failed -> reason:', error?.message || 'unknown');
      }
      if (error?.code === 'BINANCE_TIMEOUT') {
        logSpotFetchFailFast(
          symbol,
          timeframe,
          resolveSpotFallbackSource(timeframe),
          elapsedMs(binanceStartedAtMs),
          error?.timeout_ms || BINANCE_FAIL_FAST_TIMEOUT_MS
        );
      }
    }
  }

  throwIfAborted(options?.signal, `Spot fetch cancelled for ${symbol}`, 'OPERATION_ABORTED');
  const useYahooFallback = shouldUseYahooSpotFallback(timeframe);
  const yahooSymbol = symbol === 'BTC-USDT' ? 'BTC-USD' : symbol;
  let yahooError = null;
  if (useYahooFallback) {
    try {
      if (spotTiming) {
        markSpotFallback(spotTiming);
        spotTiming.fallback_chain.push('yahoo');
      }
      const quote = await withExternalTimeout(() => yahooFinance.quote(yahooSymbol), 'Yahoo quote', {
        signal: options?.signal,
        taskContext: options?.taskContext,
        callType: 'spot'
      });
      if (quote?.regularMarketPrice) {
        if (spotTiming) {
          spotTiming.source = 'yahoo';
          spotTiming.spot_fetch_ms = elapsedMs(spotStartedAtMs);
          spotTiming.fallback_ms =
            spotTiming.fallback_started_at_ms == null ? 0 : elapsedMs(spotTiming.fallback_started_at_ms);
        }
        publishSpotFetchTiming(spotTiming, options);
        return { price: Number(quote.regularMarketPrice), source: 'yahoo' };
      }
      throw new Error('Yahoo Finance sin precio');
    } catch (error) {
      yahooError = error;
      console.warn('[YAHOO] spot fetch failed -> reason:', error?.message || 'unknown');
    }
  }

  let alphaError = null;
  if (ALPHA_VANTAGE_KEY) {
    try {
      if (spotTiming) {
        markSpotFallback(spotTiming);
        spotTiming.fallback_chain.push('alpha_vantage');
      }
      const price = await fetchAlphaVantageSpot(symbol, options);
      if (spotTiming) {
        spotTiming.source = 'alpha_vantage';
        spotTiming.spot_fetch_ms = elapsedMs(spotStartedAtMs);
        spotTiming.fallback_ms =
          spotTiming.fallback_started_at_ms == null ? 0 : elapsedMs(spotTiming.fallback_started_at_ms);
      }
      publishSpotFetchTiming(spotTiming, options);
      return { price, source: 'alpha_vantage' };
    } catch (error) {
      alphaError = error;
      console.warn('[prediccionVelas] fallback AlphaVantage spot price', error.message);
    }
  }

  if (!useYahooFallback && alphaError) {
    console.warn('[YAHOO] spot fallback skipped for timeframe', timeframe);
  } else if (useYahooFallback && yahooError && alphaError) {
    console.warn('[prediccionVelas] spot fallback exhausted', {
      symbol,
      timeframe,
      yahoo_error: yahooError?.message || null,
      alpha_error: alphaError?.message || null
    });
  }

  throwIfAborted(options?.signal, `Spot fetch cancelled for ${symbol}`, 'OPERATION_ABORTED');
  if (spotTiming) {
    markSpotFallback(spotTiming);
    spotTiming.fallback_chain.push('candles_close');
  }
  const candles = await Promise.resolve(
    options?.preloadedCandles ||
      fetchCandles(
        symbol,
        timeframe,
        options?.profiling
          ? {
              profiling: options.profiling,
              traceOrigin: 'spot_fallback_candles_close',
              signal: options?.signal,
              taskContext: options?.taskContext
            }
          : {
              traceOrigin: 'spot_fallback_candles_close',
              signal: options?.signal,
              taskContext: options?.taskContext
            }
      )
  );
  const lastClose = candles.length ? Number(candles[candles.length - 1]?.close) : NaN;
  if (Number.isFinite(lastClose) && lastClose > 0) {
    console.warn('[prediccionVelas] fallback candle close spot price', { symbol, timeframe, lastClose });
    if (spotTiming) {
      spotTiming.source = 'candles_close';
      spotTiming.spot_fetch_ms = elapsedMs(spotStartedAtMs);
      spotTiming.fallback_ms =
        spotTiming.fallback_started_at_ms == null ? 0 : elapsedMs(spotTiming.fallback_started_at_ms);
    }
    publishSpotFetchTiming(spotTiming, options);
    return { price: lastClose, source: 'candles_close' };
  }

  if (spotTiming) {
    spotTiming.source = 'error';
    spotTiming.spot_fetch_ms = elapsedMs(spotStartedAtMs);
    spotTiming.fallback_ms =
      spotTiming.fallback_started_at_ms == null ? 0 : elapsedMs(spotTiming.fallback_started_at_ms);
  }
  publishSpotFetchTiming(spotTiming, options);
  throw new Error(`No se pudo obtener spot price real para ${symbol}`);
}

async function getCachedSpotPrice(symbol, timeframe = '5m', options = {}) {
  throwIfAborted(options?.signal, `Spot cache wait cancelled for ${symbol}`, 'OPERATION_ABORTED');
  const cacheKey = `${String(symbol || '').toUpperCase()}|${String(timeframe || '5m')}`;
  const cached = spotPriceCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PREDICTION_RUNTIME_CACHE_TTL_MS) {
    const spotTiming = getSpotFetchTimingState(options, symbol, timeframe);
    if (spotTiming) {
      spotTiming.cache_hit = true;
      spotTiming.source = cached?.value?.source || 'cache';
      spotTiming.spot_fetch_ms = 0;
      spotTiming.fallback_ms = 0;
      publishSpotFetchTiming(spotTiming, options);
    }
    return cached.value;
  }
  if (inflightSpotRequests.has(cacheKey)) {
    return raceWithSignal(
      inflightSpotRequests.get(cacheKey),
      options?.signal,
      `Spot cache wait cancelled for ${symbol}`,
      'OPERATION_ABORTED'
    );
  }
  const request = obtenerSpotPrice(symbol, timeframe, options)
    .then((value) => {
      spotPriceCache.set(cacheKey, { value, fetchedAt: Date.now() });
      return value;
    })
    .finally(() => {
      inflightSpotRequests.delete(cacheKey);
    });
  inflightSpotRequests.set(cacheKey, request);
  return request;
}

function computeExitWindow(timeframe, entryTime) {
  if (timeframe !== '1m') {
    return {
      exit_time: new Date(entryTime.getTime() + 60000),
      exit_window_seconds: null,
      max_time_seconds: null,
      exit_rule: null
    };
  }

  const minExit = 20;
  const maxExit = 45;
  const exitTime = new Date(entryTime.getTime() + maxExit * 1000);

  return {
    exit_time: exitTime,
    exit_window_seconds: { min: minExit, max: maxExit, preferred: 35 },
    max_time_seconds: 60,
    exit_rule: 'impulse_exhausted_or_max_time'
  };
}

function computeImpulseMetrics() {
  const momentum = randomBetween(0.2, 1.2);
  const acceleration = randomBetween(0.1, 1.0);
  const volumeSpike = randomBetween(0, 1);
  const impulseStrength = clamp(momentum * 0.45 + acceleration * 0.35 + volumeSpike * 0.2, 0, 1);
  const impulsePresent = impulseStrength >= 0.6 && acceleration >= 0.4;

  return {
    momentum: Number(momentum.toFixed(3)),
    acceleration: Number(acceleration.toFixed(3)),
    volume_spike: Number(volumeSpike.toFixed(3)),
    strength: Number(impulseStrength.toFixed(3)),
    impulse_present: impulsePresent
  };
}

async function loadTrainingStats(symbolNormalized) {
  if (!symbolNormalized) {
    return null;
  }
  const cacheKey = String(symbolNormalized || '').toUpperCase();
  const cached = trainingStatsCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < PREDICTION_RUNTIME_CACHE_TTL_MS) {
    return cached.value;
  }
  const docRef = db.collection('velas_training_stats').doc(symbolNormalized);
  const snapshot = await docRef.get();
  const value = snapshot.exists ? (snapshot.data() || null) : null;
  trainingStatsCache.set(cacheKey, { value, fetchedAt: Date.now() });
  return value;
}

function applyTrainingFeedback(confidence, quantumScore, stats) {
  if (!stats || !stats.samples) {
    return { confidence, quantumScore, adjustment: 0, note: 'no_history' };
  }

  const samples = stats.samples || 0;
  if (samples < 5) {
    return { confidence, quantumScore, adjustment: 0, note: 'insufficient_history' };
  }

  const validWins = stats.valid_wins || 0;
  const luckyWins = stats.lucky_wins || 0;
  const losses = stats.losses || 0;
  const avgTiming = stats.avg_timing_score ?? 0.5;

  const validRate = validWins / samples;
  const luckyRate = luckyWins / samples;
  const lossRate = losses / samples;

  let adjustment = 0;
  adjustment += (validRate - 0.5) * 0.2;
  adjustment -= luckyRate * 0.15;
  adjustment -= lossRate * 0.25;
  adjustment += (avgTiming - 0.6) * 0.1;

  const adjustedConfidence = clamp(confidence + adjustment, 0.1, 0.99);
  const adjustedQuantum = clamp(quantumScore + adjustment * 0.8, 0.1, 0.99);

  return {
    confidence: adjustedConfidence,
    quantumScore: adjustedQuantum,
    adjustment: Number(adjustment.toFixed(3)),
    note: 'training_feedback'
  };
}

function computeSignalStability(confidenceRaw, quantumRaw, timingRaw) {
  const confidence = Number(confidenceRaw || 0);
  const quantum = Number(quantumRaw || 0);
  const timing = Number(timingRaw || 0);
  const avg = (confidence + quantum + timing) / 3;
  const dispersion =
    (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
  return clamp(avg * (1 - Math.min(dispersion, 0.5)), 0, 1);
}

function shouldEarlyCommitExecution({
  isEventDriven,
  direction,
  confidence,
  quantumScore,
  timingScore,
  contextFilter
}) {
  if (!EARLY_EXECUTION_ENABLED) return { ok: false, reason: 'disabled' };
  if (!isEventDriven) return { ok: false, reason: 'not_event_driven' };
  if (direction !== 'up' && direction !== 'down') return { ok: false, reason: 'neutral_direction' };

  const stability = computeSignalStability(confidence, quantumScore, timingScore);
  const contextAllowed = !EVENT_CONTEXT_FILTER_ENABLED || contextFilter?.allow_event !== false;
  const ok =
    confidence >= EARLY_EXECUTION_MIN_CONFIDENCE &&
    quantumScore >= EARLY_EXECUTION_MIN_QUANTUM &&
    timingScore >= EARLY_EXECUTION_MIN_TIMING &&
    stability >= EARLY_EXECUTION_MIN_STABILITY &&
    contextAllowed;

  return {
    ok,
    stability,
    reason: ok ? 'strong_event_signal' : 'threshold_not_met'
  };
}

function applyConfidenceReweighting({
  confidence,
  quantumScore,
  timingScore,
  isEventDriven,
  neutralRate
}) {
  // Reweighting only changes scoring, not base thresholds.
  const notes = [];
  const baseConfidence = confidence;
  let adjusted = confidence;

  const alignedQuantumTiming = quantumScore >= 0.85 && timingScore >= 0.75;
  if (isEventDriven && baseConfidence >= 0.8) {
    adjusted = clamp(adjusted * 1.12, 0.05, 0.99);
    notes.push('event_boost');
  }
  if (alignedQuantumTiming) {
    adjusted = clamp(adjusted * 1.04, 0.05, 0.99);
    notes.push('aligned_boost');
  }

  if (neutralRate != null && neutralRate >= 0.8) {
    adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
    notes.push('neutral_penalty');
  }

  let lowConfidencePenalty = false;
  if (adjusted < 0.6) {
    adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
    lowConfidencePenalty = true;
    notes.push('low_confidence_penalty');
  }

  return {
    confidence_before: baseConfidence,
    confidence_after: adjusted,
    lowConfidencePenalty,
    notes
  };
}

function evaluateTimeframeGate(timeframe, confidence, quantumScore, direction, impulsePresent) {
  if (timeframe !== '1m') {
    return { pass: true, reason: 'non_1m' };
  }
  const reasons = [];
  if (confidence < 0.8) reasons.push('confidence');
  if (quantumScore < 0.85) reasons.push('quantum');
  if (direction === 'neutral') reasons.push('direction');
  if (!impulsePresent) reasons.push('impulse');
  return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function evaluateEventGate(confidence, quantumScore, timingScore, direction, impulsePresent) {
  const reasons = [];
  if (confidence < 0.85) reasons.push('confidence');
  if (quantumScore < 0.9) reasons.push('quantum');
  if (timingScore < 0.7) reasons.push('timing');
  if (direction === 'neutral') reasons.push('direction');
  if (!impulsePresent) reasons.push('impulse');
  return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function normalizeQualityGateInput(input = {}) {
  try {
    console.log('[DEBUG_NORMALIZE_START]', JSON.stringify(input));

    console.log('[DEBUG_NORMALIZE_BEFORE_CONFIDENCE]', input.confidence, input.confidence_score);
    const confidence =
      Number.isFinite(input.confidence) ? input.confidence : Number.isFinite(input.confidence_score)
        ? input.confidence_score
        : null;
    console.log('[DEBUG_NORMALIZE_AFTER_CONFIDENCE]', confidence);

    console.log('[DEBUG_NORMALIZE_BEFORE_QUANTUM]', input.quantum, input.quantum_score);
    const quantum =
      Number.isFinite(input.quantum) ? input.quantum : Number.isFinite(input.quantum_score)
        ? input.quantum_score
        : null;
    console.log('[DEBUG_NORMALIZE_AFTER_QUANTUM]', quantum);

    console.log('[DEBUG_NORMALIZE_BEFORE_TIMING]', input.timing, input.timing_score);
    const timing =
      Number.isFinite(input.timing) ? input.timing : Number.isFinite(input.timing_score)
        ? input.timing_score
        : null;
    console.log('[DEBUG_NORMALIZE_AFTER_TIMING]', timing);

    console.log('[DEBUG_NORMALIZE_BEFORE_STABILITY]', input.stability);
    const stability = Number.isFinite(input.stability) ? input.stability : 0;
    console.log('[DEBUG_NORMALIZE_AFTER_STABILITY]', stability);

    console.log('[DEBUG_NORMALIZE_BEFORE_IMPULSE]', input.impulse_present, input.impulse);
    const impulsePresent = Boolean(input.impulse_present ?? input.impulse ?? false);
    console.log('[DEBUG_NORMALIZE_AFTER_IMPULSE]', impulsePresent);

    console.log('[DEBUG_NORMALIZE_BEFORE_CONTEXT]', input.context_quality, input.context_score);
    const contextQuality = Number.isFinite(input.context_quality)
      ? input.context_quality
      : Number.isFinite(input.context_score)
        ? input.context_score
        : 0;
    console.log('[DEBUG_NORMALIZE_AFTER_CONTEXT]', contextQuality);

    console.log('[DEBUG_NORMALIZE_RETURN]', {
      confidence,
      quantum,
      timing,
      stability,
      impulsePresent,
      contextQuality
    });

    return {
      confidence,
      quantum,
      timing,
      stability,
      direction: input.direction ?? 'neutral',
      impulse_present: impulsePresent,
      context_quality: contextQuality
    };
  } catch (err) {
    console.error('[DEBUG_NORMALIZE_CRASH]', err?.message || err, err?.stack);
    throw err;
  }
}

function formatTimeUTC(date) {
  return date.toISOString().slice(11, 19);
}

function buildEventDrivenWindows(referenceTime, impulseConfig, impulseMetrics) {
  const entryOffsetMs = Math.round(randomBetween(4000, 15000));
  const entryDurationMs = Math.round(randomBetween(12000, 25000));
  const entryStart = new Date(referenceTime.getTime() + entryOffsetMs);
  const entryEnd = new Date(entryStart.getTime() + entryDurationMs);

  const impulseMin = Math.max(20, Math.round(impulseMetrics.strength * 40));
  const impulseMax = impulseMin + Math.round(randomBetween(10, 25));
  const exitDelayMs = Math.round(randomBetween(3000, 10000));
  const exitStart = new Date(entryEnd.getTime() + exitDelayMs);
  const exitEnd = new Date(exitStart.getTime() + impulseMax * 1000);

  return {
    entryWindow: {
      start: formatTimeUTC(entryStart),
      end: formatTimeUTC(entryEnd)
    },
    exitWindow: {
      start: formatTimeUTC(exitStart),
      end: formatTimeUTC(exitEnd)
    },
    impulseDurationSeconds: {
      min: impulseMin,
      max: impulseMax
    },
    exitTime: exitEnd,
    exitWindowSeconds: {
      min: impulseMin,
      max: impulseMax,
      preferred: impulseConfig?.preferred || impulseMax
    },
    entryStart,
    entryEnd,
    exitStart,
    exitEnd
  };
}

function buildTradePlan({ spotPrice, modelPriceEstimate, direction, timeframeMinutes }) {
  const entry = Number(spotPrice);
  const target = Number(modelPriceEstimate);

  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(target) || (direction !== 'up' && direction !== 'down')) {
    return null;
  }

  const rewardDistance = Math.max(
    Math.abs(target - entry),
    entry * 0.0035
  );
  const riskDistance = rewardDistance * 0.6;

  const stopLoss = direction === 'up'
    ? entry - riskDistance
    : entry + riskDistance;
  const takeProfit = direction === 'up'
    ? entry + rewardDistance
    : entry - rewardDistance;
  const referencePrice = Math.min(Math.abs(entry), Math.abs(target)) || entry;

  return {
    entry_price: roundPrice(entry, referencePrice),
    stop_loss: roundPrice(stopLoss, referencePrice),
    take_profit: roundPrice(takeProfit, referencePrice),
    target_exit_price: roundPrice(target, referencePrice),
    risk_per_unit: roundPrice(riskDistance, referencePrice),
    reward_per_unit: roundPrice(rewardDistance, referencePrice),
    risk_reward_ratio: Number((rewardDistance / riskDistance).toFixed(2)),
    estimated_holding_minutes: Number(timeframeMinutes || 0),
    plan_version: 'conservative_v1'
  };
}


async function generarPrediccion({
  symbol,
  timeframe = '5m',
  monto = 1000,
  execution_mode = 'timeframe',
  origin,
  signal,
  taskContext
} = {}) {
  console.log('[DEBUG_PREDICCION_START]', symbol);
  
  // Validación TEMPRANA de símbolo - bloquear antes de cualquier procesamiento
  if (!symbol || typeof symbol !== 'string' || symbol.includes('?')) {
    console.log('[DEBUG_INVALID_SYMBOL_BLOCKED]', symbol);
    return null;
  }
  
  throwIfAborted(signal, `Prediction cancelled for ${symbol || 'unknown'}`, 'OPERATION_ABORTED');
  
  const frameMinutes = timeframes[timeframe] || 5;
  const analysisStartAt = new Date();
  const analysisStartIso = analysisStartAt.toISOString();
  const now = analysisStartAt;
  const entryTime = new Date(now.getTime() + frameMinutes * 60000);
  const exitWindow = computeExitWindow(timeframe, entryTime);

  const symbolInput = symbol ? symbol.toUpperCase() : '';
  const symbolNormalized = normalizeSymbol(symbolInput);
  const executionMode = execution_mode === 'event_driven' ? 'event_driven' : 'timeframe';
  const isEventDriven = executionMode === 'event_driven';
  const profiling = PROFILING_FETCH_ENABLED
    ? {
        symbol: symbolNormalized || symbolInput,
        timeframe
      }
    : null;
  const trainingStatsPromise = loadTrainingStats(symbolNormalized);
  const learningConfigPromise = preloadLearningConfig(symbolNormalized || symbolInput, executionMode, timeframe);
  const sharedCandlesPromise = fetchCandles(
    symbolNormalized || symbolInput,
    timeframe,
    profiling ? { profiling, signal, taskContext } : { signal, taskContext }
  );
  console.log('[DEBUG_FETCH_CANDLES]', symbol);

  let spotPrice = null;
  let spotPriceSource = 'unresolved';
  try {
    console.log('[DEBUG_FETCH_SPOT]', symbol);
    const fetchedSpot = await getCachedSpotPrice(symbolNormalized || symbolInput, timeframe, {
      preloadedCandles: sharedCandlesPromise,
      profiling,
      signal,
      taskContext
    });
    if (Number.isFinite(fetchedSpot?.price)) {
      spotPrice = roundPrice(fetchedSpot.price);
      spotPriceSource = fetchedSpot.source || 'unknown';
    }
  } catch (error) {
    console.log('[DEBUG_FETCH_FALLBACK]', symbol);
    console.warn('[prediccionVelas] spot price fetch failed', {
      symbol: symbolInput,
      message: error?.message || 'sin detalle'
    });
  }

  if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
    throw new Error(`No se pudo generar prediccion sin spot price valido para ${symbolInput || symbolNormalized}`);
  }
  throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

  const precioActual = spotPrice;
  const predictionComputeStartedAtMs = Date.now();
  console.log('[DEBUG_STEP_1_AFTER_BEFORE]', symbol);
  let contextFilter = buildDefaultContextFilter();
  const impulseMetrics = computeImpulseMetrics();
  const impulseMinPercent = timeframe === '1m' ? 0.2 : 0.5;

  const minMove = timeframe === '1m' ? 0.15 : 0.4;
  const maxMove = timeframe === '1m' ? 1.2 : 3.5;
  const expectedMovePercent = Number(
    clamp(randomBetween(minMove, maxMove) * impulseMetrics.strength, 0, maxMove).toFixed(2)
  );

  let direction = 'neutral';
  if (impulseMetrics.impulse_present) {
    direction = Math.random() >= 0.5 ? 'up' : 'down';
  }
  const directionSign = direction === 'down' ? -1 : direction === 'up' ? 1 : 0;
  const contextCandlesPromise =
    EVENT_CONTEXT_FILTER_ENABLED && (direction === 'up' || direction === 'down')
      ? sharedCandlesPromise
      : Promise.resolve(null);

  if (EVENT_CONTEXT_FILTER_ENABLED && (direction === 'up' || direction === 'down')) {
    try {
      const contextCandles = await contextCandlesPromise;
      contextFilter = evaluateEventContextFilter({
        candles: contextCandles,
        direction,
        currentPrice: spotPrice,
        mode: EVENT_CONTEXT_FILTER_MODE
      });
    } catch (err) {
      console.log('[DEBUG_PREDICCION_ERROR] context_filter', err?.message || err);
      contextFilter = buildDefaultContextFilter({
        allow_event: EVENT_CONTEXT_FILTER_MODE === 'observe',
        would_block_event: true,
        details: { error: err?.message || 'context_filter_failed' }
      });
    }
  }
  throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

  const baseConfidence = clamp(0.45 + impulseMetrics.strength * 0.4 + randomBetween(-0.08, 0.08), 0.2, 0.99);
  const timingScore = clamp(0.5 + impulseMetrics.strength * 0.4 + randomBetween(-0.1, 0.1), 0, 1);
  const baseQuantum = clamp(0.4 + impulseMetrics.strength * 0.5 + randomBetween(-0.06, 0.06), 0.1, 0.99);

  let confidence = baseConfidence;
  let quantumScore = clamp(baseQuantum * (0.7 + timingScore * 0.3), 0.1, 0.99);
  const signedDeltaPct = directionSign === 0 ? 0 : Number((expectedMovePercent * directionSign).toFixed(2));
  const modelPriceEstimate = roundPrice(spotPrice * (1 + signedDeltaPct / 100), spotPrice);
  const gananciaEstim = Number((monto * (signedDeltaPct / 100)).toFixed(2));
  const porcentaje = signedDeltaPct;
  const computedTradePlan = buildTradePlan({
    spotPrice,
    modelPriceEstimate,
    direction,
    timeframeMinutes: frameMinutes
  });
  const eventDrivenInfo = isEventDriven
    ? buildEventDrivenWindows(now, { preferred: 35 }, impulseMetrics)
    : null;
  const entryTimeIso = isEventDriven
    ? eventDrivenInfo?.entryStart.toISOString()
    : entryTime.toISOString();
  const exitTimeIso = isEventDriven
    ? eventDrivenInfo?.exitEnd.toISOString()
    : exitWindow.exit_time.toISOString();
  const exitWindowSeconds = isEventDriven
    ? eventDrivenInfo?.exitWindowSeconds || { min: 0, max: 60, preferred: 60 }
    : exitWindow.exit_window_seconds;
  const maxTimeSeconds = isEventDriven ? 60 : exitWindow.max_time_seconds;
  const finalExitRule = isEventDriven
    ? 'Impulse exhausted or max 60s hard cap for event-driven mode'
    : exitWindow.exit_rule;
  const earlyCommitDecision = shouldEarlyCommitExecution({
    isEventDriven,
    direction,
    confidence,
    quantumScore,
    timingScore,
    contextFilter
  });
  let docRef = null;
  let earlyExecutionState = null;
  let earlySourceProfile = 'event_emitted';
  let queuedBinanceExecutionTask = null;

  if (earlyCommitDecision.ok && computedTradePlan) {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    docRef = await db.collection('velas_predicciones').add(
      sanitizeForFirestore({
        simbolo: symbolInput,
        simbolo_normalizado: symbolNormalized,
        tipo: 'velas',
        timeframe,
        execution_mode: executionMode,
        mode: isEventDriven ? 'event-driven' : 'timeframe',
        timeframe_minutes: frameMinutes,
        monto,
        spot_price: spotPrice,
        precio_actual: spotPrice,
        precio_estimado: modelPriceEstimate,
        porcentaje,
        expected_move_percent: expectedMovePercent,
        signed_delta_pct: signedDeltaPct,
        trade_plan: computedTradePlan,
        ahora: analysisStartIso,
        analysis_start_at: analysisStartIso,
        signal_created_at: analysisStartIso,
        signal_ready_at: null,
        signal_emitted: true,
        direction,
        confianza: Number(confidence.toFixed(2)),
        confidence_before: Number(confidence.toFixed(4)),
        confidence_after: Number(confidence.toFixed(4)),
        quantum_score: Number(quantumScore.toFixed(2)),
        timing_score: Number(timingScore.toFixed(2)),
        context_score: contextFilter.context_score,
        context_quality: contextFilter.context_quality,
        entry_time: entryTimeIso,
        exit_time: exitTimeIso,
        exit_window_seconds: exitWindowSeconds,
        max_time_seconds: maxTimeSeconds,
        exit_rule: finalExitRule,
        early_execution_candidate: true,
        early_execution_stability: Number(earlyCommitDecision.stability.toFixed(4)),
        status: 'processing',
        verification: null,
        timestamp: analysisStartIso,
        created_at: analysisStartIso
      })
    );

    const earlyPrediction = {
      id: docRef.id,
      prediction_id: docRef.id,
      symbol: symbolInput,
      simbolo: symbolInput,
      execution_mode: executionMode,
      mode: isEventDriven ? 'event-driven' : 'timeframe',
      timeframe_minutes: frameMinutes,
      direction,
      confidence,
      confianza: Number(confidence.toFixed(4)),
      quantum_score: Number(quantumScore.toFixed(4)),
      timing_score: Number(timingScore.toFixed(4)),
      stability: Number(earlyCommitDecision.stability.toFixed(4))
    };
    const [preAlertDecisionEarly, highConvictionDecisionEarly] = await Promise.all([
      shouldSendManualPreAlert(db, earlyPrediction).catch(() => ({ ok: false, reason: 'early_prealert_failed' })),
      shouldEmitHighConvictionSignal(db, earlyPrediction).catch(() => ({ ok: false, reason: 'early_hc_failed' }))
    ]);
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

    earlySourceProfile = highConvictionDecisionEarly.ok
      ? 'high_conviction'
      : (preAlertDecisionEarly.ok ? 'manual_prealert' : 'event_emitted');

    const signalReadyAtEarly = new Date();
    const signalReadyIsoEarly = signalReadyAtEarly.toISOString();
    const operationalEntryWindowEarly = {
      start: formatTimeUTC(signalReadyAtEarly),
      end: formatTimeUTC(new Date(signalReadyAtEarly.getTime() + ENTRY_WINDOW_SECONDS * 1000))
    };
    const executionPayloadEarly = sanitizeForFirestore({
      id: docRef.id,
      prediction_id: docRef.id,
      symbol: symbolInput,
      simbolo: symbolInput,
      timeframe,
      execution_mode: executionMode,
      mode: isEventDriven ? 'event-driven' : 'timeframe',
      timeframe_minutes: frameMinutes,
      direction,
      trade_plan: computedTradePlan,
      spot_price: spotPrice,
      precio_actual: spotPrice,
      expected_move_percent: Number(expectedMovePercent.toFixed(4)),
      context_score: contextFilter.context_score,
      context_quality: contextFilter.context_quality,
      confidence: Number(confidence.toFixed(4)),
      quantum_score: Number(quantumScore.toFixed(4)),
      timing_score: Number(timingScore.toFixed(4)),
      ahora: signalReadyIsoEarly,
      created_at: signalReadyIsoEarly,
      timestamp: signalReadyIsoEarly,
      analysis_start_at: analysisStartIso,
      signal_created_at: analysisStartIso,
      signal_ready_at: signalReadyIsoEarly,
      signal_emitted_at: signalReadyIsoEarly,
      analysis_entry_window: eventDrivenInfo?.entryWindow || null,
      estimated_window: operationalEntryWindowEarly,
      entry_window: operationalEntryWindowEarly,
      entry_window_utc: operationalEntryWindowEarly,
      entry_window_start_at: signalReadyIsoEarly,
      entry_window_end_at: new Date(signalReadyAtEarly.getTime() + ENTRY_WINDOW_SECONDS * 1000).toISOString(),
      source_profile: earlySourceProfile,
      source: earlySourceProfile
    });

    earlyExecutionState = {
      completed: true,
      sourceProfile: earlySourceProfile,
      signalReadyIso: signalReadyIsoEarly,
      analysisToSignalReadyMs: signalReadyAtEarly.getTime() - analysisStartAt.getTime(),
      entryWindowStartIso: signalReadyIsoEarly,
      entryWindowEndIso: executionPayloadEarly.entry_window_end_at,
      binanceExecution: buildQueuedBinanceExecution(earlySourceProfile)
    };
    queuedBinanceExecutionTask = {
      predictionId: docRef.id,
      executionPayload: executionPayloadEarly,
      sourceProfile: earlySourceProfile
    };
  }

  console.log('[DEBUG_STEP_2_BEFORE_TRAINING]', symbol);
  const trainingStats = await trainingStatsPromise;
  console.log('[DEBUG_STEP_3_AFTER_TRAINING]', symbol);
  console.log('[DEBUG_ABORT_CHECK_1_BEFORE]', symbol);
  throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
  console.log('[DEBUG_ABORT_CHECK_1_AFTER]', symbol);
  console.log('[DEBUG_STEP_4_BEFORE_FEEDBACK]', symbol);
  const trainingFeedback = applyTrainingFeedback(confidence, quantumScore, trainingStats);
  console.log('[DEBUG_STEP_5_AFTER_FEEDBACK]', symbol);
  confidence = trainingFeedback.confidence;
  quantumScore = trainingFeedback.quantumScore;
  const neutralRate = trainingStats?.neutral_rate ?? trainingStats?.neutralRate ?? null;
  console.log('[DEBUG_STEP_6_BEFORE_STABILITY]', symbol);
  const stability = computeSignalStability(confidence, quantumScore, timingScore);
  console.log('[DEBUG_STEP_7_AFTER_STABILITY]', symbol);
  console.log('[DEBUG_STEP_7_5_AFTER_STABILITY]', symbol);
  const gateStartedAtMs = Date.now();
  console.log('[DEBUG_STEP_7_6_BEFORE_NORMALIZATION]', symbol);
  console.log('[DEBUG_NORMALIZE_CALL_ATTEMPT]', symbol);
  console.log('[DEBUG_AFTER_ATTEMPT_LINE_UPDATED_V1]', symbol);

  // Validación robusta de valores numéricos antes de quality gate
  quantumScore = Number.isFinite(quantumScore) ? quantumScore : Number(quantumScore) || 0;
  timingScore = Number.isFinite(timingScore) ? timingScore : Number(timingScore) || 0;
  console.log('[DEBUG_STEP_7_7_AFTER_NORMALIZATION]', symbol);

  console.log('[DEBUG_STEP_7_8_BEFORE_GATE_INPUT]', symbol);
  console.log('[DEBUG_STEP_8_BEFORE_GATE]', symbol);

  console.log('[DEBUG_GATE_INPUT_CONSTRUCTION]', 'confidence', confidence, 'quantum', quantumScore, 'timing', timingScore);
  console.log('[DEBUG_GATE_INPUT_DEPENDENCIES]', {
    has_impulseMetrics: !!impulseMetrics,
    impulse_present: impulseMetrics?.impulse_present,
    has_contextFilter: !!contextFilter,
    context_quality: contextFilter?.context_quality,
    has_direction: !!direction,
    has_stability: !!stability
  });
  console.log('[DEBUG_ABOUT_TO_CONSTRUCT_GATE_INPUT]', symbol);
  
  // Bloqueo CRÍTICO: validar objetos requeridos antes de construir gate
  if (!contextFilter || !impulseMetrics) {
    console.log('[DEBUG_BLOCKED_BEFORE_GATE]', symbolInput, {
      hasContextFilter: !!contextFilter,
      hasImpulseMetrics: !!impulseMetrics
    });
    return null;
  }
  
  const gateOriginalInput = {
    confidence: Number.isFinite(confidence) ? confidence : 0,

    quantum: Number.isFinite(quantumScore) ? quantumScore : 0,
    timing: Number.isFinite(timingScore) ? timingScore : 0,

    impulse: impulseMetrics?.impulse_present ?? false,

    stability: Number.isFinite(stability) ? stability : 0,

    direction: direction ?? 'neutral',

    context_quality: Number.isFinite(contextFilter?.context_quality)
      ? contextFilter.context_quality
      : 0,

    context_score: Number.isFinite(contextFilter?.context_score)
      ? contextFilter.context_score
      : 0
  };
  console.log('[DEBUG_GATE_INPUT_CONSTRUCTED]', symbol, 'keys:', Object.keys(gateOriginalInput).length);
  console.log('[DEBUG_AFTER_CONSTRUCT_GATE_INPUT]', JSON.stringify({
    confidence: gateOriginalInput.confidence,
    quantum_score: gateOriginalInput.quantum_score,
    timing_score: gateOriginalInput.timing_score,
    context_quality: gateOriginalInput.context_quality
  }));
  console.log('[DEBUG_GATE_CALL_DECISION]', JSON.stringify({
    symbol: symbolInput,
    hasConfidence: !!confidence,
    hasQuantum: !!quantumScore,
    hasTiming: !!timingScore,
    hasContext: !!contextFilter,
    hasImpulse: !!impulseMetrics,
    stability,
    direction,
    gateOriginalInputKeys: Object.keys(gateOriginalInput).length
  }));
  
  // VALIDACIÓN: Verificar si se ejecutará normalizeQualityGateInput
  console.log('[DEBUG_BLOCKING_IF]', symbol, 'condition_check:', {confidence: !!confidence, quantumScore: !!quantumScore, gateOriginalInput: !!gateOriginalInput});
  if (!confidence || !quantumScore || !gateOriginalInput) {
    console.log('[DEBUG_GATE_SKIPPED]', JSON.stringify({
      symbol: symbolInput,
      reason: 'missing_required_data',
      confidence: !!confidence,
      quantumScore: !!quantumScore,
      gateOriginalInput: !!gateOriginalInput
    }));
  } else {
    console.log('[DEBUG_GATE_EXECUTING]', symbolInput);
  }
  
  console.log('[DEBUG_BEFORE_NORMALIZE_CALL]', symbol);
  console.log('[DEBUG_NORMALIZE_CALL_EXECUTING]', symbol);
  const gateNormalized = normalizeQualityGateInput(gateOriginalInput);
  console.log('[DEBUG_AFTER_NORMALIZE_CALL]', symbol);
  console.log('[DEBUG_NORMALIZE_CALL_COMPLETED]', symbol);

  if (QUALITY_GATE_AUDIT_ENABLED) {
    console.log('[QUALITY_GATE_NORMALIZED]', JSON.stringify({
      symbol: symbolNormalized || symbolInput,
      normalized_input: gateNormalized,
      original_input: gateOriginalInput,
      mapping_applied: true
    }));
  }

  const preLearningScores = { confidence, quantumScore, timingScore };
  const preTimeframeGate = evaluateTimeframeGate(
    timeframe,
    gateNormalized.confidence,
    gateNormalized.quantum,
    gateNormalized.direction,
    gateNormalized.impulse_present
  );
  const preEventGate = evaluateEventGate(
    gateNormalized.confidence,
    gateNormalized.quantum,
    gateNormalized.timing,
    gateNormalized.direction,
    gateNormalized.impulse_present
  );

  const learningResult = await applyLearningAdjustments(
    symbolNormalized || symbolInput,
    executionMode,
    timeframe,
    preLearningScores,
    {
      preloadedConfig: await learningConfigPromise
    }
  );
  console.log('[DEBUG_ABORT_CHECK_2_BEFORE]', symbol);
  throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
  console.log('[DEBUG_ABORT_CHECK_2_AFTER]', symbol);
  const postLearningScores = {
    confidence: learningResult.confidence,
    quantumScore: learningResult.quantumScore,
    timingScore: learningResult.timingScore
  };
  
  // Validación robusta de valores numéricos en postLearningScores antes de quality gate
  postLearningScores.quantumScore = Number.isFinite(postLearningScores.quantumScore) ? postLearningScores.quantumScore : Number(postLearningScores.quantumScore) || 0;
  postLearningScores.timingScore = Number.isFinite(postLearningScores.timingScore) ? postLearningScores.timingScore : Number(postLearningScores.timingScore) || 0;
  
  const stabilityPost = computeSignalStability(
    postLearningScores.confidence,
    postLearningScores.quantumScore,
    postLearningScores.timingScore
  );
  const gateOriginalInputPost = {
    confidence: Number.isFinite(postLearningScores.confidence) ? postLearningScores.confidence : 0,
    
    quantum: Number.isFinite(postLearningScores.quantumScore) ? postLearningScores.quantumScore : 0,
    timing: Number.isFinite(postLearningScores.timingScore) ? postLearningScores.timingScore : 0,
    
    impulse: impulseMetrics?.impulse_present ?? false,
    
    stability: Number.isFinite(stabilityPost) ? stabilityPost : 0,
    
    direction: direction ?? 'neutral',
    
    context_quality: Number.isFinite(contextFilter?.context_quality)
      ? contextFilter.context_quality
      : 0,
    
    context_score: Number.isFinite(contextFilter?.context_score)
      ? contextFilter.context_score
      : 0
  };
  const gateNormalizedPost = normalizeQualityGateInput(gateOriginalInputPost);
  const neutralCandidate =
    ALLOW_NEUTRAL_EXPERIMENT &&
    gateNormalizedPost.direction === 'neutral' &&
    Number(gateNormalizedPost.confidence || 0) > 0.70 &&
    Number(gateNormalizedPost.timing || 0) > 0.70 &&
    Number(gateNormalizedPost.quantum || 0) > 0.60;

  if (neutralCandidate) {
    console.log('[NEUTRAL_SIGNAL_CANDIDATE]', JSON.stringify({
      symbol: symbolNormalized || symbolInput,
      confidence: gateNormalizedPost.confidence,
      timing: gateNormalizedPost.timing,
      quantum: gateNormalizedPost.quantum,
      reason: 'neutral_but_high_scores'
    }));
  }
  const learningMeta = learningResult.learning;
  if (learningMeta && LEARNING_LOG) {
    console.log(
      `[learning:v${learningMeta.version}]`,
      `${learningMeta.scope.symbol}/${learningMeta.scope.mode}/${learningMeta.scope.timeframe}`,
      learningMeta.adjustments
    );
  }

  const postTimeframeGate = evaluateTimeframeGate(
    timeframe,
    gateNormalizedPost.confidence,
    gateNormalizedPost.quantum,
    gateNormalizedPost.direction,
    gateNormalizedPost.impulse_present
  );
  const postEventGate = evaluateEventGate(
    gateNormalizedPost.confidence,
    gateNormalizedPost.quantum,
    gateNormalizedPost.timing,
    gateNormalizedPost.direction,
    gateNormalizedPost.impulse_present
  );

  let signalEmitted = isEventDriven
    ? preEventGate.pass
    : timeframe !== '1m'
    ? true
    : preTimeframeGate.pass;

  let signalEmittedPost = isEventDriven
    ? postEventGate.pass
    : timeframe !== '1m'
    ? true
    : postTimeframeGate.pass;

  const actualGateInfo =
    isEventDriven || timeframe !== '1m'
      ? isEventDriven
        ? preEventGate
        : { pass: true, reason: 'non_1m' }
      : preTimeframeGate;
  const postGateInfo =
    isEventDriven || timeframe !== '1m'
      ? isEventDriven
        ? postEventGate
        : { pass: true, reason: 'non_1m' }
      : postTimeframeGate;
  const reweighted = applyConfidenceReweighting({
    confidence: postLearningScores.confidence,
    quantumScore: postLearningScores.quantumScore,
    timingScore: postLearningScores.timingScore,
    isEventDriven,
    neutralRate
  });
  if (reweighted.lowConfidencePenalty) {
    signalEmitted = false;
    signalEmittedPost = false;
  }
  const signalBeforeContext = signalEmitted;
  let suppressionReason = signalEmitted ? null : reweighted.lowConfidencePenalty ? 'low_confidence' : 'quality_gate';

  if (
    EVENT_CONTEXT_FILTER_ENABLED &&
    EVENT_CONTEXT_FILTER_MODE === 'enforce' &&
    !contextFilter.allow_event
  ) {
    signalEmitted = false;
    signalEmittedPost = false;
    suppressionReason = 'event_context';
  }
  const gateMs = elapsedMs(gateStartedAtMs);

  const contextWouldBlock =
    Boolean(EVENT_CONTEXT_FILTER_ENABLED) && !Boolean(contextFilter.allow_event);
  const shadowObserveSignalEmitted = Boolean(signalBeforeContext);
  const shadowEnforceSignalEmitted = Boolean(signalBeforeContext) && !contextWouldBlock;
  const shadowMode = EVENT_CONTEXT_FILTER_MODE === 'enforce' ? 'enforce' : 'observe';

  let executionAdjustment = {
    enabled: CONTEXT_EXECUTION_ADJUSTMENT_ENABLED,
    applied: false,
    reason: signalEmitted ? 'not_evaluated' : 'signal_not_emitted'
  };
  let finalTradePlan = computedTradePlan;

  if (signalEmitted && computedTradePlan) {
    if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED) {
      const adjustment = adjustExecutionTargets(
        {
          entry_price: computedTradePlan.entry_price,
          direction,
          base_tp: computedTradePlan.take_profit,
          base_sl: computedTradePlan.stop_loss
        },
        {
          context_score: contextFilter.context_score,
          context_quality: contextFilter.context_quality,
          volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
          relative_volume: contextFilter.relative_volume,
          volume_acceleration: contextFilter.volume_acceleration
        }
      );

      executionAdjustment = {
        enabled: true,
        ...adjustment
      };

      if (adjustment?.applied) {
        finalTradePlan = {
          ...computedTradePlan,
          stop_loss: adjustment.adjusted_sl,
          take_profit: adjustment.adjusted_tp,
          target_exit_price: adjustment.adjusted_tp,
          plan_version: `${computedTradePlan.plan_version}+context_exec_v1`
        };
      }
    } else {
      executionAdjustment = {
        enabled: false,
        applied: false,
        reason: 'disabled_by_env'
      };
    }
  }

  const decision_pre_learning = {
    symbol: symbolInput,
    timeframe,
    signal_emitted: signalEmitted,
    quality_gate_passed: actualGateInfo.pass,
    gate_reason: actualGateInfo.reason,
    suppression_reason: suppressionReason,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      allow_event: contextFilter.allow_event,
      context_score: contextFilter.context_score,
      context_quality: contextFilter.context_quality,
      would_block_event: contextFilter.would_block_event,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      }
    }
  };
  const decision_post_learning = {
    symbol: symbolInput,
    timeframe,
    signal_emitted: signalEmittedPost,
    quality_gate_passed: postGateInfo.pass,
    gate_reason: postGateInfo.reason,
    suppression_reason: suppressionReason,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      allow_event: contextFilter.allow_event,
      context_score: contextFilter.context_score,
      context_quality: contextFilter.context_quality,
      would_block_event: contextFilter.would_block_event,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      }
    },
    // Alias fields para alignarse con quality gate evaluación
    quantum: postLearningScores.quantumScore,
    timing: postLearningScores.timingScore,
    impulse: impulseMetrics.impulse_present,
    confidence: postLearningScores.confidence,
    direction: direction
  };
  if (LEARNING_MODE === 'observe') {
    if (PREDICCION_VERBOSE_LOGS) {
      console.log('decision_pre_learning', decision_pre_learning);
      console.log('decision_post_learning', decision_post_learning);
    } else {
      compactDecisionLog('decision_pre_learning', decision_pre_learning);
      compactDecisionLog('decision_post_learning', decision_post_learning);
    }
    console.log('confidence_reweighting', {
      symbol: symbolInput,
      timeframe,
      before: reweighted.confidence_before,
      after: reweighted.confidence_after,
      notes: reweighted.notes
    });
    if (EVENT_CONTEXT_FILTER_ENABLED && PREDICCION_VERBOSE_LOGS) {
      console.log('event_context_filter', {
        compression_detected: contextFilter.compression_detected,
        range_break_detected: contextFilter.range_break_detected,
        volume_confirmation: contextFilter.volume_confirmation,
        volatility_expansion_detected: contextFilter.volatility_expansion_detected,
        volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
        relative_volume: contextFilter.relative_volume,
        volume_acceleration: contextFilter.volume_acceleration,
        event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
        context_score: contextFilter.context_score,
        allow_event: contextFilter.allow_event,
        would_block_event: contextFilter.would_block_event,
        metrics: contextFilter.metrics,
        shadow: {
          mode: shadowMode,
          would_block_event: contextWouldBlock,
          signal_emitted_observe: shadowObserveSignalEmitted,
          signal_emitted_enforce: shadowEnforceSignalEmitted
        }
      });
    }
    if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED && PREDICCION_VERBOSE_LOGS) {
      console.log('execution_adjustment', executionAdjustment);
    }
  }

  // BUGFIX: Add missing confidence_score and impulse_present fields
  const confidence_score = clamp(
    ((postLearningScores.quantumScore || 0) * 0.5 + (postLearningScores.timingScore || 0) * 0.5),
    0,
    1
  );
  const impulse_present = impulseMetrics.impulse_present;

  const recomendacion = {
    simbolo: symbolInput,
    simbolo_normalizado: symbolNormalized,
    origin: origin || 'manual',
    tipo: 'velas',
    timeframe,
    execution_mode: executionMode,
    mode: isEventDriven ? 'event-driven' : 'timeframe',
    timeframe_minutes: frameMinutes,
    monto,
    spot_price: spotPrice,
    spot_price_source: spotPriceSource,
    precio_actual: precioActual,
    precio_estimado: modelPriceEstimate,
    porcentaje,
    expected_move_percent: expectedMovePercent,
    expected_delta_pct: expectedMovePercent,
    signed_delta_pct: signedDeltaPct,
    model_price_estimate: modelPriceEstimate,
    trade_plan: signalEmitted ? finalTradePlan : null,
    execution_adjustment: executionAdjustment,
    ganancia_estim: signalEmitted ? gananciaEstim : 0,
    ahora: analysisStartIso,
    analysis_start_at: analysisStartIso,
    signal_ready_at: null,
    signal_created_at: analysisStartIso,
    signal_emitted_at: null,
    entry_time: entryTimeIso,
    exit_time: exitTimeIso,
    exit_window_seconds: exitWindowSeconds,
    max_time_seconds: maxTimeSeconds,
    exit_rule: finalExitRule,
    exit_rule_description: finalExitRule,
    direction,
    observaciones: signalEmitted
      ? direction === 'up'
        ? 'Se espera impulso alcista. Salir temprano si el impulso se agota.'
        : 'Se espera impulso bajista. Salir temprano si el impulso se agota.'
      : suppressionReason === 'event_context'
      ? 'Senal suprimida por filtro de contexto de evento.'
      : 'Senal suprimida por control de calidad.',
    confianza: Number(reweighted.confidence_after.toFixed(2)),
    confidence_before: Number(reweighted.confidence_before.toFixed(4)),
    confidence_after: Number(reweighted.confidence_after.toFixed(4)),
    confidence_reweighting: {
      notes: reweighted.notes,
      neutral_rate: neutralRate ?? null
    },
    quantum_score: Number(quantumScore.toFixed(2)),
    quantum_model: 'Quantum-LSTM',
    timing_score: Number(timingScore.toFixed(2)),
    weak_signal_candidate: Boolean(neutralCandidate),
    impulse_metrics: impulseMetrics,
    compression_detected: contextFilter.compression_detected,
    range_break_detected: contextFilter.range_break_detected,
    volume_confirmation: contextFilter.volume_confirmation,
    volatility_expansion_detected: contextFilter.volatility_expansion_detected,
    volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
    relative_volume: contextFilter.relative_volume,
    volume_acceleration: contextFilter.volume_acceleration,
    context_score: contextFilter.context_score,
    context_quality: contextFilter.context_quality,
    structural_context_score: contextFilter.structural_context_score,
    volatility_context_score: contextFilter.volatility_context_score,
    volume_flow_context_score: contextFilter.volume_flow_context_score,
    liquidity_context_score: contextFilter.liquidity_context_score,
    context_layer_breakdown: contextFilter.context_layer_breakdown,
    compression_duration: contextFilter.compression_duration,
    compression_tightness: contextFilter.compression_tightness,
    break_efficiency: contextFilter.break_efficiency,
    close_location_value: contextFilter.close_location_value,
    wick_imbalance: contextFilter.wick_imbalance,
    volume_persistence_score: contextFilter.volume_persistence_score,
    volatility_slope: contextFilter.volatility_slope,
    compression_energy: contextFilter.compression_energy,
    expansion_impulse: contextFilter.expansion_impulse,
    expansion_imbalance: contextFilter.expansion_imbalance,
    fake_breakout_penalty: contextFilter.fake_breakout_penalty,
    fake_breakout_detected: contextFilter.fake_breakout_detected,
    liquidity_trap_risk: contextFilter.liquidity_trap_risk,
    session_microstructure_score: contextFilter.session_microstructure_score,
    structural_break_acceptance: contextFilter.structural_break_acceptance,
    event_context_filter: {
      enabled: EVENT_CONTEXT_FILTER_ENABLED,
      mode: EVENT_CONTEXT_FILTER_MODE,
      context_score: contextFilter.context_score,
      context_quality: contextFilter.context_quality,
      allow_event: contextFilter.allow_event,
      would_block_event: contextFilter.would_block_event,
      structural_context_score: contextFilter.structural_context_score,
      volatility_context_score: contextFilter.volatility_context_score,
      volume_flow_context_score: contextFilter.volume_flow_context_score,
      liquidity_context_score: contextFilter.liquidity_context_score,
      context_layer_breakdown: contextFilter.context_layer_breakdown,
      shadow: {
        mode: shadowMode,
        would_block_event: contextWouldBlock,
        signal_emitted_observe: shadowObserveSignalEmitted,
        signal_emitted_enforce: shadowEnforceSignalEmitted
      },
      metrics: contextFilter.metrics,
      details: contextFilter.details
    },
    impulse_min_percent: impulseMinPercent,
    signal_emitted: signalEmitted,
    suppression_reason: suppressionReason,
    entry_window: eventDrivenInfo?.entryWindow || null,
    exit_window: eventDrivenInfo?.exitWindow || null,
    expected_duration_seconds: eventDrivenInfo?.impulseDurationSeconds || null,
    entry_window_utc: eventDrivenInfo?.entryWindow || null,
    exit_window_utc: eventDrivenInfo?.exitWindow || null,
    expected_impulse_duration_seconds: eventDrivenInfo?.impulseDurationSeconds || null,
    estimation_mode: 'displacement',
    estimation_note: 'Precio estimado es desplazamiento, no un objetivo.',
    training_feedback: trainingFeedback,
    learning_applied: Boolean(learningMeta),
    learning_config_version: learningMeta?.version || null,
    learning_adjustments: learningMeta?.adjustments || null,
    pre_learning_scores: {
      confidence: preLearningScores.confidence,
      quantum_score: preLearningScores.quantumScore,
      timing_score: preLearningScores.timingScore
    },
    post_learning_scores: {
      confidence: postLearningScores.confidence,
      quantum_score: postLearningScores.quantumScore,
      timing_score: postLearningScores.timingScore
    },
    decision_pre_learning: decision_pre_learning,
    decision_post_learning: decision_post_learning,
    confidence: confidence_score,
    confidence_score: confidence_score,
    impulse_present: impulse_present,
    // Alias fields para alignarse con velasScheduler present_fields
    quantum: quantumScore,
    timing: timingScore,
    impulse: impulseMetrics.impulse_present
  };

  const postProcessStartedAtMs = Date.now();
  const status = signalEmitted ? 'pendiente' : 'suprimida';
  const finalPredictionPayload = sanitizeForFirestore({
    ...recomendacion,
    early_execution_candidate: Boolean(earlyExecutionState?.completed),
    early_execution_source_profile: earlyExecutionState?.sourceProfile || null,
    status,
    verification: null,
    timestamp: now.toISOString(),
    created_at: now.toISOString()
  });

  throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
  if (docRef) {
    await db.collection('velas_predicciones').doc(docRef.id).set(finalPredictionPayload, { merge: true });
  } else {
    docRef = await db.collection('velas_predicciones').add(finalPredictionPayload);
  }

  if (neutralCandidate) {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    const neutralPayload = sanitizeForFirestore({
      prediction_id: docRef.id,
      symbol: symbolNormalized || symbolInput,
      timeframe,
      execution_mode: executionMode,
      confidence: gateNormalizedPost.confidence,
      quantum: gateNormalizedPost.quantum,
      timing: gateNormalizedPost.timing,
      direction: gateNormalizedPost.direction,
      reason: 'neutral_but_high_scores',
      created_at: new Date().toISOString()
    });
    await db.collection('neutral_signal_candidates').add(neutralPayload);
  }

  let preAlertDecision = { ok: false, reason: 'not_evaluated' };
  let preAlertNotification = { sent: false, channel: 'none', reason: 'not_evaluated' };
  let highConvictionDecision = { ok: false, reason: 'not_evaluated' };
  let highConvictionSignalData = null;
  let highConvictionNotification = { sent: false, channel: 'none', reason: 'not_evaluated' };
  const preAlertStartedAtMs = Date.now();

  try {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    const allowSuppressedPreAlert = signalEmitted || MANUAL_PREALERT_ALLOW_SUPPRESSED;
    if (!allowSuppressedPreAlert) {
      preAlertDecision = { ok: false, reason: 'signal_not_emitted' };
    } else {
      preAlertDecision = await shouldSendManualPreAlert(db, {
        ...recomendacion,
        id: docRef.id,
        trade_plan: finalTradePlan
      });
      if (preAlertDecision.ok) {
        preAlertNotification = await sendManualPreAlertNotification(db, {
          ...recomendacion,
          id: docRef.id,
          trade_plan: finalTradePlan
        });
      }
    }
  } catch (err) {
    console.log('[DEBUG_PREDICCION_ERROR] prealert', err?.message || err);
    console.warn('[MANUAL_PREALERT] skipped', err?.message || err);
  }
  const preAlertMs = elapsedMs(preAlertStartedAtMs);

  // High Conviction Mode: only for event-driven signals that pass strict thresholds.
  try {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    if (!signalEmitted) {
      highConvictionDecision = { ok: false, reason: 'not_emitted' };
    } else if (direction !== 'up' && direction !== 'down') {
      highConvictionDecision = { ok: false, reason: 'neutral_direction' };
    } else {
      highConvictionDecision = await shouldEmitHighConvictionSignal(db, {
        ...recomendacion,
        confianza: Number(reweighted.confidence_after.toFixed(4)),
        quantum_score: Number(quantumScore.toFixed(4)),
        timing_score: Number(timingScore.toFixed(4))
      });
    }

    if (highConvictionDecision.ok) {
      highConvictionSignalData = await registerHighConvictionSignal(db, {
        ...recomendacion,
        id: docRef.id,
        status,
        trade_plan: finalTradePlan
      });
      highConvictionNotification = await sendHighConvictionNotification(highConvictionSignalData);
    }
  } catch (err) {
    console.log('[DEBUG_PREDICCION_ERROR] high_conviction', err?.message || err);
    console.warn('[HIGH_CONVICTION] skipped', err?.message || err);
  }

  let binanceExecution = {
    attempted: false,
    executed: false,
    dry_run: false,
    reason: 'not_attempted'
  };
  let binanceSourceProfile = earlyExecutionState?.sourceProfile || 'none';
  let signalReadyIso = earlyExecutionState?.signalReadyIso || null;
  let analysisToSignalReadyMs = earlyExecutionState?.analysisToSignalReadyMs || null;
  let operationalEntryWindowStartIso = earlyExecutionState?.entryWindowStartIso || null;
  let operationalEntryWindowEndIso = earlyExecutionState?.entryWindowEndIso || null;

  try {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    if (earlyExecutionState?.completed) {
      binanceExecution = earlyExecutionState.binanceExecution;
    } else if (signalEmitted && (direction === 'up' || direction === 'down')) {
      const signalReadyAt = new Date();
      signalReadyIso = signalReadyAt.toISOString();
      analysisToSignalReadyMs = signalReadyAt.getTime() - analysisStartAt.getTime();
      operationalEntryWindowStartIso = signalReadyIso;
      operationalEntryWindowEndIso = new Date(signalReadyAt.getTime() + ENTRY_WINDOW_SECONDS * 1000).toISOString();
      const operationalEntryWindow = {
        start: formatTimeUTC(signalReadyAt),
        end: formatTimeUTC(new Date(signalReadyAt.getTime() + ENTRY_WINDOW_SECONDS * 1000))
      };
      binanceSourceProfile = highConvictionSignalData
        ? 'high_conviction'
        : (preAlertDecision.ok ? 'manual_prealert' : 'event_emitted');

      const executionPayload = sanitizeForFirestore({
        ...recomendacion,
        id: docRef.id,
        prediction_id: docRef.id,
        analysis_start_at: analysisStartIso,
        signal_created_at: analysisStartIso,
        signal_ready_at: signalReadyIso,
        signal_emitted_at: signalReadyIso,
        symbol: symbolInput,
        confidence: Number(reweighted.confidence_after.toFixed(4)),
        quantum_score: Number(quantumScore.toFixed(4)),
        timing_score: Number(timingScore.toFixed(4)),
        context_score: contextFilter.context_score,
        context_quality: contextFilter.context_quality,
        structural_context_score: contextFilter.structural_context_score,
        volatility_context_score: contextFilter.volatility_context_score,
        volume_flow_context_score: contextFilter.volume_flow_context_score,
        liquidity_context_score: contextFilter.liquidity_context_score,
        expected_move_percent: Number(expectedMovePercent.toFixed(4)),
        trade_plan: finalTradePlan,
        spot_price: Number.isFinite(spotPrice) ? spotPrice : Number(recomendacion.spot_price),
        analysis_entry_window: recomendacion.entry_window_utc || recomendacion.entry_window,
        estimated_window: operationalEntryWindow,
        entry_window: operationalEntryWindow,
        entry_window_utc: operationalEntryWindow,
        entry_window_start_at: operationalEntryWindowStartIso,
        entry_window_end_at: operationalEntryWindowEndIso,
        ahora: signalReadyIso,
        created_at: signalReadyIso,
        timestamp: signalReadyIso
      });

      if (!Number.isFinite(executionPayload.spot_price)) {
        throw new Error('spot_price_invalid');
      }
      if (!Number.isFinite(executionPayload.expected_move_percent)) {
        throw new Error('expected_move_percent_invalid');
      }

      queuedBinanceExecutionTask = {
        predictionId: docRef.id,
        executionPayload,
        sourceProfile: binanceSourceProfile
      };
      binanceExecution = buildQueuedBinanceExecution(binanceSourceProfile);
    } else {
      binanceExecution = {
        attempted: false,
        executed: false,
        dry_run: false,
        reason: !signalEmitted ? 'signal_not_emitted' : 'neutral_direction',
        source_profile: 'none',
        updated_at: new Date().toISOString()
      };
    }
  } catch (err) {
    console.log('[DEBUG_PREDICCION_ERROR] binance_execution', err?.message || err);
    binanceExecution = {
      attempted: true,
      executed: false,
      dry_run: false,
      reason: `error:${err?.message || 'unknown'}`,
      source_profile: binanceSourceProfile,
      updated_at: new Date().toISOString()
    };
    console.warn('[BINANCE_EXECUTION] skipped', err?.message || err);
  }

  if (highConvictionSignalData?.id) {
    try {
      throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
      await db.collection('high_conviction_signals').doc(highConvictionSignalData.id).update(
        sanitizeForFirestore({
          telegram_notification: {
            sent: Boolean(highConvictionNotification?.sent),
            channel: highConvictionNotification?.channel || 'unknown',
            reason: highConvictionNotification?.reason || null,
            sent_at: new Date().toISOString()
          },
          binance_execution: binanceExecution
        })
      );
    } catch (err) {
      console.warn('[HIGH_CONVICTION] binance update skipped', err?.message || err);
    }
  }

  try {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    await db.collection('velas_predicciones').doc(docRef.id).update(
      sanitizeForFirestore({
        high_conviction_decision: highConvictionDecision,
        manual_prealert_decision: preAlertDecision,
        manual_prealert_notification: preAlertNotification,
        binance_route_source: binanceSourceProfile,
        binance_execution: binanceExecution,
        signal_ready_at: signalReadyIso,
        signal_emitted_at: signalReadyIso,
        analysis_to_signal_ready_ms: analysisToSignalReadyMs,
        operational_entry_window_start_at: operationalEntryWindowStartIso,
        operational_entry_window_end_at: operationalEntryWindowEndIso,
        updated_at: new Date().toISOString()
      })
    );
  } catch (err) {
    console.warn('[PREDICCION] post-update skipped', err?.message || err);
  }

  if (queuedBinanceExecutionTask?.executionPayload && queuedBinanceExecutionTask?.sourceProfile) {
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    console.info('[BINANCE_EXECUTION_QUEUED]', {
      prediction_id: queuedBinanceExecutionTask.predictionId,
      symbol: queuedBinanceExecutionTask.executionPayload?.symbol || null,
      source_profile: queuedBinanceExecutionTask.sourceProfile
    });
    launchDetached(async () => {
      try {
        await executeSignalTrade(db, queuedBinanceExecutionTask.executionPayload, {
          source: queuedBinanceExecutionTask.sourceProfile,
          source_profile: queuedBinanceExecutionTask.sourceProfile
        });
      } catch (err) {
        console.warn('[BINANCE_EXECUTION_ASYNC] failed', err?.message || err);
        await syncPredictionExecutionState(db, {
          predictionId: queuedBinanceExecutionTask.predictionId,
          sourceProfile: queuedBinanceExecutionTask.sourceProfile,
          status: 'failed',
          reason: 'async_execution_failed',
          dryRun: false,
          executed: false,
          symbol: queuedBinanceExecutionTask.executionPayload?.symbol || null,
          failureStage: 'async_execute_signal_trade',
          errorMessage: err?.message || 'async_execution_failed',
          pendingStateResolution: 'binance_terminal_sync'
        });
      }
    }, '[BINANCE_EXECUTION_ASYNC] detached_failed');
  }

  if (profiling) {
    profiling.pipeline = {
      total_ms: elapsedMs(analysisStartAt.getTime()),
      fetch_ms: profiling.fetch_candles?.total_ms ?? null,
      spot_fetch_ms: profiling.spot_fetch?.spot_fetch_ms ?? null,
      prediction_ms: Math.max(0, postProcessStartedAtMs - predictionComputeStartedAtMs),
      gate_ms: gateMs,
      post_process_ms: elapsedMs(postProcessStartedAtMs),
      prealert_ms: preAlertMs,
      binance_latency_ms: sumFinite([
        profiling.fetch_candles?.binance_latency_ms,
        profiling.spot_fetch?.binance_latency_ms
      ]),
      fallback_ms: sumFinite([
        profiling.fetch_candles?.fallback_ms,
        profiling.spot_fetch?.fallback_ms
      ])
    };
  }

  console.log('[DEBUG_PREDICCION_RETURN]', symbol);
  console.log('[DEBUG_FINAL_STATE]', JSON.stringify({
    symbol,
    status,
    has_recomendacion: !!recomendacion,
    recomendacion_keys: recomendacion ? Object.keys(recomendacion).length : 0,
    quantum: recomendacion?.quantum,
    timing: recomendacion?.timing,
    impulse: recomendacion?.impulse,
    confidence: recomendacion?.confidence,
    direction: recomendacion?.direction
  }));
  return { id: docRef.id, ...recomendacion, status, verification: null, profiling };
}

module.exports = generarPrediccion;

