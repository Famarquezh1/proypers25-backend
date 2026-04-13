function cleanSymbolInput(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\//g, '-')
    .replace(/_/g, '-');
}

function normalizeToBinance(symbol) {
  const raw = cleanSymbolInput(symbol);
  if (!raw) return null;

  if (/^[A-Z0-9]{2,30}USDT$/.test(raw)) {
    return raw;
  }

  if (/^[A-Z0-9]{2,30}-USDT$/.test(raw)) {
    return raw.replace(/-USDT$/, 'USDT');
  }

  if (/^[A-Z0-9]{2,30}-USD$/.test(raw)) {
    return `${raw.replace(/-USD$/, '')}USDT`;
  }

  if (/^[A-Z0-9]{2,30}USD$/.test(raw) && !raw.endsWith('USDT')) {
    return `${raw.slice(0, -3)}USDT`;
  }

  if (/^[A-Z0-9]{2,30}$/.test(raw) && !raw.endsWith('USDT')) {
    return `${raw}USDT`;
  }

  const collapsed = raw.replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z0-9]{2,30}USDT$/.test(collapsed)) {
    return collapsed;
  }

  return null;
}

function normalizeToInternal(symbol) {
  const binance = normalizeToBinance(symbol);
  if (!binance) return null;
  if (!binance.endsWith('USDT')) return binance;
  return `${binance.slice(0, -4)}-USD`;
}

function isValidBinanceFuturesSymbol(symbol) {
  return /^[A-Z0-9]{2,30}USDT$/.test(String(symbol || '').trim().toUpperCase());
}

module.exports = {
  cleanSymbolInput,
  normalizeToBinance,
  normalizeToInternal,
  isValidBinanceFuturesSymbol
};
