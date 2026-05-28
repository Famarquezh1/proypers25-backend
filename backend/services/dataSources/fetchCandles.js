const yahooFinance = require('yahoo-finance2').default;
const {
  fetchBinanceCandles,
  FETCH_TIMEOUT_MS
} = require('./binance');
const {
  addAbortListener,
  createAbortError,
  raceWithSignal,
  registerTaskCancellation,
  resolveAbortError,
  throwIfAborted
} = require('../../lib/abortUtils');

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || null;
const ENABLE_BINANCE = process.env.ENABLE_BINANCE === 'true';
const MARKET_DATA_BINANCE_ENABLED =
  String(process.env.MARKET_DATA_BINANCE_ENABLED || 'true').toLowerCase() !== 'false';
const PROFILING_FETCH_ENABLED =
  String(process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() === 'true';
const YAHOO_SOURCE_TIMEOUT_MS = Math.max(5000, Number(process.env.YAHOO_FETCH_TIMEOUT_MS || 5000));
const ALPHA_SOURCE_TIMEOUT_MS = Math.max(5000, Number(process.env.ALPHA_FETCH_TIMEOUT_MS || 5000));
const BINANCE_PRIMARY_TIMEOUT_MS = Math.max(
  1500,
  Math.min(2000, Number(process.env.BINANCE_PRIMARY_TIMEOUT_MS || 1800))
);
const BINANCE_PRIMARY_RETRY_DELAY_MS = Math.max(
  100,
  Math.min(1000, Number(process.env.BINANCE_PRIMARY_RETRY_DELAY_MS || 300))
);
const BINANCE_PRIMARY_RETRIES = Math.max(
  0,
  Math.min(1, Number(process.env.BINANCE_PRIMARY_RETRIES || 1))
);
const FALLBACK_DECISION_BUDGET_MS = Math.max(
  YAHOO_SOURCE_TIMEOUT_MS,
  Number(process.env.FALLBACK_DECISION_BUDGET_MS || YAHOO_SOURCE_TIMEOUT_MS)
);
const EXTERNAL_DATA_TIMEOUT_MS = Math.max(
  YAHOO_SOURCE_TIMEOUT_MS,
  Number(process.env.EXTERNAL_DATA_TIMEOUT_MS || YAHOO_SOURCE_TIMEOUT_MS)
);
const MAX_FETCH_WINDOW_MS = Math.max(15000, Number(process.env.MAX_FETCH_WINDOW_MS || 15000));
const CANDLE_CACHE_TTL_MS = Math.max(1000, Number(process.env.CANDLE_CACHE_TTL_MS || 5000));
const CANDLE_CACHE_STALE_TTL_MS = Math.max(
  CANDLE_CACHE_TTL_MS,
  Number(process.env.CANDLE_CACHE_STALE_TTL_MS || 120000)
);
const candleCache = new Map();
const inflightCandleFetches = new Map();

function elapsedMs(startedAtMs) {
  return Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
}

function createBinanceTraceId(symbol, timeframe, origin = 'candles_fetch') {
  return `${origin}:${String(symbol || 'unknown').toUpperCase()}:${String(timeframe || '5m')}:${Date.now()}`;
}

function createFetchTiming(symbol, timeframe) {
  return {
    symbol,
    timeframe,
    started_at_ms: Date.now(),
    source_used: null,
    binance_attempted: false,
    binance_success: false,
    binance_latency_ms: null,
    alpha_fetch_ms: null,
    yahoo_fetch_ms: null,
    fallback_triggered: false,
    fallback_chain: [],
    fallback_started_at_ms: null,
    fallback_ms: null,
    total_ms: null
  };
}

function snapshotFetchTiming(state) {
  return {
    symbol: state.symbol,
    timeframe: state.timeframe,
    total_ms: state.total_ms,
    source_used: state.source_used,
    binance_attempted: state.binance_attempted,
    binance_success: state.binance_success,
    binance_latency_ms: state.binance_latency_ms,
    alpha_fetch_ms: state.alpha_fetch_ms,
    yahoo_fetch_ms: state.yahoo_fetch_ms,
    fallback_triggered: state.fallback_triggered,
    fallback_chain: [...state.fallback_chain],
    fallback_chain_length: state.fallback_chain.length,
    fallback_ms: state.fallback_ms
  };
}

function publishFetchTiming(options, state) {
  const payload = snapshotFetchTiming(state);
  if (options?.profiling && typeof options.profiling === 'object') {
    options.profiling.fetch_candles = payload;
  }
  console.log('[FETCH_LATENCY]', {
    symbol: payload.symbol,
    duration_ms: payload.total_ms,
    source: payload.source_used || 'unknown'
  });
  if (!PROFILING_FETCH_ENABLED) {
    if (payload.source_used === 'none') {
      console.log('[FETCH_SKIPPED]', {
        symbol: payload.symbol,
        reason: 'all_sources_failed'
      });
    }
    return;
  }
  console.log('[FETCH_CANDLES_TIMING]', payload);
  if (payload.fallback_triggered) {
    console.log('[FALLBACK_TIMING]', {
      symbol: payload.symbol,
      timeframe: payload.timeframe,
      fallback_chain: payload.fallback_chain,
      fallback_chain_length: payload.fallback_chain_length,
      fallback_ms: payload.fallback_ms,
      final_source: payload.source_used
    });
  }
  if (payload.source_used === 'none') {
    console.log('[FETCH_SKIPPED]', {
      symbol: payload.symbol,
      reason: 'all_sources_failed'
    });
  }
}

function logDataSource(source, symbol, payload = {}) {
  console.log('[DATA_SOURCE]', {
    source,
    symbol,
    ...payload
  });
}

function markFallbackStart(state) {
  if (state.fallback_started_at_ms == null) {
    state.fallback_started_at_ms = Date.now();
  }
  state.fallback_triggered = true;
}

function shouldSkipYahooFallback(timeframe) {
  return false;
}

function resolveNextFallbackSource(timeframe, hasAlphaKey, hasStaleCache) {
  if (!shouldSkipYahooFallback(timeframe)) {
    return 'yahoo';
  }
  if (hasAlphaKey) {
    return 'alpha';
  }
  if (hasStaleCache) {
    return 'stale_cache';
  }
  return 'none';
}

function registerExternalCancellation(options = {}, stage = 'running', callType = 'other') {
  registerTaskCancellation(options?.taskContext, {
    stage,
    scope: 'external_fetch',
    call_type: callType
  });
}

function logFallbackAttempt(source, symbol, timeframe, timeoutMs = null) {
  console.log('[FALLBACK_ATTEMPT]', {
    source,
    symbol,
    timeframe,
    timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null
  });
}

function logFallbackSuccess(source, symbol, timeframe, durationMs, rows, timeoutMs = null) {
  console.log('[FALLBACK_SUCCESS]', {
    source,
    symbol,
    timeframe,
    duration_ms: Number(durationMs) || 0,
    rows: Number(rows) || 0,
    timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null
  });
}

function logFallbackFail(source, symbol, timeframe, reason, durationMs = 0, timeoutMs = null) {
  console.warn('[FALLBACK_FAIL]', {
    source,
    symbol,
    timeframe,
    reason: reason || 'unknown',
    duration_ms: Number(durationMs) || 0,
    timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null
  });
  logDataSource(source, symbol, {
    timeframe,
    latency_ms: Number(durationMs) || 0,
    status: 'fail',
    reason: reason || 'unknown'
  });
}

function logTimeoutFixApplied(source, timeoutMs) {
  console.log('[TIMEOUT_FIX_APPLIED]', {
    source,
    timeout_ms: Number(timeoutMs) || EXTERNAL_DATA_TIMEOUT_MS
  });
}

function logFetchWindowExceeded(symbol, timeframe, totalTimeMs) {
  console.warn('[FETCH_WINDOW_EXCEEDED]', {
    symbol,
    timeframe,
    total_time_ms: Number(totalTimeMs) || 0
  });
}

function resolveExternalTimeoutMs(options = {}) {
  const requested = Number(options?.timeoutMs);
  const timeoutFloorMs = Math.max(250, Number(options?.timeoutFloorMs || EXTERNAL_DATA_TIMEOUT_MS));
  if (Number.isFinite(requested) && requested >= 250) {
    return Math.max(timeoutFloorMs, requested);
  }
  return timeoutFloorMs;
}

function withExternalTimeout(promiseFactory, label, options = {}) {
  let timeoutId;
  let removeAbortListener = () => {};
  const timeoutMs = resolveExternalTimeoutMs(options);
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timeout after ${timeoutMs}ms`)),
      timeoutMs
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

const ALPHA_INTERVAL_MAP = {
  '1m': '1min',
  '5m': '5min',
  '15m': '15min',
  '30m': '30min',
  '1h': '60min'
};

function normalizeAlphaSymbol(symbol) {
  if (!symbol) return symbol;
  const cleaned = symbol.toUpperCase().replace('/', '').replace('-', '');
  if (cleaned.endsWith('USDT')) {
    return cleaned.replace(/USDT$/, '');
  }
  if (cleaned.endsWith('USD')) {
    return cleaned.replace(/USD$/, '');
  }
  return cleaned;
}

function normalizeYahooSymbol(symbol) {
  if (!symbol) return symbol;
  const cleaned = String(symbol).toUpperCase().replace(/\//g, '-').replace(/_/g, '-');
  if (cleaned.endsWith('-USDT')) {
    return `${cleaned.slice(0, -5)}-USD`;
  }
  if (cleaned.endsWith('USDT')) {
    return `${cleaned.slice(0, -4)}-USD`;
  }
  if (cleaned.endsWith('USD') && !cleaned.endsWith('-USD')) {
    return `${cleaned.slice(0, -3)}-USD`;
  }
  return cleaned;
}

async function fetchAlphaCandles(symbol, interval, options = {}) {
  throwIfAborted(options?.signal, `Alpha candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('AlphaVantage key missing');
  }
  const alphaInterval = ALPHA_INTERVAL_MAP[interval] || '5min';
  const baseSymbol = normalizeAlphaSymbol(symbol);
  const url = `https://www.alphavantage.co/query?function=CRYPTO_INTRADAY&symbol=${encodeURIComponent(
    baseSymbol
  )}&market=USD&interval=${encodeURIComponent(alphaInterval)}&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;
  const controller = new AbortController();
  const timeoutMs = resolveExternalTimeoutMs({
    ...options,
    timeoutMs: options?.timeoutMs ?? ALPHA_SOURCE_TIMEOUT_MS,
    timeoutFloorMs: options?.timeoutFloorMs ?? ALPHA_SOURCE_TIMEOUT_MS
  });
  logTimeoutFixApplied('alpha', timeoutMs);
  const removeAbortListener = addAbortListener(options?.signal, () => {
    registerExternalCancellation(options, 'running', 'candles');
    controller.abort(resolveAbortError(options?.signal, `Alpha candles cancelled for ${symbol}`, 'OPERATION_ABORTED'));
  });
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`AlphaVantage status ${response.status}`);
    }
    const data = await response.json();
    const seriesKey = `Time Series Crypto (${alphaInterval})`;
    const series = data[seriesKey];
    if (!series) {
      return [];
    }
    return Object.entries(series)
      .map(([timestamp, values]) => ({
        timestamp,
        open: parseFloat(values['1. open']),
        high: parseFloat(values['2. high']),
        low: parseFloat(values['3. low']),
        close: parseFloat(values['4. close']),
        volume: parseFloat(values['5. volume'])
      }))
      .reverse();
  } catch (error) {
    if (options?.signal?.aborted) {
      throw resolveAbortError(options.signal, `Alpha candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    }
    throw error;
  } finally {
    clearTimeout(timer);
    removeAbortListener();
  }
}

function lookbackDaysForTimeframe(timeframe) {
  switch (timeframe) {
    case '1m':
      return 2;
    case '5m':
      return 5;
    case '15m':
      return 7;
    case '30m':
      return 10;
    case '1h':
      return 14;
    case '4h':
      return 30;
    default:
      return 7;
  }
}

function resolveYahooChartParams(timeframe) {
  const normalized = String(timeframe || '5m').toLowerCase();
  const lookbackDays = lookbackDaysForTimeframe(normalized);
  switch (normalized) {
    case '1m':
      return {
        interval: '1m',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    case '5m':
      return {
        interval: '5m',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    case '15m':
      return {
        interval: '15m',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    case '30m':
      return {
        interval: '30m',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    case '1h':
      return {
        interval: '1h',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    case '4h':
      return {
        interval: '1h',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
    default:
      return {
        interval: '5m',
        period1: new Date(Date.now() - lookbackDays * 24 * 60 * 60 * 1000)
      };
  }
}

function mapYahooChartRows(result = {}) {
  if (Array.isArray(result?.quotes)) {
    return result.quotes
      .map((row) => ({
        timestamp: row?.date instanceof Date ? row.date.getTime() : Number(new Date(row?.date || row?.timestamp || 0)),
        open: Number(row?.open),
        high: Number(row?.high),
        low: Number(row?.low),
        close: Number(row?.close),
        volume: Number(row?.volume)
      }))
      .filter((row) => [row.timestamp, row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite));
  }

  const chartResult =
    result?.chart?.result?.[0] ||
    result?.result?.[0] ||
    result;
  const timestamps = Array.isArray(chartResult?.timestamp) ? chartResult.timestamp : [];
  const quote = Array.isArray(chartResult?.indicators?.quote)
    ? chartResult.indicators.quote[0]
    : null;
  if (!timestamps.length || !quote) {
    return [];
  }

  const opens = Array.isArray(quote.open) ? quote.open : [];
  const highs = Array.isArray(quote.high) ? quote.high : [];
  const lows = Array.isArray(quote.low) ? quote.low : [];
  const closes = Array.isArray(quote.close) ? quote.close : [];
  const volumes = Array.isArray(quote.volume) ? quote.volume : [];

  return timestamps
    .map((timestamp, index) => ({
      timestamp: Number(timestamp) * 1000,
      open: Number(opens[index]),
      high: Number(highs[index]),
      low: Number(lows[index]),
      close: Number(closes[index]),
      volume: Number(volumes[index])
    }))
    .filter((row) => [row.open, row.high, row.low, row.close, row.volume].every(Number.isFinite));
}

async function fetchYahooCandles(symbol, timeframe, options = {}) {
  const { interval, period1 } = resolveYahooChartParams(timeframe);
  const timeoutMs = resolveExternalTimeoutMs({
    ...options,
    timeoutFloorMs: options?.timeoutFloorMs ?? YAHOO_SOURCE_TIMEOUT_MS
  });
  logTimeoutFixApplied('yahoo', timeoutMs);
  const rows = await withExternalTimeout(
    () =>
      yahooFinance.chart(normalizeYahooSymbol(symbol), {
        interval,
        period1
      }),
    'Yahoo candles',
    {
      signal: options?.signal,
      taskContext: options?.taskContext,
      callType: 'candles',
      timeoutMs,
      timeoutFloorMs: options?.timeoutFloorMs ?? YAHOO_SOURCE_TIMEOUT_MS
    }
  );
  return mapYahooChartRows(rows);
}

function isRateLimitError(error) {
  const message = String(error?.message || '').toLowerCase();
  return error?.status === 429 || message.includes('too many requests') || message.includes('status 429');
}

function isRetryableBinanceError(error) {
  return error?.code === 'BINANCE_TIMEOUT' || error?.status === 429;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchCandles(symbol, interval, options = {}) {
  throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
  const cacheKey = `${String(symbol || '').toUpperCase()}|${String(interval || '5m')}`;
  const timing = createFetchTiming(symbol, interval);
  const cached = candleCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_CACHE_TTL_MS) {
    timing.source_used = 'cache';
    timing.total_ms = 0;
    publishFetchTiming(options, timing);
    return cached.rows;
  }
  const staleAgeMs = cached ? Date.now() - cached.fetchedAt : null;
  const hasStaleCache = cached && Number.isFinite(staleAgeMs) && staleAgeMs <= CANDLE_CACHE_STALE_TTL_MS;
  if (inflightCandleFetches.has(cacheKey)) {
    return raceWithSignal(
      inflightCandleFetches.get(cacheKey),
      options?.signal,
      `Candles cancelled for ${symbol}`,
      'OPERATION_ABORTED'
    );
  }

  const fetchPromise = (async () => {
    const fetchStartedAtMs = timing.started_at_ms;
    const getFetchElapsedMs = () => elapsedMs(fetchStartedAtMs);
    const getRemainingFetchWindowMs = () => Math.max(0, MAX_FETCH_WINDOW_MS - getFetchElapsedMs());
    const abortForFetchWindow = () => {
      logFetchWindowExceeded(symbol, interval, getFetchElapsedMs());
      return null;
    };
    let lastPrimaryError = null;

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (getRemainingFetchWindowMs() <= 0) {
      return abortForFetchWindow();
    }
    const useBinanceMarketData = MARKET_DATA_BINANCE_ENABLED || ENABLE_BINANCE;
    if (useBinanceMarketData) {
      timing.binance_attempted = true;
      timing.fallback_chain.push('binance');
      const totalBinanceAttempts = 1 + BINANCE_PRIMARY_RETRIES;
      for (let attempt = 1; attempt <= totalBinanceAttempts; attempt += 1) {
        const binanceStartedAtMs = Date.now();
        try {
          const binanceTimeoutMs = Math.min(BINANCE_PRIMARY_TIMEOUT_MS, getRemainingFetchWindowMs());
          if (binanceTimeoutMs <= 0) {
            return abortForFetchWindow();
          }
          const rows = await fetchBinanceCandles(symbol, interval, {
            timeoutMs: binanceTimeoutMs,
            retryOnTimeout: false,
            allowBelowGlobalTimeout: true,
            timeoutCeilingMs: 3000,
            signal: options?.signal,
            taskContext: options?.taskContext,
            trace: {
              symbol,
              call_type: 'candles',
              origin: options?.traceOrigin || 'candles_fetch',
              trace_id: createBinanceTraceId(symbol, interval, options?.traceOrigin || 'candles_fetch'),
              attempt_index: attempt
            }
          });
          timing.binance_latency_ms = elapsedMs(binanceStartedAtMs);
          if (rows.length) {
            timing.binance_success = true;
            timing.source_used = 'binance';
            candleCache.set(cacheKey, { rows, fetchedAt: Date.now() });
            logDataSource('binance', symbol, {
              timeframe: interval,
              latency_ms: timing.binance_latency_ms,
              status: 'ok',
              attempt,
              rows: rows.length
            });
            return rows;
          }
          lastPrimaryError = new Error('empty_result');
          logDataSource('binance', symbol, {
            timeframe: interval,
            latency_ms: timing.binance_latency_ms,
            status: 'fail',
            attempt,
            reason: 'empty_result'
          });
        } catch (err) {
          lastPrimaryError = err;
          timing.binance_latency_ms = elapsedMs(binanceStartedAtMs);
          logDataSource('binance', symbol, {
            timeframe: interval,
            latency_ms: timing.binance_latency_ms,
            status: 'fail',
            attempt,
            reason: err?.status === 429 ? 'rate_limited' : (err?.message || 'fetch_error')
          });
          if (attempt < totalBinanceAttempts && isRetryableBinanceError(err)) {
            await wait(BINANCE_PRIMARY_RETRY_DELAY_MS);
            continue;
          }
        }
        break;
      }
      if (!timing.binance_success) {
        if (lastPrimaryError?.status === 429) {
          console.warn('[BINANCE] fetch failed -> reason: rate_limited');
        } else if (lastPrimaryError) {
          console.warn(`[BINANCE] fetch failed -> reason: ${lastPrimaryError.message}`);
        } else {
          console.warn('[BINANCE] no data, fallback triggered');
        }
        markFallbackStart(timing);
      }
    } else {
      console.log('[BINANCE] market data disabled by MARKET_DATA_BINANCE_ENABLED=false');
      markFallbackStart(timing);
    }

    const totalFetchElapsedMs = getFetchElapsedMs();
    const remainingFetchWindowMs = getRemainingFetchWindowMs();
    const canAttemptYahooFallback =
      !shouldSkipYahooFallback(interval) &&
      totalFetchElapsedMs < MAX_FETCH_WINDOW_MS &&
      remainingFetchWindowMs >= Math.min(YAHOO_SOURCE_TIMEOUT_MS, FALLBACK_DECISION_BUDGET_MS);

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (canAttemptYahooFallback) {
      timing.fallback_chain.push('yahoo');
      const yahooStartedAtMs = Date.now();
      logFallbackAttempt('yahoo', symbol, interval, YAHOO_SOURCE_TIMEOUT_MS);
      try {
        const rows = await fetchYahooCandles(symbol, interval, {
          ...options,
          timeoutMs: YAHOO_SOURCE_TIMEOUT_MS,
          timeoutFloorMs: YAHOO_SOURCE_TIMEOUT_MS
        });
        timing.yahoo_fetch_ms = elapsedMs(yahooStartedAtMs);
        if (rows.length) {
          timing.source_used = 'yahoo';
          logFallbackSuccess('yahoo', symbol, interval, timing.yahoo_fetch_ms, rows.length, YAHOO_SOURCE_TIMEOUT_MS);
          candleCache.set(cacheKey, { rows, fetchedAt: Date.now() });
          logDataSource('yahoo', symbol, {
            timeframe: interval,
            latency_ms: timing.yahoo_fetch_ms,
            status: 'ok',
            rows: rows.length
          });
          return rows;
        }
        logFallbackFail('yahoo', symbol, interval, 'empty_result', timing.yahoo_fetch_ms, YAHOO_SOURCE_TIMEOUT_MS);
      } catch (err) {
        timing.yahoo_fetch_ms = elapsedMs(yahooStartedAtMs);
        logFallbackFail('yahoo', symbol, interval, err?.message, timing.yahoo_fetch_ms, YAHOO_SOURCE_TIMEOUT_MS);
      }
    } else if (timing.fallback_triggered && remainingFetchWindowMs < YAHOO_SOURCE_TIMEOUT_MS) {
      return abortForFetchWindow();
    }

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (getFetchElapsedMs() >= MAX_FETCH_WINDOW_MS) {
      return abortForFetchWindow();
    }
    if (hasStaleCache) {
      timing.fallback_chain.push('stale_cache');
      timing.source_used = 'stale_cache';
      console.warn('[STALE_SNAPSHOT_USED]', {
        source: 'candle_cache',
        symbol,
        interval,
        age_ms: staleAgeMs
      });
      logDataSource('stale_cache', symbol, {
        timeframe: interval,
        latency_ms: 0,
        status: 'ok',
        cache_age_ms: staleAgeMs,
        reason: isRateLimitError(lastPrimaryError) ? 'binance_unavailable_after_retry' : 'fallback_exhausted'
      });
      return cached.rows;
    }

    return null;
  })().finally(() => {
    timing.total_ms = elapsedMs(timing.started_at_ms);
    timing.fallback_ms =
      timing.fallback_started_at_ms == null ? 0 : elapsedMs(timing.fallback_started_at_ms);
    if (!timing.source_used) {
      timing.source_used = 'none';
    }
    publishFetchTiming(options, timing);
    inflightCandleFetches.delete(cacheKey);
  });

  inflightCandleFetches.set(cacheKey, fetchPromise);
  return raceWithSignal(fetchPromise, options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
}

module.exports = {
  fetchCandles
};
