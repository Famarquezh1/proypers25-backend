'use strict';

const express = require('express');
const crypto = require('crypto');
const db = require('../firebase-admin-config');
const { getRealSpotConfig, runRealSpotExecutionCycle } = require('../services/binanceSpotRealExecutor');
const { evaluateAndExecuteRealSpotExits, determineExit } = require('../services/controlledSpotExitExecutor');
const { reconcileRealSpotAccount } = require('../services/spotAccountReconciliation');
const { enforceAutonomousSafety } = require('../services/spotAutonomyController');

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

router.post('/internal/cron/binance/spot-real-execution', requireCronSecret, async (req, res) => {
  const startedAt = Date.now();
  try {
    // Binance is the source of truth. Reconcile manual conversions and balances
    // before any automatic SELL or BUY is considered.
    const reconciliation = await reconcileRealSpotAccount(db);

    // Exits are evaluated before entries so TP, SL and timeout remain protective.
    let config = await getRealSpotConfig(db);
    const exits = await evaluateAndExecuteRealSpotExits(db, config, req.body || {});

    const openAfterExit = await db.collection('real_spot_positions')
      .where('status', '==', 'REAL_OPEN')
      .get();

    // Recalculate autonomous risk only before considering another BUY.
    const autonomy = await enforceAutonomousSafety(db, config);
    config = await getRealSpotConfig(db);

    const reconciliationBlocksEntry = reconciliation.account_consistent !== true ||
      reconciliation.entries_blocked === true ||
      config.reconciliation_required === true ||
      config.account_consistent === false;

    let entries = {
      ok: true,
      skipped: true,
      reason: reconciliationBlocksEntry
        ? 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED'
        : openAfterExit.size > 0
          ? 'OPEN_POSITION_REMAINS'
          : autonomy.should_halt
            ? autonomy.halt_reason
            : 'ENTRY_NOT_REQUESTED'
    };

    // The legacy cycle may create a BUY only after the controlled exit executor
    // and reconciliation both completed successfully. It never handles exits here.
    const exitFailures = Array.isArray(exits.failures) ? exits.failures.length : 0;
    if (
      reconciliationBlocksEntry === false &&
      openAfterExit.size === 0 &&
      exitFailures === 0 &&
      autonomy.should_halt !== true &&
      config.enabled === true &&
      config.kill_switch !== true &&
      config.new_entries_enabled === true &&
      config.auto_order_execution === true &&
      config.real_sells_enabled === true &&
      config.spot_only === true &&
      config.futures_allowed !== true &&
      config.margin_allowed !== true &&
      config.leverage_allowed !== true &&
      config.withdrawals_allowed === false
    ) {
      entries = await runRealSpotExecutionCycle(db, {
        ...req.body,
        controlled_exit_completed: true,
        reconciliation_completed: true,
        autonomy_snapshot: autonomy
      });
    }

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
      entries,
      open_positions_after_cycle: openAfterExit.size,
      duration_ms: Date.now() - startedAt
    });
  } catch (error) {
    console.error('[CONTROLLED_REAL_SPOT] Cycle failed:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'CONTROLLED_REAL_SPOT_CYCLE_FAILED',
      details: error.message,
      duration_ms: Date.now() - startedAt
    });
  }
});

router.post('/internal/cron/binance/spot-real-reconcile', requireCronSecret, async (req, res) => {
  try {
    const reconciliation = await reconcileRealSpotAccount(db);
    return res.json({
      ok: reconciliation.ok !== false,
      real_mode: true,
      spot_only: true,
      no_order_created: true,
      reconciliation
    });
  } catch (error) {
    return res.status(500).json({ ok: false, error: 'SPOT_RECONCILIATION_FAILED', details: error.message });
  }
});

router.post('/internal/cron/binance/spot-real-exit-preview', requireCronSecret, async (req, res) => {
  try {
    const snapshot = await db.collection('real_spot_positions')
      .where('status', '==', 'REAL_OPEN')
      .get();
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
        timeout_at: position.timeout_at || null,
        no_order_created: true
      };
    });
    return res.json({ ok: true, preview_only: true, positions });
  } catch (error) {
    return res.status(500).json({ ok: false, error: error.message });
  }
});

module.exports = router;
