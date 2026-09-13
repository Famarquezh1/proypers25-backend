'use strict';

const ACTIVE_SOURCES = [
  'https://data-api.binance.vision/api/v3/exchangeInfo',
  'https://api.binance.com/api/v3/exchangeInfo'
];

const originalFetch = global.fetch;

if (typeof originalFetch !== 'function') {
  throw new Error('global fetch is required (Node.js 20+)');
}

async function fetchJsonRaw(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await originalFetch(url, {
      signal: controller.signal,
      headers: { 'user-agent': 'proypers25-active-spot-filter/1.0' }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function isActiveSpotUsdt(symbol) {
  if (!symbol || symbol.status !== 'TRADING') return false;
  if (symbol.quoteAsset !== 'USDT') return false;
  if (symbol.isSpotTradingAllowed === false) return false;
  if (Array.isArray(symbol.permissions) && symbol.permissions.length && !symbol.permissions.includes('SPOT')) return false;
  return true;
}

async function loadActiveSpotSymbols() {
  const errors = [];
  for (const url of ACTIVE_SOURCES) {
    try {
      const exchangeInfo = await fetchJsonRaw(url);
      const symbols = Array.isArray(exchangeInfo && exchangeInfo.symbols) ? exchangeInfo.symbols : [];
      const active = new Set(symbols.filter(isActiveSpotUsdt).map((item) => String(item.symbol || '').toUpperCase()));
      if (!active.size) throw new Error('exchangeInfo returned zero active Spot USDT symbols');
      console.error(`ACTIVE_SPOT_FILTER source=${url} symbols=${active.size}`);
      return active;
    } catch (error) {
      errors.push(`${url}: ${error.message}`);
      console.error(`ACTIVE_SPOT_FILTER_SOURCE_FAILED ${url} ${error.message}`);
    }
  }
  throw new Error(`Cannot establish active Binance Spot universe; refusing unfiltered radar. ${errors.join(' | ')}`);
}

function filteredResponse(response, payload) {
  const headers = new Headers(response.headers);
  headers.set('content-type', 'application/json; charset=utf-8');
  headers.delete('content-length');
  return new Response(JSON.stringify(payload), {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function installActiveSpotFilter(activeSymbols) {
  global.fetch = async function activeSpotFilteredFetch(input, init) {
    const response = await originalFetch(input, init);
    const url = typeof input === 'string' ? input : (input && input.url) || '';

    const isBinanceTicker = /\/api\/v3\/ticker\/24hr(?:\?|$)/.test(url);
    const isCoinGeckoMarket = /api\.coingecko\.com\/api\/v3\/coins\/markets(?:\?|$)/.test(url);
    if (!response.ok || (!isBinanceTicker && !isCoinGeckoMarket)) return response;

    const payload = await response.json();
    if (!Array.isArray(payload)) return filteredResponse(response, payload);

    const filtered = isBinanceTicker
      ? payload.filter((row) => activeSymbols.has(String(row && row.symbol || '').toUpperCase()))
      : payload.filter((row) => activeSymbols.has(`${String(row && row.symbol || '').toUpperCase()}USDT`));

    console.error(`ACTIVE_SPOT_FILTER_APPLIED source=${isBinanceTicker ? 'BINANCE_TICKER' : 'COINGECKO'} before=${payload.length} after=${filtered.length}`);
    return filteredResponse(response, filtered);
  };
}

(async () => {
  const activeSymbols = await loadActiveSpotSymbols();
  installActiveSpotFilter(activeSymbols);
  require('./github-spot-production-radar-v42.js');
})().catch((error) => {
  console.error(`ACTIVE_SPOT_FILTER_FATAL ${error.stack || error.message || String(error)}`);
  process.exit(1);
});
