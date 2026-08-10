'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getRealSpotConfig } = require('../services/binanceSpotRealExecutor');
const { executeApprovedSpotCandidate } = require('../services/approvedSpotRealExecutor');
const { evaluateAndExecuteRealSpotExits, determineExit } = require('../services/controlledSpotExitExecutor');
const { reconcileManagedSpotAccount } = require('../services/spotManagedQuantityRepair');
const { enforceAutonomousSafety } = require('../services/spotAutonomyController');
const { evaluatePaperToRealEntryGate } = require('../services/paperToRealEntryGate');
const { runAdaptiveSpotStrategyController, getAdaptiveEntryGate } = require('../services/adaptiveSpotStrategyController');
const { evaluateStrategyPromotion, getStrategyPromotionGate } = require('../services/spotStrategyPromotionController');
const { scanBinanceSpotOpportunities } = require('../services/binanceSpotOpportunityScanner');
const { runSpotPaperExecutionCycle } = require('../services/binanceSpotPaperExecutor');
const { buildSpotCycleDecisionLog, logSpotCycleDecision } = require('../services/spotCycleObservability');
const { persistActivity, persistCycleEvidence } = require('../services/spotLiveEvidence');
const { buildEntrySafetyFailures, buildPromotionConfidence, firstFailureReason } = require('../services/spotRealPipelinePolicy');
const { runLegacySpotRecoveryCycle } = require('../services/legacySpotRecoveryLiquidator');
const { runXecHistoricalHoldingCycle } = require('../services/xecHistoricalHoldingManager');
const { runSpotDustSweeper } = require('../services/spotDustSweeper');

const router = express.Router();

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function requireCronSecret(req, res, next) {
  const expected = process.env.CRON_SECRET;
  const supplied = req.header('x-cron-secret');
  if (!expected) return res.status(503).json({ ok: false, error: 'CRON_SECRET not configured' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'Forbidden' });
  return next();
}

async function releaseReconciliationEntryGateWhenSafe(reconciliation) {
  if (reconciliation.account_consistent !== true || reconciliation.inconsistencies !== 0) return;
  const controlRef = db.doc('real_spot_config/control');
  const snap = await controlRef.get();
  const control = snap.exists ? snap.data() : {};
  if (control.entry_block_reason !== 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED') return;
  await controlRef.set({
    reconciliation_required: false,
    account_consistent: true,
    entry_block_reason: null,
    new_entries_enabled: control.kill_switch !== true && control.enabled === true,
    reconciliation_gate_released_at: new Date().toISOString()
  }, { merge: true });
}

async function refreshAdaptiveAndPromotion(config) {
  await runAdaptiveSpotStrategyController(db);
  const adaptiveGate = await getAdaptiveEntryGate(db);
  await evaluateStrategyPromotion(db, config);
  const promotionGate = await getStrategyPromotionGate(db);
  return { adaptiveGate, promotionGate };
}

async function runLegacyRecoverySafely(options = {}) {
  try {
    return await runLegacySpotRecoveryCycle(db, options);
  } catch (error) {
    await persistActivity(db, {
      event_type: 'ERROR',
      source: 'LEGACY_SPOT_RECOVERY',
      error: error.message,
      created_at: new Date().toISOString()
    });
    return { ok: false, error: 'LEGACY_SPOT_RECOVERY_FAILED', details: error.message, outcomes: [] };
  }
}

async function runXecHoldingSafely(options = {}) {
  try {
    return await runXecHistoricalHoldingCycle(db, options);
  } catch (error) {
    await persistActivity(db, {
      event_type: 'ERROR',
      source: 'XEC_HISTORICAL_HOLDING_MANAGER',
      error: error.message,
      created_at: new Date().toISOString()
    });
    return { ok: false, error: 'XEC_HOLDING_MANAGER_FAILED', details: error.message, action: 'ERROR' };
  }
}

async function runDustSweeperSafely(options = {}) {
  try {
    return await runSpotDustSweeper(db, options);
  } catch (error) {
    await persistActivity(db, {
      event_type: 'ERROR',
      source: 'SPOT_DUST_SWEEPER',
      error: error.message,
      created_at: new Date().toISOString()
    });
    // Dust cleanup is operational housekeeping. A temporary Wallet API failure
    // must never block discovery, exits or a valid real entry.
    return { ok: false, non_blocking: true, error: 'SPOT_DUST_SWEEPER_FAILED', details: error.message, outcomes: [] };
  }
}

router.post('/internal/cron/binance/spot-adaptive-strategy', requireCronSecret, async (_req, res) => {
  try { return res.json({ ok: true, ...(await runAdaptiveSpotStrategyController(db)) }); }
  catch (error) { return res.status(500).json({ ok: false, error: 'ADAPTIVE_STRATEGY_FAILED', details: error.message }); }
});

router.get('/spot-adaptive-strategy/status', async (_req, res) => {
  try { return res.json({ ok: true, ...(await getAdaptiveEntryGate(db)) }); }
  catch (error) { return res.status(500).json({ ok: false, error: error.message }); }
});

router.post('/internal/cron/binance/spot-legacy-recovery', requireCronSecret, async (req, res) => {
  const result = await runLegacyRecoverySafely(req.body || {});
  return res.status(result.ok === false ? 500 : 200).json(result);
});

router.get('/internal/spot-legacy-recovery/status', requireCronSecret, async (_req, res) => {
  try {
    const [configSnap, statesSnap, latestRun] = await Promise.all([
      db.doc('real_spot_config/legacy_recovery').get(),
      db.collection('legacy_spot_recovery_states').get(),
      db.collection('legacy_spot_recovery_runs').orderBy('created_at', 'desc').limit(1).get()
    ]);
    return res.json({
      ok: true,
      config: configSnap.exists ? configSnap.data() : null,
      states: statesSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      latest_run: latestRun.empty ? null : latestRun.docs[0].data()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'LEGACY_SPOT_RECOVERY_STATUS_FAILED', details: error.message });
  }
});

router.post('/internal/cron/binance/spot-xec-holding', requireCronSecret, async (req, res) => {
  const result = await runXecHoldingSafely(req.body || {});
  return res.status(result.ok === false ? 500 : 200).json(result);
});

router.get('/internal/spot-xec-holding/status', requireCronSecret, async (_req, res) => {
  try {
    const [configSnap, stateSnap, latestRun] = await Promise.all([
      db.doc('real_spot_config/xec_holding_manager').get(),
      db.doc('real_spot_holding_states/XEC').get(),
      db.collection('xec_holding_manager_runs').orderBy('created_at', 'desc').limit(1).get()
    ]);
    return res.json({
      ok: true,
      autonomous: true,
      asset: 'XEC',
      new_entries_allowed: false,
      config: configSnap.exists ? configSnap.data() : null,
      state: stateSnap.exists ? stateSnap.data() : null,
      latest_run: latestRun.empty ? null : latestRun.docs[0].data()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'XEC_HOLDING_STATUS_FAILED', details: error.message });
  }
});

router.post('/internal/cron/binance/spot-dust-sweeper', requireCronSecret, async (req, res) => {
  const result = await runDustSweeperSafely(req.body || {});
  return res.status(200).json(result);
});

router.get('/internal/spot-dust-sweeper/status', requireCronSecret, async (_req, res) => {
  try {
    const [configSnap, pendingSnap, latestRun] = await Promise.all([
      db.doc('real_spot_config/dust_sweeper').get(),
      db.collection('real_spot_dust_residuals').where('status', '==', 'UNMANAGED_DUST').get(),
      db.collection('spot_dust_sweeper_runs').orderBy('created_at', 'desc').limit(1).get()
    ]);
    return res.json({
      ok: true,
      autonomous: true,
      target_asset: 'USDT',
      config: configSnap.exists ? configSnap.data() : null,
      pending_dust_count: pendingSnap.size,
      pending_dust: pendingSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() })),
      latest_run: latestRun.empty ? null : latestRun.docs[0].data()
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'SPOT_DUST_SWEEPER_STATUS_FAILED', details: error.message });
  }
});

router.post('/internal/cron/binance/spot-real-execution', requireCronSecret, async (req, res) => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let config = {};
  let reconciliation = {};
  let exits = {};
  let xecHolding = {};
  let legacyRecovery = {};
  let dustCleanup = {};
  let autonomy = {};
  let discovery = {};
  let paperValidation = {};
  let adaptiveGate = {};
  let promotionGate = {};
  let promotionConfidence = {};
  let paperGate = {};
  let safetyFailures = [];
  let entries = {};

  try {
    await persistActivity(db, { event_type: 'SCHEDULER_START', source: 'CLOUD_SCHEDULER', created_at: startedAt, route: req.path });

    reconciliation = await reconcileManagedSpotAccount(db);
    await releaseReconciliationEntryGateWhenSafe(reconciliation);
    config = await getRealSpotConfig(db);

    exits = await evaluateAndExecuteRealSpotExits(db, config, req.body || {});
    xecHolding = await runXecHoldingSafely(req.body?.xec_holding || {});
    legacyRecovery = await runLegacyRecoverySafely(req.body?.legacy_recovery || {});
    dustCleanup = await runDustSweeperSafely(req.body?.dust_sweeper || {});
    autonomy = await enforceAutonomousSafety(db, config);
    config = await getRealSpotConfig(db);

    discovery = await scanBinanceSpotOpportunities(db, req.body?.discovery || {});
    paperValidation = await runSpotPaperExecutionCycle(db, req.body?.paper || {});
    ({ adaptiveGate, promotionGate } = await refreshAdaptiveAndPromotion(config));
    promotionConfidence = buildPromotionConfidence(promotionGate);

    paperGate = await evaluatePaperToRealEntryGate(db, config);

    const openAfterExit = await db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get();
    safetyFailures = buildEntrySafetyFailures({
      reconciliation,
      exits,
      adaptiveGate,
      paperGate,
      autonomy,
      config,
      openPositions: openAfterExit.size
    });

    if (safetyFailures.length === 0) {
      entries = await executeApprovedSpotCandidate(db, paperGate.candidate, {
        paper_gate: paperGate,
        promotion_confidence: promotionConfidence,
        strategy_metadata: {
          strategy: 'CONTROLLED_PAPER_TO_REAL',
          decision_reason: 'Fresh discovery, historical Paper evidence and live technical confirmation passed',
          promotion_confidence: promotionConfidence.state
        }
      });
    } else {
      entries = {
        ok: true,
        skipped: true,
        reason: firstFailureReason(safetyFailures),
        failed_conditions: safetyFailures,
        candidate: paperGate.candidate || null,
        promotion_confidence: promotionConfidence,
        no_order_created: true
      };
    }

    const finalOpenPositions = await db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get();
    const durationMs = Date.now() - startedAtMs;
    const decisionLog = buildSpotCycleDecisionLog({
      reconciliation,
      exits,
      autonomy,
      adaptiveGate,
      promotionGate: promotionConfidence,
      paperGate,
      entries,
      openPositionsAfterCycle: finalOpenPositions.size,
      durationMs,
      config,
      discovery,
      paperValidation,
      safetyFailures
    });
    logSpotCycleDecision(decisionLog);

    const evidence = await persistCycleEvidence(db, {
      decision: decisionLog,
      started_at: startedAt,
      duration_ms: durationMs,
      reconciliation,
      exits,
      xecHolding,
      legacyRecovery,
      dustCleanup,
      autonomy,
      adaptiveGate,
      promotionGate: promotionConfidence,
      paperGate,
      entries,
      config,
      discovery,
      paperValidation,
      safetyFailures
    });

    return res.json({
      ok: reconciliation.ok !== false && exits.ok !== false && entries.ok !== false,
      real_mode: true,
      spot_only: true,
      futures: false,
      margin: false,
      leverage: false,
      withdrawals: false,
      pipeline: ['Scheduler', 'Reconciliation', 'Exit Engine', 'XEC Historical Holding Manager', 'Legacy Recovery', 'Dust Sweeper', 'Discovery', 'Ranking', 'Paper Validation', 'Adaptive Strategy', 'Strategy Promotion Confidence', 'Technical Confirmation', 'Paper-to-Real', 'Safety Checks', 'Real Executor'],
      discovery,
      ranking: { latest_scan_id: discovery.scan_id || null, candidates_saved: discovery.candidates_saved || 0, top_symbol: discovery.top_symbol || null, top_score: discovery.top_score || null },
      paper_validation: paperValidation,
      reconciliation,
      autonomy,
      exits,
      xec_holding: xecHolding,
      legacy_recovery: legacyRecovery,
      dust_cleanup: dustCleanup,
      adaptive_strategy_gate: adaptiveGate,
      strategy_promotion_confidence: promotionConfidence,
      strategy_promotion_blocks_entry: false,
      paper_entry_gate: paperGate,
      safety_checks: { allowed: safetyFailures.length === 0, failed_conditions: safetyFailures },
      entries,
      decision_summary: decisionLog,
      evidence_id: evidence.id,
      open_positions_after_cycle: finalOpenPositions.size,
      duration_ms: durationMs
    });
  } catch (error) {
    const durationMs = Date.now() - startedAtMs;
    const decisionLog = {
      event: 'SPOT_REAL_CYCLE_DECISION',
      timestamp: new Date().toISOString(),
      action: 'ERROR',
      decision: 'FAILED',
      reason: 'CONTROLLED_REAL_SPOT_CYCLE_FAILED',
      reasons: [error.message],
      error: error.message,
      duration_ms: durationMs
    };
    console.error(JSON.stringify(decisionLog));
    try {
      await persistCycleEvidence(db, {
        decision: decisionLog,
        started_at: startedAt,
        duration_ms: durationMs,
        reconciliation,
        exits,
        xecHolding,
        legacyRecovery,
        dustCleanup,
        autonomy,
        adaptiveGate,
        promotionGate: promotionConfidence,
        paperGate,
        entries,
        config,
        discovery,
        paperValidation,
        safetyFailures,
        error: error.message
      });
    } catch (persistError) {
      console.error('[SPOT_EVIDENCE] failed to persist failed cycle:', persistError.message);
    }
    return res.status(500).json({ ok: false, error: 'CONTROLLED_REAL_SPOT_CYCLE_FAILED', details: error.message, duration_ms: durationMs });
  }
});

router.post('/internal/cron/binance/spot-real-reconcile', requireCronSecret, async (_req, res) => {
  try {
    const reconciliation = await reconcileManagedSpotAccount(db);
    await releaseReconciliationEntryGateWhenSafe(reconciliation);
    await persistActivity(db, { event_type: 'RECONCILIATION', source: 'BACKEND', result: reconciliation.account_consistent === true ? 'PASS' : 'BLOCK', details: reconciliation });
    return res.json({ ok: reconciliation.ok !== false, real_mode: true, spot_only: true, no_order_created: true, reconciliation });
  } catch (error) {
    await persistActivity(db, { event_type: 'ERROR', source: 'RECONCILIATION', error: error.message });
    return res.status(500).json({ ok: false, error: 'SPOT_RECONCILIATION_FAILED', details: error.message });
  }
});

router.post('/internal/cron/binance/spot-real-exit-preview', requireCronSecret, async (req, res) => {
  try {
    const snapshot = await db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get();
    const now = new Date();
    const prices = req.body?.currentPrices || {};
    const positions = snapshot.docs.map((doc) => {
      const position = { id: doc.id, ...doc.data() };
      const currentPrice = Number(prices[position.symbol] || 0);
      return {
        id: position.id,
        symbol: position.symbol,
        current_price: currentPrice || null,
        exit_reason: currentPrice > 0 ? determineExit(position, currentPrice, now) : null,
        tp1_price: position.tp1_price || null,
        sl_price: position.sl_price || null,
        effective_tp_price: position.effective_tp_price || null,
        effective_sl_price: position.effective_sl_price || null,
        protection_mode: position.protection_mode || 'BASE',
        timeout_at: position.timeout_at || null,
        effective_timeout_at: position.effective_timeout_at || null,
        no_order_created: true
      };
    });
    return res.json({ ok: true, preview_only: true, positions });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
