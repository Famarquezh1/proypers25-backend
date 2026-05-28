#!/usr/bin/env node

/**
 * PRUEBA DIRECTA DE LA FUNCIÓN EDGE CONSOLIDATION
 * Test directo sin depender del router completo
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

async function testEdgeConsolidationExtended() {
    console.log('🧪 PRUEBA DIRECTA EDGE CONSOLIDATION EXTENDIDO');
    console.log('='.repeat(70));

    try {
        const report = await getEdgeConsolidationDiagnostic(db, {});

        console.log('✅ FUNCTION CALL SUCCESSFUL');

        console.log('\n📊 FEE MODEL ANALYSIS:');
        console.log('─'.repeat(40));
        if (report.analysis && report.analysis.fee_model) {
            const fm = report.analysis.fee_model;
            console.log(`Shadow fee avg: ${fm.shadow_fee_avg}%`);
            console.log(`Fee model validated: ${fm.fee_model_validated}`);
            console.log(`Possible fee overcount: ${fm.possible_fee_overcount}`);
            console.log(`Fee inconsistency detected: ${fm.fee_inconsistency_detected}`);
            console.log(`Formula: ${fm.fee_formula_explanation}`);
            console.log(`Expected fees: [${fm.expected_shadow_fees.join('%, ')}%]`);
        } else {
            console.log('❌ Fee model analysis not found');
        }

        console.log('\n🎯 EDGE FLOOR SIMULATIONS:');
        console.log('─'.repeat(40));
        if (report.analysis && report.analysis.edge_floor_simulations) {
            const efs = report.analysis.edge_floor_simulations;
            console.log(`No positive subgroup: ${efs.no_positive_subgroup}`);
            console.log(`Best edge floor: ${efs.best_edge_floor ? efs.best_edge_floor.filter : 'NINGUNO'}`);
            console.log(`Avg total cost used: ${efs.avg_total_cost_used}%`);
            console.log(`Simulations count: ${efs.simulations.length}`);

            // Mostrar primeros 3 como ejemplo
            if (efs.simulations.length > 0) {
                console.log('\n📋 SAMPLE SIMULATIONS:');
                efs.simulations.slice(0, 3).forEach((sim, index) => {
                    const positive = sim.pnl_neto_simulado > 0 ? '✅' : '❌';
                    console.log(`  ${positive} ${sim.filter}:`);
                    console.log(`    Threshold: ${sim.threshold}% | Kept: ${sim.trades_kept}`);
                    console.log(`    PnL Neto: ${sim.pnl_neto_simulado}% | Win Rate: ${sim.win_rate_neto}%`);
                });
            }
        } else {
            console.log('❌ Edge floor simulations not found');
        }

        console.log('\n🔬 DIAGNÓSTICOS EXTENDIDOS:');
        console.log('─'.repeat(40));
        if (report.diagnosis) {
            console.log(`Diagnósticos: [${report.diagnosis.join(', ')}]`);

            // Check for new diagnosis types
            const newDiagnosisTypes = [
                'fee_model_overcount_possible',
                'fee_model_ok_but_edge_insufficient',
                'net_edge_floor_needed',
                'no_positive_subgroup'
            ];

            const detectedNew = newDiagnosisTypes.filter(d => report.diagnosis.includes(d));
            if (detectedNew.length > 0) {
                console.log(`✅ New diagnosis types detected: [${detectedNew.join(', ')}]`);
            } else {
                console.log(`⚠️ No new diagnosis types detected`);
            }
        } else {
            console.log('❌ Diagnosis not found');
        }

        console.log('\n💼 EXECUTIVE SUMMARY:');
        console.log('─'.repeat(40));
        if (report.executive_summary) {
            const es = report.executive_summary;
            console.log(`Shadow trades: ${es.shadow_trades}`);
            console.log(`PnL neto shadow: ${es.pnl_neto_shadow}%`);
            console.log(`Diagnóstico principal: ${es.diagnostico_principal}`);
            console.log(`Reactivar bot: ${es.reactivar_bot}`);
            console.log(`Acción recomendada: ${es.accion_recomendada}`);
        } else {
            console.log('❌ Executive summary not found');
        }

        // VALIDATION CHECKS
        console.log('\n🔍 VALIDATION CHECKS:');
        console.log('─'.repeat(40));

        let validationPassed = true;

        if (!report.analysis || !report.analysis.fee_model) {
            console.log('❌ Fee model analysis missing');
            validationPassed = false;
        }

        if (!report.analysis || !report.analysis.edge_floor_simulations) {
            console.log('❌ Edge floor simulations missing');
            validationPassed = false;
        }

        if (report.diagnosis && report.diagnosis.length === 0) {
            console.log('❌ No diagnosis detected');
            validationPassed = false;
        }

        if (validationPassed) {
            console.log('✅ All validation checks passed');
        }

        console.log('\n🎯 FINAL ASSESSMENT:');
        console.log('─'.repeat(40));

        if (report.analysis.fee_model && report.analysis.fee_model.fee_inconsistency_detected) {
            console.log(`❓ Fee Model Problem: DETECTED (${report.analysis.fee_model.shadow_fee_avg}% vs expected 0.10%/0.20%)`);
        } else {
            console.log(`✅ Fee Model Problem: NOT DETECTED`);
        }

        if (report.analysis.edge_floor_simulations && report.analysis.edge_floor_simulations.no_positive_subgroup) {
            console.log(`❓ Edge Bruto Insufficient: CONFIRMED - No filter improves PnL`);
        } else {
            console.log(`✅ Edge Floor Found: ${report.analysis.edge_floor_simulations.best_edge_floor?.filter || 'UNKNOWN'}`);
        }

        console.log('\n✅ EXTENDED EDGE CONSOLIDATION TEST COMPLETADO');

    } catch (error) {
        console.error('❌ ERROR in extended test:', error);
        console.error('Stack:', error.stack);
        return 1;
    }

    return 0;
}

testEdgeConsolidationExtended()
    .then((exitCode) => {
        console.log(`\n🏁 Test completed with exit code: ${exitCode}`);
        process.exit(exitCode);
    })
    .catch(error => {
        console.error('❌ Test failed:', error);
        process.exit(1);
    });