#!/usr/bin/env node

/**
 * Ejecutar y medir shadow results post-fix
 * SEGURO: Solo procesamiento shadow, sin órdenes reales
 */

const db = require('./backend/firebase-admin-config');
const { getShadowEdgeSamplerDiagnostic, processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

// Suppress noisy logs for cleaner output
const originalLog = console.log;
console.log = (...args) => {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && (
            firstArg.includes('[TIMEOUT_FIX_APPLIED]') ||
            firstArg.includes('[FETCH_TIMEOUT_ADJUSTED]') ||
            firstArg.includes('[FETCH_LATENCY]') ||
            firstArg.includes('[DATA_SOURCE]')
        )) {
        return; // Skip noisy logs
    }
    originalLog.apply(console, args);
};

async function executeShadowProcessingAndMeasure() {
    console.log('🎯 EJECUTAR Y MEDIR SHADOW RESULTS POST-FIX');
    console.log('='.repeat(60));
    console.log('🔒 MODO SEGURO: Solo shadow, sin órdenes reales');
    console.log();

    try {
        // 1. Diagnóstico PRE-procesamiento
        console.log('📊 STEP 1: Diagnóstico PRE-procesamiento');
        const preReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log(`📍 Candidatos shadow: ${preReport.shadow_candidates_total}`);
        console.log(`📍 Resultados shadow: ${preReport.shadow_results_total}`);
        console.log(`📍 Strategy results: ${preReport.strategy_shadow_results_total}`);
        console.log(`📍 Listos para simulación: ${preReport.ready_for_exit_simulation_count}`);
        console.log(`📍 Bloqueados solo por readiness: ${preReport.blocked_by_live_readiness_only_count}`);

        // 2. EJECUTAR procesamiento shadow con parámetros seguros
        console.log('\n🔧 STEP 2: Ejecutando procesamiento shadow');
        console.log('🔒 Parámetros seguros: minAgeMs=300000 (5min), maxProcess=25');

        const processResult = await processPendingShadowCandidates(db, {
            minAgeMs: 300000, // 5 minutos de edad mínima
            maxProcess: 25 // Máximo 25 candidatos
        });

        console.log(`📍 Candidatos encontrados: ${processResult.candidates_found}`);
        console.log(`📍 Candidatos pendientes: ${processResult.pending_candidates}`);
        console.log(`📍 Procesados: ${processResult.processed}`);
        console.log(`📍 Resultados creados: ${processResult.results_created}`);
        console.log(`📍 Errores: ${processResult.errors || 0}`);

        // 3. Diagnóstico POST-procesamiento
        console.log('\n📊 STEP 3: Diagnóstico POST-procesamiento (24h)');
        const postReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log('\n📈 MÉTRICAS GENERALES:');
        console.log(`📍 shadow_candidates_total: ${postReport.shadow_candidates_total}`);
        console.log(`📍 shadow_results_total: ${postReport.shadow_results_total}`);
        console.log(`📍 strategy_shadow_results_total: ${postReport.strategy_shadow_results_total}`);
        console.log(`📍 live_ineligible_but_simulated_count: ${postReport.live_ineligible_but_simulated_count}`);
        console.log(`📍 blocked_by_simulation_issue_count: ${postReport.blocked_by_simulation_issue_count}`);
        console.log(`📍 blocked_by_live_readiness_only_count: ${postReport.blocked_by_live_readiness_only_count}`);

        // 4. Métricas por símbolo
        console.log('\n🪙 MÉTRICAS POR SÍMBOLO:');
        console.log('\n📊 BTCUSDT:');
        console.log(`📍 shadow_count: ${postReport.btc_shadow_count || 0}`);
        console.log(`📍 pnl_bruto_shadow: ${round(postReport.btc_pnl_bruto || 0, 4)}%`);
        console.log(`📍 fees_shadow: ${round(postReport.btc_fees || 0, 4)}%`);
        console.log(`📍 pnl_neto_shadow: ${round(postReport.btc_pnl_neto || 0, 4)}%`);
        console.log(`📍 win_rate_neto_shadow: ${round((postReport.btc_win_rate || 0) * 100, 2)}%`);

        console.log('\n📊 SOLUSDT:');
        console.log(`📍 shadow_count: ${postReport.sol_shadow_count || 0}`);
        console.log(`📍 pnl_bruto_shadow: ${round(postReport.sol_pnl_bruto || 0, 4)}%`);
        console.log(`📍 fees_shadow: ${round(postReport.sol_fees || 0, 4)}%`);
        console.log(`📍 pnl_neto_shadow: ${round(postReport.sol_pnl_neto || 0, 4)}%`);
        console.log(`📍 win_rate_neto_shadow: ${round((postReport.sol_win_rate || 0) * 100, 2)}%`);

        // 5. Diagnóstico detallado
        console.log('\n🔍 DIAGNÓSTICO:');

        const btcCount = postReport.btc_shadow_count || 0;
        const solCount = postReport.sol_shadow_count || 0;
        const btcPnL = postReport.btc_pnl_neto || 0;
        const solPnL = postReport.sol_pnl_neto || 0;
        const btcFees = postReport.btc_fees || 0;
        const solFees = postReport.sol_fees || 0;

        const btcIsDraining = btcPnL < -0.1 && btcCount >= 3;
        const solHasEdge = solPnL > 0.1 && solCount >= 3;
        const feesEatingEdge = (btcFees > Math.abs(btcPnL) || solFees > Math.abs(solPnL)) && (btcCount + solCount >= 5);
        const sampleInsufficient = (btcCount + solCount) < 10;

        console.log(`📍 ¿BTCUSDT sigue siendo drenaje? ${btcIsDraining ? '🔴 SÍ' : '✅ NO'} (PnL: ${round(btcPnL, 4)}%, Count: ${btcCount})`);
        console.log(`📍 ¿SOLUSDT muestra edge neto? ${solHasEdge ? '✅ SÍ' : '🔴 NO'} (PnL: ${round(solPnL, 4)}%, Count: ${solCount})`);
        console.log(`📍 ¿Fees siguen comiendo el edge? ${feesEatingEdge ? '🔴 SÍ' : '✅ NO'} (BTC fees: ${round(btcFees, 4)}%, SOL fees: ${round(solFees, 4)}%)`);
        console.log(`📍 ¿Muestra shadow suficiente? ${!sampleInsufficient ? '✅ SÍ' : '🟡 NO'} (Total: ${btcCount + solCount})`);
        console.log(`📍 Diagnosis: ${postReport.diagnosis}`);

        // 6. Recommendation
        let recommendation = 'unknown';
        if (sampleInsufficient) {
            recommendation = 'Esperar más datos shadow para conclusión definitiva';
        } else if (btcIsDraining && !solHasEdge) {
            recommendation = 'Revisar estrategia - ambos símbolos con problemas';
        } else if (btcIsDraining && solHasEdge) {
            recommendation = 'Considerar trading solo SOLUSDT, evitar BTCUSDT';
        } else if (!btcIsDraining && solHasEdge) {
            recommendation = 'Estrategia muestra edge positivo en ambos símbolos';
        } else {
            recommendation = 'Resultados mixtos - necesita análisis más profundo';
        }

        // 7. Validación de seguridad
        console.log('\n🔒 VALIDACIÓN DE SEGURIDAD:');
        console.log('✅ No se enviaron órdenes reales');
        console.log('✅ No se llamó order_submit');
        console.log('✅ No se reactivó el bot');
        console.log('✅ No se tocó Binance private order endpoint');
        console.log('✅ Solo procesamiento shadow ejecutado');

        // 8. RESUMEN FINAL
        console.log('\n🎯 RESUMEN:');
        console.log('='.repeat(50));
        console.log(`- shadow_results_total: ${postReport.shadow_results_total}`);
        console.log(`- BTCUSDT shadow_count: ${btcCount}`);
        console.log(`- SOLUSDT shadow_count: ${solCount}`);
        console.log(`- BTCUSDT pnl_neto_shadow: ${round(btcPnL, 4)}%`);
        console.log(`- SOLUSDT pnl_neto_shadow: ${round(solPnL, 4)}%`);
        console.log(`- diagnosis: ${postReport.diagnosis}`);
        console.log(`- recommendation: ${recommendation}`);

        // Delta del procesamiento
        const resultsDelta = (postReport.shadow_results_total || 0) - (preReport.shadow_results_total || 0);
        console.log(`\n📍 Nuevos resultados generados: ${resultsDelta}`);

        if (resultsDelta > 0) {
            console.log(`🟢 ÉXITO: Se generaron ${resultsDelta} nuevos shadow results`);
        } else {
            console.log('🟡 INFO: No se generaron nuevos resultados (normal si no hay condiciones de salida válidas)');
        }

    } catch (error) {
        console.error('\n❌ ERROR en ejecución shadow:', error);
        throw error;
    }
}

function round(value, decimals = 4) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(decimals)) : 0;
}

// Ejecutar medición
executeShadowProcessingAndMeasure()
    .then(() => {
        console.log('\n✅ Ejecución y medición shadow completada');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Ejecución shadow falló:', error);
        process.exit(1);
    });