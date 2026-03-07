const { exec } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const db = require('./firebase-admin-config');

const posiblesSimbolos = ['TSLA', 'AAPL', 'NVDA', 'MSFT'];
const montoInicial = 1000;
const scriptDir = path.join(__dirname, 'quantum-backend');

function ejecutarModelo(script, symbol) {
  return new Promise((resolve) => {
    exec(`python3 ${script} ${symbol}`, { cwd: scriptDir, shell: true }, (err, stdout) => {
      if (err) return resolve({ symbol, metodo: script, error: err.message });

      try {
        const resultado = JSON.parse(stdout.trim().split('\n').pop());
        return resolve(resultado);
      } catch (e) {
        return resolve({ symbol, metodo: script, error: 'Error al parsear JSON' });
      }
    });
  });
}

async function obtenerConfianzaHistorica(symbol) {
  const snapshot = await db.collection('consultas')
    .where('simbolo', '==', symbol)
    .get();

  if (snapshot.empty) return { confianza: null, alerta: '' };

  let total = 0;
  let cantidad = 0;

  snapshot.forEach(doc => {
    const val = doc.data().validacion;
    if (val && typeof val.confianza === 'number') {
      total += val.confianza;
      cantidad++;
    }
  });

  const promedio = cantidad > 0 ? total / cantidad : null;
  const alerta = promedio !== null && promedio < 0.4
    ? '⚠️ Confianza histórica baja para este símbolo.'
    : '';

  return { confianza: promedio, alerta };
}

function isTradingDay(date) {
  const day = date.getDay();
  return day >= 1 && day <= 5;
}

function nextTradingDay(date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  do {
    next.setDate(next.getDate() + 1);
  } while (!isTradingDay(next));
  return next;
}

function getNYNow() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }));
}

function formatNY(date) {
  const opts = {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false
  };
  const parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date);
  const map = {};
  parts.forEach(({ type, value }) => {
    map[type] = value;
  });
  return `${map.year}-${map.month}-${map.day} ${map.hour}:${map.minute}`;
}

function minutesToTime(date, minutes) {
  const day = new Date(date);
  day.setHours(0, 0, 0, 0);
  day.setMinutes(minutes);
  return day;
}

function getTradeTimes() {
  const nyNow = getNYNow();
  let tradingDay = isTradingDay(nyNow) ? nyNow : nextTradingDay(nyNow);
  const marketOpen = 9 * 60 + 30;
  const marketClose = 16 * 60;
  let currentMinutes = tradingDay.getHours() * 60 + tradingDay.getMinutes();
  if (currentMinutes >= marketClose) {
    tradingDay = nextTradingDay(tradingDay);
    currentMinutes = marketOpen;
  }
  if (currentMinutes < marketOpen) {
    currentMinutes = marketOpen;
  }
  const buyMinutes = Math.min(
    marketClose - 30,
    Math.ceil((currentMinutes + 15) / 15) * 15
  );
  const sellMinutes = marketClose - 15;
  return {
    comprar: formatNY(minutesToTime(tradingDay, buyMinutes)),
    vender: formatNY(minutesToTime(tradingDay, sellMinutes))
  };
}

async function recomendarInversion() {
  const resultados = [];

  for (const symbol of posiblesSimbolos) {
    const [lstm, montecarlo, cuantico] = await Promise.all([
      ejecutarModelo('lstm_model.py', symbol),
      ejecutarModelo('montecarlo.py', symbol),
      ejecutarModelo('cuantico.py', symbol)
    ]);

    resultados.push({
      symbol,
      lstm,
      montecarlo,
      cuantico
    });
  }

  let mejorProyeccion = null;

  for (const resultado of resultados) {
    const opciones = [
      {
        tipo: 'LSTM',
        symbol: resultado.symbol,
        valor: resultado.lstm.precio_estimado || 0,
        precio_actual: resultado.lstm.precio_actual || 0
      },
      {
        tipo: 'MonteCarlo',
        symbol: resultado.symbol,
        valor: resultado.montecarlo.precio_estimado || 0,
        precio_actual: resultado.montecarlo.precio_actual || 0
      },
      {
        tipo: 'Qiskit',
        symbol: resultado.symbol,
        valor: resultado.cuantico.probabilidad_alza || 0,
        precio_actual: resultado.cuantico.precio_actual || 0
      }
    ];

    const mejor = opciones.reduce((a, b) => (a.valor > b.valor ? a : b));
    if (!mejorProyeccion || mejor.valor > mejorProyeccion.valor) {
      mejorProyeccion = mejor;
    }
  }

  const { valor: estimado, precio_actual } = mejorProyeccion;

  const precioValido = precio_actual > 0 && isFinite(precio_actual);
  const porcentaje = precioValido ? ((estimado - precio_actual) / precio_actual) * 100 : 0;
  const gananciaEstim = precioValido ? (montoInicial * (porcentaje / 100)).toFixed(2) : '0.00';
  const stopLoss = precioValido ? (precio_actual * 0.98).toFixed(2) : '0.00';
  const takeProfit = precioValido ? (precio_actual * 1.05).toFixed(2) : '0.00';
  const { confianza, alerta } = await obtenerConfianzaHistorica(mejorProyeccion.symbol);

  const tiempos = getTradeTimes();

  const recomendacion = {
    simbolo: mejorProyeccion.symbol,
    tipo: mejorProyeccion.tipo,
    invertir: montoInicial,
    precio_actual: precioValido ? precio_actual.toFixed(2) : '0.00',
    precio_estimado: precioValido ? estimado.toFixed(2) : '0.00',
    porcentaje: precioValido ? porcentaje.toFixed(2) : '0.00',
    ganancia_estim: gananciaEstim,
    comprar: tiempos.comprar,
    vender: tiempos.vender,
    stop_loss: stopLoss,
    take_profit: takeProfit,
    motivo: `Mayor proyección encontrada en modelo ${mejorProyeccion.tipo}`,
    confianzaHistorica: confianza !== null ? parseFloat(confianza.toFixed(2)) : null,
    alertaConfianza: alerta
  };

  console.log(JSON.stringify(recomendacion));
}

recomendarInversion();

