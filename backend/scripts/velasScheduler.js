const prediccionVelas = require('./prediccionVelas');

const PREDICTION_CONFIG = [
  { symbol: 'BTC-USD', timeframe: '1m', execution_mode: 'event-driven' },
  { symbol: 'BTC-USD', timeframe: '5m', execution_mode: 'timeframe' },

  { symbol: 'ETH-USD', timeframe: '1m', execution_mode: 'event-driven' },
  { symbol: 'ETH-USD', timeframe: '5m', execution_mode: 'timeframe' },

  { symbol: 'DOGE-USD', timeframe: '1m', execution_mode: 'event-driven' },
  { symbol: 'DOGE-USD', timeframe: '5m', execution_mode: 'timeframe' },

  { symbol: 'SOL-USD', timeframe: '1m', execution_mode: 'event-driven' },
  { symbol: 'SOL-USD', timeframe: '5m', execution_mode: 'timeframe' },

  { symbol: 'ADA-USD', timeframe: '5m', execution_mode: 'event-driven' },

  { symbol: 'XRP-USD', timeframe: '5m', execution_mode: 'timeframe' }
];

async function runPredictionCycle() {
  const MAX_SIGNALS_PER_RUN = 20;
  let emittedCount = 0;
  let failed = 0;

  for (const config of PREDICTION_CONFIG) {
    if (emittedCount >= MAX_SIGNALS_PER_RUN) {
      console.log('[cron-velas] MAX_SIGNALS_PER_RUN alcanzado', emittedCount);
      break;
    }
    try {
      const result = await prediccionVelas({ ...config, monto: 1000, origin: 'cron' });
      if (result?.signal_emitted) {
        emittedCount += 1;
      }
      console.log('[cron-velas] prediction ok', {
        symbol: config.symbol,
        timeframe: config.timeframe,
        execution_mode: config.execution_mode,
        signal_emitted: Boolean(result?.signal_emitted)
      });
    } catch (err) {
      failed += 1;
      console.error('[cron-velas] prediction failed', config, err.message);
    }
  }

  return {
    total: PREDICTION_CONFIG.length,
    emitted: emittedCount,
    failed
  };
}

async function runFullCycle() {
  return runPredictionCycle();
}

module.exports = {
  runPredictionCycle,
  runFullCycle
};
