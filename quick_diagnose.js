#!/usr/bin/env node

/**
 * Diagnóstico simplificado para entender el no_exit_condition_met
 */

const db = require('./backend/firebase-admin-config');

async function quickDiagnose() {
    try {
        // Constantes como están en el código original
        const SHADOW_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
        const SHADOW_EVENT_TIMEOUT_RATIO = Math.min(0.95, Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8)));

        const maxHoldMs = SHADOW_MAX_HOLD_MINUTES * 60 * 1000;
        const timeoutMs = Math.round(maxHoldMs * SHADOW_EVENT_TIMEOUT_RATIO);

        console.log('🔧 CONSTANTES:');
        console.log(`MAX_HOLD_MINUTES: ${SHADOW_MAX_HOLD_MINUTES}`);
        console.log(`EVENT_TIMEOUT_RATIO: ${SHADOW_EVENT_TIMEOUT_RATIO}`);
        console.log(`Max Hold Ms: ${maxHoldMs} (${maxHoldMs/1000}s = ${maxHoldMs/60000} min)`);
        console.log(`Event Timeout Ms: ${timeoutMs} (${timeoutMs/1000}s = ${timeoutMs/60000} min)`);

        // Obtener algunos candidatos
        const candidatesSnap = await db.collection('shadow_trade_candidates')
            .limit(5)
            .get();

        console.log('\n📊 ANÁLISIS DE CANDIDATOS:');

        for (const doc of candidatesSnap.docs) {
            const candidate = { id: doc.id, ...doc.data() };
            const entryAt = candidate.simulated_entry_at ? .toDate ? .() || new Date(candidate.simulated_entry_at);
            const ageMs = Date.now() - entryAt.getTime();
            const ageMinutes = Math.round(ageMs / (60 * 1000));

            console.log(`\n📍 ${candidate.id.slice(0, 20)}...`);
            console.log(`   Symbol: ${candidate.symbol}, Side: ${candidate.side}, Origin: ${candidate.origin}`);
            console.log(`   Entry: ${entryAt.toISOString()}`);
            console.log(`   Age: ${ageMinutes} minutes (${ageMs}ms)`);
            console.log(`   Should close by max_hold: ${ageMs >= maxHoldMs}`);
            console.log(`   Should close by event_timeout: ${candidate.origin === 'event_emitted' && ageMs >= timeoutMs}`);
        }

        // Verificar si hay resultados recientes
        const resultsSnap = await db.collection('shadow_trade_results')
            .orderBy('updated_at', 'desc')
            .limit(5)
            .get();

        console.log('\n📋 RESULTADOS RECIENTES:');

        if (resultsSnap.empty) {
            console.log('❌ No hay resultados shadow recientes');
        } else {
            resultsSnap.docs.forEach((doc, i) => {
                const result = doc.data();
                console.log(`${i+1}. Symbol: ${result.symbol}, Close Reason: ${result.simulated_close_reason}, PnL: ${result.pnl_neto}%`);
            });
        }

        console.log('\n💡 CONCLUSIÓN:');
        console.log('Si los candidatos tienen edad suficiente pero no se están cerrando,');
        console.log('el problema está en la función buildShadowSimulationResult.');

    } catch (error) {
        console.error('❌ Error:', error.message);
    }
}

quickDiagnose()
    .then(() => process.exit(0))
    .catch(error => {
        console.error('❌ Error:', error);
        process.exit(1);
    });