function cleanSymbolInput(symbol) {
  return String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\//g, '-')
    .replace(/_/g, '-');
}

function logSymbolNormalization(input, output) {
  if (!input || !output || input === output) {
    return;
  }
  console.log(`[SYMBOL_NORMALIZED] ${input} -> ${output}`);
}

function toBinanceSymbol(symbol) {
  const raw = cleanSymbolInput(symbol);
  if (!raw) return null;

  let normalized = null;

  if (/^[A-Z0-9]{2,30}USDT$/.test(raw)) {
    normalized = raw;
  } else if (/^[A-Z0-9]{2,30}-USDT$/.test(raw)) {
    normalized = raw.replace(/-USDT$/, 'USDT');
  } else if (/^[A-Z0-9]{2,30}-USD$/.test(raw)) {
    normalized = `${raw.replace(/-USD$/, '')}USDT`;
  } else if (/^[A-Z0-9]{2,30}USD$/.test(raw) && !raw.endsWith('USDT')) {
    normalized = `${raw.slice(0, -3)}USDT`;
  } else if (/^[A-Z0-9]{2,30}$/.test(raw) && !raw.endsWith('USDT')) {
    normalized = `${raw}USDT`;
  } else {
    const collapsed = raw.replace(/[^A-Z0-9]/g, '');
    if (/^[A-Z0-9]{2,30}USDT$/.test(collapsed)) {
      normalized = collapsed;
    }
  }

  if (!normalized) {
    return null;
  }

  logSymbolNormalization(raw, normalized);
  return normalized;
}

function toSystemSymbol(symbol) {
  const binanceSymbol = toBinanceSymbol(symbol);
  if (!binanceSymbol) return null;
  return `${binanceSymbol.slice(0, -4)}-USD`;
}

function isValidBinanceFuturesSymbol(symbol) {
  return /^[A-Z0-9]{2,30}USDT$/.test(String(symbol || '').trim().toUpperCase());
}

module.exports = {
  cleanSymbolInput,
  toBinanceSymbol,
  toSystemSymbol,
  normalizeToBinance: toBinanceSymbol,
  normalizeToInternal: toSystemSymbol,
  isValidBinanceFuturesSymbol
};
