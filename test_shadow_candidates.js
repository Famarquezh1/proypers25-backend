#!/usr/bin/env node

/**
 * Script de prueba local para validar el sistema shadow candidatos
 * Ejecutar: node test_shadow_candidates.js
 */

const db = require('./backend/firebase-admin-config');
const { getShadowEdgeSamplerDiagnostic, processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

async function testShadowCandidates() {
    console.log('🔍 TESTING SHADOW CANDIDATES SYSTEM');
    console.log('='.repeat(50));

    try {
        // 1. Diagnóstico inicial
        console.log('\n📊 STEP 1: Diagnóstico inicial shadow edge sampler');
        const initialReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log(`📍 Candidatos shadow total: ${initialReport.shadow_candidates_total}`);
        console.log(`📍 Resultados shadow total: ${initialReport.shadow_results_total}`);
        console.log(`📍 Candidatos pendientes: ${initialReport.pending_candidates_count}`);
        console.log(`📍 Listos para simulación: ${initialReport.ready_for_exit_simulation_count}`);
        console.log(`📍 Candidatos bloqueados: ${initialReport.blocked_candidates_count}`);
        console.log(`📍 BTCUSDT shadow count: ${initialReport.btc_shadow_count}`);
        console.log(`📍 SOLUSDT shadow count: ${initialReport.sol_shadow_count}`);
        console.log(`📍 BTCUSDT PnL neto: ${initialReport.btc_pnl_neto}`);
        console.log(`📍 SOLUSDT PnL neto: ${initialReport.sol_pnl_neto}`);
        console.log(`📍 Diagnosis: ${initialReport.diagnosis}`);
        console.log(`📍 Recomendación: ${initialReport.recommendation}`);

        if (initialReport.pending_candidates_sample && initialReport.pending_candidates_sample.length > 0) {
            console.log('\n📋 SAMPLE DE CANDIDATOS PENDIENTES:');
            initialReport.pending_candidates_sample.forEach((sample, i) => {
                console.log(`  ${i+1}. ${sample.id}`);
                console.log(`     Symbol: ${sample.symbol}`);
                console.log(`     Entry: ${sample.simulated_entry_at}`);
                console.log(`     Blocked: ${sample.reason_if_blocked || 'No'}`);
                console.log(`     Quality: ${sample.would_have_passed_quality}`);
            });
        }

        // 2. Procesar candidatos pendientes
        console.log('\n🔄 STEP 2: Procesando candidatos pendientes');
        const processResult = await processPendingShadowCandidates(db, {
            minAgeMs: 30000, // 30 seconds
            maxProcess: 10 // Limit for testing
        });

        console.log(`📍 Candidatos encontrados: ${processResult.candidates_found}`);
        console.log(`📍 Candidatos pendientes: ${processResult.pending_candidates}`);
        console.log(`📍 Procesados: ${processResult.processed}`);
        console.log(`📍 Resultados creados: ${processResult.results_created}`);

        // 3. Diagnóstico post-proceso
        console.log('\n📊 STEP 3: Diagnóstico post-proceso');
        const finalReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log(`📍 Candidatos shadow total: ${finalReport.shadow_candidates_total}`);
        console.log(`📍 Resultados shadow total: ${finalReport.shadow_results_total}`);
        console.log(`📍 Candidatos pendientes: ${finalReport.pending_candidates_count}`);
        console.log(`📍 BTCUSDT shadow count: ${finalReport.btc_shadow_count}`);
        console.log(`📍 SOLUSDT shadow count: ${finalReport.sol_shadow_count}`);
        console.log(`📍 BTCUSDT PnL neto: ${finalReport.btc_pnl_neto}`);
        console.log(`📍 SOLUSDT PnL neto: ${finalReport.sol_pnl_neto}`);

        // 4. Verificación de progreso
        console.log('\n✅ STEP 4: Verificación de progreso');
        const candidatesDelta = finalReport.shadow_candidates_total - initialReport.shadow_candidates_total;
        const resultsDelta = finalReport.shadow_results_total - initialReport.shadow_results_total;

        console.log(`📍 Nuevos candidatos: ${candidatesDelta}`);
        console.log(`📍 Nuevos resultados: ${resultsDelta}`);
        console.log(`📍 Progreso en conversión: ${processResult.results_created > 0 ? '✅ SÍ' : '❌ NO'}`);

        // 5. Diagnóstico del sistema
        console.log('\n🔎 STEP 5: Diagnóstico del sistema');

        let systemStatus = 'UNKNOWN';
        let nextAction = 'unknown';

        if (finalReport.shadow_candidates_total === 0) {
            systemStatus = 'NO_CANDIDATES';
            nextAction = 'Esperar señales o verificar que el sampler esté funcionando';
        } else if (finalReport.shadow_results_total === 0) {
            systemStatus = 'NO_RESULTS';
            nextAction = 'Ejecutar processPendingShadowCandidates periódicamente';
        } else if (finalReport.pending_candidates_count > 0 && processResult.results_created === 0) {
            systemStatus = 'PROCESSING_BLOCKED';
            nextAction = 'Revisar logs de procesamiento y velas disponibles';
        } else if (finalReport.btc_shadow_count > 0 && finalReport.sol_shadow_count > 0) {
            systemStatus = 'WORKING';
            nextAction = 'Sistema funcionando, seguir observando';
        } else {
            systemStatus = 'PARTIAL_WORKING';
            nextAction = 'Sistema funcionando parcialmente, necesita más datos';
        }

        console.log(`📍 Estado del sistema: ${systemStatus}`);
        console.log(`📍 Próxima acción: ${nextAction}`);

        // 6. Resumen final
        console.log('\n🎯 RESUMEN EJECUTIVO:');
        console.log('='.repeat(50));
        console.log(`Sistema Shadow Status: ${systemStatus}`);
        console.log(`Candidatos creados en esta sesión: ${candidatesDelta}`);
        console.log(`Resultados creados en esta sesión: ${resultsDelta}`);
        console.log(`BTCUSDT PnL shadow: ${finalReport.btc_pnl_neto || 0}`);
        console.log(`SOLUSDT PnL shadow: ${finalReport.sol_pnl_neto || 0}`);
        console.log(`Recomendación: ${finalReport.recommendation}`);
        console.log(`Próximo paso: ${nextAction}`);

        if (systemStatus === 'WORKING') {
            console.log('\n🟢 ÉXITO: El sistema shadow está funcionando correctamente');
        } else if (systemStatus === 'PARTIAL_WORKING') {
            console.log('\n🟡 PARCIAL: El sistema shadow está funcionando pero necesita más datos');
        } else {
            console.log('\n🔴 PROBLEMA: El sistema shadow necesita intervención');
        }

    } catch (error) {
        console.error('\n❌ ERROR en test shadow candidates:', error);
        throw error;
    }
}

// Ejecutar test
testShadowCandidates()
    .then(() => {
        console.log('\n✅ Test completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Test falló:', error);
        process.exit(1);
    });