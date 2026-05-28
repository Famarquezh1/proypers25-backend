#!/usr/bin/env node

/**
 * Test de bypass readiness para validar el flujo de procesamiento shadow
 * Ejecutar: node test_shadow_bypass_readiness.js
 */

const db = require('./backend/firebase-admin-config');
const { processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

async function testShadowBypassReadiness() {
    console.log('🔍 TESTING SHADOW CANDIDATES BYPASS READINESS');
    console.log('='.repeat(50));

    try {
        // 1. Encontrar un candidato bloqueado por readiness
        console.log('\n📊 STEP 1: Buscar candidatos shadow bloqueados por readiness');

        const candidatesSnap = await db.collection('shadow_trade_candidates')
            .where('reason_if_blocked', '==', 'readiness_not_ready')
            .limit(1)
            .get();

        if (candidatesSnap.empty) {
            console.log('❌ No hay candidatos bloqueados por readiness');
            return;
        }

        const candidateDoc = candidatesSnap.docs[0];
        const candidate = { id: candidateDoc.id, ...candidateDoc.data() };

        console.log(`📍 Candidato seleccionado: ${candidate.id}`);
        console.log(`📍 Símbolo: ${candidate.symbol}`);
        console.log(`📍 Entry simulado: ${candidate.simulated_entry_at}`);
        console.log(`📍 Razón de bloqueo: ${candidate.reason_if_blocked}`);

        // 2. Bypass la validación de readiness temporalmente
        console.log('\n🔧 STEP 2: Bypass temporal de readiness');

        await candidateDoc.ref.update({
            reason_if_blocked: null,
            would_have_passed_readiness: true,
            readiness_bypass_test: true,
            updated_at: new Date().toISOString()
        });

        console.log('✅ Readiness bypass aplicado');

        // 3. Ejecutar procesamiento
        console.log('\n🔄 STEP 3: Procesar candidato desbloqueado');

        const processResult = await processPendingShadowCandidates(db, {
            minAgeMs: 0, // Sin restricción de edad para test
            maxProcess: 5 // Límite pequeño para test
        });

        console.log(`📍 Candidatos encontrados: ${processResult.candidates_found}`);
        console.log(`📍 Candidatos pendientes: ${processResult.pending_candidates}`);
        console.log(`📍 Procesados: ${processResult.processed}`);
        console.log(`📍 Resultados creados: ${processResult.results_created}`);

        // 4. Verificar si se creó el resultado
        console.log('\n📊 STEP 4: Verificar resultado creado');

        if (processResult.results_created > 0) {
            const resultSnap = await db.collection('shadow_trade_results')
                .where('signal_id', '==', candidate.signal_id)
                .limit(1)
                .get();

            if (!resultSnap.empty) {
                const result = resultSnap.docs[0].data();
                console.log('✅ Resultado shadow creado:');
                console.log(`  📍 ID: ${resultSnap.docs[0].id}`);
                console.log(`  📍 Símbolo: ${result.symbol}`);
                console.log(`  📍 Razón de cierre: ${result.simulated_close_reason}`);
                console.log(`  📍 PnL bruto: ${result.pnl_bruto}%`);
                console.log(`  📍 PnL neto: ${result.pnl_neto}%`);
                console.log(`  📍 Duración: ${result.simulated_duration_ms}ms`);
                console.log(`  📍 Precio entrada: ${result.simulated_entry_price}`);
                console.log(`  📍 Precio salida: ${result.simulated_exit_price}`);
            } else {
                console.log('❌ No se encontró resultado en Firestore');
            }
        } else {
            console.log('❌ No se crearon resultados');
        }

        // 5. Restaurar el candidato original
        console.log('\n🔧 STEP 5: Restaurar candidato original');

        await candidateDoc.ref.update({
            reason_if_blocked: 'readiness_not_ready',
            would_have_passed_readiness: false,
            updated_at: new Date().toISOString()
        });

        console.log('✅ Candidato restaurado');

        // 6. Conclusión
        console.log('\n🎯 CONCLUSIÓN DEL TEST:');
        console.log('='.repeat(50));

        if (processResult.results_created > 0) {
            console.log('🟢 ÉXITO: El flujo de procesamiento shadow funciona correctamente');
            console.log('📍 El problema es la configuración de readiness, no el código shadow');
            console.log('📍 Cuando el bot esté activo, el sistema shadow funcionará automáticamente');
        } else {
            console.log('🔴 PROBLEMA: El flujo de procesamiento shadow tiene issues');
            console.log('📍 Revisar logs de procesamiento para más detalles');
        }

    } catch (error) {
        console.error('\n❌ ERROR en test bypass readiness:', error);
        throw error;
    }
}

// Ejecutar test
testShadowBypassReadiness()
    .then(() => {
        console.log('\n✅ Test bypass completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Test bypass falló:', error);
        process.exit(1);
    });