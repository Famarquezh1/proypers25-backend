#!/usr/bin/env node

/**
 * SHADOW PROCESSING FINAL FIX - Garantiza que candidatos con tiempo suficiente generen resultados
 */

const db = require('./backend/firebase-admin-config');
const { fetchCandles } = require('./backend/services/dataSources/fetchCandles');

// Constantes espejo de shadowEdgeSamplerDiagnostic.js
const SHADOW_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
const SHADOW_EVENT_TIMEOUT_RATIO = Math.min(0.95, Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8)));
const SHADOW_BREAK_EVEN_FEE_PCT = Number(process.env.SHADOW_TRADE_BREAK_EVEN_FEE_PCT || 0.2);

function parseDateLike(value) {
    if (!value) return null;
    if (typeof value ? .toDate === 'function') {
        return value.toDate();
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
    const num = Number(value);
    return Number.isFinite(num) ? num : fallback;
}

function directionalMovePct(side, entryPrice, exitPrice) {
    if (!(entryPrice > 0) || !(exitPrice > 0)) return null;
    const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    return side === 'SELL' ? -rawPct : rawPct;
}

function round(value, precision) {
    return Math.round((value + Number.EPSILON) * Math.pow(10, precision)) / Math.pow(10, precision);
}

async function forceShadowCloseForTimeoutCandidates() {
    console.log('🚀 SHADOW PROCESSING FINAL FIX - FORCE CLOSE BY TIME');
    console.log('='.repeat(60));

    const maxHoldMs = SHADOW_MAX_HOLD_MINUTES * 60 * 1000;
    const timeoutMs = Math.round(maxHoldMs * SHADOW_EVENT_TIMEOUT_RATIO);

    console.log(`🔧 CONFIGURACION:`);
    console.log(`📍 Max Hold: ${maxHoldMs}ms (${maxHoldMs/60000} min)`);
    console.log(`📍 Event Timeout: ${timeoutMs}ms (${timeoutMs/60000} min)`);
    console.log(`📍 Break Even Fee: ${SHADOW_BREAK_EVEN_FEE_PCT}%`);

    try {
        // Obtener candidatos que deberían haberse cerrado por tiempo
        const candidatesSnap = await db.collection('shadow_trade_candidates')
            .limit(100)
            .get();

        // Obtener IDs de resultados existentes
        const existingResultsSnap = await db.collection('shadow_trade_results')
            .get();
        const existingResultIds = new Set();
        existingResultsSnap.docs.forEach(doc => existingResultIds.add(doc.id));

        console.log(`📍 Total candidatos: ${candidatesSnap.docs.length}`);
        console.log(`📍 Resultados existentes: ${existingResultIds.size}`);

        const candidatesToProcess = [];
        const cutoffTime = Date.now() - (15 * 60 * 1000); // 15 minutos mínimo

        for (const doc of candidatesSnap.docs) {
            if (existingResultIds.has(doc.id)) continue; // Ya tiene resultado

            const candidate = { id: doc.id, ...doc.data() };
            const entryAt = parseDateLike(candidate.simulated_entry_at);

            if (!entryAt || entryAt.getTime() > cutoffTime) continue; // Muy reciente

            const ageMs = Date.now() - entryAt.getTime();
            const shouldCloseByMaxHold = ageMs >= maxHoldMs;
            const shouldCloseByEventTimeout = candidate.origin === 'event_emitted' && ageMs >= timeoutMs;

            if (shouldCloseByMaxHold || shouldCloseByEventTimeout) {
                candidatesToProcess.push({
                    ...candidate,
                    ageMs,
                    shouldCloseByMaxHold,
                    shouldCloseByEventTimeout,
                    closeReason: shouldCloseByMaxHold ? 'max_hold_reached' : 'event_timeout_exit'
                });
            }
        }

        console.log(`📍 Candidatos para forzar cierre: ${candidatesToProcess.length}`);

        if (candidatesToProcess.length === 0) {
            console.log('⚠️  No hay candidatos listos para cierre forzado');
            return;
        }

        let processedCount = 0;
        let resultCreateCount = 0;
        const candleCache = new Map();

        for (const candidate of candidatesToProcess.slice(0, 15)) { // Procesar hasta 15
            try {
                console.log(`\n🔄 Procesando: ${candidate.id.slice(0, 20)}...`);
                console.log(`   Symbol: ${candidate.symbol}, Age: ${Math.round(candidate.ageMs/60000)} min`);

                // Obtener velas
                let candles = [];
                if (candleCache.has(candidate.symbol)) {
                    candles = candleCache.get(candidate.symbol);
                    console.log(`   📊 Velas desde cache: ${candles.length}`);
                } else {
                    const fetchResult = await fetchCandles(candidate.symbol, '1m');
                    console.log(`   📊 Fetch result:`, fetchResult ? .success, fetchResult ? .candles ? .length);
                    if (fetchResult ? .success) {
                        candles = fetchResult.candles || [];
                        candleCache.set(candidate.symbol, candles);
                        console.log(`   📊 Velas obtenidas: ${candles.length}`);
                    }
                }

                if (candles.length === 0) {
                    console.log(`   ❌ No hay velas para ${candidate.symbol} (length: ${candles.length})`);
                    continue;
                }

                const entryAt = parseDateLike(candidate.simulated_entry_at);
                const entryPrice = toNumber(candidate.simulated_entry_price, null);
                const side = String(candidate.side || '').toUpperCase();

                if (!entryAt || !(entryPrice > 0) || !['BUY', 'SELL'].includes(side)) {
                    console.log(`   ❌ Datos inválidos`);
                    continue;
                }

                // Encontrar vela de cierre (la más cercana al tiempo de timeout)
                const targetCloseTime = entryAt.getTime() + (candidate.shouldCloseByMaxHold ? maxHoldMs : timeoutMs);
                let closestCandle = null;
                let smallestDiff = Infinity;

                for (const candle of candles) {
                    const ts = toNumber(candle.timestamp, 0);
                    if (ts <= entryAt.getTime()) continue; // Debe ser después de la entrada

                    const diff = Math.abs(ts - targetCloseTime);
                    if (diff < smallestDiff) {
                        smallestDiff = diff;
                        closestCandle = candle;
                    }
                }

                if (!closestCandle) {
                    console.log(`   ❌ No se encontró vela de cierre`);
                    continue;
                }

                const closePrice = toNumber(closestCandle.close, null);
                if (!(closePrice > 0)) {
                    console.log(`   ❌ Precio de cierre inválido`);
                    continue;
                }

                // Calcular PnL
                const grossPnlPct = directionalMovePct(side, entryPrice, closePrice);
                const netPnlPct = Number.isFinite(grossPnlPct) ? grossPnlPct - SHADOW_BREAK_EVEN_FEE_PCT : null;
                const actualCloseTime = toNumber(closestCandle.timestamp, targetCloseTime);
                const durationMs = actualCloseTime - entryAt.getTime();

                // Crear resultado forzado
                const shadowResult = {
                    id: candidate.id,
                    signal_id: candidate.signal_id || candidate.id,
                    symbol: candidate.symbol,
                    origin: candidate.origin,
                    shadow_result_type: 'strategy_shadow',
                    side,
                    simulated_entry_at: candidate.simulated_entry_at,
                    simulated_entry_price: round(entryPrice, 8),
                    simulated_exit_price: round(closePrice, 8),
                    simulated_close_reason: candidate.closeReason,
                    simulated_duration_ms: durationMs,
                    pnl_bruto: round(grossPnlPct, 6),
                    fees: SHADOW_BREAK_EVEN_FEE_PCT,
                    pnl_neto: round(netPnlPct, 6),
                    gross_win: Number(grossPnlPct || 0) > 0,
                    net_win: Number(netPnlPct || 0) > 0,
                    blocked: false,
                    break_even_pass: Number(netPnlPct || 0) > 0,
                    created_at: new Date().toISOString(),
                    updated_at: new Date().toISOString(),
                    forced_close_fix: true // Marca especial
                };

                // Persistir resultado
                await db.collection('shadow_trade_results').doc(candidate.id).set(shadowResult);

                console.log(`   ✅ Resultado creado:`);
                console.log(`      Close reason: ${candidate.closeReason}`);
                console.log(`      Duration: ${Math.round(durationMs/60000)} min`);
                console.log(`      PnL neto: ${netPnlPct?.toFixed(4)}%`);
                console.log(`      Entry: ${entryPrice} → Exit: ${closePrice}`);

                resultCreateCount++;
                processedCount++;

            } catch (error) {
                console.log(`   ❌ Error procesando candidato: ${error.message}`);
                processedCount++;
            }
        }

        console.log(`\n✅ PROCESAMIENTO COMPLETADO:`);
        console.log(`📍 Candidatos procesados: ${processedCount}`);
        console.log(`📍 Resultados creados: ${resultCreateCount}`);

        if (resultCreateCount > 0) {
            console.log(`\n📊 VERIFICANDO RESULTADOS NUEVOS:`);
            const newResultsSnap = await db.collection('shadow_trade_results')
                .where('forced_close_fix', '==', true)
                .get();

            const resultsBySymbol = {};
            newResultsSnap.docs.forEach(doc => {
                const result = doc.data();
                if (!resultsBySymbol[result.symbol]) {
                    resultsBySymbol[result.symbol] = [];
                }
                resultsBySymbol[result.symbol].push(result);
            });

            Object.entries(resultsBySymbol).forEach(([symbol, results]) => {
                const totalPnL = results.reduce((sum, r) => sum + (r.pnl_neto || 0), 0);
                const winCount = results.filter(r => (r.pnl_neto || 0) > 0).length;
                const winRate = results.length ? ((winCount / results.length) * 100) : 0;

                console.log(`\n📊 ${symbol}:`);
                console.log(`   Count: ${results.length}`);
                console.log(`   Total PnL: ${totalPnL.toFixed(4)}%`);
                console.log(`   Win Rate: ${winRate.toFixed(1)}%`);
            });
        }

        console.log('\n🎯 SHADOW RESULTS AHORA DISPONIBLES PARA MEDICION');

    } catch (error) {
        console.error('❌ ERROR en fix final:', error);
    }
}

forceShadowCloseForTimeoutCandidates()
    .then(() => {
        console.log('\n✅ Fix completado exitosamente');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Fix falló:', error);
        process.exit(1);
    });