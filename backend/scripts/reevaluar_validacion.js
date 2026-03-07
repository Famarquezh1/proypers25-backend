const db = require('../firebase-admin-config');
const { FieldValue } = require('firebase-admin').firestore;

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

function direction(price, baseline) {
  if (price === null || baseline === null) return null;
  return price >= baseline ? 'up' : 'down';
}

function normalizarSimbolo(value) {
  if (!value || typeof value !== 'string') return 'general';
  const limpio = value.trim();
  if (!limpio) return 'general';
  return limpio.toUpperCase();
}

function resolveFields(data) {
  const resultado = typeof data.resultado === 'object' && data.resultado !== null ? data.resultado : {};
  const validacion =
    data.validacion ||
    data.verificacion ||
    data.verification ||
    resultado.validacion ||
    resultado.verification ||
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
    resultado.precio_estimado,
    resultado.precioEstimado,
    data.precio_estimado,
    data.precioEstimado,
    comparacionLstm.precio_estimado,
    comparacionMonteCarlo.precio_estimado,
    resultadoCuantico.precio_estimado
  );
  const precioActual = pickNumber(
    resultado.precio_actual,
    resultado.precioActual,
    data.precio_actual,
    data.precioActual,
    comparacionLstm.precio_actual,
    comparacionMonteCarlo.precio_actual,
    resultadoCuantico.precio_actual
  );
  const baseline = precioActual ?? precioEstimado;
  const symbol = normalizarSimbolo(data.simbolo || resultado.simbolo || validacion.simbolo);

  return { precioReal, precioEstimado, baseline, symbol };
}

async function ejecutarReevaluacion() {
  const sources = [
    db.collection('consultas').limit(1000),
    db.collection('velas_predicciones').limit(1000)
  ];

  const metrics = {};
  let total = 0;
  let matched = 0;

  for (const query of sources) {
    const snapshot = await query.get();
    snapshot.forEach(doc => {
      const data = doc.data();
      const { precioReal, precioEstimado, baseline, symbol } = resolveFields(data);
      if (precioReal === null || precioEstimado === null || baseline === null || precioReal === 0) return;

      const errorPct = Math.abs(precioEstimado - precioReal) / Math.abs(precioReal);
      const directionReal = direction(precioReal, baseline);
      const directionPred = direction(precioEstimado, baseline);

      total += 1;
      if (directionReal && directionPred && directionReal === directionPred) {
        matched += 1;
      }

      if (!metrics[symbol]) {
        metrics[symbol] = { count: 0, match: 0, errorSum: 0 };
      }
      metrics[symbol].count += 1;
      metrics[symbol].errorSum += errorPct;
      if (directionReal && directionPred && directionReal === directionPred) {
        metrics[symbol].match += 1;
      }
    });
  }

  const summary = {
    totalCount: total,
    totalAccuracy: total ? Number(((matched / total) * 100).toFixed(2)) : 0,
    symbolMetrics: Object.entries(metrics).map(([symbol, data]) => ({
      symbol,
      accuracy: data.count ? Number(((data.match / data.count) * 100).toFixed(2)) : 0,
      avgError: data.count ? Number((data.errorSum / data.count).toFixed(4)) : 0,
      count: data.count
    }))
  };

  await db.collection('validaciones').doc('summary').set({
    updatedAt: FieldValue.serverTimestamp(),
    ...summary
  });

  return summary;
}

module.exports = ejecutarReevaluacion;
