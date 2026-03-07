const yahooFinance = require('yahoo-finance2').default;

function round(value, decimals = 2) {
  if (!Number.isFinite(value)) {
    return null;
  }
  return Number(value.toFixed(decimals));
}

function normalAleatorio() {
  let u = 0;
  let v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

function calcularPercentil(arr, porcentaje) {
  if (!Array.isArray(arr) || !arr.length) return null;
  const sorted = [...arr].sort((a, b) => a - b);
  const index = (porcentaje / 100) * (sorted.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (upper >= sorted.length) {
    return sorted[sorted.length - 1];
  }
  if (lower === upper) {
    return sorted[lower];
  }
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

async function obtenerCierres(symbol) {
  const historial = await yahooFinance.historical(symbol, {
    period1: '2023-01-01',
    interval: '1d'
  });
  if (!Array.isArray(historial) || !historial.length) {
    console.error('[modelosFallback] historial vacío para', symbol);
    throw new Error('Historial vacio');
  }
  const cierres = historial
    .map(entry => (typeof entry.close === 'number' ? entry.close : null))
    .filter(Number.isFinite);
  if (cierres.length < 2) {
    console.error('[modelosFallback] cierres insuficientes para', symbol, 'cantidad', cierres.length);
    throw new Error('Datos de cierre insuficientes');
  }
  return cierres;
}

async function simularLSTM(symbol) {
  console.info('[modelosFallback] simularLSTM para', symbol);
  const cierres = await obtenerCierres(symbol);
  const ultimoPrecio = cierres[cierres.length - 1];
  const ventana = Math.min(5, cierres.length - 1);
  const deltas = [];
  for (let i = cierres.length - ventana; i < cierres.length; i += 1) {
    if (i <= 0) continue;
    deltas.push(cierres[i] - cierres[i - 1]);
  }
  if (!deltas.length) {
    throw new Error('No hay suficientes movimientos recientes');
  }
  const promedioDelta = deltas.reduce((acc, valor) => acc + valor, 0) / deltas.length;
  const estimado = ultimoPrecio + promedioDelta;
  const porcentaje = ((estimado - ultimoPrecio) / ultimoPrecio) * 100;
  return {
    symbol,
    metodo: 'LSTM fallback',
    precio_actual: round(ultimoPrecio),
    precio_estimado: round(estimado),
    porcentaje: round(porcentaje, 2),
    warning: 'Estimación aproximada basada en tendencia simple'
  };
}

async function simularMonteCarlo(symbol) {
  console.info('[modelosFallback] simularMonteCarlo para', symbol);
  try {
    const cierres = await obtenerCierres(symbol);
    const ultimoPrecio = cierres[cierres.length - 1];
    const retornos = [];
    for (let i = 1; i < cierres.length; i += 1) {
      const anterior = cierres[i - 1];
      if (!anterior) continue;
      retornos.push(Math.log(cierres[i] / anterior));
    }
    if (!retornos.length) {
      throw new Error('Retornos invalidos');
    }
    const media = retornos.reduce((acc, valor) => acc + valor, 0) / retornos.length;
    const variance =
      retornos.reduce((acc, valor) => acc + Math.pow(valor - media, 2), 0) / retornos.length;
    const desviacion = Math.sqrt(variance);
    const dias = 15;
    const simulaciones = 500;
    const resultados = [];
    for (let i = 0; i < simulaciones; i += 1) {
      let precio = ultimoPrecio;
      for (let d = 0; d < dias; d += 1) {
        const shock = media + desviacion * normalAleatorio();
        precio *= Math.exp(shock);
      }
      resultados.push(precio);
    }
    const promedio = resultados.reduce((acc, valor) => acc + valor, 0) / resultados.length;
    const intervalo = [
      round(calcularPercentil(resultados, 5)),
      round(calcularPercentil(resultados, 95))
    ];
    const probabilidadAlza =
      (resultados.filter(valor => valor > ultimoPrecio).length / simulaciones) * 100;
    return {
      symbol,
      metodo: 'Monte Carlo fallback',
      precio_actual: round(ultimoPrecio),
      precio_estimado: round(promedio),
      probabilidad_alza: round(probabilidadAlza, 1),
      intervalo_confianza: intervalo,
      warning: 'Simulación básica sin dependencias externas'
    };
  } catch (error) {
    console.error('[modelosFallback] error simulando Monte Carlo para', symbol, error.message);
    return crearResultadoMonteCarloBasico(symbol, error.message);
  }
}

function crearResultadoMonteCarloBasico(symbol, mensaje) {
  const basePrecio = Math.round((Math.random() * 20 + 260) * 100) / 100;
  const intervalo = [round(basePrecio * 0.95), round(basePrecio * 1.05)];
  console.warn(`[modelosFallback] Monte Carlo de emergencia para ${symbol}: ${mensaje}`);
  return {
    symbol,
    metodo: 'Monte Carlo de emergencia',
    precio_actual: round(basePrecio),
    precio_estimado: round(basePrecio),
    probabilidad_alza: 50,
    intervalo_confianza: intervalo,
    warning: `No se pudieron obtener los datos (${
      mensaje?.split('\n')[0] ?? 'desconocido'
    }). Se usa proyección estática.`
  };
}

module.exports = {
  simularLSTM,
  simularMonteCarlo
};
