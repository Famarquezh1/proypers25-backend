const express = require('express');
const router = express.Router();
const db = require('../firebase-admin-config');
const ejecutarReevaluacion = require('../scripts/reevaluar_validacion');
const generarBacktest = require('../scripts/backtest');
const revalidarHistorico = require('../scripts/revalidarHistorico');

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

router.get('/accuracy', async (req, res) => {
  try {
    const snapshot = await db.collection('consultas').get();
    const stats = {};
    let total = 0;
    let matches = 0;
    let totalError = 0;

    snapshot.forEach(doc => {
      const data = doc.data();
      const resultado = typeof data.resultado === 'object' && data.resultado !== null ? data.resultado : {};
      const validacion = data.validacion || resultado.validacion || {};
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
      const metodo = resultado.metodo || resultado.tipo || data.tipo || data.metodo || 'general';

      if (precioReal === null || precioEstimado === null || baseline === null || precioReal === 0) {
        return;
      }

      total += 1;
      const errorPct = Math.abs(precioEstimado - precioReal) / Math.abs(precioReal);
      totalError += errorPct;

      const directionReal = direction(precioReal, baseline);
      const directionPred = direction(precioEstimado, baseline);
      if (directionReal === directionPred) {
        matches += 1;
      }

      if (!stats[metodo]) {
        stats[metodo] = { count: 0, errorSum: 0, matchCount: 0 };
      }
      stats[metodo].count += 1;
      stats[metodo].errorSum += errorPct;
      if (directionReal === directionPred) {
        stats[metodo].matchCount += 1;
      }
    });

    const methods = Object.entries(stats).map(([method, value]) => ({
      method,
      accuracy: value.count ? Number(((value.matchCount / value.count) * 100).toFixed(2)) : 0,
      avgError: value.count ? Number((value.errorSum / value.count).toFixed(4)) : 0,
      count: value.count
    }));

    res.json({
      total,
      accuracy: total ? Number(((matches / total) * 100).toFixed(2)) : 0,
      avgError: total ? Number((totalError / total).toFixed(4)) : 0,
      methods
    });
  } catch (error) {
    console.error('Error al calcular precision:', error);
    res.status(500).json({ error: 'No se pudo calcular precision' });
  }
});

router.post('/metrics/recompute', async (req, res) => {
  try {
    const summary = await ejecutarReevaluacion();
    res.json({ summary });
  } catch (error) {
    console.error('Error al recalcular metricas:', error);
    res.status(500).json({ error: 'No se pudo recalcular metricas' });
  }
});

router.post('/recompute-historico', async (req, res) => {
  try {
    const { limit, force } = req.body || {};
    const processed = await revalidarHistorico({ limit, force });
    res.json(processed);
  } catch (error) {
    console.error('Error al revalidar historico:', error);
    res.status(500).json({ error: 'No se pudo revalidar historico' });
  }
});

router.get('/metrics', async (req, res) => {
  try {
    const doc = await db.collection('validaciones').doc('summary').get();
    if (!doc.exists) {
      return res.json({
        totalCount: 0,
        totalAccuracy: 0,
        symbolMetrics: [],
        updatedAt: null
      });
    }
    res.json(doc.data());
  } catch (error) {
    console.error('Error al leer metricas:', error);
    res.status(500).json({ error: 'No se pudieron obtener metricas' });
  }
});

router.get('/backtest', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 100;
    const minCount = parseInt(req.query.minCount, 10) || undefined;
    const data = await generarBacktest({ limit, minCount });
    res.json(data);
  } catch (error) {
    console.error('Error al generar backtest:', error);
    res.status(500).json({ error: 'No se pudo generar el backtest' });
  }
});

module.exports = router;
