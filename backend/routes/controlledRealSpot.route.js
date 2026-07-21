'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getRealSpotConfig, runRealSpotExecutionCycle } = require('../services/binanceSpotRealExecutor');
const { evaluateAndExecuteRealSpotExits, determineExit } = require('../services/controlledSpotExitExecutor');
const { reconcileManagedSpotAccount } = require('../services/spotManagedQuantityRepair');
const { enforceAutonomousSafety } = require('../services/spotAutonomyController');
const { evaluatePaperToRealEntryGate } = require('../services/paperToRealEntryGate');
const { getAdaptiveEntryGate, runAdaptiveSpotStrategyController } = require('../services/adaptiveSpotStrategyController');
const { getStrategyPromotionGate } = require('../services/spotStrategyPromotionController');
const { buildSpotCycleDecisionLog, logSpotCycleDecision } = require('../services/spotCycleObservability');
const { persistActivity, persistCycleEvidence } = require('../services/spotLiveEvidence');

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

router.post('/internal/cron/binance/spot-adaptive-strategy', requireCronSecret, async (_req, res) => {
  try {
    return res.json({ ok: true, ...(await runAdaptiveSpotStrategyController(db)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'ADAPTIVE_STRATEGY_FAILED', details: error.message });
  }
});

router.get('/spot-adaptive-strategy/status', async (_req, res) => {
  try {
    return res.json({ ok: true, ...(await getAdaptiveEntryGate(db)) });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

router.post('/internal/cron/binance/spot-real-execution', requireCronSecret, async (req, res) => {
  const startedAtMs = Date.now();
  const startedAt = new Date(startedAtMs).toISOString();
  let config = {};
  let reconciliation = {};
  let exits = {};
  let autonomy = {};
  let adaptiveGate = {};
  let promotionGate = {};
  let paperGate = {};
  let entries = {};
  try {
    await persistActivity(db, { event_type: 'SCHEDULER_START', source: 'CLOUD_SCHEDULER', created_at: startedAt, route: req.path });
    reconciliation = await reconcileManagedSpotAccount(db);
    await releaseReconciliationEntryGateWhenSafe(reconciliation);

    config = await getRealSpotConfig(db);
    exits = await evaluateAndExecuteRealSpotExits(db, config, req.body || {});
    const openAfterExit = await db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get();
    autonomy = await enforceAutonomousSafety(db, config);
    config = await getRealSpotConfig(db);
    [adaptiveGate, promotionGate] = await Promise.all([getAdaptiveEntryGate(db), getStrategyPromotionGate(db)]);

    const reconciliationBlocksEntry = reconciliation.account_consistent !== true || reconciliation.entries_blocked === true || config.reconciliation_required === true || config.account_consistent === false;
    const exitFailures = Array.isArray(exits.failures) ? exits.failures.length : 0;
    const exitEngineBlocksEntry = exits.blocked === true || exits.ok === false || exits.exit_engine_healthy === false || exitFailures > 0;
    const adaptiveBlocksEntry = adaptiveGate.allowed === false;
    const promotionBlocksEntry = promotionGate.allowed !== true;

    paperGate = { allowed: false, skipped: true, reasons: ['ENTRY_PRECONDITIONS_NOT_MET'], no_order_created: true, version: 'paper_to_real_entry_gate_v1' };
    entries = {
      ok: true,
      skipped: true,
      reason: reconciliationBlocksEntry ? 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED' :
        exitEngineBlocksEntry ? 'EXIT_ENGINE_NOT_HEALTHY' :
          adaptiveBlocksEntry ? 'ADAPTIVE_STRATEGY_DEGRADED' :
            promotionBlocksEntry ? 'STRATEGY_NOT_PROMOTED' :
              openAfterExit.size > 0 ? 'OPEN_POSITION_REMAINS' :
                autonomy.should_halt ? autonomy.halt_reason : 'PAPER_REAL_GATE_NOT_EVALUATED'
    };

    const baseEntryConditionsMet = !reconciliationBlocksEntry && !exitEngineBlocksEntry && !adaptiveBlocksEntry && !promotionBlocksEntry && openAfterExit.size === 0 && autonomy.should_halt !== true &&
      config.enabled === true && config.kill_switch !== true && config.new_entries_enabled === true && config.auto_order_execution === true && config.real_sells_enabled === true &&
      config.spot_only === true && config.futures_allowed !== true && config.margin_allowed !== true && config.leverage_allowed !== true && config.withdrawals_allowed === false;

    if (baseEntryConditionsMet) {
      paperGate = await evaluatePaperToRealEntryGate(db, config);
      const promotedSymbolMatches = !promotionGate.symbol || String(paperGate.candidate?.symbol || '').toUpperCase() === String(promotionGate.symbol).toUpperCase();
      if (paperGate.allowed === true && promotedSymbolMatches) {
        entries = await runRealSpotExecutionCycle(db, {
          ...req.body,
          controlled_exit_completed: true,
          exit_engine_healthy: true,
          reconciliation_completed: true,
          adaptive_strategy_gate_completed: true,
          adaptive_strategy_snapshot: adaptiveGate,
          strategy_promotion_gate_completed: true,
          strategy_promotion_snapshot: promotionGate,
          paper_real_gate_completed: true,
          paper_real_gate_snapshot: paperGate,
          autonomy_snapshot: autonomy
        });
      } else {
        entries = {
          ok: true,
          skipped: true,
          reason: paperGate.allowed !== true ? 'PAPER_REAL_ENTRY_GATE_BLOCKED' : 'PROMOTED_SYMBOL_MISMATCH',
          candidate: paperGate.candidate || null,
          promoted_symbol: promotionGate.symbol || null,
          gate_reasons: paperGate.allowed !== true ? (paperGate.reasons || []) : ['PROMOTED_SYMBOL_MISMATCH']
        };
      }
    }

    const durationMs = Date.now() - startedAtMs;
    const decisionLog = buildSpotCycleDecisionLog({ reconciliation, exits, autonomy, adaptiveGate, promotionGate, paperGate, entries, openPositionsAfterCycle: openAfterExit.size, durationMs, config });
    logSpotCycleDecision(decisionLog);
    const evidence = await persistCycleEvidence(db, {
      decision: decisionLog,
      started_at: startedAt,
      duration_ms: durationMs,
      reconciliation,
      exits,
      autonomy,
      adaptiveGate,
      promotionGate,
      paperGate,
      entries,
      config
    });

    return res.json({
      ok: reconciliation.ok !== false && exits.ok !== false && entries.ok !== false,
      real_mode: true,
      spot_only: true,
      futures: false,
      margin: false,
      leverage: false,
      withdrawals: false,
      reconciliation,
      autonomy,
      exits,
      exit_engine_blocks_entry: exitEngineBlocksEntry,
      adaptive_strategy_gate: adaptiveGate,
      adaptive_strategy_blocks_entry: adaptiveBlocksEntry,
      strategy_promotion_gate: promotionGate,
      strategy_promotion_blocks_entry: promotionBlocksEntry,
      paper_entry_gate: paperGate,
      entries,
      decision_summary: decisionLog,
      evidence_id: evidence.id,
      open_positions_after_cycle: openAfterExit.size,
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
        autonomy,
        adaptiveGate,
        promotionGate,
        paperGate,
        entries,
        config,
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
