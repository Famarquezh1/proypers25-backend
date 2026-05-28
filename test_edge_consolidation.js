#!/usr/bin/env node

/**
 * Test Edge Consolidation Diagnostic - Verificar endpoint de diagnóstico consolidado
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
            firstArg.includes('[DATA_SOURCE]')
        )) {
        return;
    }
    originalLog.apply(console, args);
};

async function testEdgeConsolidation() {
    console.log('🧪 TESTING EDGE CONSOLIDATION DIAGNOSTIC');
    console.log('='.repeat(60));

    try {
        const startTime = Date.now();
        const report = await getEdgeConsolidationDiagnostic(db, {});
        const duration = Date.now() - startTime;

        console.log(`✅ Diagnóstico completado en ${duration}ms`);
        console.log('\n📊 RESUMEN EJECUTIVO:');
        console.log('─'.repeat(40));

        const summary = report.executive_summary;
        console.log(`Real trades: ${summary.real_trades}`);
        console.log(`Shadow trades: ${summary.shadow_trades}`);
        console.log(`PnL neto real: ${summary.pnl_neto_real}%`);
        console.log(`PnL neto shadow: ${summary.pnl_neto_shadow}%`);
        console.log(`Diagnóstico principal: ${summary.diagnostico_principal}`);
        console.log(`¿Reactivar bot?: ${summary.reactivar_bot}`);
        console.log(`Acción recomendada: ${summary.accion_recomendada}`);

        console.log('\n📊 POR FUENTE:');
        console.log('─'.repeat(40));
        console.log('Real:', {
            trades: report.by_source.real.trades_count,
            pnl_neto: `${report.by_source.real.pnl_neto_total}%`,
            win_rate: `${report.by_source.real.win_rate_neto}%`
        });
        console.log('Shadow:', {
            trades: report.by_source.shadow.trades_count,
            pnl_neto: `${report.by_source.shadow.pnl_neto_total}%`,
            win_rate: `${report.by_source.shadow.win_rate_neto}%`
        });

        console.log('\n📊 POR SÍMBOLO:');
        console.log('─'.repeat(40));
        Object.entries(report.by_symbol).forEach(([symbol, data]) => {
            if (data.real_count > 0 || data.shadow_count > 0) {
                console.log(`${symbol}:`, {
                    real_count: data.real_count,
                    shadow_count: data.shadow_count,
                    pnl_real: `${data.pnl_neto_real}%`,
                    pnl_shadow: `${data.pnl_neto_shadow}%`,
                    pnl_combined: `${data.pnl_neto_combined}%`
                });
            }
        });

        console.log('\n📊 ANÁLISIS DE FEES:');
        console.log('─'.repeat(40));
        const fees = report.analysis.fees;
        console.log(`Avg fee por trade: ${fees.avg_fee_per_trade}%`);
        console.log(`Avg movimiento bruto: ${fees.avg_gross_move}%`);
        console.log(`Trades bruto+ neto-: ${fees.trades_bruto_positivo_neto_negativo}`);
        console.log(`Gap to break even: ${fees.gap_to_break_even}%`);

        console.log('\n📊 ANÁLISIS DE TIMING:');
        console.log('─'.repeat(40));
        report.analysis.timing.forEach(bucket => {
            if (bucket.count > 0) {
                console.log(`${bucket.delay_bucket}: ${bucket.count} trades, ${bucket.avg_pnl_neto}% avg PnL`);
            }
        });

        console.log('\n📊 ANÁLISIS DE SALIDAS:');
        console.log('─'.repeat(40));
        report.analysis.exit_logic.forEach(exit => {
            if (exit.count > 0) {
                console.log(`${exit.close_reason}: ${exit.count} trades, ${exit.avg_pnl_neto}% avg PnL`);
            }
        });

        console.log('\n📊 EXPECTED VS REALIZED:');
        console.log('─'.repeat(40));
        const expected = report.analysis.expected_vs_realized;
        console.log(`Avg expected: ${expected.avg_expected_move_at_entry}%`);
        console.log(`Avg realized: ${expected.avg_realized_move}%`);
        console.log(`Overestimation ratio: ${expected.overestimation_ratio}x`);

        console.log('\n🔍 DIAGNÓSTICO:');
        console.log('─'.repeat(40));
        console.log(`Categorías: ${report.diagnosis.join(', ')}`);

        console.log('\n📋 DECISIÓN FINAL:');
        console.log('─'.repeat(40));
        console.log(`Acción: ${summary.accion_recomendada}`);
        console.log(`Tipo: ${summary.tipo}`);
        console.log(`No tocar: ${summary.que_no_tocar}`);
        console.log(`Condición mínima: ${summary.condicion_minima_reactivacion}`);

        console.log('\n✅ Test completado exitosamente');

    } catch (error) {
        console.error('❌ ERROR en test:', error);
        console.error('Stack:', error.stack);
    }
}

testEdgeConsolidation()
    .then(() => {
        console.log('\n🏁 Test finalizado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Test falló:', error);
        process.exit(1);
    });