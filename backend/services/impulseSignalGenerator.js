/**
 * IMPULSE SIGNAL GENERATOR - Phase 3
 *
 * Genera señales de tipo IMPULSE solo cuando:
 * - Impulse detectado ✓
 * - No es ruido ✓
 * - Confidence ≥ 0.65
 *
 * Emite a Firestore: high_conviction_impulse_signals
 */

const admin = require('firebase-admin');
const { detectImpulse } = require('./impulseDetector');
const { filterNoise } = require('./noiseFilter');

const db = admin.firestore();

/**
 * Generate IMPULSE signal
 *
 * Returns signal object ready for Firestore
 */
async function generateImpulseSignal(symbol) {
  try {
    // Step 1: Detect impulse
    const impulseData = await detectImpulse(symbol);

    if (!impulseData.detected) {
      console.log(`[SIGNAL_GENERATOR] No impulse for ${symbol}: ${impulseData.reason}`);
      return null;
    }

    console.log(`[SIGNAL_GENERATOR] Impulse detected for ${symbol}: ${impulseData.direction} (strength: ${impulseData.strength_score.toFixed(2)})`);

    // Step 2: Apply noise filter
    const noiseCheck = await filterNoise(symbol, impulseData);

    if (noiseCheck.is_noisy) {
      console.log(`[SIGNAL_GENERATOR] Noise filter blocks ${symbol}:`, noiseCheck.reasons.join(' | '));
      return null;
    }

    console.log(`[SIGNAL_GENERATOR] Noise filter passed for ${symbol}`);

    // Step 3: Calculate confidence
    // Base confidence from strength_score, scaled to 0.6-0.9 range
    const baseConfidence = 0.6 + (impulseData.strength_score * 0.3);
    const confidence = Math.min(Math.max(baseConfidence, 0.6), 0.9);

    if (confidence < 0.65) {
      console.log(`[SIGNAL_GENERATOR] Confidence too low for ${symbol}: ${confidence.toFixed(3)}`);
      return null;
    }

    // Step 4: Build signal
    const signal = {
      symbol,
      signal_type: 'IMPULSE',
      direction: impulseData.direction,
      confidence,
      strength_score: impulseData.strength_score,
      expected_move: {
        min: 0.5,
        max: 1.2
      },
      impulse_metrics: {
        move_5m: impulseData.move_pct,
        velocity_1m: impulseData.velocity,
        volume_ratio: impulseData.volume_ratio,
        continuity_candles: impulseData.continuity_candles
      },
      noise_metrics: noiseCheck.metrics,
      entry_price: impulseData.candles['1m_close'],
      created_at: admin.firestore.FieldValue.serverTimestamp(),
      created_at_ms: Date.now(),
      status: 'PENDING_EXECUTION'
    };

    console.log(`[SIGNAL_IMPULSE] ${symbol} ${impulseData.direction} | confidence: ${confidence.toFixed(3)} | strength: ${impulseData.strength_score.toFixed(3)}`);

    return signal;

  } catch (error) {
    console.error(`[SIGNAL_GENERATOR] Error for ${symbol}:`, error.message);
    return null;
  }
}

/**
 * Process multiple symbols and emit signals
 */
async function generateImpulseSignals(symbols) {
  const signals = [];

  for (const symbol of symbols) {
    const signal = await generateImpulseSignal(symbol);
    if (signal) {
      signals.push(signal);
    }
  }

  // Emit to Firestore
  if (signals.length > 0) {
    try {
      const batch = db.batch();

      for (const signal of signals) {
        const docRef = db.collection('high_conviction_impulse_signals').doc();
        batch.set(docRef, signal);
      }

      await batch.commit();
      console.log(`[SIGNAL_EMITTED] ${signals.length} impulse signals emitted to Firestore`);
    } catch (error) {
      console.error(`[SIGNAL_EMITTER] Error emitting signals:`, error.message);
    }
  }

  return signals;
}

module.exports = {
  generateImpulseSignal,
  generateImpulseSignals
};
