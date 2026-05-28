// lib/edgeConsolidationDiagnostic.js

const {
    SHADOW_FEE_MODEL_VERSION,
    isLegacyFeeModel
} = require('./shadowFeeModelConstants');

const {
    analyzeFeeModelVersioned,
    simulateEdgeFloorsExtended
} = require('./edgeConsolidationExtended');

// Fee model constants for validation
const EXPECTED_SHADOW_FEE_HARDCODED = 0.10; // From shadowEdgeSamplerDiagnostic.js
const EXPECTED_SHADOW_FEE_ENV_DEFAULT = 0.20; // From shadow_final_fix.js env var default

function normalizeSymbol(symbol) {
    if (!symbol) return '';
    return String(symbol).replace(/[^A-Z]/g, '').toUpperCase();
}

function toNumber(value, fallback = 0) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function round(value, precision) {
    return Math.round((value + Number.EPSILON) * Math.pow(10, precision)) / Math.pow(10, precision);
}

function classifyDelayBucket(delayMs) {
    if (delayMs < 30000) return '0-30s';
    if (delayMs < 60000) return '30-60s';
    if (delayMs < 90000) return '60-90s';
    if (delayMs < 120000) return '90-120s';
    return '>120s';
}

function classifyExpectedMoveBin(expectedMove) {
    if (expectedMove < 0.30) return '0.15-0.30';
    if (expectedMove < 0.60) return '0.30-0.60';
    if (expectedMove < 1.00) return '0.60-1.00';
    return '>1.00';
}

async function loadShadowResults(db, options = {}) {
    try {
        const snapshot = await db.collection('shadow_trade_results')
            .orderBy('updated_at', 'desc')
            .limit(500)
            .get();

        if (snapshot.empty) return { current: [], legacy: [], all: [] };

        const allResults = snapshot.docs.map(doc => ({
            id: doc.id,
            source: 'shadow',
            symbol: normalizeSymbol(doc.data().symbol),
            side: doc.data().side,
            pnl_bruto: toNumber(doc.data().pnl_bruto),
            pnl_neto: toNumber(doc.data().pnl_neto),
            fees: toNumber(doc.data().fees),
            simulated_close_reason: doc.data().simulated_close_reason,
            simulated_duration_ms: toNumber(doc.data().simulated_duration_ms),
            fee_model_version: doc.data().fee_model_version,
            gross_win: Boolean(doc.data().gross_win),
            net_win: Boolean(doc.data().net_win),
            created_at: doc.data().created_at,
            updated_at: doc.data().updated_at
        }));

        // Separar legacy vs current model results
        const legacyResults = allResults.filter(isLegacyFeeModel);
        const currentModelResults = allResults.filter(r => !isLegacyFeeModel(r));

        return {
            current: currentModelResults,
            legacy: legacyResults,
            all: allResults
        };
    } catch (error) {
        console.error('[LOAD_SHADOW_RESULTS] error:', error);
        return [];
    }
}

async function loadRealTrades(db, options = {}) {
    try {
        // Buscar en la colección de trades cerrados
        const hours = options.hours || 24;
        const cutoffTime = new Date(Date.now() - hours * 60 * 60 * 1000);

        // Intentar varias colecciones posibles
        const collections = ['closed_trades', 'trades_closed', 'binance_trades_closed'];
        let trades = [];

        for (const collectionName of collections) {
            try {
                const snapshot = await db.collection(collectionName)
                    .where('closed_at', '>=', cutoffTime)
                    .orderBy('closed_at', 'desc')
                    .limit(100)
                    .get();

                if (!snapshot.empty) {
                    trades = snapshot.docs.map(doc => {
                        const data = doc.data();
                        return {
                            id: doc.id,
                            source: 'real',
                            symbol: normalizeSymbol(data.symbol || data.simbolo),
                            side: data.side,
                            pnl_bruto: toNumber(data.pnl_bruto || data.gross_pnl_pct),
                            pnl_neto: toNumber(data.pnl_neto || data.net_pnl_pct),
                            fees: toNumber(data.fees || data.fee_roundtrip_pct),
                            close_reason: data.close_reason || data.simulated_close_reason,
                            duration_ms: toNumber(data.duration_ms || data.simulated_duration_ms),
                            entry_delay_ms: toNumber(data.entry_delay_ms),
                            gross_win: toNumber(data.pnl_bruto || data.gross_pnl_pct) > 0,
                            net_win: toNumber(data.pnl_neto || data.net_pnl_pct) > 0,
                            expected_move_percent: toNumber(data.expected_move_percent),
                            realized_move_percent: Math.abs(toNumber(data.pnl_bruto || data.gross_pnl_pct)),
                            created_at: data.created_at,
                            updated_at: data.updated_at,
                            closed_at: data.closed_at
                        };
                    });
                    break; // Encontramos datos, no necesitamos seguir buscando
                }
            } catch (error) {
                // Continuar con la siguiente colección
                console.log(`[LOAD_REAL_TRADES] Collection ${collectionName} not found or accessible`);
            }
        }

        return trades;
    } catch (error) {
        console.error('[LOAD_REAL_TRADES] error:', error);
        return [];
    }
}

function analyzeBySource(trades, source) {
    const filtered = trades.filter(t => t.source === source);

    if (filtered.length === 0) {
        return {
            trades_count: 0,
            pnl_bruto_total: 0,
            fees_total: 0,
            pnl_neto_total: 0,
            win_rate_bruto: 0,
            win_rate_neto: 0,
            avg_entry_delay_ms: 0,
            avg_duration_ms: 0,
            close_reason_breakdown: [],
            symbol_breakdown: []
        };
    }

    const tradesCount = filtered.length;
    const pnlBrutoTotal = round(filtered.reduce((sum, t) => sum + t.pnl_bruto, 0), 6);
    const feesTotal = round(filtered.reduce((sum, t) => sum + t.fees, 0), 6);
    const pnlNetoTotal = round(filtered.reduce((sum, t) => sum + t.pnl_neto, 0), 6);

    const grossWins = filtered.filter(t => t.gross_win).length;
    const netWins = filtered.filter(t => t.net_win).length;
    const winRateBruto = tradesCount ? round((grossWins / tradesCount) * 100, 2) : 0;
    const winRateNeto = tradesCount ? round((netWins / tradesCount) * 100, 2) : 0;

    const avgEntryDelay = source === 'real' ? round(filtered.reduce((sum, t) => sum + (t.entry_delay_ms || 0), 0) / tradesCount, 0) : 0;
    const avgDuration = round(filtered.reduce((sum, t) => sum + (t.duration_ms || 0), 0) / tradesCount, 0);

    // Close reason breakdown
    const closeReasonMap = {};
    filtered.forEach(trade => {
        const reason = trade.close_reason || trade.simulated_close_reason || 'unknown';
        if (!closeReasonMap[reason]) {
            closeReasonMap[reason] = { count: 0, pnl_neto_total: 0 };
        }
        closeReasonMap[reason].count++;
        closeReasonMap[reason].pnl_neto_total += trade.pnl_neto;
    });

    const closeReasonBreakdown = Object.entries(closeReasonMap).map(([reason, data]) => ({
        close_reason: reason,
        count: data.count,
        pnl_neto_total: round(data.pnl_neto_total, 6)
    }));

    // Symbol breakdown
    const symbolMap = {};
    filtered.forEach(trade => {
        const symbol = trade.symbol;
        if (!symbolMap[symbol]) {
            symbolMap[symbol] = { count: 0, pnl_neto_total: 0 };
        }
        symbolMap[symbol].count++;
        symbolMap[symbol].pnl_neto_total += trade.pnl_neto;
    });

    const symbolBreakdown = Object.entries(symbolMap).map(([symbol, data]) => ({
        symbol,
        count: data.count,
        pnl_neto_total: round(data.pnl_neto_total, 6)
    }));

    return {
        trades_count: tradesCount,
        pnl_bruto_total: pnlBrutoTotal,
        fees_total: feesTotal,
        pnl_neto_total: pnlNetoTotal,
        win_rate_bruto: winRateBruto,
        win_rate_neto: winRateNeto,
        avg_entry_delay_ms: avgEntryDelay,
        avg_duration_ms: avgDuration,
        close_reason_breakdown: closeReasonBreakdown,
        symbol_breakdown: symbolBreakdown
    };
}

function analyzeBySymbol(trades, symbol) {
    const realTrades = trades.filter(t => t.source === 'real' && t.symbol === symbol);
    const shadowTrades = trades.filter(t => t.source === 'shadow' && t.symbol === symbol);
    const allTrades = trades.filter(t => t.symbol === symbol);

    const realCount = realTrades.length;
    const shadowCount = shadowTrades.length;

    const pnlNetoReal = realCount ? round(realTrades.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;
    const pnlNetoShadow = shadowCount ? round(shadowTrades.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;
    const pnlNetoCombined = round(pnlNetoReal + pnlNetoShadow, 6);

    return {
        real_count: realCount,
        shadow_count: shadowCount,
        pnl_neto_real: pnlNetoReal,
        pnl_neto_shadow: pnlNetoShadow,
        pnl_neto_combined: pnlNetoCombined
    };
}

function analyzeFeesImpact(trades) {
    if (trades.length === 0) {
        return {
            avg_fee_per_trade: 0,
            avg_gross_move: 0,
            avg_net_move: 0,
            trades_bruto_positivo_neto_negativo: 0,
            gap_to_break_even: 0
        };
    }

    const avgFeePerTrade = round(trades.reduce((sum, t) => sum + t.fees, 0) / trades.length, 6);
    const avgGrossMove = round(trades.reduce((sum, t) => sum + Math.abs(t.pnl_bruto), 0) / trades.length, 6);
    const avgNetMove = round(trades.reduce((sum, t) => sum + t.pnl_neto, 0) / trades.length, 6);

    const brutoPosNetoNeg = trades.filter(t => t.pnl_bruto > 0 && t.pnl_neto <= 0).length;

    // Gap to break even: diferencia promedio entre fees y movimiento bruto positivo
    const positiveBrutoTrades = trades.filter(t => t.pnl_bruto > 0);
    const gapToBreakEven = positiveBrutoTrades.length ?
        round((positiveBrutoTrades.reduce((sum, t) => sum + t.fees, 0) / positiveBrutoTrades.length) -
            (positiveBrutoTrades.reduce((sum, t) => sum + t.pnl_bruto, 0) / positiveBrutoTrades.length), 6) : 0;

    return {
        avg_fee_per_trade: avgFeePerTrade,
        avg_gross_move: avgGrossMove,
        avg_net_move: avgNetMove,
        trades_bruto_positivo_neto_negativo: brutoPosNetoNeg,
        gap_to_break_even: gapToBreakEven
    };
}

function analyzeTimingImpact(trades) {
    const delayBuckets = ['0-30s', '30-60s', '60-90s', '90-120s', '>120s'];

    return delayBuckets.map(bucket => {
        const bucketTrades = trades.filter(t => {
            if (t.source !== 'real') return false; // Solo trades reales tienen delay
            return classifyDelayBucket(t.entry_delay_ms || 0) === bucket;
        });

        const count = bucketTrades.length;
        const pnlNetoTotal = count ? round(bucketTrades.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;
        const avgPnlNeto = count ? round(pnlNetoTotal / count, 6) : 0;

        return {
            delay_bucket: bucket,
            count,
            pnl_neto_total: pnlNetoTotal,
            avg_pnl_neto: avgPnlNeto
        };
    });
}

function analyzeExitLogic(trades) {
    const exitReasons = ['max_hold_reached', 'event_timeout_exit', 'stop_loss_hit', 'take_profit_hit', 'manual_close'];

    return exitReasons.map(reason => {
        const reasonTrades = trades.filter(t =>
            (t.close_reason === reason || t.simulated_close_reason === reason)
        );

        const count = reasonTrades.length;
        const pnlNetoTotal = count ? round(reasonTrades.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;
        const avgPnlNeto = count ? round(pnlNetoTotal / count, 6) : 0;

        return {
            close_reason: reason,
            count,
            pnl_neto_total: pnlNetoTotal,
            avg_pnl_neto: avgPnlNeto
        };
    });
}

function analyzeExpectedVsRealized(trades) {
    const realTradesWithExpected = trades.filter(t =>
        t.source === 'real' &&
        t.expected_move_percent > 0 &&
        t.realized_move_percent >= 0
    );

    if (realTradesWithExpected.length === 0) {
        return {
            avg_expected_move_at_entry: 0,
            avg_realized_move: 0,
            overestimation_ratio: 1,
            expected_move_bins: []
        };
    }

    const avgExpected = round(realTradesWithExpected.reduce((sum, t) => sum + t.expected_move_percent, 0) / realTradesWithExpected.length, 6);
    const avgRealized = round(realTradesWithExpected.reduce((sum, t) => sum + t.realized_move_percent, 0) / realTradesWithExpected.length, 6);
    const overestimationRatio = avgRealized > 0 ? round(avgExpected / avgRealized, 2) : 1;

    const expectedMoveBins = ['0.15-0.30', '0.30-0.60', '0.60-1.00', '>1.00'];
    const binAnalysis = expectedMoveBins.map(bin => {
        const binTrades = realTradesWithExpected.filter(t =>
            classifyExpectedMoveBin(t.expected_move_percent) === bin
        );

        const count = binTrades.length;
        const pnlNetoTotal = count ? round(binTrades.reduce((sum, t) => sum + t.pnl_neto, 0), 6) : 0;
        const avgPnlNeto = count ? round(pnlNetoTotal / count, 6) : 0;

        return {
            expected_move_bin: bin,
            count,
            pnl_neto_total: pnlNetoTotal,
            avg_pnl_neto: avgPnlNeto
        };
    });

    return {
        avg_expected_move_at_entry: avgExpected,
        avg_realized_move: avgRealized,
        overestimation_ratio: overestimationRatio,
        expected_move_bins: binAnalysis
    };
}

function classifyDiagnosis(realAnalysis, shadowAnalysis, symbolAnalysis, feesAnalysis, timingAnalysis, expectedVsRealizedAnalysis, feeModelAnalysis = {}) {
    const diagnoses = [];

    // Criterio 0: Fee model validation
    if (feeModelAnalysis.possible_fee_overcount === true) {
        diagnoses.push('fee_model_overcount_possible');
    }
    if (!feeModelAnalysis.fee_model_validated && feeModelAnalysis.fee_inconsistency_detected) {
        diagnoses.push('fee_model_ok_but_edge_insufficient');
    }

    // Criterio 1: Broad no edge - real y shadow negativos en símbolos principales
    const btcCombined = symbolAnalysis.BTCUSDT ? symbolAnalysis.BTCUSDT.pnl_neto_combined : 0;
    const solCombined = symbolAnalysis.SOLUSDT ? symbolAnalysis.SOLUSDT.pnl_neto_combined : 0;

    if (btcCombined < 0 && solCombined < 0 && (realAnalysis.pnl_neto_total < 0 || shadowAnalysis.pnl_neto_total < 0)) {
        if (feesAnalysis.trades_bruto_positivo_neto_negativo > 2) {
            diagnoses.push('fees_dominate');
        } else {
            diagnoses.push('broad_no_edge');
        }
    }

    // Criterio 2: Expected move overestimation
    if (expectedVsRealizedAnalysis.overestimation_ratio > 1.5) {
        diagnoses.push('expected_move_overestimation');
    }

    // Criterio 3: Fees dominate - muchos brutos positivos que se vuelven netos negativos
    if (feesAnalysis.trades_bruto_positivo_neto_negativo >= Math.max(1, realAnalysis.trades_count * 0.3)) {
        diagnoses.push('fees_dominate');
    }

    // Criterio 4: Timing delay issue - pérdidas concentradas en delays altos
    const highDelayBuckets = timingAnalysis.filter(bucket =>
        (bucket.delay_bucket === '90-120s' || bucket.delay_bucket === '>120s') &&
        bucket.count > 0 && bucket.avg_pnl_neto < -0.2
    );
    if (highDelayBuckets.length > 0) {
        diagnoses.push('timing_delay_issue');
    }

    // Criterio 5: Symbol specific issue
    const btcNegative = (symbolAnalysis.BTCUSDT && symbolAnalysis.BTCUSDT.pnl_neto_combined || 0) < -0.3;
    const solPositive = (symbolAnalysis.SOLUSDT && symbolAnalysis.SOLUSDT.pnl_neto_combined || 0) > 0;
    if (btcNegative && solPositive) {
        diagnoses.push('symbol_specific_issue');
    }

    // Criterio 6: Insufficient sample
    const totalTrades = realAnalysis.trades_count + shadowAnalysis.trades_count;
    if (totalTrades < 10) {
        diagnoses.push('insufficient_sample');
    }

    // Criterio 7: Net edge floor needed
    if (feeModelAnalysis.best_edge_floor && feeModelAnalysis.best_edge_floor.pnl_neto_simulado > 0) {
        diagnoses.push('net_edge_floor_needed');
    }

    // Criterio 8: No positive subgroup
    if (feeModelAnalysis.no_positive_subgroup === true) {
        diagnoses.push('no_positive_subgroup');
    }

    return diagnoses.length > 0 ? diagnoses : ['broad_no_edge'];
}

function generateExecutiveSummary(realAnalysis, shadowAnalysis, diagnosis, symbolAnalysis) {
    const totalRealTrades = realAnalysis.trades_count;
    const totalShadowTrades = shadowAnalysis.trades_count;
    const pnlNetoReal = realAnalysis.pnl_neto_total;
    const pnlNetoShadow = shadowAnalysis.pnl_neto_total;
    const mainDiagnosis = diagnosis[0] || 'insufficient_sample';

    // Decisión de reactivación basada en criterios estrictos
    const shouldReactivate = pnlNetoReal > 0 && pnlNetoShadow > 0 &&
        !diagnosis.includes('broad_no_edge') &&
        !diagnosis.includes('fees_dominate') &&
        (totalRealTrades + totalShadowTrades) >= 15;

    let recommendedAction;
    if (diagnosis.includes('insufficient_sample')) {
        recommendedAction = 'continuar_shadow_sampling';
    } else if (diagnosis.includes('broad_no_edge')) {
        recommendedAction = 'mantener_halted_indefinido';
    } else if (diagnosis.includes('fees_dominate')) {
        recommendedAction = 'revisar_sizing_y_fees';
    } else if (diagnosis.includes('symbol_specific_issue')) {
        recommendedAction = 'filtrar_simbolos_problematicos';
    } else if (diagnosis.includes('timing_delay_issue')) {
        recommendedAction = 'implementar_filtros_delay';
    } else {
        recommendedAction = 'monitorear_antes_reactivar';
    }

    const condicionMinima = diagnosis.includes('broad_no_edge') ?
        'Evidencia sostenida de edge positivo en shadow por 72h' :
        'PnL neto positivo sostenido en real y shadow, muestra n>=20';

    return {
        real_trades: totalRealTrades,
        shadow_trades: totalShadowTrades,
        pnl_neto_real: round(pnlNetoReal, 6),
        pnl_neto_shadow: round(pnlNetoShadow, 6),
        diagnostico_principal: mainDiagnosis,
        reactivar_bot: shouldReactivate ? 'sí' : 'no',
        accion_recomendada: recommendedAction,
        tipo: diagnosis.join(', '),
        que_no_tocar: 'model, thresholds, quality, handoff, sizing, capital, leverage, margin_type, max_concurrent_trades, order_submit',
        condicion_minima_reactivacion: condicionMinima
    };
}

async function getEdgeConsolidationDiagnostic(db, options = {}) {
    console.log('[EDGE_CONSOLIDATION_DIAGNOSTIC] starting analysis...');

    try {
        // Cargar datos
        const realTrades = await loadRealTrades(db, options);
        const shadowResultsData = await loadShadowResults(db, options);

        // Separar shadow results por versión de fee model
        const shadowTradesCurrent = shadowResultsData.current || [];
        const shadowTradesLegacy = shadowResultsData.legacy || [];
        const shadowTradesAll = shadowResultsData.all || [];

        // Usar solo current model para análisis principal
        const allTradesForAnalysis = [...realTrades, ...shadowTradesCurrent];

        const allTrades = allTradesForAnalysis;

        console.log(`[EDGE_CONSOLIDATION_DIAGNOSTIC] real: ${realTrades.length}, shadow_current: ${shadowTradesCurrent.length}, shadow_legacy: ${shadowTradesLegacy.length}`);

        // Análisis por fuente (current model)
        const realAnalysis = analyzeBySource(allTrades, 'real');
        const shadowAnalysis = analyzeBySource(allTrades, 'shadow');
        const combinedAnalysis = {
            ...analyzeBySource(allTrades, 'combined'),
            trades_count: realAnalysis.trades_count + shadowAnalysis.trades_count,
            pnl_neto_total: round(realAnalysis.pnl_neto_total + shadowAnalysis.pnl_neto_total, 6)
        };

        // Análisis legacy por separado
        const shadowAnalysisLegacy = analyzeBySource(shadowTradesLegacy, 'shadow');

        // Net Edge Gate Analysis
        const netEdgeGateAnalysis = analyzeNetEdgeGateImpact(allTrades);

        // Análisis por símbolo (current model)
        const symbols = ['BTCUSDT', 'SOLUSDT', 'ETHUSDT', 'BNBUSDT', 'XRPUSDT'];
        const symbolAnalysis = {};
        symbols.forEach(symbol => {
            symbolAnalysis[symbol] = analyzeBySymbol(allTrades, symbol);
        });

        // Análisis específicos (current model)
        const feesAnalysis = analyzeFeesImpact(allTrades);
        const timingAnalysis = analyzeTimingImpact(allTrades);
        const exitLogicAnalysis = analyzeExitLogic(allTrades);
        const expectedVsRealizedAnalysis = analyzeExpectedVsRealized(allTrades);

        // Análisis del fee model y simulaciones de edge floor (current model)
        const feeModelAnalysis = analyzeFeeModelVersioned(shadowTradesCurrent, shadowTradesLegacy, realAnalysis, shadowAnalysis);
        const edgeFloorSimulations = simulateEdgeFloorsExtended(shadowTradesCurrent);

        // Clasificación de diagnóstico
        const diagnosis = classifyDiagnosis(
            realAnalysis,
            shadowAnalysis,
            symbolAnalysis,
            feesAnalysis,
            timingAnalysis,
            expectedVsRealizedAnalysis, {...feeModelAnalysis, ...edgeFloorSimulations }
        );

        // Resumen ejecutivo
        const executiveSummary = generateExecutiveSummary(realAnalysis, shadowAnalysis, diagnosis, symbolAnalysis);

        return {
            executive_summary: executiveSummary,
            by_source: {
                real: realAnalysis,
                shadow: shadowAnalysis,
                shadow_legacy: shadowAnalysisLegacy,
                combined: combinedAnalysis
            },
            net_edge_gate_analysis: netEdgeGateAnalysis,
            by_symbol: symbolAnalysis,
            analysis: {
                fees: feesAnalysis,
                timing: timingAnalysis,
                exit_logic: exitLogicAnalysis,
                expected_vs_realized: expectedVsRealizedAnalysis,
                fee_model: feeModelAnalysis,
                edge_floor_simulations: edgeFloorSimulations
            },
            diagnosis: diagnosis,
            generated_at: new Date().toISOString()
        };

    } catch (error) {
        console.error('[EDGE_CONSOLIDATION_DIAGNOSTIC] error:', error);
        throw error;
    }
}

function analyzeFeeModel(allTrades, realAnalysis, shadowAnalysis) {
    const realTrades = allTrades.filter(t => t.source === 'real');
    const shadowTrades = allTrades.filter(t => t.source === 'shadow');

    // Calcular fees promedio
    const realFeeAvg = realTrades.length > 0 ?
        round(realTrades.reduce((sum, t) => sum + t.fees, 0) / realTrades.length, 6) : 0;
    const shadowFeeAvg = shadowTrades.length > 0 ?
        round(shadowTrades.reduce((sum, t) => sum + t.fees, 0) / shadowTrades.length, 6) : 0;

    // Detectar inconsistencias en fee model
    const expectedShadowFees = [EXPECTED_SHADOW_FEE_HARDCODED, EXPECTED_SHADOW_FEE_ENV_DEFAULT];
    const feeModelValidated = expectedShadowFees.includes(shadowFeeAvg) || shadowTrades.length === 0;

    // Detectar posible doble conteo
    const possibleFeeOvercount = shadowFeeAvg > EXPECTED_SHADOW_FEE_ENV_DEFAULT * 1.1;

    // Análisis de trades bruto+ neto-
    const shadowBrutoPositiveNetoNegative = shadowTrades.filter(t =>
        t.pnl_bruto > 0 && t.pnl_neto <= 0
    ).length;

    // Fórmula explicación
    const feeFormulaExplanation = shadowTrades.length > 0 ?
        `pnl_neto = pnl_bruto - ${shadowFeeAvg}% (fee fija por trade)` :
        'Sin shadow trades para analizar';

    return {
        real_fee_avg: realFeeAvg,
        shadow_fee_avg: shadowFeeAvg,
        fee_model_validated: feeModelValidated,
        possible_fee_overcount: possibleFeeOvercount,
        fee_formula_explanation: feeFormulaExplanation,
        expected_shadow_fees: expectedShadowFees,
        shadow_bruto_positive_neto_negative: shadowBrutoPositiveNetoNegative,
        fee_inconsistency_detected: !feeModelValidated && shadowTrades.length > 0
    };
}

function simulateEdgeFloors(shadowTrades) {
    if (shadowTrades.length === 0) {
        return {
            simulations: [],
            best_edge_floor: null,
            no_positive_subgroup: true
        };
    }

    // Calcular total_cost promedio (asumiendo que es igual al fee avg)
    const avgTotalCost = shadowTrades.reduce((sum, t) => sum + t.fees, 0) / shadowTrades.length;

    // Filtros a simular
    const filters = [
        { label: 'expected_move >= total_cost * 1.0', threshold: avgTotalCost * 1.0 },
        { label: 'expected_move >= total_cost * 1.25', threshold: avgTotalCost * 1.25 },
        { label: 'expected_move >= total_cost * 1.5', threshold: avgTotalCost * 1.5 },
        { label: 'expected_move >= total_cost * 2.0', threshold: avgTotalCost * 2.0 },
        { label: 'expected_move >= 0.20%', threshold: 0.20 },
        { label: 'expected_move >= 0.30%', threshold: 0.30 },
        { label: 'expected_move >= 0.40%', threshold: 0.40 },
        { label: 'expected_move >= 0.50%', threshold: 0.50 }
    ];

    const simulations = filters.map(filter => {
        // Para shadow trades, no tenemos expected_move, así que simularemos
        // basado en pnl_bruto como proxy del expected move potencial
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

// Analizar impacto del Net Edge Gate
function analyzeNetEdgeGateImpact(trades) {
    if (!trades || trades.length === 0) {
        return {
            total_signals: 0,
            would_be_blocked: 0,
            would_be_allowed: 0,
            blocked_percentage: 0,
            average_expected_move_blocked: 0,
            average_expected_move_allowed: 0,
            symbols_frequently_blocked: [],
            net_edge_gate_effective: false
        };
    }

    const gateFeeThreshold = 0.50; // Default gate threshold
    const feeRoundtrip = 0.10; // Current fee model

    let blockedCount = 0;
    let allowedCount = 0;
    let blockedExpectedMoveSum = 0;
    let allowedExpectedMoveSum = 0;
    const symbolBlockCounts = {};

    trades.forEach(trade => {
        const expectedMove = Number(trade.expected_move_percent || 0);
        const symbol = trade.symbol;

        // Simulate net edge gate logic
        const wouldBeBlocked = expectedMove < gateFeeThreshold;

        if (wouldBeBlocked) {
            blockedCount++;
            blockedExpectedMoveSum += expectedMove;
            symbolBlockCounts[symbol] = (symbolBlockCounts[symbol] || 0) + 1;
        } else {
            allowedCount++;
            allowedExpectedMoveSum += expectedMove;
        }
    });

    // Find symbols frequently blocked
    const symbolBlockEntries = Object.entries(symbolBlockCounts)
        .map(([symbol, blocks]) => ({
            symbol,
            blocks,
            total: trades.filter(t => t.symbol === symbol).length,
            block_rate: blocks / trades.filter(t => t.symbol === symbol).length
        }))
        .filter(entry => entry.block_rate > 0.5)
        .sort((a, b) => b.block_rate - a.block_rate);

    return {
        total_signals: trades.length,
        would_be_blocked: blockedCount,
        would_be_allowed: allowedCount,
        blocked_percentage: round((blockedCount / trades.length) * 100, 2),
        average_expected_move_blocked: blockedCount > 0 ? round(blockedExpectedMoveSum / blockedCount, 4) : 0,
        average_expected_move_allowed: allowedCount > 0 ? round(allowedExpectedMoveSum / allowedCount, 4) : 0,
        symbols_frequently_blocked: symbolBlockEntries.slice(0, 3),
        net_edge_gate_effective: blockedCount > allowedCount,
        gate_threshold_pct: gateFeeThreshold,
        fee_roundtrip_pct: feeRoundtrip
    };
}

module.exports = {
    getEdgeConsolidationDiagnostic
};