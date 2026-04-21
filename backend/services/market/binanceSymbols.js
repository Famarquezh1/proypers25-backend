const ACTIVE_SYMBOLS = Object.freeze([
  'BTCUSDT',
  'ETHUSDT',
  'SOLUSDT',
  'BNBUSDT',
  'XRPUSDT'
]);

function toSystemSymbol(binanceSymbol) {
  if (!binanceSymbol || typeof binanceSymbol !== 'string' || !binanceSymbol.endsWith('USDT')) {
    return null;
  }
  const base = binanceSymbol.slice(0, -4);
  if (!base) {
    return null;
  }
  return `${base}-USD`;
}

async function getTopBinanceFuturesSymbols(options = {}) {
  const maxSymbols = Math.max(1, Number(options.maxSymbols || ACTIVE_SYMBOLS.length));
  return ACTIVE_SYMBOLS
    .map((symbol) => toSystemSymbol(symbol))
    .filter(Boolean)
    .slice(0, maxSymbols);
}

module.exports = {
  ACTIVE_SYMBOLS,
  getTopBinanceFuturesSymbols
};
