// analyzeFeeModelVersioned - Nueva función para análisis versionado
function analyzeFeeModelVersioned(shadowTradesCurrent, shadowTradesLegacy, realAnalysis, shadowAnalysis) {
    const {
        SHADOW_FEE_MODEL_VERSION,
        SHADOW_FEE_ROUNDTRIP_PCT,
        SHADOW_FEE_FORMULA
    } = require('./shadowFeeModelConstants');

    const realTrades = []; // Will be loaded separately if needed

    // Calcular fees promedio para cada versión
    const realFeeAvg = realTrades.length > 0 ?
        round(realTrades.reduce((sum, t) => sum + t.fees, 0) / realTrades.length, 6) : 0;

    const currentModelFeeAvg = shadowTradesCurrent.length > 0 ?
        round(shadowTradesCurrent.reduce((sum, t) => sum + t.fees, 0) / shadowTradesCurrent.length, 6) : 0;

    const legacyModelFeeAvg = shadowTradesLegacy.length > 0 ?
        round(shadowTradesLegacy.reduce((sum, t) => sum + t.fees, 0) / shadowTradesLegacy.length, 6) : 0;

    // Detectar versiones de fee model
    const feeModelVersionsDetected = [];
    if (shadowTradesCurrent.length > 0) {
        feeModelVersionsDetected.push(SHADOW_FEE_MODEL_VERSION);
    }
    if (shadowTradesLegacy.length > 0) {
        feeModelVersionsDetected.push('legacy');
    }

    // Validar consistencia del modelo actual
    const feeModelConsistent = shadowTradesLegacy.length === 0 ||
        (shadowTradesCurrent.length > 0 && Math.abs(currentModelFeeAvg - SHADOW_FEE_ROUNDTRIP_PCT) < 0.001);

    // Análisis de PnL por versión
    const shadowPnlNetoCurrentModel = shadowTradesCurrent.length > 0 ?
        round(shadowTradesCurrent.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;

    const shadowPnlNetoLegacy = shadowTradesLegacy.length > 0 ?
        round(shadowTradesLegacy.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;

    // Detectar posible sobreconteo en legacy
    const possibleFeeOvercount = legacyModelFeeAvg > SHADOW_FEE_ROUNDTRIP_PCT * 1.5;

    // Trades bruto+ neto- en modelo actual
    const currentModelBrutoPositiveNetoNegative = shadowTradesCurrent.filter(t =>
        t.pnl_bruto > 0 && t.pnl_neto <= 0
    ).length;

    return {
        fee_model_versions_detected: feeModelVersionsDetected,
        legacy_results_count: shadowTradesLegacy.length,
        current_fee_model_results_count: shadowTradesCurrent.length,
        fee_model_consistent: feeModelConsistent,
        shadow_fee_avg_current_model: currentModelFeeAvg,
        shadow_fee_avg_legacy: legacyModelFeeAvg,
        shadow_pnl_neto_current_model: shadowPnlNetoCurrentModel,
        shadow_pnl_neto_legacy: shadowPnlNetoLegacy,
        possible_fee_overcount: possibleFeeOvercount,
        real_fee_avg: realFeeAvg,
        fee_formula_explanation: SHADOW_FEE_FORMULA,
        current_model_bruto_positive_neto_negative: currentModelBrutoPositiveNetoNegative,
        improvement_vs_legacy: shadowPnlNetoCurrentModel - shadowPnlNetoLegacy
    };
}

// simulateEdgeFloorsExtended - Edge floor simulations extendidas
function simulateEdgeFloorsExtended(shadowTrades) {
    if (shadowTrades.length === 0) {
        return {
            simulations: [],
            best_edge_floor: null,
            no_positive_subgroup: true
        };
    }

    // Calcular total_cost promedio
    const avgTotalCost = shadowTrades.reduce((sum, t) => sum + t.fees, 0) / shadowTrades.length;

    // Filtros extendidos según user request
    const filters = [
        { label: 'expected_move >= 0.15%', threshold: 0.15 },
        { label: 'expected_move >= 0.20%', threshold: 0.20 },
        { label: 'expected_move >= 0.25%', threshold: 0.25 },
        { label: 'expected_move >= 0.30%', threshold: 0.30 },
        { label: 'expected_move >= 0.40%', threshold: 0.40 },
        { label: 'expected_move >= 0.50%', threshold: 0.50 },
        { label: 'expected_move >= 0.60%', threshold: 0.60 }
    ];

    const simulations = filters.map(filter => {
        // Usar pnl_bruto como proxy del expected move potencial
        const kept = shadowTrades.filter(t => {
            const proxyExpectedMove = Math.abs(t.pnl_bruto) + t.fees;
            return proxyExpectedMove >= filter.threshold;
        });
        const filtered = shadowTrades.length - kept.length;

        const pnlBrutoSimulado = kept.reduce((sum, t) => sum + t.pnl_bruto, 0);
        const feesSimuladas = kept.reduce((sum, t) => sum + t.fees, 0);
        const pnlNetoSimulado = pnlBrutoSimulado - feesSimuladas;
        const winRateNeto = kept.length > 0 ?
            round((kept.filter(t => t.pnl_neto > 0).length / kept.length) * 100, 2) : 0;

        const symbolsKept = [...new Set(kept.map(t => t.symbol))];

        return {
            filter: filter.label,
            threshold: round(filter.threshold, 4),
            trades_kept: kept.length,
            trades_filtered: filtered,
            pnl_bruto_simulado: round(pnlBrutoSimulado, 6),
            fees_simuladas: round(feesSimuladas, 6),
            pnl_neto_simulado: round(pnlNetoSimulado, 6),
            win_rate_neto: winRateNeto,
            symbols_kept: symbolsKept
        };
    });

    // Encontrar el mejor edge floor (primer filtro que da PnL neto positivo)
    const bestEdgeFloor = simulations.find(sim => sim.pnl_neto_simulado > 0) || null;

    // Detectar si no hay ningún subgrupo positivo
    const noPositiveSubgroup = simulations.every(sim => sim.pnl_neto_simulado <= 0);

    return {
        simulations,
        best_edge_floor: bestEdgeFloor,
        no_positive_subgroup: noPositiveSubgroup,
        avg_total_cost_used: round(avgTotalCost, 6)
    };
}

function round(value, precision) {
    return Math.round((value + Number.EPSILON) * Math.pow(10, precision)) / Math.pow(10, precision);
}

module.exports = {
    analyzeFeeModelVersioned,
    simulateEdgeFloorsExtended
};