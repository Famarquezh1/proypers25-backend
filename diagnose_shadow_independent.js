#!/usr/bin/env node

/**
 * Diagnóstico independiente de candidatos shadow con no_exit_condition_met
 */

const db = require('./backend/firebase-admin-config');
const { fetchCandles } = require('./backend/services/dataSources/fetchCandles');

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

function normalizeSymbol(symbol) {
    if (!symbol) return '';
    return String(symbol).replace(/[^A-Z]/g, '').toUpperCase();
}

function parseDateLike(value) {
    if (!value) return null;
    if (typeof value ? .toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date ? .getTime ? .()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

async function loadCandlesForSymbol(symbol, cache) {
    if (cache.has(symbol)) {
        console.log('[FETCH_LATENCY]', { symbol, duration_ms: 0, source: 'cache' });
        return cache.get(symbol);
    }
    try {
        const result = await fetchCandles(symbol, '1m');
        const candles = result ? .success ? result.candles || [] : [];
        cache.set(symbol, candles);
        return candles;
    } catch (error) {
        console.log('[FETCH_ERROR]', { symbol, error: error.message });
        return [];
    }
}

async function inspectNoExitCandidates() {
    console.log('🔍 DIAGNOSTICO NO_EXIT_CONDITION_MET');
    console.log('='.repeat(50));

    try {
        // Constants from environment
        const SHADOW_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
        const SHADOW_EVENT_TIMEOUT_RATIO = Math.min(0.95, Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8)));

        console.log(`📍 SHADOW_MAX_HOLD_MINUTES: ${SHADOW_MAX_HOLD_MINUTES}`);
        console.log(`📍 SHADOW_EVENT_TIMEOUT_RATIO: ${SHADOW_EVENT_TIMEOUT_RATIO}`);

        // Obtener candidatos pendientes
        const candidatesSnap = await db.collection('shadow_trade_candidates')
            .orderBy('updated_at', 'desc')
            .limit(100)
            .get();

        if (candidatesSnap.empty) {
            console.log('❌ No hay candidatos shadow');
            return;
        }

        // Obtener resultados existentes
        const resultsSnap = await db.collection('shadow_trade_results')
            .orderBy('updated_at', 'desc')
            .limit(500)
            .get();

        const existingResultIds = new Set();
        if (!resultsSnap.empty) {
            resultsSnap.docs.forEach(doc => existingResultIds.add(doc.id));
        }

        console.log(`📍 Total candidatos: ${candidatesSnap.docs.length}`);
        console.log(`📍 Resultados existentes: ${existingResultIds.size}`);

        const candidatesData = candidatesSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        const candleCache = new Map();

        console.log('\n📊 INSPECCION DE 10 CANDIDATOS PENDIENTES:');
        console.log('='.repeat(50));

        let inspected = 0;
        let shouldHaveClosedByMaxHold = 0;
        let shouldHaveClosedByEventTimeout = 0;

        for (const candidate of candidatesData) {
            if (inspected >= 10) break;
            if (existingResultIds.has(candidate.id)) continue; // Ya tiene resultado

            const entryAt = parseDateLike(candidate.simulated_entry_at);
            if (!entryAt) continue;

            const now = Date.now();
            const ageMs = now - entryAt.getTime();
            if (ageMs < 300000) continue; // Mínimo 5 minutos

            inspected++;

            try {
                const candles = await loadCandlesForSymbol(candidate.symbol, candleCache);
                const futureCandles = candles.filter(candle =>
                    toNumber(candle ? .timestamp, 0) > entryAt.getTime()
                );

                // Calcular timeouts
                const maxHoldMs = SHADOW_MAX_HOLD_MINUTES * 60 * 1000;
                const eventTimeoutMs = Math.round(maxHoldMs * SHADOW_EVENT_TIMEOUT_RATIO);

                // Calcular tiempo disponible
                const lastCandle = futureCandles[futureCandles.length - 1];
                const lastCandleAt = lastCandle ? parseDateLike(lastCandle.timestamp) : null;
                const elapsedMsAvailable = lastCandleAt ? lastCandleAt.getTime() - entryAt.getTime() : 0;

                // Determinar si debería haber cerrado
                const shouldCloseByMaxHold = elapsedMsAvailable >= maxHoldMs;
                const shouldCloseByEventTimeout = candidate.origin === 'event_emitted' && elapsedMsAvailable >= eventTimeoutMs;

                if (shouldCloseByMaxHold) shouldHaveClosedByMaxHold++;
                if (shouldCloseByEventTimeout) shouldHaveClosedByEventTimeout++;

                let expectedCloseDueToTime = shouldCloseByMaxHold || shouldCloseByEventTimeout;
                let reasonNotClosed = 'unknown';

                if (futureCandles.length === 0) {
                    reasonNotClosed = 'no_future_candles';
                    expectedCloseDueToTime = false;
                } else if (shouldCloseByMaxHold) {
                    reasonNotClosed = `should_close_by_max_hold (elapsed: ${Math.round(elapsedMsAvailable/1000)}s >= ${Math.round(maxHoldMs/1000)}s)`;
                } else if (shouldCloseByEventTimeout) {
                    reasonNotClosed = `should_close_by_event_timeout (elapsed: ${Math.round(elapsedMsAvailable/1000)}s >= ${Math.round(eventTimeoutMs/1000)}s)`;
                } else {
                    reasonNotClosed = `time_insufficient (elapsed: ${Math.round(elapsedMsAvailable/1000)}s < max_hold: ${Math.round(maxHoldMs/1000)}s)`;
                }

                console.log(`\n${inspected}. candidate_id: ${candidate.id}`);
                console.log(`   symbol: ${candidate.symbol}`);
                console.log(`   normalized_symbol: ${normalizeSymbol(candidate.symbol)}`);
                console.log(`   side: ${candidate.side}`);
                console.log(`   simulated_entry_at: ${candidate.simulated_entry_at}`);
                console.log(`   simulated_entry_price: ${candidate.simulated_entry_price}`);
                console.log(`   stop_loss: ${candidate.trade_plan?.stop_loss || 'null'}`);
                console.log(`   take_profit: ${candidate.trade_plan?.take_profit || 'null'}`);
                console.log(`   max_hold_ms: ${maxHoldMs}`);
                console.log(`   event_timeout_ms: ${eventTimeoutMs}`);
                console.log(`   candles_after_entry_count: ${futureCandles.length}`);
                console.log(`   first_candle_at: ${futureCandles[0]?.timestamp || 'null'}`);
                console.log(`   last_candle_at: ${lastCandle?.timestamp || 'null'}`);
                console.log(`   elapsed_ms_available: ${elapsedMsAvailable}`);
                console.log(`   expected_close_due_to_time: ${expectedCloseDueToTime}`);
                console.log(`   reason_not_closed: ${reasonNotClosed}`);

            } catch (error) {
                console.log(`\n${inspected}. candidate_id: ${candidate.id}`);
                console.log(`   ERROR: ${error.message}`);
            }
        }

        console.log(`\n🔍 RESUMEN DE INSPECCION:`);
        console.log(`📍 Candidatos inspeccionados: ${inspected}`);
        console.log(`📍 Should have closed by max_hold: ${shouldHaveClosedByMaxHold}`);
        console.log(`📍 Should have closed by event_timeout: ${shouldHaveClosedByEventTimeout}`);

        // Diagnosticar resultados existentes
        console.log('\n📋 DIAGNOSTICO DE RESULTADOS EXISTENTES:');
        console.log('='.repeat(50));

        if (resultsSnap.empty) {
            console.log('❌ No hay resultados shadow existentes');
        } else {
            const results = resultsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));

            console.log(`📍 Total resultados: ${results.length}`);

            const resultsBySymbol = {};
            results.forEach(r => {
                const sym = normalizeSymbol(r.symbol);
                if (!resultsBySymbol[sym]) resultsBySymbol[sym] = [];
                resultsBySymbol[sym].push(r);
            });

            console.log(`📍 Symbols found in results: ${Object.keys(resultsBySymbol).join(', ')}`);

            Object.entries(resultsBySymbol).forEach(([symbol, symbolResults]) => {
                console.log(`\n📊 ${symbol}: ${symbolResults.length} resultados`);
                symbolResults.forEach((r, i) => {
                    console.log(`   ${i+1}. result_type: ${r.shadow_result_type || 'unknown'}, pnl_neto: ${r.pnl_neto}%, reason: ${r.simulated_close_reason}`);
                });
            });

            console.log('\n📍 RAZON por la que no cuentan en BTCUSDT/SOLUSDT:');
            const btcResults = results.filter(r => normalizeSymbol(r.symbol) === 'BTCUSDT');
            const solResults = results.filter(r => normalizeSymbol(r.symbol) === 'SOLUSDT');

            console.log(`   BTCUSDT count: ${btcResults.length}`);
            console.log(`   SOLUSDT count: ${solResults.length}`);

            if (btcResults.length === 0 && solResults.length === 0) {
                console.log('   PROBLEMA: Los resultados existentes no son de BTCUSDT ni SOLUSDT');
                console.log('   Símbolos encontrados:', [...new Set(results.map(r => normalizeSymbol(r.symbol)))]);
            }
        }

    } catch (error) {
        console.error('❌ ERROR en diagnóstico:', error);
    }
}

inspectNoExitCandidates()
    .then(() => {
        console.log('\n✅ Diagnóstico completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Diagnóstico falló:', error);
        process.exit(1);
    });