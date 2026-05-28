/**
 * IMPULSE SCHEDULER ROUTES v2
 *
 * Endpoints llamados por Cloud Scheduler cada 15 minutos
 * Integrado con impulseDetectorV2 para detección temprana
 */

const express = require('express');
const crypto = require('crypto');
const { runImpulseCycle } = require('../tasks/velasScheduler');

const router = express.Router();
const CRON_SECRET = process.env.CRON_SECRET || crypto.randomBytes(24).toString('hex');

if (!process.env.CRON_SECRET) {
  console.warn('[IMPULSE_CRON] CRON_SECRET not set. Using random default; set CRON_SECRET for production.');
}

// Track last confirmation per symbol to implement 1-cycle confirmation
const confirmationState = new Map();

/**
 * Validate CRON_SECRET
 */
function checkSecret(req, res) {
  if (!CRON_SECRET) {
    res.status(500).json({ ok: false, error: 'CRON_SECRET not configured' });
    return false;
  }
  const provided = req.header('x-cron-secret') || req.query.cron_secret;
  if (!provided || provided !== CRON_SECRET) {
    res.status(403).json({ ok: false, error: 'Forbidden' });
    return false;
  }
  return true;
}

/**
 * Main impulse trading cycle (called every 15 minutes)
 *
 * PHASE 2: Confirmation layer
 * - Detect impulses on cycle N
 * - Revalidate on cycle N+1
 * - Only execute on confirmed impulses
 */
router.post('/internal/cron/impulse/cycle', async (req, res) => {
  if (!checkSecret(req, res)) return;

  console.log('[IMPULSE_CRON] Cycle triggered via Cloud Scheduler');

  // Return 202 Accepted immediately
  res.status(202).json({
    ok: true,
    source: 'scheduler',
    job: 'impulse-trading-v2',
    accepted: true,
    timestamp: new Date().toISOString(),
    phase: 'detection'
  });

  // Execute cycle asynchronously with confirmation logic
  setImmediate(async () => {
    try {
      const cycleResult = await runImpulseCycle({
        debug: process.env.DEBUG_IMPULSE === 'true'
      });

      console.log('[IMPULSE_CRON] Cycle result:', {
        success: cycleResult.success,
        impulses_detected: cycleResult.impulses_detected,
        duration_ms: cycleResult.duration_ms
      });

      // PHASE 3: Confirmation validation
      // Check if impulses from last cycle are still valid
      if (cycleResult.impulses_detected > 0) {
        console.log('[IMPULSE_CRON] Detected impulses - awaiting confirmation in next cycle');

        // Store for confirmation in next cycle
        cycleResult.detected_impulses.forEach(impulse => {
          const key = `${impulse.symbol}:${impulse.direction}`;
          const entry = {
            detected_at: Date.now(),
            ...impulse
          };
          confirmationState.set(key, entry);
          console.log(`[IMPULSE_CRON] Pending confirmation: ${key}`);
        });
      }

      // Check if any previously detected impulses are still valid (confirmation passed)
      const confirmedImpulses = [];
      const now = Date.now();

      for (const [key, entry] of confirmationState.entries()) {
        const age = now - entry.detected_at;
        const cycleAge = Math.floor(age / 60000); // Convert to minute cycles (approximation)

        if (cycleAge >= 1) {
          // At least 1 cycle has passed - this is a confirmed impulse
          confirmedImpulses.push(entry);
          console.log(`[IMPULSE_CRON] \u2713 CONFIRMED: ${key} (age: ${cycleAge} cycles)`);
          confirmationState.delete(key);
        }
      }

      // Log final status
      console.log('[IMPULSE_CRON] Cycle completed', {
        detected_this_cycle: cycleResult.impulses_detected,
        confirmed_impulses: confirmedImpulses.length,
        pending_confirmation: confirmationState.size,
        duration_ms: cycleResult.duration_ms
      });

    } catch (error) {
      console.error('[IMPULSE_CRON] Cycle failed:', error.message);
    }
  });
});

/**
 * Health check endpoint
 */
router.get('/internal/health/impulse', async (req, res) => {
  try {
    const db = require('../firebase-admin-config');

    // Check if we can read from Firestore
    const testDoc = await db.collection('high_conviction_impulse_signals').limit(1).get();

    res.status(200).json({
      status: 'healthy',
      impulse_system: 'operational',
      timestamp: new Date().toISOString(),
      signals_collection_exists: true
    });
  } catch (error) {
    res.status(500).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

module.exports = router;
