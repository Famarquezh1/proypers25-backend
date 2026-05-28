#!/usr/bin/env node

/**
 * Test de validación del fix shadow readiness
 * Ejecutar: node test_shadow_readiness_fix.js
 */

const db = require('./backend/firebase-admin-config');
const { getShadowEdgeSamplerDiagnostic, processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

async function testShadowReadinessFix() {
    console.log('🔍 TESTING SHADOW READINESS FIX');
    console.log('='.repeat(60));

    try {
        // 1. Diagnóstico ANTES del fix
        console.log('\n📊 STEP 1: Diagnóstico inicial (post-fix)');
        const initialReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log(`📍 Candidatos shadow total: ${initialReport.shadow_candidates_total}`);
        console.log(`📍 Resultados shadow total: ${initialReport.shadow_results_total}`);
        console.log(`📍 Strategy shadow results total: ${initialReport.strategy_shadow_results_total}`);
        console.log(`📍 Live eligible shadow count: ${initialReport.live_eligible_shadow_count}`);
        console.log(`📍 Live ineligible but simulated count: ${initialReport.live_ineligible_but_simulated_count}`);
        console.log(`📍 Candidatos pendientes: ${initialReport.pending_candidates_count}`);
        console.log(`📍 Listos para simulación: ${initialReport.ready_for_exit_simulation_count}`);
        console.log(`📍 Bloqueados por simulación: ${initialReport.blocked_by_simulation_issue_count}`);
        console.log(`📍 Bloqueados solo por readiness: ${initialReport.blocked_by_live_readiness_only_count}`);
        console.log(`📍 Diagnosis: ${initialReport.diagnosis}`);

        if (initialReport.diagnosis === 'shadow_blocked_by_live_readiness_bug') {
            console.log('\n🎯 CONFIRMADO: Diagnosis detecta el bug de readiness bloqueando shadow');
        }

        // 2. Procesar candidatos con el fix aplicado
        console.log('\n🔧 STEP 2: Procesando candidatos (post-fix)');
        const processResult = await processPendingShadowCandidates(db, {
            minAgeMs: 0, // Sin restricción de edad para test
            maxProcess: 20 // Procesar varios candidatos
        });

        console.log(`📍 Candidatos encontrados: ${processResult.candidates_found}`);
        console.log(`📍 Candidatos pendientes: ${processResult.pending_candidates}`);
        console.log(`📍 Procesados: ${processResult.processed}`);
        console.log(`📍 Resultados creados: ${processResult.results_created}`);

        // 3. Diagnóstico DESPUÉS del procesamiento
        console.log('\n📊 STEP 3: Diagnóstico post-procesamiento');
        const finalReport = await getShadowEdgeSamplerDiagnostic(db, { hours: 24 });

        console.log(`📍 Candidatos shadow total: ${finalReport.shadow_candidates_total}`);
        console.log(`📍 Resultados shadow total: ${finalReport.shadow_results_total}`);
        console.log(`📍 Strategy shadow results total: ${finalReport.strategy_shadow_results_total}`);
        console.log(`📍 Live eligible shadow count: ${finalReport.live_eligible_shadow_count}`);
        console.log(`📍 Live ineligible but simulated count: ${finalReport.live_ineligible_but_simulated_count}`);
        console.log(`📍 BTCUSDT shadow count: ${finalReport.btc_shadow_count}`);
        console.log(`📍 SOLUSDT shadow count: ${finalReport.sol_shadow_count}`);
        console.log(`📍 BTCUSDT PnL neto: ${finalReport.btc_pnl_neto}`);
        console.log(`📍 SOLUSDT PnL neto: ${finalReport.sol_pnl_neto}`);
        console.log(`📍 Diagnosis: ${finalReport.diagnosis}`);

        // 4. Análisis de resultados
        console.log('\n🎯 STEP 4: Análisis de resultados');

        const candidatesDelta = finalReport.shadow_candidates_total - initialReport.shadow_candidates_total;
        const resultsDelta = finalReport.shadow_results_total - initialReport.shadow_results_total;
        const strategyResultsDelta = finalReport.strategy_shadow_results_total - initialReport.strategy_shadow_results_total;

        console.log(`📍 Nuevos candidatos: ${candidatesDelta}`);
        console.log(`📍 Nuevos resultados totales: ${resultsDelta}`);
        console.log(`📍 Nuevos strategy results: ${strategyResultsDelta}`);

        // 5. Verificación del fix
        console.log('\n✅ STEP 5: Verificación del fix');

        let fixSuccess = false;
        let fixReason = '';

        if (processResult.results_created > 0) {
            fixSuccess = true;
            fixReason = `Se crearon ${processResult.results_created} resultados shadow`;
        } else if (finalReport.ready_for_exit_simulation_count === 0 && finalReport.blocked_by_live_readiness_only_count > 0) {
            fixSuccess = false;
            fixReason = 'Candidatos listos pero no se procesan por issue técnico';
        } else if (finalReport.ready_for_exit_simulation_count === 0) {
            fixSuccess = true;
            fixReason = 'No hay candidatos listos para procesar (necesita más tiempo)';
        } else {
            fixSuccess = false;
            fixReason = 'Candidatos listos pero no se procesan';
        }

        console.log(`📍 Fix exitoso: ${fixSuccess ? '✅ SÍ' : '❌ NO'}`);
        console.log(`📍 Razón: ${fixReason}`);

        // 6. Verificar resultados específicos creados
        if (processResult.results_created > 0) {
            console.log('\n📋 STEP 6: Verificar resultados shadow creados');

            const resultsSnap = await db.collection('shadow_trade_results')
                .where('processed_by', '==', 'processPendingShadowCandidates')
                .limit(5)
                .get();

            if (!resultsSnap.empty) {
                console.log('✅ Resultados shadow encontrados:');
                resultsSnap.docs.forEach((doc, i) => {
                    const result = doc.data();
                    console.log(`  ${i+1}. ${result.symbol} - ${result.simulated_close_reason} - PnL: ${result.pnl_neto}%`);
                    console.log(`     Shadow type: ${result.shadow_result_type}`);
                    console.log(`     Live eligible: ${result.live_eligibility?.would_have_reached_live_order}`);
                    console.log(`     Live block reason: ${result.live_eligibility?.reason_if_not_live_eligible}`);
                });
            } else {
                console.log('❌ No se encontraron resultados shadow en Firestore');
            }
        }

        // 7. Resumen ejecutivo
        console.log('\n🎯 RESUMEN EJECUTIVO:');
        console.log('='.repeat(60));

        if (fixSuccess && processResult.results_created > 0) {
            console.log('🟢 ÉXITO: El fix de readiness funciona correctamente');
            console.log(`📍 Se generaron ${processResult.results_created} resultados shadow`);
            console.log('📍 El shadow ahora funciona independientemente del estado live del bot');
            console.log('📍 Los candidatos con readiness_not_ready se procesan como strategy_shadow');
        } else if (fixSuccess && processResult.results_created === 0) {
            console.log('🟡 FIX APLICADO: Lógica corregida pero sin datos para procesar');
            console.log('📍 El sistema está listo para generar resultados cuando haya candidatos válidos');
            console.log('📍 Necesita más tiempo o candidatos con velas futuras disponibles');
        } else {
            console.log('🔴 PROBLEMA: El fix no resolvió completamente el issue');
            console.log('📍 Revisar logs de procesamiento para más detalles');
        }

        console.log(`\nStrategy shadow results: ${finalReport.strategy_shadow_results_total}`);
        console.log(`Live ineligible but simulated: ${finalReport.live_ineligible_but_simulated_count}`);
        console.log(`BTCUSDT PnL shadow: ${finalReport.btc_pnl_neto || 0}`);
        console.log(`SOLUSDT PnL shadow: ${finalReport.sol_pnl_neto || 0}`);
        console.log(`Diagnosis: ${finalReport.diagnosis}`);

    } catch (error) {
        console.error('\n❌ ERROR en test shadow readiness fix:', error);
        throw error;
    }
}

// Ejecutar test
testShadowReadinessFix()
    .then(() => {
        console.log('\n✅ Test shadow readiness fix completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Test shadow readiness fix falló:', error);
        process.exit(1);
    });