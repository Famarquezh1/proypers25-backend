const { fetchBinanceCandles } = require('../services/dataSources/binance');

async function run() {
  const symbol = process.argv[2] || 'BTC-USD';
  const interval = process.argv[3] || '5m';
  const candles = await fetchBinanceCandles(symbol, interval);
  const tail = candles.slice(-5);
  console.log(`Last 5 candles for ${symbol} (${interval}):`);
  console.table(tail);
}

run().catch((err) => {
  console.error('[BINANCE] fetch failed -> reason:', err.message);
  process.exit(1);
});
