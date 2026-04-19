/**
 * DATA SOURCE RECOVERY ENGINE
 *
 * Phases 3-4: Production Hardening
 *
 * ✔ Automatic fallback chain (Fase 3)
 * ✔ Mandatory symbol normalization (Fase 4)
 * ✔ Data source failover
 * ✔ Never stops system on fetch failure
 *
 * Priority chain:
 * 1. Binance API (principal)
 * 2. Yahoo Finance
 * 3. Alpha Vantage
 * 4. Last valid snapshot (max 60s)
 */

const axios = require('axios');

// Cache for last valid data per symbol
let symbolDataCache = new Map();
const DATA_CACHE_TTL_MS = 60 * 1000; // 60 seconds

/**
 * Fase 4: Mandatory symbol normalization
 *
 * Convert: BTC-USD → BTCUSDT
 */
function normalizeSymbol(symbol) {
  try {
    if (!symbol) {
      throw new Error('Symbol is empty');
    }

    // Remove spaces
    symbol = symbol.toUpperCase().trim();

    // Handle common formats
    const normalizations = {
      'BTC-USD': 'BTCUSDT',
      'ETH-USD': 'ETHUSDT',
      'BNB-USD': 'BNBUSDT',
      'SOL-USD': 'SOLUSDT',
      'ADA-USD': 'ADAUSDT',
      'XRP-USD': 'XRPUSDT',
      'DOGE-USD': 'DOGEUSDT',
      'AVAX-USD': 'AVAXUSDT',
      'MATIC-USD': 'MATICUSDT',
      'LINK-USD': 'LINKUSDT',
      // Add more as needed
    };

    if (normalizations[symbol]) {
      console.log(`[DataRecovery] Symbol normalized: ${symbol} → ${normalizations[symbol]}`);
      return normalizations[symbol];
    }

    // If already in USDT format, return as is
    if (symbol.endsWith('USDT') || symbol.endsWith('BUSD') || symbol.endsWith('USDC')) {
      return symbol;
    }

    // If hyphenated with USDT-like, convert
    if (symbol.includes('-') && (symbol.includes('USDT') || symbol.includes('USD'))) {
      const [base] = symbol.split('-');
      return base + 'USDT';
    }

    // Default: append USDT
    return symbol + 'USDT';
  } catch (err) {
    console.error('[DataRecovery] Symbol normalization error:', err.message);
    logEvent('SYMBOL_NORMALIZATION_ERROR', {
      symbol,
      error: err.message,
      severity: 'high'
    });
    return null;
  }
}

/**
 * Log a recovery event
 */
function logEvent(eventType, data = {}) {
  const timestamp = new Date().toISOString();
  console.log(`[DataRecovery] ${eventType} | ${JSON.stringify({ timestamp, ...data })}`);
}

/**
 * Attempt to fetch from Binance API (Primary source)
 */
async function fetchFromBinance(symbol, options = {}) {
  try {
    normalized = normalizeSymbol(symbol);
    if (!normalized) throw new Error('Failed to normalize symbol');

    // Use Binance Testnet or live API based on config
    const baseURL = process.env.BINANCE_TESTNET === 'true'
      ? 'https://testnet.binancefuture.com'
      : 'https://fapi.binance.com';

    const response = await axios.get(`${baseURL}/fapi/v1/ticker/price`, {
      params: { symbol: normalized },
      timeout: 5000
    });

    if (response.data && response.data.price) {
      cacheSymbolData(normalized, parseFloat(response.data.price), 'binance');
      return {
        symbol: normalized,
        price: parseFloat(response.data.price),
        source: 'binance',
        timestamp: new Date()
      };
    }
  } catch (err) {
    console.error('[DataRecovery] Binance fetch failed:', err.message);
  }
  return null;
}

/**
 * Attempt to fetch from Yahoo Finance (Secondary source)
 */
async function fetchFromYahooFinance(symbol, options = {}) {
  try {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) throw new Error('Failed to normalize symbol');

    // Convert USDT to Yahoo format (e.g., BTCUSDT → BTC-USD)
    const yahooSymbol = normalized.replace('USDT', '-USD');

    // Yahoo Finance API (free tier)
    const response = await axios.get('https://query1.finance.yahoo.com/v7/finance/quote', {
      params: {
        symbols: yahooSymbol,
        fields: 'regularMarketPrice'
      },
      timeout: 5000
    });

    if (response.data?.quoteResponse?.result?.[0]?.regularMarketPrice) {
      const price = response.data.quoteResponse.result[0].regularMarketPrice;
      cacheSymbolData(normalized, price, 'yahoo');
      return {
        symbol: normalized,
        price,
        source: 'yahoo',
        timestamp: new Date()
      };
    }
  } catch (err) {
    console.error('[DataRecovery] Yahoo Finance fetch failed:', err.message);
  }
  return null;
}

/**
 * Attempt to fetch from Alpha Vantage (Tertiary source)
 */
async function fetchFromAlphaVantage(symbol, options = {}) {
  try {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) throw new Error('Failed to normalize symbol');

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
    if (!apiKey) {
      console.warn('[DataRecovery] Alpha Vantage API key not configured');
      return null;
    }

    // Convert BTCUSDT to BTC for Alpha Vantage
    const baseSymbol = normalized.replace('USDT', '').replace('USD', '');

    const response = await axios.get('https://www.alphavantage.co/query', {
      params: {
        function: 'CURRENCY_EXCHANGE_RATE',
        from_currency: baseSymbol,
        to_currency: 'USD',
        apikey: apiKey
      },
      timeout: 5000
    });

    if (response.data?.['Realtime Currency Exchange Rate']?.['5. Exchange Rate']) {
      const price = parseFloat(response.data['Realtime Currency Exchange Rate']['5. Exchange Rate']);
      cacheSymbolData(normalized, price, 'alphavantage');
      return {
        symbol: normalized,
        price,
        source: 'alphavantage',
        timestamp: new Date()
      };
    }
  } catch (err) {
    console.error('[DataRecovery] Alpha Vantage fetch failed:', err.message);
  }
  return null;
}

/**
 * Get last valid snapshot from cache (max 60s old)
 */
function getFromCache(symbol) {
  try {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return null;

    const cached = symbolDataCache.get(normalized);
    if (!cached) return null;

    const ageMs = Date.now() - cached.timestamp.getTime();
    if (ageMs > DATA_CACHE_TTL_MS) {
      symbolDataCache.delete(normalized);
      return null;
    }

    console.log(`[DataRecovery] Using cached data for ${normalized} (${ageMs}ms old)`);
    return cached;
  } catch (err) {
    console.error('[DataRecovery] Error getting from cache:', err.message);
    return null;
  }
}

/**
 * Cache symbol data
 */
function cacheSymbolData(symbol, price, source) {
  try {
    symbolDataCache.set(symbol, {
      symbol,
      price,
      source,
      timestamp: new Date()
    });
  } catch (err) {
    console.error('[DataRecovery] Error caching data:', err.message);
  }
}

/**
 * Fase 3: Automatic fallback chain
 *
 * Priority:
 * 1. Binance API
 * 2. Yahoo Finance
 * 3. Alpha Vantage
 * 4. Cache (max 60s)
 *
 * If all fail:
 * - Mark symbol as degraded
 * - DO NOT stop system
 */
async function fetchSymbolDataWithFallback(symbol, options = {}) {
  try {
    // Normalize first
    const normalized = normalizeSymbol(symbol);
    if (!normalized) {
      return {
        symbol,
        success: false,
        error: 'normalization_failed',
        severity: 'critical'
      };
    }

    // 1. Try Binance (primary)
    console.log(`[DataRecovery] Fetching ${normalized} from Binance...`);
    let result = await fetchFromBinance(normalized);
    if (result) {
      logEvent('DATA_FETCH_SUCCESS', {
        symbol: normalized,
        source: 'binance',
        price: result.price
      });
      return { ...result, success: true };
    }

    // 2. Try Yahoo Finance (secondary)
    console.log(`[DataRecovery] Binance failed, trying Yahoo Finance...`);
    result = await fetchFromYahooFinance(normalized);
    if (result) {
      logEvent('DATA_SOURCE_FALLBACK', {
        symbol: normalized,
        source: 'yahoo',
        reason: 'binance_failed',
        price: result.price,
        severity: 'medium'
      });
      return { ...result, success: true };
    }

    // 3. Try Alpha Vantage (tertiary)
    console.log(`[DataRecovery] Yahoo failed, trying Alpha Vantage...`);
    result = await fetchFromAlphaVantage(normalized);
    if (result) {
      logEvent('DATA_SOURCE_FALLBACK', {
        symbol: normalized,
        source: 'alphavantage',
        reason: 'binance_and_yahoo_failed',
        price: result.price,
        severity: 'high'
      });
      return { ...result, success: true };
    }

    // 4. Try cache (max 60s old)
    console.log(`[DataRecovery] All sources failed, checking cache...`);
    result = getFromCache(normalized);
    if (result) {
      logEvent('DATA_SOURCE_FALLBACK', {
        symbol: normalized,
        source: 'cache',
        reason: 'all_sources_failed',
        price: result.price,
        cache_age_ms: Date.now() - result.timestamp.getTime(),
        severity: 'high'
      });
      return { ...result, success: true, from_cache: true };
    }

    // All failed - mark as degraded, do NOT stop
    logEvent('DATA_FETCH_ALL_FAILED', {
      symbol: normalized,
      reason: 'all_sources_exhausted',
      action: 'mark_degraded_continue',
      severity: 'critical'
    });

    return {
      symbol: normalized,
      success: false,
      error: 'all_sources_failed',
      action: 'mark_degraded',
      severity: 'critical'
    };
  } catch (err) {
    console.error('[DataRecovery] Unexpected error in fallback chain:', err.message);
    return {
      symbol,
      success: false,
      error: err.message,
      severity: 'critical'
    };
  }
}

/**
 * Fetch multiple symbols with fallback
 */
async function fetchMultipleWithFallback(symbols = []) {
  const results = [];
  for (const symbol of symbols) {
    const result = await fetchSymbolDataWithFallback(symbol);
    results.push(result);
  }
  return results;
}

/**
 * Clear cache (for reset)
 */
function clearCache() {
  symbolDataCache.clear();
  console.log('[DataRecovery] Symbol data cache cleared');
}

/**
 * Get cache statistics
 */
function getCacheStats() {
  return {
    cached_symbols: symbolDataCache.size,
    symbols: Array.from(symbolDataCache.keys()),
    timestamp: new Date()
  };
}

module.exports = {
  normalizeSymbol,
  fetchSymbolDataWithFallback,
  fetchMultipleWithFallback,
  fetchFromBinance,
  fetchFromYahooFinance,
  fetchFromAlphaVantage,
  getFromCache,
  cacheSymbolData,
  clearCache,
  getCacheStats,
  logEvent,
  DATA_CACHE_TTL_MS
};
