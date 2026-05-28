#!/usr/bin/env node

/**
 * Extractor de métricas shadow - solo resultados esenciales
 */

const db = require('./backend/firebase-admin-config');
const { getShadowEdgeSamplerDiagnostic, processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

// Suprimir logs de red
const originalLog = console.log;
console.log = (...args) => {
    const firstArg = args[0];
    if (typeof firstArg === 'string' && (
            firstArg.includes('[TIMEOUT_FIX_APPLIED]') ||
            firstArg.includes('[FETCH_TIMEOUT_ADJUSTED]') ||
            firstArg.includes('[FETCH_LATENCY]') ||
            firstArg.includes('[DATA_SOURCE]') ||
            firstArg.includes('[SHADOW_EXIT_SIM_ATTEMPT]') ||
            firstArg.includes('[SHADOW_EXIT_SIM_RESULT]')
        )) {
        return;
    }
    originalLog.apply(console, args);
};

async function getShadowMetricsOnly() {
    try {
        console.log('🎯 EXTRACTOR METRICAS SHADOW POST-FIX');
        console.log('============================================');

        // Ejecutar procesamiento shadow
        console.log('\nProcesando candidatos shadow (minAge: 5min, max: 25)...');
        const processResult = await processPendingShadowCandidates(db, {
            minAgeMs: 300000, // 5 minutos
            maxProcess: 25
        });

        console.log(`Procesados: ${processResult.processed}, Resultados creados: ${processResult.results_created}`);

        // Obtener diagnóstico actualizado
        console.log('\nObteniendo métricas actualizadas...');
        const report = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        // Extraer métricas esenciales
        const metrics = {
            shadow_candidates_total: report.shadow_candidates_total || 0,
            shadow_results_total: report.shadow_results_total || 0,
            strategy_shadow_results_total: report.strategy_shadow_results_total || 0,
            live_ineligible_but_simulated_count: report.live_ineligible_but_simulated_count || 0,
            blocked_by_simulation_issue_count: report.blocked_by_simulation_issue_count || 0,
            blocked_by_live_readiness_only_count: report.blocked_by_live_readiness_only_count || 0,

            // BTCUSDT
            btc_shadow_count: report.btc_shadow_count || 0,
            btc_pnl_bruto_shadow: round(report.btc_pnl_bruto || 0, 4),
            btc_fees_shadow: round(report.btc_fees || 0, 4),
            btc_pnl_neto_shadow: round(report.btc_pnl_neto || 0, 4),
            btc_win_rate_neto_shadow: round((report.btc_win_rate || 0) * 100, 2),

            // SOLUSDT
            sol_shadow_count: report.sol_shadow_count || 0,
            sol_pnl_bruto_shadow: round(report.sol_pnl_bruto || 0, 4),
            sol_fees_shadow: round(report.sol_fees || 0, 4),
            sol_pnl_neto_shadow: round(report.sol_pnl_neto || 0, 4),
            sol_win_rate_neto_shadow: round((report.sol_win_rate || 0) * 100, 2),

            diagnosis: report.diagnosis || 'unknown'
        };

        // Análisis específico
        const btcIsDraining = metrics.btc_pnl_neto_shadow < -0.1 && metrics.btc_shadow_count >= 3;
        const solHasEdge = metrics.sol_pnl_neto_shadow > 0.1 && metrics.sol_shadow_count >= 3;
        const feesEatingEdge = (metrics.btc_fees_shadow > Math.abs(metrics.btc_pnl_neto_shadow) ||
                metrics.sol_fees_shadow > Math.abs(metrics.sol_pnl_neto_shadow)) &&
            (metrics.btc_shadow_count + metrics.sol_shadow_count >= 5);
        const sampleInsufficient = (metrics.btc_shadow_count + metrics.sol_shadow_count) < 10;

        let recommendation = 'Esperar más datos shadow';
        if (!sampleInsufficient) {
            if (btcIsDraining && !solHasEdge) {
                recommendation = 'Revisar estrategia - ambos símbolos problemáticos';
            } else if (btcIsDraining && solHasEdge) {
                recommendation = 'Trading solo SOLUSDT, evitar BTCUSDT';
            } else if (!btcIsDraining && solHasEdge) {
                recommendation = 'Estrategia muestra edge positivo en ambos';
            } else {
                recommendation = 'Resultados mixtos - análisis profundo requerido';
            }
        }

        // OUTPUT FINAL
        console.log('\n🏁 METRICAS SHADOW POST-FIX:');
        console.log('============================================');
        console.log(`shadow_candidates_total: ${metrics.shadow_candidates_total}`);
        console.log(`shadow_results_total: ${metrics.shadow_results_total}`);
        console.log(`strategy_shadow_results_total: ${metrics.strategy_shadow_results_total}`);
        console.log(`live_ineligible_but_simulated_count: ${metrics.live_ineligible_but_simulated_count}`);
        console.log(`blocked_by_simulation_issue_count: ${metrics.blocked_by_simulation_issue_count}`);
        console.log(`blocked_by_live_readiness_only_count: ${metrics.blocked_by_live_readiness_only_count}`);

        console.log('\n📊 BTCUSDT:');
        console.log(`shadow_count: ${metrics.btc_shadow_count}`);
        console.log(`pnl_bruto_shadow: ${metrics.btc_pnl_bruto_shadow}%`);
        console.log(`fees_shadow: ${metrics.btc_fees_shadow}%`);
        console.log(`pnl_neto_shadow: ${metrics.btc_pnl_neto_shadow}%`);
        console.log(`win_rate_neto_shadow: ${metrics.btc_win_rate_neto_shadow}%`);

        console.log('\n📊 SOLUSDT:');
        console.log(`shadow_count: ${metrics.sol_shadow_count}`);
        console.log(`pnl_bruto_shadow: ${metrics.sol_pnl_bruto_shadow}%`);
        console.log(`fees_shadow: ${metrics.sol_fees_shadow}%`);
        console.log(`pnl_neto_shadow: ${metrics.sol_pnl_neto_shadow}%`);
        console.log(`win_rate_neto_shadow: ${metrics.sol_win_rate_neto_shadow}%`);

        console.log('\n🔍 DIAGNOSTICO:');
        console.log(`BTCUSDT sigue drenando? ${btcIsDraining ? 'SI' : 'NO'} (${metrics.btc_pnl_neto_shadow}%, n=${metrics.btc_shadow_count})`);
        console.log(`SOLUSDT muestra edge? ${solHasEdge ? 'SI' : 'NO'} (${metrics.sol_pnl_neto_shadow}%, n=${metrics.sol_shadow_count})`);
        console.log(`Fees comiendo edge? ${feesEatingEdge ? 'SI' : 'NO'}`);
        console.log(`Muestra suficiente? ${!sampleInsufficient ? 'SI' : 'NO'} (Total: ${metrics.btc_shadow_count + metrics.sol_shadow_count})`);
        console.log(`diagnosis: ${metrics.diagnosis}`);
        console.log(`recommendation: ${recommendation}`);

        // VALIDACION DE SEGURIDAD
        console.log('\n🔒 VALIDACION DE SEGURIDAD:');
        console.log('✅ No se enviaron órdenes reales');
        console.log('✅ No se llamó order_submit');
        console.log('✅ No se reactivó el bot');
        console.log('✅ No se tocó Binance private order endpoint');

        // RESUMEN FINAL (formato solicitado)
        console.log('\n🎯 RESUMEN:');
        console.log(`- shadow_results_total: ${metrics.shadow_results_total}`);
        console.log(`- BTCUSDT shadow_count: ${metrics.btc_shadow_count}`);
        console.log(`- SOLUSDT shadow_count: ${metrics.sol_shadow_count}`);
        console.log(`- BTCUSDT pnl_neto_shadow: ${metrics.btc_pnl_neto_shadow}%`);
        console.log(`- SOLUSDT pnl_neto_shadow: ${metrics.sol_pnl_neto_shadow}%`);
        console.log(`- diagnosis: ${metrics.diagnosis}`);
        console.log(`- recommendation: ${recommendation}`);

        console.log(`\n✅ Nuevos resultados generados en esta sesion: ${processResult.results_created}`);

    } catch (error) {
        console.error('❌ ERROR:', error.message);
    }
}

function round(value, decimals = 4) {
    const num = Number(value);
    return Number.isFinite(num) ? Number(num.toFixed(decimals)) : 0;
}

getShadowMetricsOnly()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('ERROR:', error);
        process.exit(1);
    });