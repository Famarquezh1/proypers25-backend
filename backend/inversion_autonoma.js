const { exec } = require('child_process');
const path = require('path');
const admin = require('firebase-admin');
const db = require('./firebase-admin-config');


const posiblesSimbolos = ['TSLA', 'AAPL', 'NVDA', 'MSFT'];
;
const montoInicial = 1000;
const scriptDir = path.join(__dirname, 'quantum-backend');

function ejecutarModelo(script, symbol) {
  return new Promise((resolve) => {
    exec(`py -3.9 ${script} ${symbol}`, { cwd: scriptDir }, (err, stdout) => {
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


function obtenerProximaFechaHora(hora = '10:30') {
  const fecha = new Date();
  fecha.setDate(fecha.getDate() + 1);
  const yyyy = fecha.getFullYear();
  const mm = String(fecha.getMonth() + 1).padStart(2, '0');
  const dd = String(fecha.getDate()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hora}`;
}

// ... (mismos imports y funciones previas)

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

  // Validación fuerte
  const precioValido = precio_actual > 0 && isFinite(precio_actual);
  const porcentaje = precioValido ? ((estimado - precio_actual) / precio_actual) * 100 : 0;
  const gananciaEstim = precioValido ? (montoInicial * (porcentaje / 100)).toFixed(2) : '0.00';
  const stopLoss = precioValido ? (precio_actual * 0.98).toFixed(2) : '0.00';
  const takeProfit = precioValido ? (precio_actual * 1.05).toFixed(2) : '0.00';
  const { confianza, alerta } = await obtenerConfianzaHistorica(mejorProyeccion.symbol);

  const recomendacion = {
    simbolo: mejorProyeccion.symbol,
    tipo: mejorProyeccion.tipo,
    invertir: montoInicial,
    precio_actual: precioValido ? precio_actual.toFixed(2) : '0.00',
    precio_estimado: precioValido ? estimado.toFixed(2) : '0.00',
    porcentaje: precioValido ? porcentaje.toFixed(2) : '0.00',
    ganancia_estim: gananciaEstim,
    comprar: obtenerProximaFechaHora('10:30'),
    vender: obtenerProximaFechaHora('15:30'),
    stop_loss: stopLoss,
    take_profit: takeProfit,
    motivo: `Mayor proyección encontrada en modelo ${mejorProyeccion.tipo}`,
    confianzaHistorica: confianza !== null ? parseFloat(confianza.toFixed(2)) : null,
    alertaConfianza: alerta
  };

  console.log(JSON.stringify(recomendacion));
}

recomendarInversion();
