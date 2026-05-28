// lib/shadowFeeModelConstants.js

/**
 * SHADOW FEE MODEL - FUENTE ÚNICA DE VERDAD
 * Version: roundtrip_0_10_v1
 *
 * Constantes unificadas para todos los cálculos de fees shadow
 * NO modificar sin versionar apropiadamente
 */

// Shadow Fee Model Version
const SHADOW_FEE_MODEL_VERSION = "roundtrip_0_10_v1";

// Fee Components (basis points to percentage)
const SHADOW_FEE_ENTRY_PCT = 0.05; // 0.05% por entrada
const SHADOW_FEE_EXIT_PCT = 0.05; // 0.05% por salida
const SHADOW_FEE_ROUNDTRIP_PCT = 0.10; // 0.10% roundtrip total
const SHADOW_SLIPPAGE_PCT = 0; // 0% por ahora (sin fuente real)
const SHADOW_SPREAD_PCT = 0; // 0% por ahora (sin fuente real)
const SHADOW_TOTAL_COST_PCT = 0.10; // 0.10% costo total por trade

// Formula identifier
const SHADOW_FEE_FORMULA = "pnl_neto = pnl_bruto - 0.10%";

// Legacy detection
const LEGACY_FEE_VALUES = [0.20, 0.196]; // Valores que indican legacy model

/**
 * Calculate net PnL using current fee model
 */
function calculateShadowNetPnl(pnlBruto) {
    const bruto = Number(pnlBruto) || 0;
    return bruto - SHADOW_FEE_ROUNDTRIP_PCT;
}

/**
 * Get fee model metadata for shadow result
 */
function getShadowFeeModelMetadata() {
    return {
        fee_model_version: SHADOW_FEE_MODEL_VERSION,
        fee_entry_pct: SHADOW_FEE_ENTRY_PCT,
        fee_exit_pct: SHADOW_FEE_EXIT_PCT,
        fee_roundtrip_pct: SHADOW_FEE_ROUNDTRIP_PCT,
        slippage_pct: SHADOW_SLIPPAGE_PCT,
        spread_pct: SHADOW_SPREAD_PCT,
        total_cost_pct: SHADOW_TOTAL_COST_PCT,
        fee_formula_used: SHADOW_FEE_FORMULA
    };
}

/**
 * Determine if a shadow result uses legacy fee model
 */
function isLegacyFeeModel(shadowResult) {
    // Si no tiene version, es legacy
    if (!shadowResult.fee_model_version) {
        return true;
    }

    // Si la version no es la actual, es legacy
    if (shadowResult.fee_model_version !== SHADOW_FEE_MODEL_VERSION) {
        return true;
    }

    // Si el fee está en valores legacy conocidos, es legacy
    const fees = Number(shadowResult.fees) || 0;
    if (LEGACY_FEE_VALUES.some(legacyFee => Math.abs(fees - legacyFee) < 0.001)) {
        return true;
    }

    return false;
}

/**
 * Recalculate shadow result with current fee model
 */
function recalculateShadowResult(originalResult) {
    const pnlBruto = Number(originalResult.pnl_bruto) || 0;
    const pnlNeto = calculateShadowNetPnl(pnlBruto);
    const metadata = getShadowFeeModelMetadata();

    return {
        ...originalResult,
        ...metadata,
        fees: SHADOW_FEE_ROUNDTRIP_PCT,
        pnl_neto: pnlNeto,
        gross_win: pnlBruto > 0,
        net_win: pnlNeto > 0,
        recalculated_at: new Date().toISOString(),
        original_fees: originalResult.fees,
        original_pnl_neto: originalResult.pnl_neto
    };
}

module.exports = {
    SHADOW_FEE_MODEL_VERSION,
    SHADOW_FEE_ENTRY_PCT,
    SHADOW_FEE_EXIT_PCT,
    SHADOW_FEE_ROUNDTRIP_PCT,
    SHADOW_SLIPPAGE_PCT,
    SHADOW_SPREAD_PCT,
    SHADOW_TOTAL_COST_PCT,
    SHADOW_FEE_FORMULA,
    LEGACY_FEE_VALUES,
    calculateShadowNetPnl,
    getShadowFeeModelMetadata,
    isLegacyFeeModel,
    recalculateShadowResult
};