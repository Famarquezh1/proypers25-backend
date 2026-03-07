const db = require('../firebase-admin-config');

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

function formatDate(date) {
  const d = new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

async function obtenerSnapshot(limit) {
  try {
    return await db.collection('consultas').orderBy('fecha', 'desc').limit(limit).get();
  } catch (error) {
    try {
      return await db.collection('consultas').orderBy('timestamp', 'desc').limit(limit).get();
    } catch (fallbackError) {
      return db.collection('consultas').limit(limit).get();
    }
  }
}

function resolveFecha(data) {
  const raw = data.fecha ?? data.timestamp ?? data.created_at;
  if (!raw) return null;
  if (raw instanceof Date) return raw;
  if (raw.toDate) return raw.toDate();
  const parsed = new Date(raw);
  return isNaN(parsed.getTime()) ? null : parsed;
}

function resolveFields(data) {
  const result = typeof data.resultado === 'object' && data.resultado !== null ? data.resultado : {};
  const validacion =
    data.validacion ||
    result.validacion ||
    result.verification ||
    data.verificacion ||
    data.verification ||
    {};
  const comparacion = data.comparacionModelos || {};
  const comparacionLstm = comparacion.LSTM || comparacion.lstm || {};
  const comparacionMonteCarlo = comparacion.MonteCarlo || comparacion.monteCarlo || {};
  const resultadoCuantico = data.resultadoCuantico || {};

  const precioReal = pickNumber(
    validacion.precio_real,
    validacion.precio_final,
    validacion.final_price,
    validacion.finalPrice
  );
  const precioEstimado = pickNumber(
    result.precio_estimado,
    result.precioEstimado,
    data.precio_estimado,
    data.precioEstimado,
    comparacionLstm.precio_estimado,
    comparacionMonteCarlo.precio_estimado,
    resultadoCuantico.precio_estimado
  );
  const precioActual = pickNumber(
    result.precio_actual,
    result.precioActual,
    data.precio_actual,
    data.precioActual,
    comparacionLstm.precio_actual,
    comparacionMonteCarlo.precio_actual,
    resultadoCuantico.precio_actual,
    precioEstimado
  );
  const baseline = precioActual ?? precioEstimado;

  return { precioReal, precioEstimado, baseline };
}

const DEFAULT_MIN_COUNT = 3;

async function generarBacktest({ limit = 100, minCount = DEFAULT_MIN_COUNT }) {
  const snapshot = await obtenerSnapshot(limit);
  const perDay = {};
  let total = 0;
  let matches = 0;

  snapshot.forEach(doc => {
    const data = doc.data();
    const fecha = resolveFecha(data);
    if (!fecha) return;

    const { precioReal, precioEstimado, baseline } = resolveFields(data);
    if (precioReal === null || precioEstimado === null || baseline === null || precioReal === 0) return;

    const directionReal = precioReal >= baseline ? 'up' : 'down';
    const directionPred = precioEstimado >= baseline ? 'up' : 'down';
    const dayKey = formatDate(fecha);

    if (!perDay[dayKey]) {
      perDay[dayKey] = { count: 0, match: 0 };
    }
    perDay[dayKey].count += 1;
    if (directionReal === directionPred) {
      perDay[dayKey].match += 1;
      matches += 1;
    }
    total += 1;
  });

  const perDayList = Object.entries(perDay)
    .map(([day, value]) => ({
      day,
      accuracy: value.count ? Number(((value.match / value.count) * 100).toFixed(2)) : 0,
      count: value.count
    }))
    .filter(item => item.count >= minCount);

  return {
    total,
    accuracy: total ? Number(((matches / total) * 100).toFixed(2)) : 0,
    perDay: perDayList
  };
}

module.exports = generarBacktest;
