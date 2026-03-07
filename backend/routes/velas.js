const express = require('express');
const router = express.Router();
const entrenarVelas = require('../scripts/entrenamientoVelas');
const prediccionVelas = require('../scripts/prediccionVelas');
const verificarPrediccionVelas = require('../scripts/verificacionVelas');
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
