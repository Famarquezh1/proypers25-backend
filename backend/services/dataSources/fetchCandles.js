const yahooFinance = require('yahoo-finance2').default;
const { fetchBinanceCandles, BINANCE_FAIL_FAST_TIMEOUT_MS } = require('./binance');
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
const PROFILING_FETCH_ENABLED =
  String(process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() === 'true';
const EXTERNAL_DATA_TIMEOUT_MS = Math.max(2000, Number(process.env.EXTERNAL_DATA_TIMEOUT_MS || 8000));
const CANDLE_CACHE_TTL_MS = Math.max(2000, Number(process.env.CANDLE_CACHE_TTL_MS || 15000));
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
  if (!PROFILING_FETCH_ENABLED) {
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
}

function markFallbackStart(state) {
  if (state.fallback_started_at_ms == null) {
    state.fallback_started_at_ms = Date.now();
  }
  state.fallback_triggered = true;
}

function shouldSkipYahooFallback(timeframe) {
  return String(timeframe || '').toLowerCase() === '5m';
}

function logFetchFailFast(symbol, timeframe, fallbackUsed, decisionTimeMs, timeoutMs) {
  console.warn('[FETCH_FAIL_FAST]', {
    symbol,
    timeframe,
    stage: 'candles',
    binance_timeout_ms: Number(timeoutMs) || BINANCE_FAIL_FAST_TIMEOUT_MS,
    fallback_used: fallbackUsed,
    decision_time_ms: Number(decisionTimeMs) || 0
  });
}

function resolveNextFallbackSource(timeframe, hasAlphaKey, hasStaleCache) {
  if (hasAlphaKey) {
    return 'alpha';
  }
  if (!shouldSkipYahooFallback(timeframe)) {
    return 'yahoo';
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
  const removeAbortListener = addAbortListener(options?.signal, () => {
    registerExternalCancellation(options, 'running', 'candles');
    controller.abort(resolveAbortError(options?.signal, `Alpha candles cancelled for ${symbol}`, 'OPERATION_ABORTED'));
  });
  const timer = setTimeout(() => controller.abort(), EXTERNAL_DATA_TIMEOUT_MS);
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

async function fetchYahooCandles(symbol, timeframe, options = {}) {
  const now = new Date();
  const lookbackDays = lookbackDaysForTimeframe(timeframe);
  const period1 = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await withExternalTimeout(
    () =>
      yahooFinance.historical(symbol, {
        period1,
        period2: now,
        interval: timeframe
      }),
    'Yahoo candles',
    {
      signal: options?.signal,
      taskContext: options?.taskContext,
      callType: 'candles'
    }
  );
  return (rows || []).map((row) => ({
    timestamp: row.date || row.timestamp || row.datetime || row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume
  }));
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
    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (ENABLE_BINANCE) {
      timing.binance_attempted = true;
      timing.fallback_chain.push('binance');
      const binanceStartedAtMs = Date.now();
      try {
        const rows = await fetchBinanceCandles(symbol, interval, {
          timeoutMs: BINANCE_FAIL_FAST_TIMEOUT_MS,
          retryOnTimeout: false,
          signal: options?.signal,
          taskContext: options?.taskContext,
          trace: {
            symbol,
            call_type: 'candles',
            origin: options?.traceOrigin || 'candles_fetch',
            trace_id: createBinanceTraceId(symbol, interval, options?.traceOrigin || 'candles_fetch')
          }
        });
        timing.binance_latency_ms = elapsedMs(binanceStartedAtMs);
        if (rows.length) {
          timing.binance_success = true;
          timing.source_used = 'binance';
          console.log(`[BINANCE] candle fetch ok (${rows.length} velas)`);
          candleCache.set(cacheKey, { rows, fetchedAt: Date.now() });
          return rows;
        }
        console.warn('[BINANCE] no data, fallback triggered');
        markFallbackStart(timing);
      } catch (err) {
        timing.binance_latency_ms = elapsedMs(binanceStartedAtMs);
        if (err?.status === 429) {
          console.warn('[BINANCE] fetch failed -> reason: rate_limited');
        } else {
          console.warn(`[BINANCE] fetch failed -> reason: ${err.message}`);
        }
        markFallbackStart(timing);
        if (err?.code === 'BINANCE_TIMEOUT') {
          logFetchFailFast(
            symbol,
            interval,
            resolveNextFallbackSource(interval, Boolean(ALPHA_VANTAGE_KEY), hasStaleCache),
            timing.binance_latency_ms,
            err?.timeout_ms || BINANCE_FAIL_FAST_TIMEOUT_MS
          );
        }
      }
    } else {
      console.log('[BINANCE] disabled by ENABLE_BINANCE=false');
      markFallbackStart(timing);
    }

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    timing.fallback_chain.push('alpha');
    const alphaStartedAtMs = Date.now();
    try {
      const rows = await fetchAlphaCandles(symbol, interval, options);
      timing.alpha_fetch_ms = elapsedMs(alphaStartedAtMs);
      if (rows.length) {
        timing.source_used = 'alpha';
        console.log(`[ALPHA] candle fetch ok (${rows.length} velas)`);
        candleCache.set(cacheKey, { rows, fetchedAt: Date.now() });
        return rows;
      }
      console.warn('[ALPHA] no data, fallback triggered');
    } catch (err) {
      timing.alpha_fetch_ms = elapsedMs(alphaStartedAtMs);
      console.warn(`[ALPHA] fetch failed -> reason: ${err.message}`);
    }

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (!shouldSkipYahooFallback(interval)) {
      timing.fallback_chain.push('yahoo');
      const yahooStartedAtMs = Date.now();
      try {
        const rows = await fetchYahooCandles(symbol, interval, options);
        timing.yahoo_fetch_ms = elapsedMs(yahooStartedAtMs);
        if (rows.length) {
          timing.source_used = 'yahoo';
          console.log(`[YAHOO] candle fetch ok (${rows.length} velas)`);
          candleCache.set(cacheKey, { rows, fetchedAt: Date.now() });
          return rows;
        }
        console.warn('[YAHOO] no data, fallback triggered');
      } catch (err) {
        timing.yahoo_fetch_ms = elapsedMs(yahooStartedAtMs);
        console.warn(`[YAHOO] fetch failed -> reason: ${err.message}`);
      }
    }

    throwIfAborted(options?.signal, `Candles cancelled for ${symbol}`, 'OPERATION_ABORTED');
    if (hasStaleCache) {
      timing.fallback_chain.push('stale_cache');
      timing.source_used = 'stale_cache';
      console.warn('[STALE_SNAPSHOT_USED]', {
        source: 'candle_cache',
        symbol,
        interval,
        age_ms: staleAgeMs
      });
      return cached.rows;
    }

    return [];
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
