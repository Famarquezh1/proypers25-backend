const BINANCE_SPOT_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const BINANCE_SPOT_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';
const BINANCE_FUTURES_KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const BINANCE_FUTURES_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/price';
const {
  addAbortListener,
  createAbortError,
  registerTaskCancellation,
  resolveAbortError,
  throwIfAborted
} = require('../../lib/abortUtils');

const INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h'
};

const FETCH_TIMEOUT_MS = Math.max(10000, Number(process.env.FETCH_TIMEOUT_MS || 10000));
const BINANCE_HTTP_TIMEOUT_MS = Math.max(FETCH_TIMEOUT_MS, Number(process.env.BINANCE_HTTP_TIMEOUT_MS || FETCH_TIMEOUT_MS));
const BINANCE_FAIL_FAST_TIMEOUT_MS = Math.max(
  FETCH_TIMEOUT_MS,
  Number(process.env.BINANCE_FAIL_FAST_TIMEOUT_MS || FETCH_TIMEOUT_MS)
);
const BINANCE_CONCURRENCY_LIMIT = Math.max(
  1,
  Math.min(8, Number(process.env.BINANCE_CONCURRENCY_LIMIT || 5))
);
const MARKET_CACHE_TTL_MS = Math.max(1000, Number(process.env.MARKET_CACHE_TTL_MS || 5000));
const BINANCE_CALL_TRACE_ENABLED =
  String(process.env.BINANCE_CALL_TRACE_ENABLED || process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() ===
  'true';
const BINANCE_CONCURRENCY_LOG_ENABLED =
  String(process.env.BINANCE_CONCURRENCY_LOG_ENABLED || process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() ===
  'true';
let activeBinanceCalls = 0;
const queuedBinanceCalls = [];
const marketCache = new Map();

function getCached(cacheKey) {
  const entry = marketCache.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (Date.now() - entry.ts > MARKET_CACHE_TTL_MS) {
    marketCache.delete(cacheKey);
    return null;
  }
  return entry.data;
}

function setCache(cacheKey, data) {
  marketCache.set(cacheKey, {
    data,
    ts: Date.now()
  });
}

function fetchWithTimeout(promiseFactory, ms = FETCH_TIMEOUT_MS, onTimeout = () => {}) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      onTimeout();
      const error = new Error('FETCH_TIMEOUT');
      error.code = 'FETCH_TIMEOUT';
      error.timeout_ms = ms;
      reject(error);
    }, ms);
  });
  return Promise.race([
    Promise.resolve().then(() => promiseFactory()),
    timeoutPromise
  ]).finally(() => {
    clearTimeout(timeoutId);
  });
}

function logFetchTimeoutAdjusted(options = {}, timeoutMs) {
  if (options?.trace?.market !== 'futures') {
    return;
  }
  console.log('[FETCH_TIMEOUT_ADJUSTED]', {
    symbol: options?.trace?.symbol || null,
    timeout_ms: Number(timeoutMs) || FETCH_TIMEOUT_MS
  });
}

function logTimeoutFixApplied(source, timeoutMs) {
  console.log('[TIMEOUT_FIX_APPLIED]', {
    source,
    timeout_ms: Number(timeoutMs) || FETCH_TIMEOUT_MS
  });
}

function notifyTaskCancellation(options = {}, stage = 'running') {
  registerTaskCancellation(options?.taskContext, {
    stage,
    scope: 'binance',
    call_type: getTraceIdentity(options).call_type
  });
}

function createBinanceCancelledError(options = {}, fallbackMessage = 'Binance request cancelled') {
  const error = resolveAbortError(options?.signal, fallbackMessage, 'BINANCE_CANCELLED');
  if (!error.code) {
    error.code = 'BINANCE_CANCELLED';
  }
  return error;
}

function normalizeBinanceSymbol(symbol) {
  if (!symbol) return symbol;
  const cleaned = symbol.toUpperCase().replace('/', '').replace('-', '');
  if (cleaned.endsWith('USDT')) {
    return cleaned;
  }
  if (cleaned.endsWith('USD')) {
    return cleaned.replace(/USD$/, 'USDT');
  }
  return `${cleaned}USDT`;
}

function resolveTimeoutMs(options = {}) {
  const override = Number(options?.timeoutMs);
  if (Number.isFinite(override) && override >= 250) {
    return Math.max(FETCH_TIMEOUT_MS, Math.min(override, BINANCE_HTTP_TIMEOUT_MS));
  }
  return BINANCE_HTTP_TIMEOUT_MS;
}

function buildTraceMetadata(options = {}, overrides = {}) {
  const trace = options?.trace && typeof options.trace === 'object' ? options.trace : {};
  const startedAtMs = Number(overrides.startedAtMs || Date.now());
  return {
    symbol: overrides.symbol || trace.symbol || null,
    call_type: overrides.call_type || trace.call_type || 'other',
    origin: overrides.origin || trace.origin || 'unknown',
    market: overrides.market || trace.market || 'unknown',
    request_kind: overrides.request_kind || trace.request_kind || 'other',
    trace_id: overrides.trace_id || trace.trace_id || null,
    attempt_index:
      overrides.attempt_index != null ? overrides.attempt_index : trace.attempt_index != null ? trace.attempt_index : null,
    started_at: new Date(startedAtMs).toISOString(),
    timeout_configured_ms: resolveTimeoutMs(options)
  };
}

function getTraceIdentity(options = {}) {
  const trace = options?.trace && typeof options.trace === 'object' ? options.trace : {};
  return {
    symbol: trace.symbol || null,
    call_type: trace.call_type || 'other'
  };
}

function publishBinanceCallTrace(options = {}, payload = {}) {
  if (!BINANCE_CALL_TRACE_ENABLED) {
    return;
  }
  console.log('[BINANCE_CALL_TRACE]', payload);
}

function publishBinanceConcurrency(options = {}, payload = {}) {
  if (!BINANCE_CONCURRENCY_LOG_ENABLED) {
    return;
  }
  console.log('[BINANCE_CONCURRENCY]', {
    active_calls: activeBinanceCalls,
    queued_calls: queuedBinanceCalls.length,
    ...getTraceIdentity(options),
    ...payload
  });
}

function withTraceOptions(options = {}, traceOverrides = {}) {
  const nextTrace = {
    ...(options?.trace && typeof options.trace === 'object' ? options.trace : {}),
    ...traceOverrides
  };
  return {
    ...options,
    trace: nextTrace
  };
}

function releaseNextQueuedBinanceCall() {
  if (activeBinanceCalls >= BINANCE_CONCURRENCY_LIMIT) {
    return;
  }
  while (queuedBinanceCalls.length > 0) {
    const next = queuedBinanceCalls.shift();
    if (!next || next.cancelled || typeof next.run !== 'function') {
      continue;
    }
    next.run();
    return;
  }
}

async function acquireBinanceCallSlot(options = {}) {
  throwIfAborted(options?.signal, 'Binance request cancelled before queue', 'BINANCE_CANCELLED');
  if (activeBinanceCalls < BINANCE_CONCURRENCY_LIMIT) {
    activeBinanceCalls += 1;
    publishBinanceConcurrency(options, {
      phase: 'acquired',
      queue_wait_ms: 0,
      limit: BINANCE_CONCURRENCY_LIMIT
    });
    return {
      queue_wait_ms: 0,
      release() {
        activeBinanceCalls = Math.max(0, activeBinanceCalls - 1);
        publishBinanceConcurrency(options, {
          phase: 'released',
          limit: BINANCE_CONCURRENCY_LIMIT
        });
        releaseNextQueuedBinanceCall();
      }
    };
  }

  const queuedAtMs = Date.now();
  publishBinanceConcurrency(options, {
    phase: 'queued',
    limit: BINANCE_CONCURRENCY_LIMIT
  });
  return new Promise((resolve, reject) => {
    const entry = {
      cancelled: false,
      settled: false,
      removeAbortListener: () => {},
      run() {
        if (entry.settled || entry.cancelled) {
          return;
        }
        entry.settled = true;
        entry.removeAbortListener();
        if (options?.signal?.aborted) {
          entry.cancelled = true;
          notifyTaskCancellation(options, 'queued');
          publishBinanceConcurrency(options, {
            phase: 'cancelled_queued',
            queue_wait_ms: Math.max(0, Date.now() - queuedAtMs),
            limit: BINANCE_CONCURRENCY_LIMIT
          });
          reject(createBinanceCancelledError(options));
          releaseNextQueuedBinanceCall();
          return;
        }
        activeBinanceCalls += 1;
        const queueWaitMs = Math.max(0, Date.now() - queuedAtMs);
        publishBinanceConcurrency(options, {
          phase: 'dequeued',
          queue_wait_ms: queueWaitMs,
          limit: BINANCE_CONCURRENCY_LIMIT
        });
        resolve({
          queue_wait_ms: queueWaitMs,
          release() {
            activeBinanceCalls = Math.max(0, activeBinanceCalls - 1);
            publishBinanceConcurrency(options, {
              phase: 'released',
              limit: BINANCE_CONCURRENCY_LIMIT
            });
            releaseNextQueuedBinanceCall();
          }
        });
      }
    };

    entry.removeAbortListener = addAbortListener(options?.signal, () => {
      if (entry.settled || entry.cancelled) {
        return;
      }
      entry.cancelled = true;
      entry.settled = true;
      const queueIndex = queuedBinanceCalls.indexOf(entry);
      if (queueIndex >= 0) {
        queuedBinanceCalls.splice(queueIndex, 1);
      }
      notifyTaskCancellation(options, 'queued');
      publishBinanceConcurrency(options, {
        phase: 'cancelled_queued',
        queue_wait_ms: Math.max(0, Date.now() - queuedAtMs),
        limit: BINANCE_CONCURRENCY_LIMIT
      });
      reject(createBinanceCancelledError(options));
    });

    if (entry.cancelled) {
      return;
    }
    queuedBinanceCalls.push(entry);
  });
}

async function fetchJsonWithTimeout(url, options = {}) {
  throwIfAborted(options?.signal, 'Binance request cancelled before start', 'BINANCE_CANCELLED');
  const cacheKey = url;
  const cached = getCached(cacheKey);
  if (cached != null) {
    console.log('[FETCH_LATENCY]', {
      symbol: options?.trace?.symbol || null,
      duration_ms: 0,
      source: 'cache',
      call_type: options?.trace?.call_type || 'other'
    });
    return cached;
  }
  const slot = await acquireBinanceCallSlot(options);
  const timeoutMs = resolveTimeoutMs(options);
  logTimeoutFixApplied('binance', timeoutMs);
  logFetchTimeoutAdjusted(options, timeoutMs);
  const controller = new AbortController();
  const startedAtMs = Date.now();
  let abortedByExternal = false;
  let abortedByTimeout = false;
  const removeAbortListener = addAbortListener(options?.signal, () => {
    abortedByExternal = true;
    notifyTaskCancellation(options, 'running');
    controller.abort(createBinanceCancelledError(options));
  });
  try {
    const response = await fetchWithTimeout(
      () => fetch(url, { signal: controller.signal }),
      timeoutMs,
      () => {
        abortedByTimeout = true;
        controller.abort(createAbortError(`Binance timeout after ${timeoutMs}ms`, 'BINANCE_TIMEOUT'));
      }
    );
    if (!response.ok) {
      const error = new Error(`Binance status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    const data = await response.json();
    setCache(cacheKey, data);
    console.log('[FETCH_LATENCY]', {
      symbol: options?.trace?.symbol || null,
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      source: `binance_${options?.trace?.market || 'unknown'}`,
      call_type: options?.trace?.call_type || 'other'
    });
    publishBinanceCallTrace(options, {
      ...buildTraceMetadata(options, { startedAtMs }),
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      queue_wait_ms: slot.queue_wait_ms,
      success: true,
      aborted_by_fail_fast: false,
      status: response.status,
      url
    });
    return data;
  } catch (error) {
    let normalizedError = error;
    if (abortedByTimeout || error?.code === 'FETCH_TIMEOUT') {
      const timeoutError = new Error(`Binance timeout after ${timeoutMs}ms`);
      timeoutError.code = 'BINANCE_TIMEOUT';
      timeoutError.timeout_ms = timeoutMs;
      normalizedError = timeoutError;
    } else if (abortedByExternal || options?.signal?.aborted) {
      normalizedError = createBinanceCancelledError(options);
    }
    console.log('[FETCH_SKIPPED]', {
      symbol: options?.trace?.symbol || null,
      reason:
        normalizedError?.code === 'BINANCE_TIMEOUT'
          ? 'timeout'
          : normalizedError?.code === 'BINANCE_CANCELLED'
            ? 'cancelled'
            : normalizedError?.message || 'fetch_error',
      source: `binance_${options?.trace?.market || 'unknown'}`,
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      call_type: options?.trace?.call_type || 'other'
    });
    publishBinanceCallTrace(options, {
      ...buildTraceMetadata(options, { startedAtMs }),
      duration_ms: Math.max(0, Date.now() - startedAtMs),
      queue_wait_ms: slot.queue_wait_ms,
      success: false,
      aborted_by_fail_fast:
        normalizedError?.code === 'BINANCE_TIMEOUT' && timeoutMs <= BINANCE_FAIL_FAST_TIMEOUT_MS,
      cancelled_by_symbol:
        normalizedError?.code === 'BINANCE_CANCELLED' || normalizedError?.code === 'OPERATION_TIMEOUT',
      error_code: normalizedError?.code || null,
      error_message: normalizedError?.message || 'unknown',
      status: normalizedError?.status || null,
      url
    });
    throw normalizedError;
  } finally {
    removeAbortListener();
    slot.release();
  }
}

function mapKlines(data) {
  if (!Array.isArray(data)) {
    return [];
  }

  return data.map((row) => ({
    timestamp: row[0],
    open: parseFloat(row[1]),
    high: parseFloat(row[2]),
    low: parseFloat(row[3]),
    close: parseFloat(row[4]),
    volume: parseFloat(row[5])
  }));
}

async function fetchCandlesFromMarket(baseUrl, symbol, interval, options = {}) {
  const mappedInterval = INTERVAL_MAP[interval] || interval || '5m';
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${baseUrl}?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(
    mappedInterval
  )}&limit=500`;
  const data = await fetchJsonWithTimeout(url, options);
  return mapKlines(data);
}

async function fetchPriceFromMarket(baseUrl, symbol, options = {}) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${baseUrl}?symbol=${encodeURIComponent(binanceSymbol)}`;
  const data = await fetchJsonWithTimeout(url, options);
  const price = Number.parseFloat(data?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Binance price sin valor valido');
  }
  return price;
}

async function tryMarkets(markets, fetcher, options = {}) {
  let lastError = null;
  const retryOnTimeout = options?.retryOnTimeout !== false;
  for (let index = 0; index < markets.length; index += 1) {
    const market = markets[index];
    try {
      return await fetcher(
        market,
        withTraceOptions(options, {
          market: market?.name || 'unknown',
          attempt_index: index + 1
        })
      );
    } catch (error) {
      lastError = error;
      const isInvalidSymbol = error?.status === 400;
      const isTimeout = error?.code === 'BINANCE_TIMEOUT';
      if (isTimeout && !retryOnTimeout) {
        throw error;
      }
      if (!isInvalidSymbol && !isTimeout) {
        throw error;
      }
    }
  }
  throw lastError || new Error('Binance market unavailable');
}

async function fetchBinanceCandles(symbol, interval, options = {}) {
  return tryMarkets(
    [
      { name: 'futures', klinesUrl: BINANCE_FUTURES_KLINES_URL },
      { name: 'spot', klinesUrl: BINANCE_SPOT_KLINES_URL }
    ],
    async (market, marketOptions) =>
      fetchCandlesFromMarket(
        market.klinesUrl,
        symbol,
        interval,
        withTraceOptions(marketOptions, {
          symbol,
          call_type: 'candles',
          request_kind: 'klines'
        })
      ),
    options
  );
}

async function fetchBinanceSpot(symbol, options = {}) {
  return tryMarkets(
    [
      { name: 'futures', tickerUrl: BINANCE_FUTURES_TICKER_URL },
      { name: 'spot', tickerUrl: BINANCE_SPOT_TICKER_URL }
    ],
    async (market, marketOptions) =>
      fetchPriceFromMarket(
        market.tickerUrl,
        symbol,
        withTraceOptions(marketOptions, {
          symbol,
          call_type: 'spot',
          request_kind: 'ticker'
        })
      ),
    options
  );
}

module.exports = {
  fetchBinanceCandles,
  fetchBinanceSpot,
  FETCH_TIMEOUT_MS,
  BINANCE_FAIL_FAST_TIMEOUT_MS,
  BINANCE_CONCURRENCY_LIMIT,
  getBinanceConcurrencySnapshot: () => ({
    active_calls: activeBinanceCalls,
    queued_calls: queuedBinanceCalls.length,
    limit: BINANCE_CONCURRENCY_LIMIT
  }),
  normalizeBinanceSymbol
};
