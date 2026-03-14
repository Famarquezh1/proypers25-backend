const BINANCE_SPOT_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const BINANCE_SPOT_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';
const BINANCE_FUTURES_KLINES_URL = 'https://fapi.binance.com/fapi/v1/klines';
const BINANCE_FUTURES_TICKER_URL = 'https://fapi.binance.com/fapi/v1/ticker/price';

const INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h'
};

const BINANCE_HTTP_TIMEOUT_MS = Math.max(2000, Number(process.env.BINANCE_HTTP_TIMEOUT_MS || 8000));

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

async function fetchJsonWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BINANCE_HTTP_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      const error = new Error(`Binance status ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error(`Binance timeout after ${BINANCE_HTTP_TIMEOUT_MS}ms`);
      timeoutError.code = 'BINANCE_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timer);
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

async function fetchCandlesFromMarket(baseUrl, symbol, interval) {
  const mappedInterval = INTERVAL_MAP[interval] || interval || '5m';
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${baseUrl}?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(
    mappedInterval
  )}&limit=500`;
  const data = await fetchJsonWithTimeout(url);
  return mapKlines(data);
}

async function fetchPriceFromMarket(baseUrl, symbol) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${baseUrl}?symbol=${encodeURIComponent(binanceSymbol)}`;
  const data = await fetchJsonWithTimeout(url);
  const price = Number.parseFloat(data?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Binance price sin valor valido');
  }
  return price;
}

async function tryMarkets(markets, fetcher) {
  let lastError = null;
  for (const market of markets) {
    try {
      return await fetcher(market);
    } catch (error) {
      lastError = error;
      const isInvalidSymbol = error?.status === 400;
      const isTimeout = error?.code === 'BINANCE_TIMEOUT';
      if (!isInvalidSymbol && !isTimeout) {
        throw error;
      }
    }
  }
  throw lastError || new Error('Binance market unavailable');
}

async function fetchBinanceCandles(symbol, interval) {
  return tryMarkets(
    [
      { name: 'futures', klinesUrl: BINANCE_FUTURES_KLINES_URL },
      { name: 'spot', klinesUrl: BINANCE_SPOT_KLINES_URL }
    ],
    async (market) => fetchCandlesFromMarket(market.klinesUrl, symbol, interval)
  );
}

async function fetchBinanceSpot(symbol) {
  return tryMarkets(
    [
      { name: 'futures', tickerUrl: BINANCE_FUTURES_TICKER_URL },
      { name: 'spot', tickerUrl: BINANCE_SPOT_TICKER_URL }
    ],
    async (market) => fetchPriceFromMarket(market.tickerUrl, symbol)
  );
}

module.exports = {
  fetchBinanceCandles,
  fetchBinanceSpot,
  normalizeBinanceSymbol
};
