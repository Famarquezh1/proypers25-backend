#!/usr/bin/env node

/**
 * SHADOW FEE MODEL + NET EDGE FLOOR VERIFICATION
 * Validar si el modelo de fees shadow es correcto y determinar edge mínimo neto
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

async function verifyFeeModelAndEdgeFloor() {
    console.log('🔍 SHADOW FEE MODEL + NET EDGE FLOOR VERIFICATION');
    console.log('='.repeat(70));
    console.log('OBJETIVO: Validar fee model shadow y determinar edge floor mínimo');
    console.log('='.repeat(70));

    try {
        const report = await getEdgeConsolidationDiagnostic(db, {});

        console.log('\n💼 RESUMEN EJECUTIVO:');
        console.log('─'.repeat(50));
        const summary = report.executive_summary;
        console.log(`📍 Real trades: ${summary.real_trades}`);
        console.log(`📍 Shadow trades: ${summary.shadow_trades}`);
        console.log(`📍 PnL neto real: ${summary.pnl_neto_real}%`);
        console.log(`📍 PnL neto shadow: ${summary.pnl_neto_shadow}%`);
        console.log(`📍 Diagnóstico principal: ${summary.diagnostico_principal}`);

        console.log('\n💰 ANÁLISIS DEL FEE MODEL:');
        console.log('─'.repeat(50));
        const feeModel = report.analysis.fee_model;
        console.log(`📍 Real fee avg: ${feeModel.real_fee_avg}%`);
        console.log(`📍 Shadow fee avg: ${feeModel.shadow_fee_avg}%`);
        console.log(`📍 Fee model validated: ${feeModel.fee_model_validated}`);
        console.log(`📍 Possible fee overcount: ${feeModel.possible_fee_overcount}`);
        console.log(`📍 Fee inconsistency detected: ${feeModel.fee_inconsistency_detected}`);
        console.log(`📍 Expected shadow fees: [${feeModel.expected_shadow_fees.join('%, ')}%]`);
        console.log(`📍 Formula: ${feeModel.fee_formula_explanation}`);
        console.log(`📍 Shadow bruto+/neto- trades: ${feeModel.shadow_bruto_positive_neto_negative}`);

        console.log('\n🎯 EDGE FLOOR SIMULATIONS:');
        console.log('─'.repeat(50));
        const edgeFloor = report.analysis.edge_floor_simulations;
        console.log(`📍 Avg total cost usado: ${edgeFloor.avg_total_cost_used}%`);
        console.log(`📍 No positive subgroup: ${edgeFloor.no_positive_subgroup}`);
        console.log(`📍 Best edge floor: ${edgeFloor.best_edge_floor ? edgeFloor.best_edge_floor.filter : 'NINGUNO'}`);

        if (edgeFloor.best_edge_floor) {
            const best = edgeFloor.best_edge_floor;
            console.log(`📍 Best threshold: ${best.threshold}%`);
            console.log(`📍 Best trades kept: ${best.trades_kept}`);
            console.log(`📍 Best PnL neto simulado: ${best.pnl_neto_simulado}%`);
            console.log(`📍 Best win rate neto: ${best.win_rate_neto}%`);
        }

        console.log('\n📊 SIMULACIONES DETALLADAS:');
        console.log('─'.repeat(50));
        edgeFloor.simulations.forEach((sim, index) => {
            const isPositive = sim.pnl_neto_simulado > 0;
            const icon = isPositive ? '✅' : '❌';
            console.log(`${icon} ${sim.filter}:`);
            console.log(`   Threshold: ${sim.threshold}% | Kept: ${sim.trades_kept}/${sim.trades_kept + sim.trades_filtered}`);
            console.log(`   PnL Bruto: ${sim.pnl_bruto_simulado}% | Fees: ${sim.fees_simuladas}%`);
            console.log(`   PnL Neto: ${sim.pnl_neto_simulado}% | Win Rate: ${sim.win_rate_neto}%`);
            console.log(`   Symbols: [${sim.symbols_kept.join(', ')}]`);
        });

        console.log('\n🔬 DIAGNÓSTICOS EXTENDIDOS:');
        console.log('─'.repeat(50));
        console.log(`📍 Diagnósticos detectados: [${report.diagnosis.join(', ')}]`);

        console.log('\n🔍 COMPARACIÓN DE FEES:');
        console.log('─'.repeat(50));
        if (feeModel.real_fee_avg > 0) {
            const realVsShadow = ((feeModel.shadow_fee_avg - feeModel.real_fee_avg) / feeModel.real_fee_avg) * 100;
            console.log(`📍 Diferencia real vs shadow: ${realVsShadow.toFixed(2)}%`);
        } else {
            console.log(`📍 Sin trades reales para comparar fees`);
        }

        console.log('\n🧮 VALIDACIÓN DE FÓRMULA:');
        console.log('─'.repeat(50));
        console.log(`📍 Hardcoded esperado: 0.10%`);
        console.log(`📍 Env var default esperado: 0.20%`);
        console.log(`📍 Shadow fee actual: ${feeModel.shadow_fee_avg}%`);

        if (feeModel.shadow_fee_avg === 0.1) {
            console.log(`✅ Usando fee hardcoded (0.10%)`);
        } else if (feeModel.shadow_fee_avg === 0.2) {
            console.log(`⚠️ Usando env var default (0.20%)`);
        } else {
            console.log(`❌ Usando fee inconsistente (${feeModel.shadow_fee_avg}%)`);
        }

        console.log('\n⚖️ CONCLUSIÓN EDGE FLOOR:');
        console.log('─'.repeat(50));
        if (edgeFloor.no_positive_subgroup) {
            console.log(`❌ NINGÚN EDGE FLOOR genera PnL neto positivo`);
            console.log(`💡 Problema fundamental: Edge bruto insuficiente vs fees`);
        } else if (edgeFloor.best_edge_floor) {
            const best = edgeFloor.best_edge_floor;
            console.log(`✅ EDGE FLOOR ÓPTIMO: ${best.filter}`);
            console.log(`💡 Threshold mínimo: ${best.threshold}%`);
            console.log(`💡 Trades mantenidos: ${best.trades_kept}/${best.trades_kept + best.trades_filtered}`);
            console.log(`💡 PnL neto esperado: +${best.pnl_neto_simulado}%`);
        }

        console.log('\n🎯 RESPUESTA A PREGUNTAS CLAVE:');
        console.log('─'.repeat(50));

        if (feeModel.possible_fee_overcount) {
            console.log(`❓ ¿Fee model exagerado?: SÍ - Posible sobreconteo`);
        } else if (!feeModel.fee_model_validated) {
            console.log(`❓ ¿Fee model exagerado?: POSIBLE - Inconsistencia detectada`);
        } else {
            console.log(`❓ ¿Fee model exagerado?: NO - Fees correctas`);
        }

        if (edgeFloor.no_positive_subgroup) {
            console.log(`❓ ¿Edge bruto insuficiente?: SÍ - Ningún filtro mejora`);
        } else {
            console.log(`❓ ¿Edge bruto insuficiente?: NO - Filtro ${edgeFloor.best_edge_floor.threshold}% funciona`);
        }

        const finalAnswers = [];
        if (feeModel.possible_fee_overcount || !feeModel.fee_model_validated) {
            finalAnswers.push('FEE_MODEL_PROBLEMA');
        }
        if (edgeFloor.no_positive_subgroup) {
            finalAnswers.push('EDGE_BRUTO_INSUFICIENTE');
        }
        if (edgeFloor.best_edge_floor && edgeFloor.best_edge_floor.threshold > feeModel.shadow_fee_avg * 2) {
            finalAnswers.push('EDGE_FLOOR_ALTO_NECESARIO');
        }

        console.log(`❓ Problema principal: ${finalAnswers.length > 0 ? finalAnswers.join(' + ') : 'FEES_DOMINAN_EDGE_MARGINAL'}`);

        console.log('\n✅ VERIFICACIÓN DE FEE MODEL + EDGE FLOOR COMPLETADA');

    } catch (error) {
        console.error('❌ ERROR en verificación:', error);
        console.error('Stack:', error.stack);
    }
}

verifyFeeModelAndEdgeFloor()
    .then(() => {
        console.log('\n🏁 Verificación completada');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Verificación falló:', error);
        process.exit(1);
    });