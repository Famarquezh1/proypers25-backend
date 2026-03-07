/**
 * learnFromCandleOutcomes.js
 * ----------------------------------------
 * Aprendizaje offline de predicciones de velas.
 * Lee resultados verificados y genera configs
 * de calibración ANALYSIS_ONLY.
 */

const admin = require('firebase-admin');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.applicationDefault(),
  });
}

const db = admin.firestore();

const SOURCE_COLLECTION = 'velas_predicciones';
const TARGET_COLLECTION = 'velas_learning_config';

function safeNumber(v) {
  return typeof v === 'number' && !isNaN(v) ? v : null;
}

function avg(arr) {
  if (!arr.length) return null;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

async function getNextVersion() {
  const snap = await db
    .collection(TARGET_COLLECTION)
    .orderBy('version', 'desc')
    .limit(1)
    .get();

  if (snap.empty) return 1;
  return (snap.docs[0].data().version || 0) + 1;
}

async function run() {
  console.log('🧠 Learning from candle outcomes (offline)');
  console.log('------------------------------------------');

  const snap = await db
    .collection(SOURCE_COLLECTION)
    .where('verification_outcome', 'in', ['WIN', 'LOSS', 'EXPIRED', 'LUCKY_WIN'])
    .get();

  if (snap.empty) {
    console.log('⚠️ No hay predicciones verificadas.');
    return { saved: 0, version: null, total_groups: 0 };
  }

  const groups = new Map();

  snap.docs.forEach(doc => {
    const p = doc.data();

    if (p.suppression_reason) return;

    const key = [
      p.symbol || 'UNKNOWN',
      p.execution_mode || 'timeframe',
      p.timeframe || 'NA'
    ].join('|');

    if (!groups.has(key)) {
      groups.set(key, {
        symbol: p.symbol || 'UNKNOWN',
        execution_mode: p.execution_mode || 'timeframe',
        timeframe: p.timeframe || null,
        results: [],
        confidence: [],
        quantum: [],
        timing: [],
      });
    }

    const g = groups.get(key);

    g.results.push(p.verification_outcome);
    if (safeNumber(p.confianza) !== null) g.confidence.push(p.confianza);
    if (safeNumber(p.quantum_score) !== null) g.quantum.push(p.quantum_score);
    if (safeNumber(p.timing_score) !== null) g.timing.push(p.timing_score);
  });

  const version = await getNextVersion();
  let saved = 0;

  for (const g of groups.values()) {
    const total = g.results.length;
    if (total < 3) continue; // muestra mínima

    const wins = g.results.filter(r => r === 'WIN' || r === 'LUCKY_WIN').length;
    const losses = g.results.filter(r => r === 'LOSS').length;
    const expired = g.results.filter(r => r === 'EXPIRED').length;

    const doc = {
      version,
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      scope: {
        symbol: g.symbol,
        execution_mode: g.execution_mode,
        timeframe: g.timeframe,
      },
      metrics: {
        sample_size: total,
        wins,
        losses,
        expired,
        win_rate: wins / total,
        loss_rate: losses / total,
        expired_rate: expired / total,
        avg_confidence: avg(g.confidence),
        avg_quantum_score: avg(g.quantum),
        avg_timing_score: avg(g.timing),
      },
      status: 'analysis_only',
      note: 'Offline learning – no behavioral changes applied',
    };

    await db.collection(TARGET_COLLECTION).add(doc);
    saved++;

    console.table({
      symbol: g.symbol,
      mode: g.execution_mode,
      timeframe: g.timeframe,
      sample: total,
      win_rate: `${(doc.metrics.win_rate * 100).toFixed(2)}%`,
    });
  }

  console.log(`✅ Learning configs guardadas: ${saved}`);
  console.log(`📦 Versión generada: v${version}`);
  return { saved, version, total_groups: Object.keys(groups).length };
}

if (require.main === module) {
  run().catch(err => {
    console.error('❌ Error en learning job:', err);
    process.exit(1);
  });
}

module.exports = { run };
