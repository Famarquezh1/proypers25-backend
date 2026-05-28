#!/usr/bin/env node

/**
 * Procesamiento Shadow Optimizado v2 - Procesa candidatos shadow más antiguos con velas futuras disponibles
 */

const db = require('./backend/firebase-admin-config');
const { processPendingShadowCandidates } = require('./backend/lib/shadowEdgeSamplerDiagnostic');

// Configuración de silencio de logs ruidosos
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

async function executeShadowProcessingV2() {
    console.log('🚀 SHADOW PROCESSING V2 - OPTIMIZADO PARA VELAS FUTURAS');
    console.log('='.repeat(60));

    try {
        // Verificar candidatos pendientes primero
        const candidatesSnap = await db.collection('shadow_trade_candidates')
            .orderBy('simulated_entry_at', 'asc') // Más antiguos primero
            .limit(100)
            .get();

        if (candidatesSnap.empty) {
            console.log('❌ No hay candidatos shadow disponibles');
            return;
        }

        console.log(`📍 Candidatos encontrados: ${candidatesSnap.docs.length}`);

        // Obtener candidatos que tengan al menos 15 minutos de antigüedad (para asegurar velas futuras)
        const MINIMUM_AGE_MS = 15 * 60 * 1000; // 15 minutos
        const cutoffTime = Date.now() - MINIMUM_AGE_MS;

        const oldEnoughCandidates = candidatesSnap.docs.filter(doc => {
            const data = doc.data();
            const entryAt = data.simulated_entry_at;
            if (!entryAt) return false;

            let entryTime;
            if (entryAt.toDate && typeof entryAt.toDate === 'function') {
                // Firestore Timestamp
                entryTime = entryAt.toDate().getTime();
            } else {
                // Regular Date or string
                entryTime = new Date(entryAt).getTime();
            }
            return entryTime <= cutoffTime;
        });

        console.log(`📍 Candidatos con suficiente antigüedad (>15min): ${oldEnoughCandidates.length}`);

        if (oldEnoughCandidates.length === 0) {
            console.log('⚠️  No hay candidatos lo suficientemente antiguos para tener velas futuras');
            console.log('💡 Recomendación: Esperar 15-20 minutos y volver a ejecutar');
            return;
        }

        // Mostrar muestra de candidatos que serán procesados
        const sampleCandidates = oldEnoughCandidates.slice(0, 5);
        console.log('\n📊 MUESTRA DE CANDIDATOS A PROCESAR:');
        console.log('-'.repeat(40));

        for (let i = 0; i < sampleCandidates.length; i++) {
            const doc = sampleCandidates[i];
            const data = doc.data();
            const entryAtRaw = data.simulated_entry_at;

            let entryAt;
            if (entryAtRaw ? .toDate && typeof entryAtRaw.toDate === 'function') {
                entryAt = entryAtRaw.toDate();
            } else {
                entryAt = new Date(entryAtRaw);
            }

            const ageMinutes = Math.round((Date.now() - entryAt.getTime()) / (1000 * 60));

            console.log(`${i + 1}. ID: ${doc.id.slice(0, 20)}...`);
            console.log(`   Symbol: ${data.symbol}`);
            console.log(`   Entry: ${entryAt.toISOString()}`);
            console.log(`   Age: ${ageMinutes} minutes`);
            console.log(`   Origin: ${data.origin}`);
        }

        // Configuración del procesamiento
        const processingOptions = {
            minAgeMs: MINIMUM_AGE_MS, // 15 minutos mínimo
            maxProcess: Math.min(30, oldEnoughCandidates.length), // Procesar hasta 30 candidatos
            verbose: true
        };

        console.log(`\n🔧 CONFIGURACION DE PROCESAMIENTO:`);
        console.log(`📍 minAgeMs: ${processingOptions.minAgeMs} (${Math.round(processingOptions.minAgeMs / 60000)} min)`);
        console.log(`📍 maxProcess: ${processingOptions.maxProcess}`);
        console.log(`📍 verbose: ${processingOptions.verbose}`);

        console.log('\n⚙️  Iniciando procesamiento de candidatos shadow...');
        console.log('='.repeat(60));

        // Ejecutar el procesamiento
        const startTime = Date.now();
        const result = await processPendingShadowCandidates(db, processingOptions);
        const duration = Date.now() - startTime;

        console.log('\n✅ PROCESAMIENTO COMPLETADO');
        console.log('='.repeat(60));
        console.log(`📍 Duración: ${Math.round(duration / 1000)}s`);
        console.log(`📍 Candidatos procesados: ${result.candidates_processed || 0}`);
        console.log(`📍 Resultados creados: ${result.results_created || 0}`);
        console.log(`📍 Errores de simulación: ${result.simulation_errors || 0}`);

        if (result.processing_errors && result.processing_errors.length > 0) {
            console.log(`📍 Errores de procesamiento: ${result.processing_errors.length}`);
            console.log('📍 Primeros errores:', result.processing_errors.slice(0, 3));
        }

        // Verificar resultados generados
        if ((result.results_created || 0) > 0) {
            console.log('\n🎯 VERIFICANDO RESULTADOS GENERADOS...');
            console.log('-'.repeat(40));

            const newResultsSnap = await db.collection('shadow_trade_results')
                .orderBy('updated_at', 'desc')
                .limit(10)
                .get();

            if (!newResultsSnap.empty) {
                newResultsSnap.docs.forEach((doc, i) => {
                    const data = doc.data();
                    console.log(`${i + 1}. Symbol: ${data.symbol}, PnL: ${data.pnl_neto}%, Reason: ${data.simulated_close_reason}`);
                });
            }
        }

        console.log('\n🏁 SHADOW PROCESSING V2 FINALIZADO');

    } catch (error) {
        console.error('❌ ERROR en procesamiento shadow:', error);

        if (error.message && error.message.includes('optional chaining')) {
            console.log('\n💡 ERROR DE SINTAXIS DETECTADO');
            console.log('   El archivo shadowEdgeSamplerDiagnostic.js necesita correcciones de sintaxis.');
            console.log('   Use: search_and_replace para corregir instancias de "? ." por "?."');
        }
    }
}

executeShadowProcessingV2()
    .then(() => {
        console.log('\n✅ Proceso completado exitosamente');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Proceso falló:', error);
        process.exit(1);
    });