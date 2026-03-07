const db = require('../firebase-admin-config');
const dayjs = require('dayjs');

const outcomeOf = (data) => {
  const raw =
    data.verification?.outcome_label ||
    data.verification?.outcomeLabel ||
    data.verification?.result ||
    data.resultado ||
    data.verification?.outcome?.resultado ||
    null;
  return raw ? raw.toString().toUpperCase() : null;
};

const normalizeKey = (symbol, mode, timeframe) => {
  const sym = (symbol || 'GLOBAL').toUpperCase();
  return `${sym}|${mode || 'timeframe'}|${timeframe || 'any'}`;
};

const ensureGroup = (map, key) => {
  if (!map.has(key)) {
    map.set(key, {
      symbol: null,
      mode: null,
      timeframe: null,
      counts: { WIN: 0, LOSS: 0, LUCKY_WIN: 0, EXPIRED: 0 },
      confidenceSum: 0,
      quantumSum: 0,
      timingSum: 0,
      samples: 0,
      suppressed: 0
    });
  }
  return map.get(key);
};

const computeMetrics = (group) => {
  const { counts, samples, confidenceSum, quantumSum, timingSum, suppressed } = group;
  const total = samples;
  const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
  const loss = counts.LOSS || 0;
  const expired = counts.EXPIRED || 0;
  return {
    win_rate: total ? (winPlusLucky / total) * 100 : 0,
    strict_win_rate: total ? (counts.WIN / total) * 100 : 0,
    loss_rate: total ? (loss / total) * 100 : 0,
    lucky_win_rate: total ? ((counts.LUCKY_WIN || 0) / total) * 100 : 0,
    expired_rate: total ? (expired / total) * 100 : 0,
    avg_confidence: total ? confidenceSum / total : 0,
    avg_quantum_score: total ? quantumSum / total : 0,
    avg_timing_score: total ? timingSum / total : 0,
    suppression_rate: total + suppressed ? (suppressed / (total + suppressed)) * 100 : 0,
    total_samples: total
  };
};

const gatherGroups = (predictions) => {
  const groups = new Map();
  const suppressedGroups = new Map();
  for (const doc of predictions) {
    const data = doc.data();
    const symbol = data.simbolo || data.simbolo_normalizado || 'GLOBAL';
    const mode = data.execution_mode || data.mode || 'timeframe';
    const timeframe = data.timeframe || 'any';
    const key = normalizeKey(symbol, mode, timeframe);
    const group = ensureGroup(groups, key);
    group.symbol = symbol.toUpperCase();
    group.mode = mode;
    group.timeframe = timeframe;

    if (data.suppression_reason || data.signal_emitted === false || data.status === 'suprimida') {
      const supGroup = ensureGroup(suppressedGroups, key);
      supGroup.suppressed += 1;
      continue;
    }

    const outcome = outcomeOf(data);
    if (!outcome) {
      continue;
    }

    group.samples += 1;
    group.confidenceSum += Number(data.confianza ?? data.confidence ?? 0);
    group.quantumSum += Number(data.quantum_score ?? 0);
    group.timingSum += Number(data.timing_score ?? 0);
    if (typeof group.counts[outcome] === 'number') {
      group.counts[outcome] += 1;
    } else {
      group.counts[outcome] = (group.counts[outcome] || 0) + 1;
    }
  }

  for (const [key, value] of suppressedGroups.entries()) {
    const g = ensureGroup(groups, key);
    g.suppressed += value.suppressed;
  }

  return [...groups.values()].filter((group) => group.samples > 0);
};

const persistMetrics = async (entries) => {
  const indexSnapshot = await db
    .collection('velas_learning_config')
    .orderBy('version', 'desc')
    .limit(1)
    .get();
  const lastVersion = indexSnapshot.empty ? 0 : indexSnapshot.docs[0].data().version || 0;
  const batch = db.batch();
  entries.forEach((entry, idx) => {
    const metrics = computeMetrics(entry);
    const docRef = db.collection('velas_learning_config').doc();
    batch.set(docRef, {
      version: lastVersion + idx + 1,
      created_at: new Date().toISOString(),
      scope: {
        symbol: entry.symbol,
        mode: entry.mode,
        timeframe: entry.timeframe
      },
      metrics,
      status: 'analysis_only',
      notes: 'No behavioral changes applied'
    });
  });
  await batch.commit();
  return lastVersion + entries.length;
};

const run = async () => {
  const snapshot = await db.collection('velas_predicciones').get();
  if (snapshot.empty) {
    console.log('No hay predicciones en Firestore.');
    return;
  }
  const entries = gatherGroups(snapshot.docs);
  if (!entries.length) {
    console.log('No se encontraron predicciones verificadas.');
    return;
  }

  entries.forEach((entry) => {
    const metrics = computeMetrics(entry);
    console.log(`Grupo ${entry.symbol} | ${entry.mode} | ${entry.timeframe}`);
    console.table(metrics);
  });

  const finalVersion = await persistMetrics(entries);
  console.log(`Se guardaron ${entries.length} configuraciones de aprendizaje (versión hasta ${finalVersion}).`);
};

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('El job falló:', err);
      process.exit(1);
    });
}

module.exports = run;
