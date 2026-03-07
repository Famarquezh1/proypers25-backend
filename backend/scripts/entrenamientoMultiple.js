const entrenarLSTM = require('./entrenamientoLSTM');
const entrenarVelas = require('./entrenamientoVelas');

const DEFAULT_SYMBOLS = [
  'MSFT', 'AAPL', 'GOOGL', 'AMZN', 'NVDA',
  'BTC-USD', 'ETH-USD', 'SOL-USD', 'DOGE-USD',
  'ADA-USD', 'XRP-USD', 'DOT-USD', 'LINK-USD', 'AVAX-USD', 'LTC-USD', 'HBAR-USD'
];

function esCripto(simbolo) {
  return simbolo.endsWith('-USD');
}

function esHorarioHabil() {
  const ahora = new Date();
  const dia = ahora.getDay();
  const hora = ahora.getHours();
  const minutos = ahora.getMinutes();
  const totalMinutos = hora * 60 + minutos;
  return dia >= 1 && dia <= 5 && totalMinutos >= 600 && totalMinutos <= 1050;
}

async function logStatus(callback, symbol, payload) {
  if (callback && typeof callback === 'function') {
    await callback(symbol, payload);
  }
}

module.exports = async function entrenamientoMultiple(options = {}) {
  const symbols = Array.isArray(options.symbols) ? options.symbols : DEFAULT_SYMBOLS;
  const logCallback = options.logCallback;

  console.log('Starting hybrid multiple training...');
  for (const simbolo of symbols) {
    const cripto = esCripto(simbolo);
    const permitted = cripto || esHorarioHabil();

    if (!permitted) {
      console.log(`${simbolo} skipped: outside market hours`);
      await logStatus(logCallback, simbolo, { status: 'skipped', reason: 'outside market hours' });
      continue;
    }

    console.log(`Training ${simbolo} (${cripto ? 'Crypto' : 'Stock'})`);
    await logStatus(logCallback, simbolo, { status: 'running' });

    try {
      await entrenarLSTM(simbolo, 50);
      await logStatus(logCallback, simbolo, { status: 'lstm_complete' });
    } catch (error) {
      console.error(`Error training LSTM ${simbolo}:`, error.message);
      await logStatus(logCallback, simbolo, { status: 'lstm_failed', error: error.message });
      continue;
    }

    if (cripto) {
      try {
        await entrenarVelas(simbolo);
        await logStatus(logCallback, simbolo, { status: 'candlestick_complete' });
      } catch (error) {
        console.error(`Error training candlesticks ${simbolo}:`, error.message);
        await logStatus(logCallback, simbolo, { status: 'candlestick_failed', error: error.message });
      }
    }
  }

  console.log('Hybrid training finished.');
};
