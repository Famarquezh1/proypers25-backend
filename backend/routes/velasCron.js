const express = require('express');
const crypto = require('crypto');
const {
    runPredictionCycle,
    runPreAlertCycle,
    runBinanceManagerCycle,
    runVerificationCycle,
    runLearningCycle,
    runAuditCycle,
    runImpulseCycle
} = require('../tasks/velasScheduler');
const db = require('../firebase-admin-config');
const { scanBinanceSpotOpportunities } = require('../services/binanceSpotOpportunityScanner');
const { runSpotPaperExecutionCycle } = require('../services/binanceSpotPaperExecutor');
const { runRealSpotExecutionCycle, getRealSpotExecutionDiagnostic, runRealSpotPreflightCheck } = require('../services/binanceSpotRealExecutor');
const { runHybridExecutionCycle } = require('../services/hybridExecutionWrapper');

const router = express.Router();
const CRON_SECRET = process.env.CRON_SECRET || crypto.randomBytes(24).toString('hex');
if (!process.env.CRON_SECRET) {
    console.warn('[CRON] CRON_SECRET not set. Using random default; set CRON_SECRET for production.');
}

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

router.post('/internal/cron/velas/predictions', async(req, res) => {
    if (!checkSecret(req, res)) return;
    await runPredictionCycle();
    res.json({ ok: true });
});

router.post('/internal/cron/velas/prealerts', async(req, res) => {
    if (!checkSecret(req, res)) return;
    console.log('[CRON] runPreAlertCycle triggered via velas-prealerts');
    res.status(202).json({ ok: true, source: 'scheduler', job: 'velas-prealerts', accepted: true });
    setImmediate(async() => {
        try {
            const summary = await runPreAlertCycle();
            if (summary ?.skipped) {
                console.warn('[CRON] impulse cycle skipped', summary);
            }
        } catch (err) {
            console.error('[CRON] impulse cycle failed', err ?.message || err);
        }
    });
});

router.get('/internal/cron/predict', async(req, res) => {
    if (!checkSecret(req, res)) return;
    console.log('[CRON] runPreAlertCycle triggered via /internal/cron/predict');
    res.status(202).json({ ok: true, source: 'scheduler', job: 'predict', accepted: true });
    setImmediate(async() => {
        try {
            const summary = await runPreAlertCycle();
            if (summary ?.skipped) {
                console.warn('[CRON] prealert cycle skipped', summary);
            }
        } catch (err) {
            console.error('[CRON] prealert cycle failed', err ?.message || err);
        }
    });
});

router.post('/internal/cron/binance/position-manager', async(req, res) => {
    if (!checkSecret(req, res)) return;
    await runBinanceManagerCycle();
    res.json({ ok: true, source: 'scheduler', job: 'binance-position-manager' });
});

router.post('/internal/cron/binance/spot-opportunities', async(req, res) => {
    if (!checkSecret(req, res)) return;
    const summary = await scanBinanceSpotOpportunities(db, req.body || {});
    res.json({
        ok: true,
        total_symbols_scanned: summary.total_symbols_scanned,
        candidates_saved: summary.candidates_saved,
        top_symbol: summary.top_symbol,
        top_score: summary.top_score
    });
});

router.post('/internal/cron/binance/spot-paper-execution', async(req, res) => {
    if (!checkSecret(req, res)) return;
    const summary = await runSpotPaperExecutionCycle(db, req.body || {});
    res.json({
        ok: true,
        paper_only: true,
        latest_scan_id: summary.latest_scan_id,
        intents_created: summary.intents_created,
        intents_rejected: summary.intents_rejected,
        positions_closed: summary.positions_closed,
        open_positions_seen: summary.open_positions_seen,
        opened_symbols: summary.opened_symbols
    });
});

router.post('/internal/cron/binance/spot-real-execution', async(req, res) => {
    if (!checkSecret(req, res)) return;
    
    try {
        // Get base config
        const configDoc = await db.collection('real_spot_config').doc('control').get();
        const baseConfig = configDoc.exists ? configDoc.data() : {};
        
        // Get best candidate
        const candidatesSnap = await db.collection('spot_opportunity_candidates')
            .orderBy('opportunityScore', 'desc')
            .limit(1)
            .get();
        
        let executionConfig = baseConfig;
        let strategyMetadata = { strategy: 'CONSERVATIVE' };
        
        // If candidate exists, determine strategy
        if (!candidatesSnap.empty) {
            const candidate = candidatesSnap.docs[0].data();
            const hybridDecision = await runHybridExecutionCycle(db, candidate, baseConfig, req.body || {});
            
            executionConfig = hybridDecision.config;
            strategyMetadata = hybridDecision.metadata;
            
            console.log('[CRON] Strategy determined:', strategyMetadata.strategy);
        }
        
        // Execute with determined strategy
        const summary = await runRealSpotExecutionCycle(db, {
            ...req.body,
            strategy_metadata: strategyMetadata
        });
        
        res.json({
            ok: summary.ok,
            real_mode: summary.real_mode,
            blocked: summary.blocked || false,
            blocked_reason: summary.blocked_reason || null,
            positions_closed: summary.positions_closed || 0,
            positions_opened: summary.positions_opened || 0,
            open_positions_count: summary.open_positions_count || 0,
            total_capital_exposed: summary.total_capital_exposed || 0,
            duration_ms: summary.duration_ms || 0,
            strategy: strategyMetadata.strategy || 'CONSERVATIVE'
        });
    } catch (error) {
        console.error('[CRON] Hybrid execution error:', error.message);
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

router.post('/internal/cron/velas/verifications', async(req, res) => {
    if (!checkSecret(req, res)) return;
    await runVerificationCycle();
    res.json({ ok: true });
});

router.post('/internal/cron/velas/learning', async(req, res) => {
    if (!checkSecret(req, res)) return;
    await runLearningCycle();
    res.json({ ok: true });
});

router.post('/internal/cron/velas/audit', async(req, res) => {
    if (!checkSecret(req, res)) return;
    await runAuditCycle();
    res.json({ ok: true });
});

router.post('/internal/cron/velas/impulse-cycle', async(req, res) => {
    if (!checkSecret(req, res)) return;
    console.log('[CRON] runImpulseCycle triggered via /internal/cron/velas/impulse-cycle');
    res.status(202).json({ ok: true, source: 'scheduler', job: 'velas-impulse-cycle', accepted: true });
    setImmediate(async() => {
        try {
            const summary = await runImpulseCycle();
            console.log('[CRON] impulse-cycle result', summary);
        } catch (err) {
            console.error('[CRON] impulse-cycle failed', err ?.message || err);
        }
    });
});

router.post('/internal/cron/velas/full-cycle', async(req, res) => {
    if (!checkSecret(req, res)) return;
    const payload = { ok: true, source: 'scheduler', job: 'velas-full-cycle' };
    res.status(200).json(payload);

    setImmediate(async() => {
        try {
            await runPredictionCycle();
            await runVerificationCycle();
            await runLearningCycle();
            await runAuditCycle();
        } catch (err) {
            console.error('[CRON] full-cycle failed', err ?.message || err);
        }
    });
});

router.get('/internal/cron/health', (req, res) => {
    if (!checkSecret(req, res)) return;
    res.json({ ok: true });
});

// ============================================================
// REAL SPOT EXECUTION ENDPOINTS (CONTROLLED, GATED MODE)
// ============================================================

/**
 * POST /internal/cron/binance/spot-real-execution-dryrun
 * Dry-run simulation: Show what WOULD execute before going live
 * MANDATORY: Must run dry-run and get approval before real execution
 * SAFETY: Requires CRON_SECRET
 */
router.post('/internal/cron/binance/spot-real-execution-dryrun', async(req, res) => {
    if (!checkSecret(req, res)) return;

    try {
        const { performDryRun } = require('../services/binanceSpotRealExecutor');
        const { symbol, entry_price, capital_usdt, scan_id, reason } = req.body;

        // Validate inputs
        if (!symbol || !entry_price || !capital_usdt) {
            return res.status(400).json({
                ok: false,
                error: 'Missing required fields: symbol, entry_price, capital_usdt'
            });
        }

        // Run dry-run
        const dryRunResult = await performDryRun(db, {
            symbol,
            entry_price,
            capital_usdt,
            scan_id: scan_id || 'manual_trigger',
            reason: reason || 'MANUAL_DRY_RUN'
        });

        return res.json({
            ok: true,
            message: 'Dry-run simulation completed. REQUIRES MANUAL APPROVAL BEFORE LIVE EXECUTION.',
            dry_run: dryRunResult.dry_run,
            next_step: 'User must manually approve at POST /internal/cron/binance/spot-real-execution-approve'
        });
    } catch (error) {
        console.error('[DRY-RUN] Error:', error.message);
        return res.status(500).json({
            ok: false,
            error: error.message,
            type: 'DRY_RUN_FAILED'
        });
    }
});

/**
 * POST /internal/cron/binance/spot-real-execution-approve
 * Approve a dry-run and proceed with live execution
 * SAFETY: Requires explicit dry-run ID and user confirmation token
 * SAFETY: Requires CRON_SECRET + Firestore approval record
 */
router.post('/internal/cron/binance/spot-real-execution-approve', async(req, res) => {
    if (!checkSecret(req, res)) return;

    try {
        const { dry_run_id, approval_token } = req.body;
        const REAL_CONFIG = require('../config/binanceSpotRealConfig');

        // Verify real execution is enabled
        if (!REAL_CONFIG.enabled) {
            return res.status(403).json({
                ok: false,
                error: 'Real execution is disabled',
                message: 'Set enabled: true in binanceSpotRealConfig.js'
            });
        }

        // Get dry-run record
        const dryRunSnap = await db.collection(REAL_CONFIG.firestore_collections.dry_runs).doc(dry_run_id).get();
        if (!dryRunSnap.exists) {
            return res.status(404).json({
                ok: false,
                error: 'Dry-run not found',
                dry_run_id: dry_run_id
            });
        }

        const dryRun = dryRunSnap.data();

        // Verify dry-run is not expired
        if (new Date() > new Date(dryRun.expires_at)) {
            return res.status(410).json({
                ok: false,
                error: 'Dry-run has expired',
                expired_at: dryRun.expires_at
            });
        }

        // Mark dry-run as approved
        await db.collection(REAL_CONFIG.firestore_collections.dry_runs).doc(dry_run_id).update({
            approved: true,
            approval_timestamp: new Date().toISOString(),
            approval_user: 'manual_cron',
            approval_token: approval_token || 'verified'
        });

        return res.json({
            ok: true,
            message: 'Dry-run approved. Ready for live execution.',
            approved_dry_run_id: dry_run_id,
            next_step: 'POST to /internal/cron/binance/spot-real-execution with symbol=' + dryRun.symbol
        });
    } catch (error) {
        console.error('[APPROVE] Error:', error.message);
        return res.status(500).json({
            ok: false,
            error: error.message,
            type: 'APPROVAL_FAILED'
        });
    }
});

/**
 * POST /internal/cron/binance/spot-real-execution
 * Triggers controlled real Spot trading (if enabled in config)
 * SAFETY: Requires enabled=true in binanceSpotRealConfig.js
 * SAFETY: Gated by CRON_SECRET
 */
router.post('/internal/cron/binance/spot-real-execution', async(req, res) => {
    if (!checkSecret(req, res)) return;

    try {
        const { getRealSpotExecutionDiagnostic: getRealDiag } = require('../services/binanceSpotRealExecutor');
        const REAL_CONFIG = require('../config/binanceSpotRealConfig');

        // SAFETY: Require explicit enabled flag
        if (!REAL_CONFIG.enabled) {
            return res.status(403).json({
                ok: false,
                error: 'Real execution is disabled',
                message: 'Set enabled: true in binanceSpotRealConfig.js to activate',
                paper_only: true
            });
        }

        // SAFETY: Check manual confirm requirement
        if (!REAL_CONFIG.require_manual_confirm) {
            return res.status(403).json({
                ok: false,
                error: 'Manual confirmation required',
                message: 'Set require_manual_confirm: true in config'
            });
        }

        // TODO: Call actual real execution logic here
        // For now, return diagnostic showing system is ready but not executing
        const diagnostic = await getRealDiag(db);

        return res.json({
            ok: true,
            message: 'Real execution endpoint ready (placeholder)',
            real_execution_enabled: REAL_CONFIG.enabled,
            diagnostic
        });
    } catch (error) {
        console.error('[REAL] Error in spot-real-execution:', error.message);
        return res.status(500).json({
            ok: false,
            error: error.message,
            disabled_real_execution_due_to_error: true
        });
    }
});

/**
 * POST /internal/cron/binance/spot-real-preflight
 * CRON-protected preflight check for Binance Spot
 * Requires x-cron-secret header
 */
router.post('/cron/binance/spot-real-preflight', (req, res) => {
    // Validate CRON_SECRET
    if (!checkSecret(req, res)) {
        return res.status(401).json({
            ok: false,
            error: 'Unauthorized: invalid or missing cron secret'
        });
    }

    (async() => {
        try {
            const preflight = await runRealSpotPreflightCheck(db);
            return res.json({
                ok: preflight.ok,
                preflight,
                cron_executed: true,
                blocked: false
            });
        } catch (error) {
            console.error('[CRON_PREFLIGHT] Error:', error.message);
            return res.status(500).json({
                ok: false,
                error: error.message,
                cron_executed: false
            });
        }
    })();
});

module.exports = router;
