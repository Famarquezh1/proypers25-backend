// routes/analizar.route.js
const express = require('express');
const router = express.Router();
const simClasico = require('../scripts/sim_clasico');
const simCuantico = require('../scripts/sim_cuantico');
const db = require('../firebase-admin-config');
const { getNetEdgeDiagnostic } = require('../lib/netEdgeDiagnostic');
const { getPipelineBinanceDiagnostic } = require('../lib/pipelineBinanceDiagnostic');
const { getSignalGenerationDiagnostic } = require('../lib/signalGenerationDiagnostic');
const { getPredictionFlowDiagnostic } = require('../lib/predictionFlowDiagnostic');
const { getPredictionSaveDiagnostic } = require('../lib/predictionSaveDiagnostic');
const { getPrealertFlowDiagnostic } = require('../lib/prealertFlowDiagnostic');
const { getIntentExecutionDiagnostic } = require('../lib/intentExecutionDiagnostic');
const { getQualityGateImpactDiagnostic } = require('../lib/qualityGateImpactDiagnostic');
const { getMoveSizeDiagnostic } = require('../lib/moveSizeDiagnostic');
const { getExecutionBlockImpactDiagnostic } = require('../lib/executionBlockImpactDiagnostic');
const { getExecutionProtectionDiagnostic } = require('../lib/executionProtectionDiagnostic');
const { getPipelinePassRateDiagnostic } = require('../lib/pipelinePassRateDiagnostic');
const { getQualityGateBreakdownDiagnostic } = require('../lib/qualityGateBreakdownDiagnostic');
const { getExecutionFailuresDiagnostic } = require('../lib/executionFailuresDiagnostic');
const { getExecutionReadinessDiagnostic } = require('../lib/executionReadinessDiagnostic');
const { getExecutionHaltDiagnostic } = require('../lib/executionHaltDiagnostic');
const { getSignalIntentHandoffDiagnostic } = require('../lib/signalIntentHandoffDiagnostic');
const { getLiveOrderFailuresDiagnostic } = require('../lib/liveOrderFailuresDiagnostic');
const { getHighConvictionBlocksDiagnostic } = require('../lib/highConvictionBlocksDiagnostic');
const { getMarginLeverageReadinessDiagnostic } = require('../lib/marginLeverageReadinessDiagnostic');
const { getLeveragePreflightDiagnostic } = require('../lib/leveragePreflightDiagnostic');
const { getMinNotionalSizingDiagnostic } = require('../lib/minNotionalSizingDiagnostic');
const { getEntryOrderFailuresDiagnostic } = require('../lib/entryOrderFailuresDiagnostic');
const { getEntryOrderReconciliationDiagnostic } = require('../lib/entryOrderReconciliationDiagnostic');
const { getPnlCounterfactualDiagnostic } = require('../lib/pnlCounterfactualDiagnostic');
const { getPnlAttributionDiagnostic } = require('../lib/pnlAttributionDiagnostic');
const { getPnlFocusedCounterfactualDiagnostic } = require('../lib/pnlFocusedCounterfactualDiagnostic');
const { getSymbolEdgeReviewDiagnostic } = require('../lib/symbolEdgeReviewDiagnostic');
const { getShadowEdgeSamplerDiagnostic, processPendingShadowCandidates } = require('../lib/shadowEdgeSamplerDiagnostic');
const { getShadowValidationDiagnostic } = require('../lib/shadowValidationDiagnostic');
const { getEdgeConsolidationDiagnostic } = require('../lib/edgeConsolidationDiagnostic');
const { reconcileTimedOutEntryOrders } = require('../lib/binanceFuturesExecutor');
const { getLatestSpotOpportunityDiagnostic } = require('../services/binanceSpotOpportunityScanner');
const { getSpotOpportunityValidationDiagnostic } = require('../services/binanceSpotOpportunityValidation');
const { getSpotPaperExecutionDiagnostic } = require('../services/binanceSpotPaperExecutor');
const { getRealSpotExecutionDiagnostic, runRealSpotPreflightCheck } = require('../services/binanceSpotRealExecutor');

const ADMIN_SECRET = process.env.ADMIN_SECRET || process.env.CRON_SECRET || '';

function checkAdminSecret(req, res) {
    if (!ADMIN_SECRET) {
        res.status(500).json({ ok: false, error: 'ADMIN_SECRET not configured' });
        return false;
    }
    const provided =
        req.header('x-admin-secret') ||
        req.header('x-cron-secret') ||
        req.query.admin_secret ||
        req.query.cron_secret;
    if (!provided || provided !== ADMIN_SECRET) {
        res.status(403).json({ ok: false, error: 'Forbidden' });
        return false;
    }
    return true;
}

router.get('/analizar', async(req, res) => {
    const { codigo = 'Q0', simbolo = 'MSFT' } = req.query;

    const qubitN = parseInt(codigo.replace('Q', ''));
    if (isNaN(qubitN)) {
        return res.status(400).json({ error: 'Código inválido. Usa formato Q0, Q1, ..., Q15' });
    }

    try {
        let resultado;
        if (qubitN <= 10) {
            resultado = await simClasico(simbolo, qubitN);
            resultado.motor = 'clásico';
        } else {
            resultado = await simCuantico(simbolo, qubitN);
            resultado.motor = 'cuántico';
        }

        return res.status(200).json({ codigo, simbolo, resultado });
    } catch (error) {
        console.error(`❌ Error al procesar ${codigo}:`, error.message);
        return res.status(500).json({ error: 'Fallo durante el análisis', detalle: error.message });
    }
});

router.get('/diagnostico/neto', async(req, res) => {
    try {
        const report = await getNetEdgeDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[NET_EDGE_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_neto_failed'
        });
    }
});

router.get('/diagnostico/pnl-counterfactual', async(req, res) => {
    try {
        const report = await getPnlCounterfactualDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PNL_COUNTERFACTUAL_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_pnl_counterfactual_failed'
        });
    }
});

router.get('/diagnostico/pnl-attribution', async(req, res) => {
    try {
        const report = await getPnlAttributionDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PNL_ATTRIBUTION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_pnl_attribution_failed'
        });
    }
});

router.get('/diagnostico/pnl-focused-counterfactual', async(req, res) => {
    try {
        const report = await getPnlFocusedCounterfactualDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PNL_FOCUSED_COUNTERFACTUAL_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_pnl_focused_counterfactual_failed'
        });
    }
});

router.get('/diagnostico/symbol-edge-review', async(req, res) => {
    try {
        const report = await getSymbolEdgeReviewDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SYMBOL_EDGE_REVIEW_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_symbol_edge_review_failed'
        });
    }
});

router.get('/diagnostico/btcusdt-forensics', async(req, res) => {
    try {
        const report = await getSymbolEdgeReviewDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[BTCUSDT_FORENSICS_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_btcusdt_forensics_failed'
        });
    }
});

router.get('/diagnostico/shadow-edge-sampler', async(req, res) => {
    try {
        const report = await getShadowEdgeSamplerDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SHADOW_EDGE_SAMPLER_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_shadow_edge_sampler_failed'
        });
    }
});

router.get('/diagnostico/shadow-validation', async(req, res) => {
    try {
        const report = await getShadowValidationDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SHADOW_VALIDATION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_shadow_validation_failed'
        });
    }
});

router.get('/diagnostico/spot-opportunities', async(req, res) => {
    try {
        const report = await getLatestSpotOpportunityDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_OPPORTUNITIES_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_spot_opportunities_failed'
        });
    }
});

router.get('/diagnostico/spot-opportunity-validation', async(req, res) => {
    try {
        const report = await getSpotOpportunityValidationDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_OPPORTUNITY_VALIDATION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_spot_opportunity_validation_failed'
        });
    }
});

router.get('/diagnostico/spot-paper-execution', async(req, res) => {
    try {
        const report = await getSpotPaperExecutionDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_PAPER_EXECUTION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_spot_paper_execution_failed'
        });
    }
});

/**
 * GET /api/diagnostico/spot-real-execution
 * Public diagnostic endpoint for real Spot execution status
 * Returns config limits, open positions, closed positions, PnL, and recent errors
 */
router.get('/diagnostico/spot-real-execution', async(req, res) => {
    try {
        const report = await getRealSpotExecutionDiagnostic(db);
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_REAL_EXECUTION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_spot_real_execution_failed'
        });
    }
});

router.get('/diagnostico/edge-consolidation', async(req, res) => {
    try {
        const report = await getEdgeConsolidationDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EDGE_CONSOLIDATION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_edge_consolidation_failed'
        });
    }
});

router.post('/shadow/process-pending-candidates', async(req, res) => {
    try {
        if (!checkAdminSecret(req, res)) {
            return;
        }

        const result = await processPendingShadowCandidates(db, req.body || {});
        return res.status(200).json({
            ok: true,
            result
        });
    } catch (error) {
        console.error('[PROCESS_PENDING_SHADOW_CANDIDATES_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'process_pending_shadow_candidates_failed'
        });
    }
});

router.get('/diagnostico/pipeline-binance', async(req, res) => {
    try {
        const report = await getPipelineBinanceDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PIPELINE_BINANCE_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_pipeline_binance_failed'
        });
    }
});

router.get('/diagnostico/signal-generation', async(req, res) => {
    try {
        const report = await getSignalGenerationDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SIGNAL_GENERATION_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_signal_generation_failed'
        });
    }
});

router.get('/diagnostico/prediction-flow', async(req, res) => {
    try {
        const report = await getPredictionFlowDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PREDICTION_FLOW_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_prediction_flow_failed'
        });
    }
});

router.get('/diagnostico/prediction-save', async(req, res) => {
    try {
        const report = await getPredictionSaveDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PREDICTION_SAVE_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_prediction_save_failed'
        });
    }
});

router.get('/diagnostico/prealert-flow', async(req, res) => {
    try {
        const report = await getPrealertFlowDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PREALERT_FLOW_DIAGNOSTIC_ROUTE] error', error && error.message || error);
        return res.status(500).json({
            ok: false,
            error: error && error.message || 'diagnostico_prealert_flow_failed'
        });
    }
});

router.get('/diagnostico/intent-execution', async(req, res) => {
    try {
        const report = await getIntentExecutionDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[INTENT_EXECUTION_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_intent_execution_failed'
        });
    }
});

router.get('/diagnostico/quality-gate-impact', async(req, res) => {
    try {
        const report = await getQualityGateImpactDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[QUALITY_GATE_IMPACT_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_quality_gate_impact_failed'
        });
    }
});

router.get('/diagnostico/move-size', async(req, res) => {
    try {
        const report = await getMoveSizeDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[MOVE_SIZE_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_move_size_failed'
        });
    }
});

router.get('/diagnostico/execution-block-impact', async(req, res) => {
    try {
        const report = await getExecutionBlockImpactDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EXECUTION_BLOCK_IMPACT_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_execution_block_impact_failed'
        });
    }
});

router.get('/diagnostico/execution-protection', async(req, res) => {
    try {
        const report = await getExecutionProtectionDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EXECUTION_PROTECTION_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_execution_protection_failed'
        });
    }
});

router.get('/diagnostico/pipeline-pass-rate', async(req, res) => {
    try {
        const report = await getPipelinePassRateDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[PIPELINE_PASS_RATE_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_pipeline_pass_rate_failed'
        });
    }
});

router.get('/diagnostico/quality-gate-breakdown', async(req, res) => {
    try {
        const report = await getQualityGateBreakdownDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[QUALITY_GATE_BREAKDOWN_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_quality_gate_breakdown_failed'
        });
    }
});

router.get('/diagnostico/execution-failures', async(req, res) => {
    try {
        const report = await getExecutionFailuresDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EXECUTION_FAILURES_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_execution_failures_failed'
        });
    }
});

router.get('/diagnostico/execution-readiness', async(req, res) => {
    try {
        const report = await getExecutionReadinessDiagnostic(db);
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EXECUTION_READINESS_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_execution_readiness_failed'
        });
    }
});

router.get('/diagnostico/execution-halt', async(req, res) => {
    try {
        const report = await getExecutionHaltDiagnostic(db);
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[EXECUTION_HALT_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_execution_halt_failed'
        });
    }
});

router.get('/diagnostico/signal-intent-handoff', async(req, res) => {
    try {
        const report = await getSignalIntentHandoffDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SIGNAL_INTENT_HANDOFF_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_signal_intent_handoff_failed'
        });
    }
});

router.get('/diagnostico/live-order-failures', async(req, res) => {
    try {
        const report = await getLiveOrderFailuresDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[LIVE_ORDER_FAILURES_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_live_order_failures_failed'
        });
    }
});

router.get('/diagnostico/margin-leverage-readiness', async(req, res) => {
    try {
        const report = await getMarginLeverageReadinessDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[MARGIN_LEVERAGE_READINESS_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_margin_leverage_readiness_failed'
        });
    }
});

router.get('/diagnostico/leverage-preflight', async(req, res) => {
    try {
        const report = await getLeveragePreflightDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[LEVERAGE_PREFLIGHT_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_leverage_preflight_failed'
        });
    }
});

router.get('/diagnostico/min-notional-sizing', async(req, res) => {
    try {
        const report = await getMinNotionalSizingDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[MIN_NOTIONAL_SIZING_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_min_notional_sizing_failed'
        });
    }
});

router.get('/diagnostico/entry-order-failures', async(req, res) => {
    try {
        const report = await getEntryOrderFailuresDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[ENTRY_ORDER_FAILURES_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_entry_order_failures_failed'
        });
    }
});

router.get('/diagnostico/entry-order-reconciliation', async(req, res) => {
    try {
        const report = await getEntryOrderReconciliationDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[ENTRY_ORDER_RECONCILIATION_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_entry_order_reconciliation_failed'
        });
    }
});

router.post('/admin/reconcile-entry-order', async(req, res) => {
    if (!checkAdminSecret(req, res)) return;
    try {
        const body = req.body && typeof req.body === 'object' ? req.body : {};
        const intentIds = Array.isArray(body.intent_ids) ?
            body.intent_ids :
            body.intent_id ? [body.intent_id] : [];
        const maxDocs = Math.max(1, Math.min(200, Number(body.maxDocs || req.query.maxDocs || 25)));
        const timeoutMs = Math.max(3000, Math.min(20000, Number(body.timeoutMs || req.query.timeoutMs || 10000)));
        const result = await reconcileTimedOutEntryOrders(db, {
            intentIds,
            maxDocs,
            timeoutMs
        });
        return res.status(200).json({
            ok: true,
            mode: 'reconciliation_only',
            result
        });
    } catch (error) {
        console.error('[ENTRY_ORDER_RECONCILE_ADMIN_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'admin_reconcile_entry_order_failed'
        });
    }
});

router.get('/diagnostico/high-conviction-blocks', async(req, res) => {
    try {
        const report = await getHighConvictionBlocksDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[HIGH_CONVICTION_BLOCKS_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_high_conviction_blocks_failed'
        });
    }
});

router.get('/diagnostico/spot-paper-execution', async(req, res) => {
    try {
        const report = await getSpotPaperExecutionDiagnostic(db, req.query || {});
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_PAPER_EXECUTION_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_spot_paper_execution_failed'
        });
    }
});

router.get('/diagnostico/spot-real-execution-alt', async(req, res) => {
    try {
        const report = await getRealSpotExecutionDiagnostic(db);
        return res.status(200).json({
            ok: true,
            report
        });
    } catch (error) {
        console.error('[SPOT_REAL_EXECUTION_DIAGNOSTIC_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_spot_real_execution_failed'
        });
    }
});

/**
 * GET /api/diagnostico/spot-real-preflight
 * Public read-only preflight check for Binance Spot credentials and account
 * No orders created, no positions opened
 */
router.get('/diagnostico/spot-real-preflight', async(req, res) => {
    try {
        const report = await runRealSpotPreflightCheck(db);
        return res.status(200).json({
            ok: report.ok,
            preflight: report
        });
    } catch (error) {
        console.error('[SPOT_REAL_PREFLIGHT_ROUTE] error', error ?.message || error);
        return res.status(500).json({
            ok: false,
            error: error ?.message || 'diagnostico_spot_real_preflight_failed'
        });
    }
});

/**
 * GET /api/diagnostico/hybrid-mode
 * Hybrid strategy configuration and current exposure
 */
router.get('/diagnostico/hybrid-mode', async(req, res) => {
    try {
        // Get main config
        const configDoc = await db.collection('real_spot_config').doc('control').get();
        const moonshotDoc = await db.collection('real_spot_config').doc('moonshot_strategy').get();
        
        if (!configDoc.exists || !moonshotDoc.exists) {
            return res.status(400).json({
                ok: false,
                error: 'HYBRID_CONFIG_NOT_FOUND'
            });
        }
        
        const mainConfig = configDoc.data();
        const moonshotConfig = moonshotDoc.data();
        
        // Get open positions by strategy
        const conservativeOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'CONSERVATIVE')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        const moonshotOpen = await db.collection('real_spot_positions')
            .where('strategy', '==', 'MOONSHOT')
            .where('status', '==', 'REAL_OPEN')
            .get();
        
        // Calculate exposure
        let conservative_capital_used = 0;
        let moonshot_capital_used = 0;
        const conservative_positions = [];
        const moonshot_positions = [];
        
        conservativeOpen.forEach(doc => {
            const pos = doc.data();
            conservative_capital_used += Number(pos.capital_usdt || 0);
            conservative_positions.push({
                id: doc.id,
                symbol: pos.symbol,
                capital_usdt: pos.capital_usdt,
                entry_price: pos.entry_price,
                targets: {
                    tp1_pct: pos.take_profit_1_pct,
                    tp2_pct: pos.take_profit_2_pct,
                    sl_pct: pos.stop_loss_pct
                }
            });
        });
        
        moonshotOpen.forEach(doc => {
            const pos = doc.data();
            moonshot_capital_used += Number(pos.capital_usdt || 0);
            moonshot_positions.push({
                id: doc.id,
                symbol: pos.symbol,
                capital_usdt: pos.capital_usdt,
                entry_price: pos.entry_price,
                targets: {
                    tp1_pct: pos.take_profit_1_pct,
                    tp2_pct: pos.take_profit_2_pct,
                    tp3_pct: pos.strategy_info?.tp_targets?.[2] || null,
                    sl_pct: pos.stop_loss_pct
                },
                timeout_days: pos.strategy_info?.timeout_hours ? Math.round(pos.strategy_info.timeout_hours / 24) : 1
            });
        });
        
        return res.status(200).json({
            ok: true,
            mode: mainConfig.strategy_mode || 'HYBRID_70_30',
            enabled: mainConfig.enabled === true,
            
            allocation: {
                total_available_usdt: mainConfig.available_for_trading_usdt || 90,
                conservative_pct: mainConfig.conservative_strategy_pct || 70,
                moonshot_pct: mainConfig.moonshot_strategy_pct || 30,
                conservative_total_usdt: mainConfig.conservative_capital_usdt || 63,
                moonshot_total_usdt: mainConfig.moonshot_capital_usdt || 27
            },
            
            conservative_strategy: {
                capital_available: (mainConfig.conservative_capital_usdt || 63) - conservative_capital_used,
                capital_used: conservative_capital_used,
                capital_limit: mainConfig.conservative_capital_usdt || 63,
                targets: {
                    tp1_pct: mainConfig.take_profit_1_pct || 3,
                    tp2_pct: mainConfig.take_profit_2_pct || 6,
                    sl_pct: mainConfig.stop_loss_pct || -3
                },
                timeout_hours: 24,
                max_position_usdt: 15,
                open_positions_count: conservativeOpen.size,
                open_positions: conservative_positions
            },
            
            moonshot_strategy: {
                enabled: moonshotConfig.enabled === true,
                capital_available: (moonshotConfig.moonshot_capital_usdt || 27) - moonshot_capital_used,
                capital_used: moonshot_capital_used,
                capital_limit: moonshotConfig.moonshot_capital_usdt || 27,
                max_position_usdt: moonshotConfig.max_position_usdt || 4,
                max_open_positions: moonshotConfig.max_open_positions || 3,
                targets: {
                    tp1_pct: moonshotConfig.take_profit_1_pct || 50,
                    tp2_pct: moonshotConfig.take_profit_2_pct || 150,
                    tp3_pct: moonshotConfig.take_profit_3_pct || 500,
                    sl_pct: moonshotConfig.stop_loss_pct || -20
                },
                token_criteria: {
                    min_age_days: moonshotConfig.min_token_age_days,
                    max_age_days: moonshotConfig.max_token_age_days,
                    min_price_usd: moonshotConfig.min_price_usdt,
                    max_price_usd: moonshotConfig.max_price_usdt,
                    min_volume_usdt: moonshotConfig.min_volume_usdt,
                    min_holders: moonshotConfig.min_holders
                },
                timeout_hours: moonshotConfig.timeout_hours || 720,
                timeout_days: Math.round((moonshotConfig.timeout_hours || 720) / 24),
                open_positions_count: moonshotOpen.size,
                open_positions: moonshot_positions
            },
            
            summary: {
                total_capital_exposed: conservative_capital_used + moonshot_capital_used,
                total_available: (mainConfig.conservative_capital_usdt || 63) + (moonshotConfig.moonshot_capital_usdt || 27),
                total_open_positions: conservativeOpen.size + moonshotOpen.size,
                conservative_positions: conservativeOpen.size,
                moonshot_positions: moonshotOpen.size
            },
            
            timestamp: new Date().toISOString()
        });
        
    } catch (error) {
        console.error('[HYBRID_DIAG] Error:', error.message);
        return res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

module.exports = router;
