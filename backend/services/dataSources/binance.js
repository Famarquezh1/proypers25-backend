const BINANCE_BASE_URL = 'https://api.binance.com/api/v3/klines';
const BINANCE_TICKER_URL = 'https://api.binance.com/api/v3/ticker/price';

const INTERVAL_MAP = {
  '1m': '1m',
  '5m': '5m',
  '15m': '15m',
  '1h': '1h'
};

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

async function fetchBinanceCandles(symbol, interval) {
  const mappedInterval = INTERVAL_MAP[interval] || interval || '5m';
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${BINANCE_BASE_URL}?symbol=${encodeURIComponent(binanceSymbol)}&interval=${encodeURIComponent(
    mappedInterval
  )}&limit=500`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Binance status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
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

async function fetchBinanceSpot(symbol) {
  const binanceSymbol = normalizeBinanceSymbol(symbol);
  const url = `${BINANCE_TICKER_URL}?symbol=${encodeURIComponent(binanceSymbol)}`;

  const response = await fetch(url);
  if (!response.ok) {
    const error = new Error(`Binance status ${response.status}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const price = Number.parseFloat(data?.price);
  if (!Number.isFinite(price) || price <= 0) {
    throw new Error('Binance spot sin precio valido');
  }

  return price;
}

module.exports = {
  fetchBinanceCandles,
  fetchBinanceSpot
};
