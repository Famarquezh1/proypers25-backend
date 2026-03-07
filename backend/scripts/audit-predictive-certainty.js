/**
 * Audit script para estimar certeza real del predictor de velas.
 * Solo lee Firestore (sin escrituras). Ejecutar con GOOGLE_APPLICATION_CREDENTIALS.
 */

const { Firestore } = require('@google-cloud/firestore');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const advancedFormat = require('dayjs/plugin/advancedFormat');
const isoWeek = require('dayjs/plugin/isoWeek');

dayjs.extend(utc);
dayjs.extend(advancedFormat);
dayjs.extend(isoWeek);

const firestore = new Firestore();

const confidenceBuckets = [
  { label: '90%+', min: 0.9 },
  { label: '80-89%', min: 0.8 },
  { label: '70-79%', min: 0.7 },
  { label: '60-69%', min: 0.6 }
];

const symbolsToTrack = [
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

// Helper
const safeNum = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

const formatPct = (value) => `${value.toFixed(2)}%`;
const rate = (numerator, denominator) => (denominator ? (numerator / denominator) * 100 : 0);

const outcomeKey = (row) => {
  const result = (row.verificationOutcome || row.verification?.result || row.resultado || '').toString().toUpperCase();
  if (['WIN', 'W', 'GANADOR'].includes(result)) return 'WIN';
  if (['LOSS', 'L', 'PERDIDA'].includes(result)) return 'LOSS';
  if (['LUCKY_WIN', 'LUCKY', 'LUCKY WIN'].includes(result)) return 'LUCKY_WIN';
  if (['EXPIRED', 'EXPIRADA', 'NOEXECUTE'].includes(result)) return 'EXPIRED';
  return 'UNKNOWN';
};

function bucketLabel(value) {
  for (const bucket of confidenceBuckets) {
    if (value >= bucket.min) return bucket.label;
  }
  return '<60%';
}

function bucketLabelRange(value) {
  if (value >= 0.9) return '90%+';
  if (value >= 0.8) return '80-89%';
  if (value >= 0.7) return '70-79%';
  return '<70%';
}

async function loadPredictions() {
  const cutoffDate = dayjs.utc().subtract(60, 'day').toDate();
  const cutoffIso = dayjs.utc().subtract(60, 'day').toISOString();
  const byId = new Map();

  try {
    const snapshotByTimestamp = await firestore
      .collection('velas_predicciones')
      .where('timestamp', '>=', cutoffIso)
      .get();
    snapshotByTimestamp.docs.forEach((doc) => byId.set(doc.id, doc));
  } catch (err) {
    console.warn('[audit] timestamp query failed:', err.message);
  }

  try {
    const snapshotByCreatedAt = await firestore
      .collection('velas_predicciones')
      .where('created_at', '>=', cutoffDate)
      .get();
    snapshotByCreatedAt.docs.forEach((doc) => byId.set(doc.id, doc));
  } catch (err) {
    console.warn('[audit] created_at query failed:', err.message);
  }

  return Array.from(byId.values()).map((doc) => {
    const data = doc.data();
    const verificationResult =
      data.verification_outcome ||
      data.verification?.result ||
      data.verification?.outcome_label ||
      data.verification?.outcomeLabel ||
      (data.resultado || data.verification?.outcome)?.resultado ||
      null;
    return {
      id: doc.id,
      symbol: (data.simbolo || data.simbolo_normalizado || 'UNKNOWN').toUpperCase(),
      mode: (data.execution_mode || data.mode || 'timeframe').toLowerCase(),
      timeframe: data.timeframe || 'unknown',
      signalEmitted: Boolean(data.signal_emitted),
      suppressionReason: data.suppression_reason || null,
      confidence: safeNum(data.confianza ?? data.confidence ?? 0),
      confidenceBefore: safeNum(data.confidence_before ?? data.confianza ?? data.confidence ?? 0),
      confidenceAfter: safeNum(data.confidence_after ?? data.confianza ?? data.confidence ?? 0),
      quantumScore: safeNum(data.quantum_score ?? 0),
      timingScore: safeNum(data.timing_score ?? 0),
      createdAt: data.created_at ? dayjs.utc(data.created_at) : dayjs.utc(),
      verificationOutcome: verificationResult ? verificationResult.toUpperCase() : null,
      verification: {
        result: verificationResult ? verificationResult.toUpperCase() : null
      }
    };
  });
}

async function loadFeatureProbabilities() {
  const snapshot = await firestore.collection('velas_probabilities').get();
  return snapshot.docs.map((doc) => {
    const data = doc.data() || {};
    return {
      symbol: (data.symbol || data.simbolo || 'UNKNOWN').toUpperCase(),
      timeframe: data.timeframe || 'unknown',
      mode: data.mode || 'feature_model_v1',
      signal: (data.signal || 'neutral').toLowerCase(),
      confidence: safeNum(data.confidence ?? 0)
    };
  });
}

function summaryCounts(list) {
  const total = list.length;
  const counts = list.reduce((acc, row) => {
    const key = outcomeKey(row);
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
  return { total, counts };
}

function printRates(label, list) {
  const { total, counts } = summaryCounts(list);
  const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
  const strictWin = counts.WIN || 0;
  const loss = counts.LOSS || 0;
  const expired = counts.EXPIRED || 0;
  console.table({
    label,
    total,
    win_rate: formatPct(rate(winPlusLucky, total)),
    strict_win_rate: formatPct(rate(strictWin, total)),
    loss_rate: formatPct(rate(loss, total)),
    expired_rate: formatPct(rate(expired, total))
  });
}

function bucketWinRates(list, valueAccessor) {
  const buckets = {};
  list.forEach((row) => {
    const value = valueAccessor(row);
    const label = bucketLabelRange(value);
    if (!buckets[label]) buckets[label] = [];
    buckets[label].push(row);
  });
  return Object.entries(buckets).map(([label, records]) => {
    const { total, counts } = summaryCounts(records);
    const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
    return {
      bucket: label,
      n: total,
      win_rate: formatPct(rate(winPlusLucky, total))
    };
  });
}

async function run() {
  const cutoff = dayjs.utc().subtract(60, 'day');
  console.log('🧮 Audit predictivo de velas (solo lectura)');
  console.log(`Audit window: ${cutoff.format('YYYY-MM-DD')} -> ${dayjs.utc().format('YYYY-MM-DD')}`);
  const allPreds = await loadPredictions();

  const totalPredictions = allPreds.length;
  const emitted = allPreds.filter((p) => p.signalEmitted);
  const suppressed = allPreds.filter((p) => p.suppressionReason);
  const verified = allPreds.filter((p) => outcomeKey(p) !== 'UNKNOWN' && !p.suppressionReason);

  console.log('\n1️⃣ Performance global');
  console.table({
    total_predictions: totalPredictions,
    total_emitted: emitted.length,
    total_suppressed: suppressed.length,
    total_verified: verified.length
  });
  printRates('Global verified', verified);

  console.log('\n2️⃣ Performance por modo');
  const perModeSummary = {};
  ['timeframe', 'event_driven'].forEach((mode) => {
    const subset = verified.filter((p) => p.mode === mode);
    if (!subset.length) return;
    printRates(`Mode ${mode}`, subset);
    const avgConfidence = subset.reduce((sum, p) => sum + p.confidence, 0) / subset.length;
    const avgQuantum = subset.reduce((sum, p) => sum + p.quantumScore, 0) / subset.length;
    const avgTiming = subset.reduce((sum, p) => sum + p.timingScore, 0) / subset.length;
    console.log(`Mode ${mode} averages -> confidence: ${formatPct(avgConfidence * 100)}, quantum_score: ${formatPct(avgQuantum * 100)}, timing_score: ${formatPct(avgTiming * 100)}`);
    const { total, counts } = summaryCounts(subset);
    perModeSummary[mode] = {
      total,
      win_rate: rate((counts.WIN || 0) + (counts.LUCKY_WIN || 0), total),
      strict_win_rate: rate(counts.WIN || 0, total),
      loss_rate: rate(counts.LOSS || 0, total),
      expired_rate: rate(counts.EXPIRED || 0, total),
      avg_confidence: avgConfidence,
      avg_quantum_score: avgQuantum,
      avg_timing_score: avgTiming
    };
  });

  console.log('\n3️⃣ Performance por símbolo (criptos entrenados)');
  const perSymbolSummary = {};
  for (const symbol of symbolsToTrack) {
    const subset = allPreds.filter((p) => p.symbol === symbol);
    if (!subset.length) continue;
    const suppressedSubset = subset.filter((p) => p.suppressionReason);
    const verifiedSubset = subset.filter((p) => outcomeKey(p) !== 'UNKNOWN');
    const { total, counts } = summaryCounts(verifiedSubset);
    if (!total) continue;
    const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
    console.table({
      symbol,
      total_predictions: subset.length,
      win_rate: formatPct(rate(winPlusLucky, total)),
      loss_rate: formatPct(rate(counts.LOSS || 0, total)),
      suppression_rate: formatPct((suppressedSubset.length / subset.length) * 100)
    });
    perSymbolSummary[symbol] = {
      total_predictions: subset.length,
      win_rate: rate(winPlusLucky, total),
      loss_rate: rate(counts.LOSS || 0, total),
      suppression_rate: subset.length ? (suppressedSubset.length / subset.length) * 100 : 0
    };
  }

  console.log('\n4️⃣ Confianza vs reality');
  const bucketed = {};
  for (const pred of verified) {
    const key = bucketLabel(pred.confidence);
    bucketed[key] = bucketed[key] || [];
    bucketed[key].push(pred);
  }
  Object.entries(bucketed).forEach(([label, records]) => {
    const { total, counts } = summaryCounts(records);
    const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
    console.log(`${label} (n=${total}) -> win_rate: ${formatPct(rate(winPlusLucky, total))}`);
  });

  console.log('\n4.1 Confidence reweighting impact (bucket win_rate)');
  const beforeBuckets = bucketWinRates(verified, (row) => row.confidenceBefore);
  const afterBuckets = bucketWinRates(verified, (row) => row.confidenceAfter);
  console.log('confidence_before buckets:');
  console.table(beforeBuckets);
  console.log('confidence_after buckets:');
  console.table(afterBuckets);

  console.log('Quantum_score thresholds:');
  for (const bucket of confidenceBuckets) {
    const label = bucket.label;
    const subset = verified.filter((p) => p.quantumScore >= bucket.min);
    if (!subset.length) continue;
    const { total, counts } = summaryCounts(subset);
    const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
    console.log(`${label} → win rate ${formatPct(rate(winPlusLucky, total))}`);
  }

  console.log('\n5️⃣ Calidad del quality gate');
  const suppressedRate = totalPredictions ? (suppressed.length / totalPredictions) * 100 : 0;
  console.table({
    total_suppressed: suppressed.length,
    percent_suppressed: formatPct(suppressedRate)
  });
  const suppressedVerified = suppressed.filter((p) => outcomeKey(p) !== 'UNKNOWN');
  const optCounts = summaryCounts(suppressedVerified);
  console.log('Suppressed summary (cuando hubo verificación):', optCounts.counts);
  if (suppressedVerified.length) {
    const { total, counts } = summaryCounts(suppressedVerified);
    const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
    const hypotheticalRate = rate(winPlusLucky, total);
    console.log(`Los suprimidos verificados tendrían win_rate ${formatPct(hypotheticalRate)} si se hubiesen ejecutado.`);
  }
  console.log('\n6️⃣ Estabilidad temporal (semanal)');
  const weeklyGroups = {};
  verified.forEach((pred) => {
    const weekLabel = pred.createdAt.startOf('week').format('YYYY-[W]WW');
    if (!weeklyGroups[weekLabel]) weeklyGroups[weekLabel] = [];
    weeklyGroups[weekLabel].push(pred);
  });
  Object.entries(weeklyGroups)
    .sort()
    .forEach(([week, records]) => {
      const { total, counts } = summaryCounts(records);
      const winPlusLucky = (counts.WIN || 0) + (counts.LUCKY_WIN || 0);
      console.log(`${week} -> win_rate ${formatPct(rate(winPlusLucky, total))}`);
    });

  console.log('\n7) Feature Velas Model snapshot (velas_probabilities)');
  const featureRows = await loadFeatureProbabilities();
  if (!featureRows.length) {
    console.log('No hay registros en velas_probabilities.');
  } else {
    const grouped = {};
    featureRows.forEach((row) => {
      const key = `${row.symbol} ${row.timeframe} ${row.mode}`;
      if (!grouped[key]) {
        grouped[key] = {
          symbol: row.symbol,
          timeframe: row.timeframe,
          mode: row.mode,
          total: 0,
          up: 0,
          down: 0,
          neutral: 0,
          confidenceSum: 0
        };
      }
      grouped[key].total += 1;
      grouped[key].confidenceSum += row.confidence;
      if (row.signal === 'up') grouped[key].up += 1;
      else if (row.signal === 'down') grouped[key].down += 1;
      else grouped[key].neutral += 1;
    });

    Object.values(grouped).forEach((group) => {
      const avgConfidence = group.total ? group.confidenceSum / group.total : 0;
      const upRate = rate(group.up, group.total);
      const downRate = rate(group.down, group.total);
      const neutralRate = rate(group.neutral, group.total);
      console.log(
        `- ${group.symbol} ${group.timeframe}: n=${group.total}, up=${formatPct(upRate)}, down=${formatPct(
          downRate
        )}, neutral=${formatPct(neutralRate)}, avg_confidence=${formatPct(avgConfidence * 100)}`
      );
    });
  }

  const globalCounts = summaryCounts(verified);
  const globalWinRate = rate((globalCounts.counts.WIN || 0) + (globalCounts.counts.LUCKY_WIN || 0), verified.length);
  const certainty =
    globalWinRate >= 75
      ? 'High-confidence predictive system (>75%)'
      : globalWinRate >= 65
      ? 'Strong probabilistic edge (65–75%)'
      : globalWinRate >= 55
      ? 'Moderate predictive edge (55–65%)'
      : 'Low predictive certainty (<55%)';

  console.log('\n🎯 Resumen final:');
  console.log(`La certeza real estimada está alrededor de ${globalWinRate.toFixed(2)}% → ${certainty}`);

  return {
    totals: {
      total_predictions: totalPredictions,
      total_emitted: emitted.length,
      total_suppressed: suppressed.length,
      total_verified: verified.length
    },
    global: {
      win_rate: globalWinRate,
      strict_win_rate: rate(globalCounts.counts.WIN || 0, verified.length),
      loss_rate: rate(globalCounts.counts.LOSS || 0, verified.length),
      expired_rate: rate(globalCounts.counts.EXPIRED || 0, verified.length)
    },
    per_mode: perModeSummary,
    per_symbol: perSymbolSummary,
    classification: certainty
  };
}

if (require.main === module) {
  run().catch((err) => {
    console.error('❌ Error en auditoría:', err);
    process.exit(1);
  });
}

module.exports = { run };
