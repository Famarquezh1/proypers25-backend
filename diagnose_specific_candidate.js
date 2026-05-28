#!/usr/bin/env node

/**
 * Diagnóstico detallado de un candidato específico para entender el no_exit_condition_met
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

function directionalMovePct(side, entryPrice, exitPrice) {
    if (!(entryPrice > 0) || !(exitPrice > 0)) return null;
    const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
    return side === 'SELL' ? -rawPct : rawPct;
}

function candleHitsStopOrTp(candle, side, stopLoss, takeProfit) {
    const low = toNumber(candle.low, null);
    const high = toNumber(candle.high, null);

    if (stopLoss > 0) {
        if (side === 'BUY' && low <= stopLoss) {
            return { hit: true, reason: 'stop_loss_hit', price: stopLoss };
        }
        if (side === 'SELL' && high >= stopLoss) {
            return { hit: true, reason: 'stop_loss_hit', price: stopLoss };
        }
    }

    if (takeProfit > 0) {
        if (side === 'BUY' && high >= takeProfit) {
            return { hit: true, reason: 'take_profit_hit', price: takeProfit };
        }
        if (side === 'SELL' && low <= takeProfit) {
            return { hit: true, reason: 'take_profit_hit', price: takeProfit };
        }
    }

    return { hit: false, reason: null, price: null };
}

async function diagnoseSpecificCandidate() {
    console.log('🔍 DIAGNÓSTICO DETALLADO DE CANDIDATO ESPECÍFICO');
    console.log('='.repeat(60));

    try {
        // Obtener un candidato específico que tenga muchas velas futuras
        const candidateDoc = await db.collection('shadow_trade_candidates')
            .doc('dBR8ZcLtzWO729lhZvH8__event_emitted') // BTCUSDT con 500 velas
            .get();

        if (!candidateDoc.exists) {
            console.log('❌ Candidato no encontrado');
            return;
        }

        const candidate = { id: candidateDoc.id, ...candidateDoc.data() };
        console.log(`📍 Candidato: ${candidate.id}`);
        console.log(`📍 Symbol: ${candidate.symbol}`);
        console.log(`📍 Side: ${candidate.side}`);
        console.log(`📍 Origin: ${candidate.origin}`);
        console.log(`📍 Entry Price: ${candidate.simulated_entry_price}`);
        console.log(`📍 Stop Loss: ${candidate.trade_plan?.stop_loss}`);
        console.log(`📍 Take Profit: ${candidate.trade_plan?.take_profit}`);

        // Obtener velas
        console.log('\n📊 OBTENIENDO VELAS...');

        let result;
        try {
            result = await fetchCandles(candidate.symbol, '1m');
        } catch (fetchError) {
            console.log('❌ Exception al obtener velas:', fetchError.message);
            return;
        }

        console.log('📍 Result object:', result);

        if (!result ? .success) {
            console.log('❌ Error obteniendo velas (no success):', result ? .error || 'Unknown error');
            console.log('📍 Full result:', JSON.stringify(result, null, 2));
            return;
        }

        const candles = result.candles || [];
        console.log(`📍 Total velas obtenidas: ${candles.length}`);

        // Analizar entrada
        const entryAt = parseDateLike(candidate.simulated_entry_at);
        if (!entryAt) {
            console.log('❌ No se pudo parsear simulated_entry_at');
            return;
        }

        console.log(`📍 Entry time: ${entryAt.toISOString()}`);
        console.log(`📍 Entry timestamp: ${entryAt.getTime()}`);

        // Filtrar velas futuras
        const futureCandles = candles.filter(candle =>
            toNumber(candle ? .timestamp, 0) > entryAt.getTime()
        );

        console.log(`📍 Velas futuras disponibles: ${futureCandles.length}`);

        if (futureCandles.length === 0) {
            console.log('❌ No hay velas futuras');
            return;
        }

        // Configuración de timeouts
        const SHADOW_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
        const SHADOW_EVENT_TIMEOUT_RATIO = Math.min(0.95, Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8)));
        const SHADOW_BREAK_EVEN_FEE_PCT = Number(process.env.SHADOW_TRADE_BREAK_EVEN_FEE_PCT || 0.2);

        const maxHoldMs = SHADOW_MAX_HOLD_MINUTES * 60 * 1000;
        const timeoutMs = Math.round(maxHoldMs * SHADOW_EVENT_TIMEOUT_RATIO);

        console.log(`\n🔧 CONFIGURACIÓN:`);
        console.log(`📍 SHADOW_MAX_HOLD_MINUTES: ${SHADOW_MAX_HOLD_MINUTES}`);
        console.log(`📍 SHADOW_EVENT_TIMEOUT_RATIO: ${SHADOW_EVENT_TIMEOUT_RATIO}`);
        console.log(`📍 Max Hold Ms: ${maxHoldMs} (${maxHoldMs/1000}s)`);
        console.log(`📍 Event Timeout Ms: ${timeoutMs} (${timeoutMs/1000}s)`);

        // Simular el proceso de la función buildShadowSimulationResult
        console.log(`\n🔄 SIMULANDO LÓGICA DE SALIDA:`);

        const entryPrice = toNumber(candidate.simulated_entry_price, null);
        const side = String(candidate.side || '').toUpperCase();
        const stopLoss = toNumber(candidate.trade_plan ? .stop_loss, null);
        const takeProfit = toNumber(candidate.trade_plan ? .take_profit, null);

        console.log(`📍 Entry price: ${entryPrice}`);
        console.log(`📍 Side: ${side}`);
        console.log(`📍 Stop loss: ${stopLoss}`);
        console.log(`📍 Take profit: ${takeProfit}`);

        // Buscar índice de inicio
        const startIndex = futureCandles.findIndex(candle =>
            Number(candle ? .timestamp || 0) >= entryAt.getTime()
        );

        console.log(`📍 Start index en velas futuras: ${startIndex}`);

        if (startIndex < 0) {
            console.log('❌ No se encontró vela de inicio válida');
            return;
        }

        // Procesar velas
        let foundExit = false;
        let maxSeenPct = -Infinity;
        let lastProcessedCandle = null;
        let processedCandles = 0;

        for (let index = startIndex; index < Math.min(futureCandles.length, startIndex + 20); index++) {
            const candle = futureCandles[index];
            const ts = Number(candle ? .timestamp || 0);
            if (!Number.isFinite(ts) || ts < entryAt.getTime()) continue;

            const elapsedMs = ts - entryAt.getTime();
            const closePrice = toNumber(candle.close, null);

            if (!(closePrice > 0)) continue;

            const grossPnlPct = directionalMovePct(side, entryPrice, closePrice);
            if (Number.isFinite(grossPnlPct)) {
                maxSeenPct = Math.max(maxSeenPct, grossPnlPct);
            }

            processedCandles++;
            lastProcessedCandle = {
                index,
                timestamp: new Date(ts).toISOString(),
                elapsedMs,
                elapsedMinutes: Math.round(elapsedMs / (60 * 1000)),
                closePrice,
                grossPnlPct,
                maxSeenPct
            };

            // Verificar stop/tp
            const stopTpHit = candleHitsStopOrTp(candle, side, stopLoss, takeProfit);
            if (stopTpHit.hit) {
                console.log(`\n💥 STOP/TP HIT en vela ${index}:`);
                console.log(`   Timestamp: ${new Date(ts).toISOString()}`);
                console.log(`   Elapsed: ${elapsedMs}ms (${Math.round(elapsedMs/60000)} min)`);
                console.log(`   Reason: ${stopTpHit.reason}`);
                console.log(`   Price: ${stopTpHit.price}`);
                foundExit = true;
                break;
            }

            // Verificar event timeout
            if (candidate.origin === 'event_emitted' && elapsedMs >= timeoutMs) {
                console.log(`\n⏰ EVENT TIMEOUT alcanzado en vela ${index}:`);
                console.log(`   Timestamp: ${new Date(ts).toISOString()}`);
                console.log(`   Elapsed: ${elapsedMs}ms >= ${timeoutMs}ms`);
                console.log(`   Should trigger event_timeout_exit`);
                foundExit = true;
                break;
            }

            // Verificar max hold
            if (elapsedMs >= maxHoldMs) {
                console.log(`\n⏱️  MAX HOLD alcanzado en vela ${index}:`);
                console.log(`   Timestamp: ${new Date(ts).toISOString()}`);
                console.log(`   Elapsed: ${elapsedMs}ms >= ${maxHoldMs}ms`);
                console.log(`   Should trigger max_hold_reached`);
                foundExit = true;
                break;
            }

            // Mostrar primeras velas para debug
            if (index < startIndex + 3) {
                console.log(`\n📊 Vela ${index}:`);
                console.log(`   Timestamp: ${new Date(ts).toISOString()}`);
                console.log(`   Elapsed: ${elapsedMs}ms (${Math.round(elapsedMs/60000)} min)`);
                console.log(`   Close: ${closePrice}`);
                console.log(`   PnL: ${grossPnlPct?.toFixed(4)}%`);
            }
        }

        console.log(`\n📋 RESUMEN:`);
        console.log(`📍 Velas procesadas: ${processedCandles}`);
        console.log(`📍 Found exit condition: ${foundExit}`);

        if (lastProcessedCandle) {
            console.log(`📍 Última vela procesada:`);
            console.log(`   Index: ${lastProcessedCandle.index}`);
            console.log(`   Timestamp: ${lastProcessedCandle.timestamp}`);
            console.log(`   Elapsed: ${lastProcessedCandle.elapsedMinutes} minutos`);
            console.log(`   PnL actual: ${lastProcessedCandle.grossPnlPct?.toFixed(4)}%`);
        }

        if (!foundExit) {
            console.log(`\n❌ PROBLEMA: No se encontró condición de salida en las primeras ${processedCandles} velas`);
            console.log(`💡 Esto explicaría el no_exit_condition_met`);

            // Verificar si la última vela debería cumplir max_hold
            if (lastProcessedCandle && lastProcessedCandle.elapsedMs) {
                console.log(`\n🔍 ANÁLISIS DE ÚLTIMA VELA:`);
                console.log(`   Elapsed: ${lastProcessedCandle.elapsedMs}ms`);
                console.log(`   Max Hold Threshold: ${maxHoldMs}ms`);
                console.log(`   Should close by max_hold: ${lastProcessedCandle.elapsedMs >= maxHoldMs}`);

                if (candidate.origin === 'event_emitted') {
                    console.log(`   Event Timeout Threshold: ${timeoutMs}ms`);
                    console.log(`   Should close by event_timeout: ${lastProcessedCandle.elapsedMs >= timeoutMs}`);
                }
            }
        }

    } catch (error) {
        console.error('❌ ERROR en diagnóstico:', error);
    }
}

diagnoseSpecificCandidate()
    .then(() => {
        console.log('\n✅ Diagnóstico completado');
        process.exit(0);
    })
    .catch(error => {
        console.error('❌ Diagnóstico falló:', error);
        process.exit(1);
    });