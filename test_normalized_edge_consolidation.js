#!/usr/bin/env node

/**
 * PRUEBA EDGE CONSOLIDATION NORMALIZADO
 * Test del endpoint con fee model normalizado y edge floor simulations extendidas
 */

const { getEdgeConsolidationDiagnostic } = require('./backend/lib/edgeConsolidationDiagnostic');
const db = require('./backend/firebase-admin-config');

// Suprimir logs ruidosos
const originalLog = console.log;
console.log = (...args) => {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && (
            firstArg.includes('[TIMEOUT_FIX_APPLIED]') ||
            firstArg.includes('[FETCH_TIMEOUT_ADJUSTED]') ||
            firstArg.includes('[FETCH_LATENCY]') ||
            firstArg.includes('[DATA_SOURCE]') ||
            firstArg.includes('[EDGE_CONSOLIDATION_DIAGNOSTIC]')
        )) {
        return;
    }
    originalLog.apply(console, args);
};

async function testNormalizedEdgeConsolidation() {
    console.log('🎯 EDGE CONSOLIDATION NORMALIZADO - FEE MODEL 0.10%');
    console.log('='.repeat(70));
    console.log('OBJETIVO: Analizar edge con fee model unificado');
    console.log('='.repeat(70));

    try {
        const report = await getEdgeConsolidationDiagnostic(db, {});

        console.log('✅ FUNCTION CALL SUCCESSFUL');

        console.log('\n📑 RESUMEN EJECUTIVO:');
        console.log('─'.repeat(50));
        if (report.executive_summary) {
            const es = report.executive_summary;
            console.log(`📍 Shadow trades: ${es.shadow_trades}`);
            console.log(`📍 PnL neto shadow: ${es.pnl_neto_shadow}%`);
            console.log(`📍 Diagnóstico principal: ${es.diagnostico_principal}`);
            console.log(`📍 Reactivar bot: ${es.reactivar_bot}`);
            console.log(`📍 Acción recomendada: ${es.accion_recomendada}`);
        }

        console.log('\n📊 FEE MODEL ANALYSIS (Versionado):');
        console.log('─'.repeat(50));
        if (report.analysis && report.analysis.fee_model) {
            const fm = report.analysis.fee_model;
            console.log(`📍 Fee model versions detected: [${fm.fee_model_versions_detected.join(', ')}]`);
            console.log(`📍 Legacy results count: ${fm.legacy_results_count}`);
            console.log(`📍 Current model results count: ${fm.current_fee_model_results_count}`);
            console.log(`📍 Fee model consistent: ${fm.fee_model_consistent}`);
            console.log(`📍 Shadow fee avg current model: ${fm.shadow_fee_avg_current_model}%`);
            console.log(`📍 Shadow fee avg legacy: ${fm.shadow_fee_avg_legacy}%`);
            console.log(`📍 Shadow PnL neto current model: ${fm.shadow_pnl_neto_current_model}%`);
            console.log(`📍 Shadow PnL neto legacy: ${fm.shadow_pnl_neto_legacy}%`);
            console.log(`📍 Improvement vs legacy: ${fm.improvement_vs_legacy}%`);
            console.log(`📍 Possible fee overcount: ${fm.possible_fee_overcount}`);
        }

        console.log('\n🎯 EDGE FLOOR SIMULATIONS (Extendidas):');
        console.log('─'.repeat(50));
        if (report.analysis && report.analysis.edge_floor_simulations) {
            const efs = report.analysis.edge_floor_simulations;
            console.log(`📍 No positive subgroup: ${efs.no_positive_subgroup}`);
            console.log(`📍 Best edge floor: ${efs.best_edge_floor ? efs.best_edge_floor.filter : 'NINGUNO'}`);
            console.log(`📍 Avg total cost used: ${efs.avg_total_cost_used}%`);
            console.log(`📍 Simulations count: ${efs.simulations.length}`);

            if (efs.best_edge_floor) {
                const best = efs.best_edge_floor;
                console.log(`📍 Best threshold: ${best.threshold}%`);
                console.log(`📍 Best trades kept: ${best.trades_kept}`);
                console.log(`📍 Best PnL neto simulado: ${best.pnl_neto_simulado}%`);
                console.log(`📍 Best win rate neto: ${best.win_rate_neto}%`);
            }

            console.log('\n📋 TODAS LAS SIMULACIONES:');
            efs.simulations.forEach((sim, index) => {
                const isPositive = sim.pnl_neto_simulado > 0;
                const icon = isPositive ? '✅' : '❌';
                console.log(`  ${icon} ${sim.filter}:`);
                console.log(`    Threshold: ${sim.threshold}% | Kept: ${sim.trades_kept}`);
                console.log(`    PnL Neto: ${sim.pnl_neto_simulado}% | Win Rate: ${sim.win_rate_neto}%`);
                console.log(`    Symbols: [${sim.symbols_kept.join(', ')}]`);
            });
        }

        console.log('\n📊 SOURCE ANALYSIS:');
        console.log('─'.repeat(50));
        if (report.by_source) {
            console.log(`📍 Shadow current: ${report.by_source.shadow.trades_count} trades, ${report.by_source.shadow.pnl_neto_total}% PnL`);
            console.log(`📍 Shadow legacy: ${report.by_source.shadow_legacy.trades_count} trades, ${report.by_source.shadow_legacy.pnl_neto_total}% PnL`);
            console.log(`📍 Real: ${report.by_source.real.trades_count} trades, ${report.by_source.real.pnl_neto_total}% PnL`);
        }

        console.log('\n🔬 DIAGNÓSTICOS:');
        console.log('─'.repeat(50));
        if (report.diagnosis) {
            console.log(`📍 Diagnósticos detectados: [${report.diagnosis.join(', ')}]`);

            // Check for normalized specific diagnosis
            const normalizedDiagnosisTypes = [
                'fee_model_normalized_edge_still_negative',
                'fee_model_was_overcounting',
                'edge_floor_candidate_found',
                'no_positive_subgroup'
            ];

            const detectedNormalized = normalizedDiagnosisTypes.filter(d => report.diagnosis.includes(d));
            if (detectedNormalized.length > 0) {
                console.log(`✅ Normalized diagnosis detected: [${detectedNormalized.join(', ')}]`);
            }
        }

        console.log('\n🎯 CONCLUSIÓN FINAL:');
        console.log('─'.repeat(50));

        const feeModelAnalysis = report.analysis ? .fee_model;
        const edgeFloorAnalysis = report.analysis ? .edge_floor_simulations;

        if (feeModelAnalysis) {
            const feeImprovement = feeModelAnalysis.improvement_vs_legacy;
            if (feeImprovement > 0) {
                console.log(`✅ Fee normalization MEJORA performance en ${feeImprovement}%`);
            } else {
                console.log(`❌ Fee normalization NO mejora performance significativamente`);
            }
        }

        if (edgeFloorAnalysis) {
            if (edgeFloorAnalysis.no_positive_subgroup) {
                console.log(`❌ EDGE BRUTO SIGUE INSUFICIENTE - Ningún threshold genera PnL positivo`);
            } else {
                console.log(`✅ EDGE FLOOR ENCONTRADO: ${edgeFloorAnalysis.best_edge_floor.filter}`);
                console.log(`💡 Threshold óptimo: ${edgeFloorAnalysis.best_edge_floor.threshold}%`);
            }
        }

        // Determinar respuesta final
        const problems = [];
        if (feeModelAnalysis ? .improvement_vs_legacy < 0.05) {
            problems.push('FEE_NORMALIZATION_INSUFFICIENT');
        }
        if (edgeFloorAnalysis ? .no_positive_subgroup) {
            problems.push('EDGE_BRUTO_FUNDAMENTALLY_NEGATIVE');
        }

        console.log(`🎯 PROBLEMA PRINCIPAL: ${problems.join(' + ')}`);

        if (problems.includes('EDGE_BRUTO_FUNDAMENTALLY_NEGATIVE')) {
            console.log(`💡 RECOMENDACIÓN: Estrategia necesita revisión fundamental`);
        } else if (feeModelAnalysis ? .best_edge_floor) {
            console.log(`💡 RECOMENDACIÓN: Filtrar por edge floor ${feeModelAnalysis.best_edge_floor.threshold}%`);
        }

        console.log('\n✅ NORMALIZED EDGE CONSOLIDATION TEST COMPLETADO');

    } catch (error) {
        console.error('❌ ERROR in normalized test:', error);
        console.error('Stack:', error.stack);
        return 1;
    }

    return 0;
}

testNormalizedEdgeConsolidation()
    .then((exitCode) => {
        console.log(`\n🏁 Test completed with exit code: ${exitCode}`);
        process.exit(exitCode);
    })
    .catch(error => {
        console.error('❌ Test failed:', error);
        process.exit(1);
    });