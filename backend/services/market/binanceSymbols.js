const BINANCE_FUTURES_EXCHANGE_INFO = 'https://fapi.binance.com/fapi/v1/exchangeInfo';
const BINANCE_FUTURES_TICKER_24H = 'https://fapi.binance.com/fapi/v1/ticker/24hr';

const MAX_SYMBOLS = Number(process.env.MAX_SYMBOLS || 60);
const SYMBOLS_CACHE_TTL_MS = Number(process.env.SYMBOLS_CACHE_TTL_MS || 3600000);
const SYMBOLS_FETCH_RETRIES = Number(process.env.SYMBOLS_FETCH_RETRIES || 2);
const SYMBOLS_FETCH_BACKOFF_MS = Number(process.env.SYMBOLS_FETCH_BACKOFF_MS || 500);

let cache = {
  symbols: [],
  fetchedAt: 0
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry(url, retries = SYMBOLS_FETCH_RETRIES) {
  let attempt = 0;
  let lastErr = null;

  while (attempt <= retries) {
    try {
      const response = await fetch(url);
      if (!response.ok) {
        const err = new Error(`status ${response.status}`);
        err.status = response.status;
        throw err;
      }
      return await response.json();
    } catch (err) {
      lastErr = err;
      const retriable = err?.status === 429 || (err?.status >= 500 && err?.status < 600);
      if (!retriable || attempt === retries) {
        break;
      }
      const backoffMs = SYMBOLS_FETCH_BACKOFF_MS * (attempt + 1);
      await sleep(backoffMs);
    }
    attempt += 1;
  }

  throw lastErr || new Error('failed to fetch data');
}

function toSystemSymbol(binanceSymbol) {
  if (!binanceSymbol || typeof binanceSymbol !== 'string') {
    return null;
  }
  if (!binanceSymbol.endsWith('USDT')) {
    return null;
  }
  const base = binanceSymbol.slice(0, -4);
  if (!base) {
    return null;
  }
  return `${base}-USD`;
}

async function fetchTopBinanceFuturesSymbols(maxSymbols = MAX_SYMBOLS) {
  const [exchangeInfo, tickers] = await Promise.all([
    fetchJsonWithRetry(BINANCE_FUTURES_EXCHANGE_INFO),
    fetchJsonWithRetry(BINANCE_FUTURES_TICKER_24H)
  ]);

  const tradablePerpetual = new Set(
    (exchangeInfo?.symbols || [])
      .filter(
        (item) =>
          item?.quoteAsset === 'USDT' &&
          item?.status === 'TRADING' &&
          item?.contractType === 'PERPETUAL'
      )
      .map((item) => item.symbol)
  );

  const sortedByQuoteVolume = (tickers || [])
    .filter((item) => tradablePerpetual.has(item?.symbol))
    .map((item) => ({
      symbol: item.symbol,
      quoteVolume: Number(item.quoteVolume || 0)
    }))
    .filter((item) => Number.isFinite(item.quoteVolume) && item.quoteVolume > 0)
    .sort((a, b) => b.quoteVolume - a.quoteVolume);

  const selected = [];
  const seen = new Set();

  for (const item of sortedByQuoteVolume) {
    const systemSymbol = toSystemSymbol(item.symbol);
    if (!systemSymbol || seen.has(systemSymbol)) {
      continue;
    }
    seen.add(systemSymbol);
    selected.push(systemSymbol);
    if (selected.length >= maxSymbols) {
      break;
    }
  }

  return selected;
}

async function getTopBinanceFuturesSymbols(options = {}) {
  const maxSymbols = Number(options.maxSymbols || MAX_SYMBOLS);
  const forceRefresh = options.forceRefresh === true;
  const now = Date.now();

  if (
    !forceRefresh &&
    cache.symbols.length &&
    now - cache.fetchedAt < SYMBOLS_CACHE_TTL_MS
  ) {
    return cache.symbols.slice(0, maxSymbols);
  }

  const symbols = await fetchTopBinanceFuturesSymbols(maxSymbols);
  cache = {
    symbols,
    fetchedAt: now
  };

  return symbols;
}

module.exports = {
  getTopBinanceFuturesSymbols
};
