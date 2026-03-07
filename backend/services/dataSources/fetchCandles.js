const yahooFinance = require('yahoo-finance2').default;
const { fetchBinanceCandles } = require('./binance');

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY || null;
const ENABLE_BINANCE = process.env.ENABLE_BINANCE === 'true';

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

async function fetchAlphaCandles(symbol, interval) {
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('AlphaVantage key missing');
  }
  const alphaInterval = ALPHA_INTERVAL_MAP[interval] || '5min';
  const baseSymbol = normalizeAlphaSymbol(symbol);
  const url = `https://www.alphavantage.co/query?function=CRYPTO_INTRADAY&symbol=${encodeURIComponent(
    baseSymbol
  )}&market=USD&interval=${encodeURIComponent(alphaInterval)}&outputsize=compact&apikey=${ALPHA_VANTAGE_KEY}`;
  const response = await fetch(url);
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

async function fetchYahooCandles(symbol, timeframe) {
  const now = new Date();
  const lookbackDays = lookbackDaysForTimeframe(timeframe);
  const period1 = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const rows = await yahooFinance.historical(symbol, {
    period1,
    period2: now,
    interval: timeframe
  });
  return (rows || []).map((row) => ({
    timestamp: row.date || row.timestamp || row.datetime || row.time,
    open: row.open,
    high: row.high,
    low: row.low,
    close: row.close,
    volume: row.volume
  }));
}

async function fetchCandles(symbol, interval) {
  if (ENABLE_BINANCE) {
    try {
      const rows = await fetchBinanceCandles(symbol, interval);
      if (rows.length) {
        console.log(`[BINANCE] candle fetch ok (${rows.length} velas)`);
        return rows;
      }
      console.warn('[BINANCE] no data, fallback triggered');
    } catch (err) {
      if (err?.status === 429) {
        console.warn('[BINANCE] fetch failed -> reason: rate_limited');
      } else {
        console.warn(`[BINANCE] fetch failed -> reason: ${err.message}`);
      }
    }
  } else {
    console.log('[BINANCE] disabled by ENABLE_BINANCE=false');
  }

  try {
    const rows = await fetchAlphaCandles(symbol, interval);
    if (rows.length) {
      console.log(`[ALPHA] candle fetch ok (${rows.length} velas)`);
      return rows;
    }
    console.warn('[ALPHA] no data, fallback triggered');
  } catch (err) {
    console.warn(`[ALPHA] fetch failed -> reason: ${err.message}`);
  }

  try {
    const rows = await fetchYahooCandles(symbol, interval);
    if (rows.length) {
      console.log(`[YAHOO] candle fetch ok (${rows.length} velas)`);
      return rows;
    }
    console.warn('[YAHOO] no data, fallback triggered');
  } catch (err) {
    console.warn(`[YAHOO] fetch failed -> reason: ${err.message}`);
  }

  return [];
}

module.exports = {
  fetchCandles
};
