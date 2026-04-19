process.env.CANDLE_CACHE_TTL_MS = '0';
process.env.CANDLE_CACHE_STALE_TTL_MS = String(60 * 60 * 1000);
process.env.MIN_CANDLE_ROWS = '50';

const { fetchCandles } = require('../services/dataSources/fetchCandles');

function buildCandles(count, stepMs = 5 * 60 * 1000) {
  const baseTime = Date.now() - count * stepMs;
  return Array.from({ length: count }, (_, index) => {
    const timestamp = baseTime + index * stepMs;
    const open = 100 + index * 0.5;
    const close = open + 0.25;
    return {
      timestamp,
      open,
      high: close + 0.1,
      low: open - 0.1,
      close,
      volume: 1000 + index
    };
  });
}

function buildAlphaPayload(count) {
  const series = {};
  for (const candle of buildCandles(count, 24 * 60 * 60 * 1000)) {
    const iso = new Date(candle.timestamp).toISOString().slice(0, 10);
    series[iso] = {
      '1a. open (USD)': String(candle.open),
      '1b. open (USD)': String(candle.open),
      '2a. high (USD)': String(candle.high),
      '2b. high (USD)': String(candle.high),
      '3a. low (USD)': String(candle.low),
      '3b. low (USD)': String(candle.low),
      '4a. close (USD)': String(candle.close),
      '4b. close (USD)': String(candle.close),
      '5. volume': String(candle.volume),
      '6. market cap (USD)': String(candle.close * candle.volume)
    };
  }
  return {
    'Time Series (Digital Currency Daily)': series
  };
}

function buildTimeoutError(timeoutMs = 20000) {
  const error = new Error(`Binance timeout after ${timeoutMs}ms`);
  error.code = 'BINANCE_TIMEOUT';
  error.timeout_ms = timeoutMs;
  return error;
}

async function runScenario(name, providers, options = {}) {
  const profiling = {};
  const rows = await fetchCandles(options.symbol || `SIM-${name}`, options.interval || '5m', {
    disableCache: options.disableCache ?? true,
    profiling,
    providers
  });

  return {
    name,
    row_count: rows.length,
    source_used: profiling.fetch_candles?.source_used || null,
    fallback_chain: profiling.fetch_candles?.fallback_chain || [],
    yahoo_fetch_ms: profiling.fetch_candles?.yahoo_fetch_ms ?? null,
    alpha_fetch_ms: profiling.fetch_candles?.alpha_fetch_ms ?? null,
    binance_latency_ms: profiling.fetch_candles?.binance_latency_ms ?? null
  };
}

async function main() {
  const yahooSuccess = await runScenario('YAHOO_SUCCESS', {
    binance: async () => {
      throw buildTimeoutError();
    },
    yahoo: async () => buildCandles(80),
    alpha: async () => {
      throw new Error('alpha_should_not_execute');
    }
  });

  const alphaSuccess = await runScenario('ALPHA_SUCCESS', {
    binance: async () => {
      throw buildTimeoutError();
    },
    yahoo: async () => {
      throw new Error('Yahoo upstream unavailable');
    },
    alpha: async () => buildAlphaPayload(90)
  });

  const staleSymbol = 'SIM-STALE_CACHE';
  await runScenario(
    'STALE_CACHE_SEED',
    {
      binance: async () => buildCandles(80),
      yahoo: async () => {
        throw new Error('yahoo_should_not_execute');
      },
      alpha: async () => {
        throw new Error('alpha_should_not_execute');
      }
    },
    {
      symbol: staleSymbol,
      disableCache: false
    }
  );

  const realDateNow = Date.now;
  const staleCachePreferred = await (async () => {
    const now = realDateNow();
    Date.now = () => now + 5000;
    try {
      return await runScenario(
        'STALE_CACHE_BEATS_ALPHA',
        {
          binance: async () => {
            throw buildTimeoutError();
          },
          yahoo: async () => {
            throw new Error('Yahoo upstream unavailable');
          },
          alpha: async () => buildAlphaPayload(90)
        },
        {
          symbol: staleSymbol,
          disableCache: false
        }
      );
    } finally {
      Date.now = realDateNow;
    }
  })();

  const failures = [];
  if (yahooSuccess.source_used !== 'yahoo' || yahooSuccess.row_count < 50) {
    failures.push({ scenario: yahooSuccess.name, result: yahooSuccess });
  }
  if (alphaSuccess.source_used !== 'alpha' || alphaSuccess.row_count < 50) {
    failures.push({ scenario: alphaSuccess.name, result: alphaSuccess });
  }
  if (staleCachePreferred.source_used !== 'stale_cache' || staleCachePreferred.row_count < 50) {
    failures.push({ scenario: staleCachePreferred.name, result: staleCachePreferred });
  }
  if ([yahooSuccess.source_used, alphaSuccess.source_used].includes('none')) {
    failures.push({ scenario: 'UNEXPECTED_NONE', result: { yahooSuccess, alphaSuccess } });
  }

  console.log(JSON.stringify({ yahooSuccess, alphaSuccess, staleCachePreferred, failures }, null, 2));

  if (failures.length) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error?.stack || error?.message || error);
  process.exit(1);
});
