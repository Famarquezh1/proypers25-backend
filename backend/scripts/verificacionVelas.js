const db = require('../firebase-admin-config');
const { FieldValue } = require('firebase-admin/firestore');

const randomBetween = (min, max) =>
  Number((Math.random() * (max - min) + min).toFixed(4));

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

function normalizeSymbol(symbol) {
  if (!symbol) return symbol;

  const normalized = symbol.toUpperCase().replace('/', '-');
  if (
    normalized === 'BTC-USD' ||
    normalized === 'BTCUSD' ||
    normalized === 'BTC/USDT' ||
    normalized === 'BTCUSDT'
  ) {
    return 'BTC-USDT';
  }
  return normalized;
}

async function updateTrainingStats(symbolNormalized, timingScore, outcome, confidence, quantumScore) {
  if (!symbolNormalized) return;

  const statsRef = db.collection('velas_training_stats').doc(symbolNormalized);

  await db.runTransaction(async (tx) => {
    const snap = await tx.get(statsRef);
    const data = snap.exists ? snap.data() : {};
    const samples = data.samples || 0;
    const newSamples = samples + 1;

    const avgTiming = data.avg_timing_score || 0;
    const newAvgTiming = ((avgTiming * samples) + timingScore) / newSamples;

    const updates = {
      samples: newSamples,
      avg_timing_score: Number(newAvgTiming.toFixed(4)),
      updated_at: FieldValue.serverTimestamp(),
      last_result: outcome,
      last_confidence: confidence ?? null,
      last_quantum_score: quantumScore ?? null
    };

    if (outcome === 'VALID_WIN') {
      updates.valid_wins = (data.valid_wins || 0) + 1;
    } else if (outcome === 'LUCKY_WIN') {
      updates.lucky_wins = (data.lucky_wins || 0) + 1;
    } else {
      updates.losses = (data.losses || 0) + 1;
    }

    tx.set(statsRef, updates, { merge: true });
  });
}

async function syncHighConvictionStatus(predictionId, payload) {
  if (!predictionId || !payload) return;
  try {
    const hcSnapshot = await db
      .collection('high_conviction_signals')
      .where('prediction_id', '==', predictionId)
      .limit(1)
      .get();
    if (!hcSnapshot.empty) {
      await hcSnapshot.docs[0].ref.update({
        ...payload,
        updated_at: FieldValue.serverTimestamp()
      });
    }
  } catch (err) {
    console.warn('[HIGH_CONVICTION] status sync failed', err?.message || err);
  }
}

function hasSuppressedVerification(data) {
  const outcome = String(
    data?.suppressed_verification?.counterfactual_outcome ||
      data?.verification?.suppressed_verification?.counterfactual_outcome ||
      data?.verification?.counterfactual_outcome ||
      data?.counterfactual_outcome ||
      ''
  ).toUpperCase();
  return outcome.includes('WIN') || outcome.includes('LOSS');
}

function buildSuppressedCounterfactual(data, executedAt) {
  const basePrice = data.precio_actual || data.precio_estimado || 0;
  const expectedMove = Math.abs(
    data.expected_move_percent ?? data.porcentaje ?? data.porcentaje_estimado ?? 0
  );
  const confidence = data.confianza ?? 0.5;
  const impulseStrength = data.impulse_metrics?.strength ?? 0.5;
  const directionSignal = data.direction === 'down' ? -1 : data.direction === 'up' ? 1 : 0;

  const directionHit = Math.random() < clamp(
    0.28 + confidence * 0.5 + impulseStrength * 0.12,
    0.08,
    0.92
  );

  const realizedDirection =
    directionSignal === 0
      ? (directionHit ? 'up' : 'down')
      : (directionHit ? data.direction : (data.direction === 'up' ? 'down' : 'up'));

  const magnitudeFactor = clamp(0.55 + impulseStrength * 0.55 + randomBetween(-0.25, 0.25), 0.05, 1.45);
  const signedMove = expectedMove * magnitudeFactor * (realizedDirection === 'down' ? -1 : 1);
  const finalPrice = basePrice
    ? Number((basePrice * (1 + signedMove / 100)).toFixed(6))
    : null;
  const actualChange = basePrice && finalPrice
    ? Number((((finalPrice - basePrice) / basePrice) * 100).toFixed(4))
    : 0;

  const directionMatch = data.direction === realizedDirection;
  const impulseStrong = Math.abs(actualChange) >= (data.impulse_min_percent ?? 0.2);
  const counterfactualOutcome = directionMatch && impulseStrong ? 'WIN' : 'LOSS';

  const suppressedVerification = {
    is_verified: true,
    counterfactual_outcome: counterfactualOutcome,
    direction_match: directionMatch,
    impulse_strong: impulseStrong,
    actual_change: actualChange,
    final_price: finalPrice,
    verified_at: executedAt,
    method: 'counterfactual_simulation_v1'
  };

  return {
    finalPrice,
    actualChange,
    realizedDirection,
    directionMatch,
    impulseStrong,
    counterfactualOutcome,
    suppressedVerification
  };
}

async function verificarPrediccionVelas(id) {
  const docRef = db.collection('velas_predicciones').doc(id);
  const snapshot = await docRef.get();

  if (!snapshot.exists) throw new Error('Prediction not found');

  const data = snapshot.data();
  if (!data) throw new Error('Prediction has no data');

  // Already processed (except suppressed without counterfactual verification, which we backfill).
  const isSuppressed = data.signal_emitted === false || String(data.status || '').toLowerCase() === 'suprimida';
  const shouldBackfillSuppressed = isSuppressed && !hasSuppressedVerification(data);
  if (data.status && data.status !== 'pendiente' && !shouldBackfillSuppressed) {
    return { id, ...data };
  }

  // Signal suppressed by quality gate.
  if (isSuppressed) {
    const executedAt = new Date().toISOString();
    const counterfactual = buildSuppressedCounterfactual(data, executedAt);

    const verification = {
      executed_at: executedAt,
      final_price: counterfactual.finalPrice,
      actual_change: counterfactual.actualChange,
      success: false,
      reached_target: false,
      direction_match: counterfactual.directionMatch,
      impulse_strong: counterfactual.impulseStrong,
      timing_score: 0,
      remarks: 'Signal suppressed by quality gate.',
      realized_direction: counterfactual.realizedDirection,
      outcome_label: 'SUPPRESSED',
      verification_outcome: 'SUPPRESSED',
      suppressed_verification: counterfactual.suppressedVerification,
      counterfactual_outcome: counterfactual.counterfactualOutcome
    };

    await docRef.update({
      status: 'suprimida',
      verification,
      suppressed_verification: counterfactual.suppressedVerification,
      counterfactual_outcome: counterfactual.counterfactualOutcome,
      completed_at: executedAt
    });

    await syncHighConvictionStatus(id, {
      status: 'suprimida',
      verification_outcome: 'SUPPRESSED',
      suppressed_verification: counterfactual.suppressedVerification,
      counterfactual_outcome: counterfactual.counterfactualOutcome
    });

    try {
      await db.collection('velas_suppressed_learning').doc(id).set({
        prediction_id: id,
        symbol: data.simbolo || data.simbolo_normalizado || null,
        execution_mode: data.execution_mode || data.mode || null,
        timeframe: data.timeframe || null,
        suppression_reason: data.suppression_reason || null,
        confidence: data.confianza ?? null,
        quantum_score: data.quantum_score ?? null,
        timing_score: data.timing_score ?? null,
        context_score: data.context_score ?? null,
        counterfactual_outcome: counterfactual.counterfactualOutcome,
        suppressed_verification: counterfactual.suppressedVerification,
        created_at: data.created_at || data.timestamp || null,
        verified_at: executedAt,
        source: 'verificacionVelas'
      }, { merge: true });
    } catch (err) {
      console.warn('[SUPPRESSED_LEARNING] persist failed', err?.message || err);
    }

    return {
      id,
      ...data,
      status: 'suprimida',
      verification,
      suppressed_verification: counterfactual.suppressedVerification,
      counterfactual_outcome: counterfactual.counterfactualOutcome,
      completed_at: executedAt
    };
  }

  // Emitted signal (simulation).
  const symbolNormalized = normalizeSymbol(data.simbolo_normalizado || data.simbolo || '');
  const basePrice = data.precio_actual || data.precio_estimado || 0;

  const expectedMove = Math.abs(
    data.expected_move_percent ?? data.porcentaje ?? data.porcentaje_estimado ?? 0
  );

  const confidence = data.confianza ?? 0.5;
  const quantumScore = data.quantum_score ?? null;
  const impulseStrength = data.impulse_metrics?.strength ?? 0.5;

  const directionSignal = data.direction === 'down' ? -1 : data.direction === 'up' ? 1 : 0;

  const directionHit = Math.random() < clamp(
    0.35 + confidence * 0.55 + impulseStrength * 0.15,
    0.1,
    0.95
  );

  const realizedDirection =
    directionSignal === 0
      ? (directionHit ? 'up' : 'down')
      : (directionHit ? data.direction : (data.direction === 'up' ? 'down' : 'up'));

  const magnitudeFactor = clamp(0.6 + impulseStrength * 0.6 + randomBetween(-0.2, 0.2), 0.1, 1.5);
  const signedMove = expectedMove * magnitudeFactor * (realizedDirection === 'down' ? -1 : 1);

  const finalPrice = basePrice
    ? Number((basePrice * (1 + signedMove / 100)).toFixed(2))
    : 0;

  const actualChange = basePrice
    ? Number((((finalPrice - basePrice) / basePrice) * 100).toFixed(2))
    : 0;

  const directionMatch = data.direction === realizedDirection;
  const impulseStrong = Math.abs(actualChange) >= (data.impulse_min_percent ?? 0.2);
  const timingScore = expectedMove > 0 ? clamp(Math.abs(actualChange) / expectedMove, 0, 1) : 0;
  const success = directionMatch && impulseStrong;

  let outcomeLabel = 'LOSS';
  if (directionMatch && impulseStrong && timingScore >= 0.85) {
    outcomeLabel = 'VALID_WIN';
  } else if (directionMatch) {
    outcomeLabel = 'LUCKY_WIN';
  }

  // Canonical outcome for learning/audit.
  let verificationOutcome = 'LOSS';
  if (data.expired) {
    verificationOutcome = 'EXPIRED';
  } else if (outcomeLabel === 'VALID_WIN') {
    verificationOutcome = 'WIN';
  } else if (outcomeLabel === 'LUCKY_WIN') {
    verificationOutcome = 'LUCKY_WIN';
  }

  const verification = {
    executed_at: new Date().toISOString(),
    final_price: finalPrice,
    actual_change: actualChange,
    success,
    reached_target: false,
    direction_match: directionMatch,
    impulse_strong: impulseStrong,
    timing_score: Number(timingScore.toFixed(2)),
    remarks: success
      ? 'Movimiento confirmado.'
      : directionMatch
        ? 'Parcial: direccion correcta pero impulso debil.'
        : 'Movimiento contrario.',
    realized_direction: realizedDirection,
    outcome_label: outcomeLabel,
    verification_outcome: verificationOutcome
  };

  const status = success ? 'validado' : directionMatch ? 'validado-parcial' : 'fallido';

  await docRef.update({
    status,
    verification,
    completed_at: verification.executed_at
  });

  await syncHighConvictionStatus(id, {
    status,
    verification_outcome: verification.verification_outcome || null
  });

  await updateTrainingStats(symbolNormalized, timingScore, outcomeLabel, confidence, quantumScore);

  return {
    id,
    ...data,
    status,
    verification,
    completed_at: verification.executed_at
  };
}

module.exports = verificarPrediccionVelas;
