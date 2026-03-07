const db = require('../firebase-admin-config');
const axios = require('axios');
const verificarPrediccionVelas = require('./verificacionVelas');

const DEFAULT_LIMIT = 100;
const HISTORICO_INTERVAL_DIAS = 2;
const CRYPTO_FIAT_SUFFIX = '-USD';
const CRYPTO_SYMBOLS = new Set([
  'BTC',
  'ETH',
  'DOGE',
  'SOL',
  'XRP',
  'ADA',
  'DOT',
  'LINK',
  'AVAX',
  'LTC',
  'HBAR'
]);

function coerceNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const cleaned = value.replace(/[^0-9.-]/g, '');
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function pickNumber(...values) {
  for (const value of values) {
    const parsed = coerceNumber(value);
    if (parsed !== null) return parsed;
  }
  return null;
}

function normalizarFecha(value) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (value.toDate) return value.toDate();
  const parsed = new Date(value);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function extraerNumero(texto, etiqueta) {
  if (!texto || typeof texto !== 'string') return null;
  const regex = new RegExp(`${etiqueta}\\s*[:=]\\s*\\$?([0-9.,-]+)`, 'i');
  const match = texto.match(regex);
  if (!match) return null;
  return coerceNumber(match[1]);
}

function extraerValoresTexto(texto) {
  return {
    precio_actual: extraerNumero(texto, 'Precio actual'),
    precio_estimado: extraerNumero(texto, 'Precio estimado'),
    porcentaje: extraerNumero(texto, 'Rentabilidad'),
    ganancia_estim: extraerNumero(texto, 'Ganancia estimada')
  };
}

function normalizarSimbolo(simbolo) {
  if (!simbolo || typeof simbolo !== 'string') return null;
  const limpio = simbolo.trim().toUpperCase();
  if (limpio.includes('-')) return limpio;
  if (CRYPTO_SYMBOLS.has(limpio)) return `${limpio}${CRYPTO_FIAT_SUFFIX}`;
  return limpio;
}

function inferirDireccion(texto, riesgo) {
  const base = `${texto || ''} ${riesgo || ''}`.toLowerCase();
  const positivos = ['tendencia positiva', 'alza', 'alcista', 'sube', 'compra', 'oportunidad'];
  const negativos = ['tendencia negativa', 'baja', 'bajista', 'caida', 'venta en corto', 'riesgo alto'];
  if (positivos.some(tag => base.includes(tag))) return 'up';
  if (negativos.some(tag => base.includes(tag))) return 'down';
  return null;
}

async function obtenerPrecioActual(symbol) {
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1m&range=1d`
    );
    const datos = res.data?.chart?.result?.[0];
    const precio = datos?.meta?.regularMarketPrice;
    return typeof precio === 'number' ? precio : null;
  } catch (error) {
    console.error(`Error obteniendo precio de ${symbol}:`, error.message);
    return null;
  }
}

async function obtenerPrecioHistorico(symbol, fechaBase) {
  const fecha = normalizarFecha(fechaBase);
  if (!fecha) return obtenerPrecioActual(symbol);

  const desde = Math.floor(fecha.getTime() / 1000);
  const hasta = Math.floor((fecha.getTime() + HISTORICO_INTERVAL_DIAS * 24 * 60 * 60 * 1000) / 1000);
  try {
    const res = await axios.get(
      `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=1d&period1=${desde}&period2=${hasta}`
    );
    const datos = res.data?.chart?.result?.[0];
    const closes = datos?.indicators?.quote?.[0]?.close || [];
    const ultimo = closes.filter(n => typeof n === 'number').slice(-1)[0];
    if (typeof ultimo === 'number') return ultimo;
    const metaPrice = datos?.meta?.regularMarketPrice;
    return typeof metaPrice === 'number' ? metaPrice : null;
  } catch (error) {
    console.error(`Error historico ${symbol}:`, error.message);
    return obtenerPrecioActual(symbol);
  }
}

async function procesarVelas(limit, lastDoc = null, force = false) {
  let query = db.collection('velas_predicciones').orderBy('timestamp', 'asc').limit(limit);
  if (lastDoc) {
    query = query.startAfter(lastDoc);
  }

  const snapshot = await query.get();
  if (snapshot.empty) {
    return { lastDoc: null, processed: 0 };
  }

  let processed = 0;
  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (!force && (data.verification || data.resultado?.validacion || data.completed_at || data.status === 'validado')) {
      continue;
    }

    try {
      console.log(`Revalidando velas ${doc.id}`);
      await verificarPrediccionVelas(doc.id);
      processed += 1;
    } catch (error) {
      console.error(`Error revalidando velas ${doc.id}:`, error.message);
    }
  }

  return { lastDoc: snapshot.docs[snapshot.docs.length - 1], processed };
}

async function validarConsulta(doc, force = false) {
  const data = doc.data();
  const resultado = typeof data.resultado === 'object' && data.resultado !== null ? data.resultado : {};
  const validacionExistente = data.validacion || resultado.validacion;
  if (validacionExistente && !force) return false;

  const resultadoTexto =
    typeof data.resultado === 'string'
      ? data.resultado
      : resultado.texto || resultado.resultado || data.resultadoExtendido || data.sugerenciaCuantitativa || '';
  const parsedTexto = extraerValoresTexto(resultadoTexto);

  const simboloRaw = resultado.simbolo || data.simbolo || data.symbol;
  const simbolo = normalizarSimbolo(simboloRaw);
  if (!simbolo) return false;

  const comparacion = data.comparacionModelos || {};
  const comparacionLstm = comparacion.LSTM || comparacion.lstm || {};
  const comparacionMonteCarlo = comparacion.MonteCarlo || comparacion.monteCarlo || {};
  const resultadoCuantico = data.resultadoCuantico || {};

  const precioEstimado = pickNumber(
    resultado.precio_estimado,
    resultado.precioEstimado,
    data.precio_estimado,
    data.precioEstimado,
    comparacionLstm.precio_estimado,
    comparacionMonteCarlo.precio_estimado,
    resultadoCuantico.precio_estimado,
    parsedTexto.precio_estimado
  );
  const porcentaje = pickNumber(
    resultado.porcentaje,
    data.porcentaje,
    parsedTexto.porcentaje
  );
  const precioActual = pickNumber(
    resultado.precio_actual,
    resultado.precioActual,
    data.precio_actual,
    data.precioActual,
    comparacionLstm.precio_actual,
    comparacionMonteCarlo.precio_actual,
    resultadoCuantico.precio_actual,
    parsedTexto.precio_actual,
    precioEstimado
  );
  let baseline = precioActual ?? precioEstimado;
  let estimado = precioEstimado;
  if (estimado === null && baseline !== null && porcentaje !== null) {
    estimado = baseline * (1 + porcentaje / 100);
  }
  if (baseline === null) return false;

  const fechaBase = normalizarFecha(data.fecha ?? data.timestamp ?? data.created_at);
  const precioReal = await obtenerPrecioHistorico(simbolo, fechaBase);
  if (precioReal === null) return false;

  const directionReal = precioReal >= baseline ? 'up' : 'down';
  const directionPred =
    estimado !== null && baseline !== null
      ? estimado >= baseline ? 'up' : 'down'
      : inferirDireccion(resultadoTexto, data.riesgo);
  if (!directionPred) return false;
  const directionMatch = directionReal === directionPred;
  const diferencia = Number((precioReal - (estimado ?? baseline)).toFixed(4));

  const validacion = {
    acierto: directionMatch,
    precio_real: precioReal,
    precio_final: precioReal,
    diferencia,
    direction_pred: directionPred,
    direction_match: directionMatch,
    fecha_validacion: new Date(),
    mensaje: directionMatch ? 'Prediccion acertada.' : 'Prediccion no se cumplio.'
  };

  const update = { validacion };
  if (typeof data.resultado === 'object' && data.resultado !== null) {
    update['resultado.validacion'] = validacion;
    if (parsedTexto.precio_actual !== null && resultado.precio_actual === undefined) {
      update['resultado.precio_actual'] = parsedTexto.precio_actual;
    }
    if (parsedTexto.precio_estimado !== null && resultado.precio_estimado === undefined) {
      update['resultado.precio_estimado'] = parsedTexto.precio_estimado;
    }
    if (estimado !== null && resultado.precio_estimado === undefined) {
      update['resultado.precio_estimado'] = estimado;
    }
  } else if (typeof data.resultado === 'string' && (parsedTexto.precio_actual !== null || parsedTexto.precio_estimado !== null)) {
    update.resultado = {
      texto: resultadoTexto,
      simbolo,
      tipo: data.tipo,
      ...parsedTexto
    };
  }

  await doc.ref.update(update);
  console.log(`Consulta validada ${doc.id} (${simbolo})`);
  return true;
}

async function procesarConsultas(limit, lastDoc = null, force = false) {
  let query = db.collection('consultas').orderBy('fecha', 'asc').limit(limit);
  if (lastDoc) {
    query = query.startAfter(lastDoc);
  }

  let snapshot;
  try {
    snapshot = await query.get();
  } catch (error) {
    snapshot = await db.collection('consultas').orderBy('timestamp', 'asc').limit(limit).get();
  }

  if (snapshot.empty) {
    return { lastDoc: null, processed: 0 };
  }

  let processed = 0;
  for (const doc of snapshot.docs) {
    try {
      const ok = await validarConsulta(doc, force);
      if (ok) processed += 1;
    } catch (error) {
      console.error(`Error validando consulta ${doc.id}:`, error.message);
    }
  }

  return { lastDoc: snapshot.docs[snapshot.docs.length - 1], processed };
}

async function revalidarHistorico(options = {}) {
  const limit = options.limit && Number.isFinite(Number(options.limit)) ? Number(options.limit) : DEFAULT_LIMIT;
  const force = options.force === true || options.force === 'true';
  console.log(`Iniciando revalidacion historica (lote ${limit})`);
  let processed = 0;
  let velasProcessed = 0;
  let consultasProcessed = 0;

  let lastVelas = null;
  while (true) {
    const result = await procesarVelas(limit, lastVelas, force);
    processed += result.processed;
    velasProcessed += result.processed;
    lastVelas = result.lastDoc;
    if (!lastVelas) break;
  }

  let lastConsultas = null;
  while (true) {
    const result = await procesarConsultas(limit, lastConsultas, force);
    processed += result.processed;
    consultasProcessed += result.processed;
    lastConsultas = result.lastDoc;
    if (!lastConsultas) break;
  }

  console.log(`Revalidacion terminada. Procesados: ${processed}`);
  return { processed, velasProcessed, consultasProcessed };
}

if (require.main === module) {
  revalidarHistorico()
    .catch(err => {
      console.error('Error revalidando historico:', err);
      process.exit(1);
    });
}

module.exports = revalidarHistorico;
