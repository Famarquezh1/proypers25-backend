const express = require('express');
const router = express.Router();
const entrenarVelas = require('../scripts/entrenamientoVelas');
const prediccionVelas = require('../scripts/prediccionVelas');
const verificarPrediccionVelas = require('../scripts/verificacionVelas');
const { fetchBinanceSpot } = require('../services/dataSources/binance');
const { executeSignalTrade, getMarkPrice, toBinanceSymbol } = require('../lib/binanceFuturesExecutor');
const db = require('../firebase-admin-config');
const FieldValue = require('firebase-admin').firestore.FieldValue;

const SIMBOLOS_VELAS = [
  'BTC-USD',
  'ETH-USD',
  'DOGE-USD',
  'HBAR-USD',
  'SOL-USD',
  'ADA-USD',
  'XRP-USD',
  'BNB-USD',
  'AVAX-USD',
  'LINK-USD',
  'MATIC-USD',
  'DOT-USD',
  'LTC-USD',
  'BCH-USD',
  'TRX-USD',
  'SHIB-USD',
  'TON-USD',
  'NEAR-USD',
  'ATOM-USD',
  'ICP-USD',
  'XLM-USD',
  'OP-USD',
  'ARB-USD',
  'INJ-USD',
  'APT-USD'
];
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];

const handleError = (res, err, message = 'Error interno') => {
  console.error(message, err);
  res.status(500).json({ error: message });
};

const CRON_SECRET = process.env.CRON_SECRET || '';

function requireCronSecret(req, res) {
  if (!CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET no configurado en backend.' });
    return false;
  }
  const incoming = req.get('x-cron-secret') || '';
  if (incoming !== CRON_SECRET) {
    res.status(401).json({ error: 'No autorizado. x-cron-secret inválido.' });
    return false;
  }
  return true;
}

router.get('/disponibles', (_req, res) => {
  res.json({
    symbols: SIMBOLOS_VELAS,
    timeframes: TIMEFRAMES
  });
});

router.post('/entrenar/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!symbol) {
    return res.status(400).json({ error: 'Debe indicar un símbolo para entrenar.' });
  }

  try {
    await entrenarVelas(symbol);
    res.json({ message: `Entrenamiento iniciado para ${symbol}` });
  } catch (err) {
    handleError(res, err, `Error al entrenar ${symbol}`);
  }
});

router.post('/entrenar-multiple', async (_req, res) => {
  try {
    const sessionRef = await db.collection('velas_entrenamientos').add({
      type: 'entrenamiento-multiple',
      symbols: SIMBOLOS_VELAS,
      created_at: new Date().toISOString(),
      status: 'en-cola',
      total_symbols: SIMBOLOS_VELAS.length,
      completed_count: 0,
      estimated_duration_minutes: 1
    });

    for (const symbol of SIMBOLOS_VELAS) {
      try {
        const registered = await entrenarVelas(symbol);
        const detailRef = sessionRef.collection('detalle');
        await detailRef.add({
          simbolo: symbol,
          status: 'entrenado',
          registrado_id: registered.id,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Error entrenando símbolo', symbol, err.message);
        const detailRef = sessionRef.collection('detalle');
        await detailRef.add({
          simbolo: symbol,
          status: 'error',
          timestamp: new Date().toISOString(),
          error: err.message
        });
      }

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(sessionRef);
        const completed = (snap.get('completed_count') || 0) + 1;
        tx.update(sessionRef, {
          completed_count: completed,
          status: completed >= SIMBOLOS_VELAS.length ? 'completado' : 'en-progreso'
        });
      });
    }

    res.json({ message: 'Entrenamiento masivo iniciado', sessionId: sessionRef.id });
  } catch (err) {
    handleError(res, err, 'Error al entrenar múltiples símbolos');
  }
});

router.get('/historial/entrenamientos', async (_req, res) => {
  try {
    const snapshot = await db.collection('velas_entrenamientos')
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();

    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err) {
    handleError(res, err, 'Error al obtener historial de entrenamientos');
  }
});

router.get('/entrenamientos/pendientes', async (_req, res) => {
  try {
    const doc = await db.collection('entrenamientos_pendientes')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (doc.empty) {
      return res.json(null);
    }

    const snapshot = doc.docs[0];
    const data = snapshot.data();
    res.json({
      id: snapshot.id,
      ...data
    });
  } catch (err) {
    handleError(res, err, 'Error al obtener entrenamiento pendiente');
  }
});

router.post('/prediccion', async (req, res) => {
  const { symbol, timeframe = '5m', monto = 1000, execution_mode } = req.body;
  if (!symbol) {
    return res.status(400).json({ error: 'El campo symbol es obligatorio.' });
  }

    try {
      const prediction = await prediccionVelas({ symbol, timeframe, monto, execution_mode });
    res.json(prediction);
  } catch (err) {
    handleError(res, err, 'Error al generar predicción de velas');
  }
});

// Test manual controlado para validar conexión/permiso real con Binance Futures sin esperar HC.
// Requiere x-cron-secret y ejecuta 1 intento con payload sintético.
router.post('/binance/test-order', async (req, res) => {
  if (!requireCronSecret(req, res)) return;

  const {
    symbol = 'ETH-USD',
    direction = 'up',
    source_profile = 'manual_prealert'
  } = req.body || {};

  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction debe ser up o down.' });
  }

  try {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    let spotPrice = 0;
    try {
      const fetchedSpot = await fetchBinanceSpot(normalizedSymbol);
      spotPrice = Number(fetchedSpot?.price || 0);
    } catch (_) {
      spotPrice = 0;
    }
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      const futuresSymbol = toBinanceSymbol(normalizedSymbol);
      if (futuresSymbol) {
        spotPrice = Number(await getMarkPrice(futuresSymbol));
      }
    }
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      return res.status(400).json({ error: 'No se pudo obtener spot válido para test.' });
    }

    const deltaPct = 0.6;
    const rr = 1.67;
    const riskPct = Number((deltaPct / rr).toFixed(4));
    const tpPrice = direction === 'up'
      ? Number((spotPrice * (1 + deltaPct / 100)).toFixed(8))
      : Number((spotPrice * (1 - deltaPct / 100)).toFixed(8));
    const slPrice = direction === 'up'
      ? Number((spotPrice * (1 - riskPct / 100)).toFixed(8))
      : Number((spotPrice * (1 + riskPct / 100)).toFixed(8));

    const testSignal = {
      id: `manual-test-${Date.now()}`,
      prediction_id: `manual-test-${Date.now()}`,
      symbol: normalizedSymbol,
      direction,
      confidence: 0.99,
      quantum_score: 0.99,
      timing_score: 0.99,
      context_score: 4,
      expected_move_percent: deltaPct,
      spot_price: spotPrice,
      trade_plan: {
        entry_price: spotPrice,
        stop_loss: slPrice,
        take_profit: tpPrice,
        target_exit_price: tpPrice,
        risk_reward_ratio: rr
      },
      estimated_window: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 60 * 1000).toISOString()
      },
      timestamp: new Date().toISOString()
    };

    const result = await executeSignalTrade(db, testSignal, {
      source: 'manual_test',
      source_profile
    });

    return res.status(200).json({
      ok: true,
      mode: 'binance_test_order',
      symbol: normalizedSymbol,
      source_profile,
      result
    });
  } catch (err) {
    console.error('[BINANCE_TEST_ORDER] error', err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'binance_test_order_failed'
    });
  }
});

router.get('/predicciones', async (req, res) => {
  try {
    let queryRef = db.collection('velas_predicciones').orderBy('timestamp', 'desc').limit(50);
    if (req.query.symbol) {
      queryRef = queryRef.where('simbolo', '==', req.query.symbol);
    }
    const snapshot = await queryRef.get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err) {
    handleError(res, err, 'Error al obtener predicciones');
  }
});

router.get('/historial', async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const symbol = (req.query.symbol || '').toString().toUpperCase();
    const status = (req.query.status || '').toString();
    const from = req.query.from ? req.query.from.toString() : null;
    const to = req.query.to ? req.query.to.toString() : null;
    const startAfter = req.query.startAfter ? req.query.startAfter.toString() : null;

    let queryRef = db.collection('velas_predicciones').orderBy('timestamp', 'desc');

    if (symbol) {
      queryRef = queryRef.where('simbolo', '==', symbol);
    }
    if (status) {
      queryRef = queryRef.where('status', '==', status);
    }
    if (from) {
      queryRef = queryRef.where('timestamp', '>=', from);
    }
    if (to) {
      queryRef = queryRef.where('timestamp', '<=', to);
    }
    if (startAfter) {
      queryRef = queryRef.startAfter(startAfter);
    }
    if (Number.isFinite(rawLimit) && rawLimit > 0) {
      queryRef = queryRef.limit(rawLimit);
    }

    const snapshot = await queryRef.get();
    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err) {
    handleError(res, err, 'Error al obtener historial de velas');
  }
});

router.post('/verificar/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Se requiere el ID de la predicción.' });
  }

  try {
    const result = await verificarPrediccionVelas(id);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Error al verificar predicción');
  }
});

module.exports = router;
