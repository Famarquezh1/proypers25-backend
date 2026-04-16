/**
 * Quality Gate Diagnostic - Compare Historical Performance vs Current Thresholds
 *
 * Purpose:
 * - Analyze historical predictions to understand signal distribution
 * - Compare with current quality gate thresholds
 * - Determine if gate is too strict or model is weak
 *
 * Analysis includes:
 * - Distribution analysis (avg, percentiles)
 * - Gate pass rate calculation
 * - Winner profile analysis
 * - Recommendations
 */

const db = require('../firebase-admin-config');

// Current quality gate thresholds (from code)
const CURRENT_THRESHOLDS = {
  confidence: 85,
  quantum: 90,
  timing: 70
};

async function fetchHistoricalPredictions(limit = 500) {
  console.log('[DIAGNOSTIC] Fetching historical predictions from Firestore...');

  try {
    const snapshot = await db.collection('velas_predicciones')
      .orderBy('created_at', 'desc')
      .limit(limit)
      .get();

    const predictions = [];

    snapshot.forEach(doc => {
      const data = doc.data();
      predictions.push({
        id: doc.id,
        symbol: data.simbolo || data.symbol || 'unknown',
        timeframe: data.timeframe || '5m',
        confidence: Number(data.confidence || data.confianza || 0),
        quantum: Number(data.quantum_score || data.quantum || 0),
        timing: Number(data.timing_score || data.timing || 0),
        stability: Number(data.stability || 0),
        signal_emitted: Boolean(data.signal_emitted),
        suppression_reason: data.suppression_reason || null,
        status: data.status || 'unknown',
        created_at: data.created_at,
        outcome: data.outcome || null // win, loss, suppressed, pending
      });
    });

    console.log(`[DIAGNOSTIC] Retrieved ${predictions.length} historical predictions`);
    return predictions;
  } catch (error) {
    console.error('[DIAGNOSTIC_ERROR] Failed to fetch predictions:', error.message);
    throw error;
  }
}

function calculateDistribution(scores) {
  if (!scores || scores.length === 0) return null;

  const sorted = [...scores].sort((a, b) => a - b);
  const len = sorted.length;

  const avg = sorted.reduce((sum, val) => sum + val, 0) / len;
  const min = sorted[0];
  const max = sorted[len - 1];

  const p50 = sorted[Math.floor(len * 0.50)];
  const p70 = sorted[Math.floor(len * 0.70)];
  const p80 = sorted[Math.floor(len * 0.80)];
  const p90 = sorted[Math.floor(len * 0.90)];
  const p95 = sorted[Math.floor(len * 0.95)];

  return { avg, min, max, p50, p70, p80, p90, p95 };
}

function analyzeQualityGate(predictions) {
  console.log('\n=== QUALITY GATE PASS RATE ANALYSIS ===\n');

  let passCount = 0;
  let failCount = 0;
  const failReasons = {};

  predictions.forEach(pred => {
    let passed = true;
    const failures = [];

    if (pred.confidence < CURRENT_THRESHOLDS.confidence) {
      passed = false;
      failures.push(`confidence(${pred.confidence} < ${CURRENT_THRESHOLDS.confidence})`);
    }
    if (pred.quantum < CURRENT_THRESHOLDS.quantum) {
      passed = false;
      failures.push(`quantum(${pred.quantum} < ${CURRENT_THRESHOLDS.quantum})`);
    }
    if (pred.timing < CURRENT_THRESHOLDS.timing) {
      passed = false;
      failures.push(`timing(${pred.timing} < ${CURRENT_THRESHOLDS.timing})`);
    }

    if (passed) {
      passCount++;
    } else {
      failCount++;
      const reason = failures.join(' + ');
      failReasons[reason] = (failReasons[reason] || 0) + 1;
    }
  });

  const passRate = (passCount / predictions.length * 100).toFixed(2);

  console.log(`Total predictions analyzed: ${predictions.length}`);
  console.log(`Pass rate with current thresholds: ${passRate}%`);
  console.log(`Predictions that WOULD pass gate: ${passCount}`);
  console.log(`Predictions that WOULD be blocked: ${failCount}\n`);

  console.log('Top failure reasons:');
  Object.entries(failReasons)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .forEach(([reason, count]) => {
      const pct = (count / failCount * 100).toFixed(1);
      console.log(`  ${count} (${pct}%): ${reason}`);
    });

  return { passCount, failCount, passRate };
}

function analyzeWinners(predictions) {
  console.log('\n=== WINNER PROFILE ANALYSIS ===\n');

  // Try multiple outcome fields
  const winners = predictions.filter(p =>
    p.outcome === 'win' ||
    p.status === 'win' ||
    (p.signal_emitted && !p.suppression_reason && p.status !== 'suppressed')
  );

  if (winners.length === 0) {
    console.log('⚠️  No winners found in dataset. Checking for alternative outcomes...');
    console.log('Sample prediction structure:');
    if (predictions.length > 0) {
      console.log(JSON.stringify(predictions[0], null, 2).substring(0, 500));
    }
    return null;
  }

  const winnerConfidence = winners.map(w => w.confidence);
  const winnerQuantum = winners.map(w => w.quantum);
  const winnerTiming = winners.map(w => w.timing);

  const confDist = calculateDistribution(winnerConfidence);
  const quantumDist = calculateDistribution(winnerQuantum);
  const timingDist = calculateDistribution(winnerTiming);

  console.log(`Total winners identified: ${winners.length}`);
  console.log(`Win rate in dataset: ${(winners.length / predictions.length * 100).toFixed(2)}%\n`);

  console.log('Winner Confidence Distribution:');
  console.log(`  avg: ${confDist.avg.toFixed(2)}, min: ${confDist.min.toFixed(2)}, max: ${confDist.max.toFixed(2)}`);
  console.log(`  p50: ${confDist.p50.toFixed(2)}, p70: ${confDist.p70.toFixed(2)}, p90: ${confDist.p90.toFixed(2)}`);

  console.log('\nWinner Quantum Distribution:');
  console.log(`  avg: ${quantumDist.avg.toFixed(2)}, min: ${quantumDist.min.toFixed(2)}, max: ${quantumDist.max.toFixed(2)}`);
  console.log(`  p50: ${quantumDist.p50.toFixed(2)}, p70: ${quantumDist.p70.toFixed(2)}, p90: ${quantumDist.p90.toFixed(2)}`);

  console.log('\nWinner Timing Distribution:');
  console.log(`  avg: ${timingDist.avg.toFixed(2)}, min: ${timingDist.min.toFixed(2)}, max: ${timingDist.max.toFixed(2)}`);
  console.log(`  p50: ${timingDist.p50.toFixed(2)}, p70: ${timingDist.p70.toFixed(2)}, p90: ${timingDist.p90.toFixed(2)}`);

  // Check how many winners meet current thresholds
  const winnersPassingGate = winners.filter(w =>
    w.confidence >= CURRENT_THRESHOLDS.confidence &&
    w.quantum >= CURRENT_THRESHOLDS.quantum &&
    w.timing >= CURRENT_THRESHOLDS.timing
  );

  console.log(`\n✓ Winners that meet CURRENT thresholds: ${winnersPassingGate.length}/${winners.length} (${(winnersPassingGate.length / winners.length * 100).toFixed(2)}%)`);

  return { winners, confDist, quantumDist, timingDist, winnersPassingGate };
}

function analyzeAllScores(predictions) {
  console.log('\n=== OVERALL SCORE DISTRIBUTION ===\n');

  const allConfidence = predictions.map(p => p.confidence);
  const allQuantum = predictions.map(p => p.quantum);
  const allTiming = predictions.map(p => p.timing);
  const allStability = predictions.map(p => p.stability);

  const confDist = calculateDistribution(allConfidence);
  const quantumDist = calculateDistribution(allQuantum);
  const timingDist = calculateDistribution(allTiming);
  const stabilityDist = calculateDistribution(allStability);

  console.log('Confidence Distribution (all predictions):');
  console.log(`  avg: ${confDist.avg.toFixed(2)}, min: ${confDist.min.toFixed(2)}, max: ${confDist.max.toFixed(2)}`);
  console.log(`  p50: ${confDist.p50.toFixed(2)}, p70: ${confDist.p70.toFixed(2)}, p80: ${confDist.p80.toFixed(2)}, p90: ${confDist.p90.toFixed(2)}`);

  console.log('\nQuantum Distribution (all predictions):');
  console.log(`  avg: ${quantumDist.avg.toFixed(2)}, min: ${quantumDist.min.toFixed(2)}, max: ${quantumDist.max.toFixed(2)}`);
  console.log(`  p50: ${quantumDist.p50.toFixed(2)}, p70: ${quantumDist.p70.toFixed(2)}, p80: ${quantumDist.p80.toFixed(2)}, p90: ${quantumDist.p90.toFixed(2)}`);

  console.log('\nTiming Distribution (all predictions):');
  console.log(`  avg: ${timingDist.avg.toFixed(2)}, min: ${timingDist.min.toFixed(2)}, max: ${timingDist.max.toFixed(2)}`);
  console.log(`  p50: ${timingDist.p50.toFixed(2)}, p70: ${timingDist.p70.toFixed(2)}, p80: ${timingDist.p80.toFixed(2)}, p90: ${timingDist.p90.toFixed(2)}`);

  console.log('\nStability Distribution (all predictions):');
  console.log(`  avg: ${stabilityDist.avg.toFixed(2)}, min: ${stabilityDist.min.toFixed(2)}, max: ${stabilityDist.max.toFixed(2)}`);
  console.log(`  p50: ${stabilityDist.p50.toFixed(2)}, p70: ${stabilityDist.p70.toFixed(2)}, p80: ${stabilityDist.p80.toFixed(2)}, p90: ${stabilityDist.p90.toFixed(2)}`);

  return { confDist, quantumDist, timingDist, stabilityDist };
}

function generateDiagnosis(predictions, gateAnalysis, scoreAnalysis, winnerAnalysis) {
  console.log('\n=== DIAGNOSTIC CONCLUSION ===\n');

  const passRate = parseFloat(gateAnalysis.passRate);

  let classification = null;
  let diagnosis = null;
  let recommendation = null;

  // Determine classification
  if (passRate < 5) {
    // Very few predictions pass
    classification = '[A] Gate too strict';
    diagnosis = 'Quality gate thresholds are blocking almost all predictions. Either the model rarely generates high-conviction signals, or the thresholds are unrealistically high.';

    if (winnerAnalysis && winnerAnalysis.winnersPassingGate.length < winnerAnalysis.winners.length / 2) {
      diagnosis += ' Historical winners do NOT meet current thresholds.';
      recommendation = 'OPTION 1: Lower thresholds to match historical winner profiles (confidence: p70, quantum: p70, timing: p50)';
    } else {
      diagnosis += ' Even winners barely pass the gate.';
      recommendation = 'OPTION 2: Investigate model calibration - scores may be systematically low';
    }
  } else if (passRate > 40) {
    // Many predictions pass
    if (!winnerAnalysis || winnerAnalysis.winners.length === 0) {
      classification = '[C] Market conditions or data issue';
      diagnosis = 'Cannot determine outcome distribution. No winners identified in dataset. This suggests either very recent data, or outcomes not yet recorded.';
      recommendation = 'Wait for more historical data OR verify outcome recording is working in real-time predictions';
    } else if (winnerAnalysis.winnersPassingGate.length / winnerAnalysis.winners.length > 0.7) {
      classification = '[OK] Gate aligned';
      diagnosis = 'Most passing predictions are winners. Gate threshold appears appropriate.';
      recommendation = 'No immediate action needed. Monitor signal_emitted rate in real-time.';
    } else {
      classification = '[D] Model weak';
      diagnosis = 'Many predictions pass gate but most are not winners. Model generates high scores even for unsuccessful trades.';
      recommendation = 'REVIEW: Model may need recalibration. Check if confidence/quantum scores reflect actual market conditions.';
    }
  } else {
    // Middle ground
    classification = '[D] Desalignment detected';
    diagnosis = 'Moderate pass rate but insufficient winner data to validate. Historical and real-time conditions may differ.';
    recommendation = 'MONITOR: Continue real-time execution and compare outcomes. Adjust thresholds based on new outcome data.';
  }

  console.log(`Classification: ${classification}`);
  console.log(`\nDiagnosis:\n${diagnosis}`);
  console.log(`\nRecommendation:\n${recommendation}`);

  return { classification, diagnosis, recommendation };
}

async function runDiagnostic() {
  try {
    console.log('[DIAGNOSTIC] Starting Quality Gate Analysis...\n');

    // 1. Fetch data
    const predictions = await fetchHistoricalPredictions(500);

    if (predictions.length === 0) {
      console.log('\n⚠️  No historical predictions found. Database may be empty.');
      process.exit(0);
    }

    // 2. Analyze overall distribution
    const scoreAnalysis = analyzeAllScores(predictions);

    // 3. Analyze gate effectiveness
    const gateAnalysis = analyzeQualityGate(predictions);

    // 4. Analyze winners
    const winnerAnalysis = analyzeWinners(predictions);

    // 5. Generate diagnosis
    const conclusion = generateDiagnosis(predictions, gateAnalysis, scoreAnalysis, winnerAnalysis);

    console.log('\n' + '='.repeat(60));
    console.log('[DIAGNOSTIC] Analysis Complete');
    console.log('='.repeat(60) + '\n');

  } catch (error) {
    console.error('[DIAGNOSTIC_FATAL]', error.message);
    process.exit(1);
  }
}

if (require.main === module) {
  runDiagnostic().then(() => process.exit(0));
}

module.exports = { runDiagnostic };
