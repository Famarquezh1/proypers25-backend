#!/usr/bin/env node

/**
 * EDGE CONSOLIDATION FINAL REPORT - Diagnóstico Real + Shadow Completo
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

async function generateFinalReport() {
    console.log('🎯 REAL + SHADOW EDGE CONSOLIDATION DIAGNOSTIC');
    console.log('='.repeat(70));
    console.log('NOTA: Bot está HALTED - Análisis solo diagnóstico, NO reactivación');
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
        console.log(`📍 ¿Reactivar bot?: ${summary.reactivar_bot}`);

        console.log('\n📊 RESULTADO POR AGENTE:');
        console.log('─'.repeat(50));

        console.log('\n1. Real Trades:');
        const real = report.by_source.real;
        console.log(`   • Trades ejecutados: ${real.trades_count}`);
        console.log(`   • PnL bruto total: ${real.pnl_bruto_total}%`);
        console.log(`   • Fees total: ${real.fees_total}%`);
        console.log(`   • PnL neto total: ${real.pnl_neto_total}%`);
        console.log(`   • Win rate neto: ${real.win_rate_neto}%`);
        console.log(`   • Avg entry delay: ${Math.round(real.avg_entry_delay_ms/1000)}s`);

        console.log('\n2. Shadow Trades:');
        const shadow = report.by_source.shadow;
        console.log(`   • Trades simulados: ${shadow.trades_count}`);
        console.log(`   • PnL bruto total: ${shadow.pnl_bruto_total}%`);
        console.log(`   • Fees total: ${shadow.fees_total}%`);
        console.log(`   • PnL neto total: ${shadow.pnl_neto_total}%`);
        console.log(`   • Win rate neto: ${shadow.win_rate_neto}%`);

        console.log('\n3. Fees:');
        const fees = report.analysis.fees;
        console.log(`   • Avg fee por trade: ${fees.avg_fee_per_trade}%`);
        console.log(`   • Avg movimiento bruto: ${fees.avg_gross_move}%`);
        console.log(`   • Trades bruto+ pero neto-: ${fees.trades_bruto_positivo_neto_negativo}`);
        console.log(`   • Gap to break even: ${fees.gap_to_break_even}%`);

        console.log('\n4. Timing:');
        report.analysis.timing.forEach(bucket => {
            if (bucket.count > 0) {
                console.log(`   • ${bucket.delay_bucket}: ${bucket.count} trades, ${bucket.avg_pnl_neto}% avg PnL`);
            }
        });
        if (report.analysis.timing.every(bucket => bucket.count === 0)) {
            console.log(`   • Sin datos de timing (solo shadow tiene datos reales de delay)`);
        }

        console.log('\n5. Exit Logic:');
        report.analysis.exit_logic.forEach(exit => {
            if (exit.count > 0) {
                console.log(`   • ${exit.close_reason}: ${exit.count} trades, ${exit.avg_pnl_neto}% avg PnL`);
            }
        });

        console.log('\n6. Expected vs Realized:');
        const expected = report.analysis.expected_vs_realized;
        console.log(`   • Avg expected move: ${expected.avg_expected_move_at_entry}%`);
        console.log(`   • Avg realized move: ${expected.avg_realized_move}%`);
        console.log(`   • Overestimation ratio: ${expected.overestimation_ratio}x`);
        if (expected.expected_move_bins.some(bin => bin.count > 0)) {
            expected.expected_move_bins.forEach(bin => {
                if (bin.count > 0) {
                    console.log(`   • ${bin.expected_move_bin}: ${bin.count} trades, ${bin.avg_pnl_neto}% avg PnL`);
                }
            });
        } else {
            console.log(`   • Sin datos de expected move (solo trades reales)`);
        }

        console.log('\n7. Símbolos:');
        Object.entries(report.by_symbol).forEach(([symbol, data]) => {
            if (data.real_count > 0 || data.shadow_count > 0) {
                console.log(`   • ${symbol}:`);
                console.log(`     Real: ${data.real_count} trades, ${data.pnl_neto_real}% PnL`);
                console.log(`     Shadow: ${data.shadow_count} trades, ${data.pnl_neto_shadow}% PnL`);
                console.log(`     Combined: ${data.pnl_neto_combined}% PnL total`);
            }
        });

        console.log('\n8. Coordinador:');
        console.log(`   • Análisis combinado completado: ${report.generated_at}`);
        console.log(`   • Diagnósticos identificados: ${report.diagnosis.join(', ')}`);
        console.log(`   • Fuentes analizadas: real (${real.trades_count}), shadow (${shadow.trades_count})`);

        console.log('\n🎯 DECISIÓN:');
        console.log('─'.repeat(50));
        console.log(`📍 Acción recomendada: ${summary.accion_recomendada}`);
        console.log(`📍 Tipo: ${summary.tipo}`);
        console.log(`📍 Qué NO tocar: ${summary.que_no_tocar}`);
        console.log(`📍 Condición mínima para reactivación: ${summary.condicion_minima_reactivacion}`);

        console.log('\n🔒 META - DETERMINACIÓN FINAL:');
        console.log('─'.repeat(50));

        const btcCombined = report.by_symbol.BTCUSDT ? .pnl_neto_combined || 0;
        const solCombined = report.by_symbol.SOLUSDT ? .pnl_neto_combined || 0;
        const isGeneralProblem = btcCombined < 0 && solCombined < 0;

        console.log(`📍 BTCUSDT combinado: ${btcCombined}%`);
        console.log(`📍 SOLUSDT combinado: ${solCombined}%`);
        console.log(`📍 ¿Problema económico general?: ${isGeneralProblem ? 'SÍ' : 'NO'}`);
        console.log(`📍 ¿Sistema debe seguir HALTED?: ${summary.reactivar_bot === 'no' ? 'SÍ' : 'NO'}`);
        console.log(`📍 Edge evidence: ${summary.pnl_neto_real + summary.pnl_neto_shadow >= 0 ? 'POSITIVO' : 'NEGATIVO'}`);

        if (summary.diagnostico_principal === 'fees_dominate') {
            console.log('\n⚠️  CONCLUSIÓN: Las fees están dominando las ganancias brutas.');
            console.log('💡 RECOMENDACIÓN: Revisar sizing y estructura de fees antes de reactivar.');
        } else if (summary.diagnostico_principal === 'broad_no_edge') {
            console.log('\n❌ CONCLUSIÓN: No hay edge económico detectable en la estrategia actual.');
            console.log('💡 RECOMENDACIÓN: Mantener HALTED hasta evidencia sostenida de edge.');
        } else if (summary.diagnostico_principal === 'insufficient_sample') {
            console.log('\n📊 CONCLUSIÓN: Muestra insuficiente para conclusiones definitivas.');
            console.log('💡 RECOMENDACIÓN: Continuar shadow sampling para más datos.');
        }

        console.log('\n✅ DIAGNÓSTICO REAL + SHADOW COMPLETADO');
        console.log(`🎯 Endpoint disponible: GET /api/analizar/diagnostico/edge-consolidation`);

    } catch (error) {
        console.error('❌ ERROR en diagnóstico final:', error);
        console.error('Stack:', error.stack);
    }
}

generateFinalReport()
    .then(() => {
        console.log('\n🏁 Reporte final completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Reporte final falló:', error);
        process.exit(1);
    });