const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FASE 3: VALIDACIÓN TEMPORAL
 * Analiza resultados en diferentes ventanas: 1h, 6h, 24h, 72h, 7d, 30d
 * Detecta si el edge es inmediato o de maduración lenta
 */

async function analyzeTemporalWindow() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('⏱️  AUDITORÍA FASE 3: VALIDACIÓN TEMPORAL');
        console.log('='.repeat(80));

        // Obtener todos los trades cerrados
        const closedSnapshot = await db.collection('real_spot_positions')
            .where('status', '==', 'CLOSED')
            .get();

        const closedTrades = [];
        closedSnapshot.forEach(doc => {
            closedTrades.push({ id: doc.id, ...doc.data() });
        });

        if (closedTrades.length === 0) {
            console.log('\n⚠️ No hay trades cerrados para analizar');
            return;
        }

        // Función auxiliar para calcular duración
        function getDurationMinutes(opened_at, closed_at) {
            if (!opened_at || !closed_at) return null;
            const start = new Date(opened_at);
            const end = new Date(closed_at);
            return (end - start) / 1000 / 60;
        }

        // Función auxiliar para evaluar PnL en timeframe hipotético
        function evaluateAtTimeframe(trade, durationMinutes) {
            const actualDuration = getDurationMinutes(trade.opened_at, trade.closed_at);

            if (actualDuration === null) return null;

            // Si el trade duró menos que la ventana, usamos el resultado real
            // Si duró más, interpolamos conservadoramente

            if (actualDuration <= durationMinutes) {
                // Trade se cerró dentro de la ventana
                return {
                    pnl: trade.pnl || 0,
                    reason: 'closed_within_window'
                };
            } else {
                // Trade se cerró DESPUÉS de la ventana
                // Interpolamos linealmente (asunción simplificada)
                const estimatedPnL = (trade.pnl || 0) * (durationMinutes / actualDuration);
                return {
                    pnl: estimatedPnL,
                    reason: 'interpolated'
                };
            }
        }

        // Timeframes a analizar
        const timeframes = [
            { name: '1h', minutes: 60 },
            { name: '6h', minutes: 360 },
            { name: '24h', minutes: 1440 },
            { name: '72h', minutes: 4320 },
            { name: '7d', minutes: 10080 },
            { name: '30d', minutes: 43200 }
        ];

        console.log(`\n📊 ANÁLISIS DE VENTANAS TEMPORALES:`);
        console.log(`Total trades: ${closedTrades.length}\n`);

        const temporalAnalysis = [];

        timeframes.forEach(tf => {
            let winCount = 0;
            let lossCount = 0;
            let totalPnL = 0;
            let totalCapital = 0;
            let validCount = 0;
            let tradesThatClosedInWindow = 0;

            closedTrades.forEach(trade => {
                const evaluation = evaluateAtTimeframe(trade, tf.minutes);

                if (evaluation !== null) {
                    validCount++;
                    totalCapital += (trade.capital_usdt || 0);
                    totalPnL += evaluation.pnl;

                    if (evaluation.pnl > 0.01) {
                        winCount++;
                    } else if (evaluation.pnl < -0.01) {
                        lossCount++;
                    }

                    if (evaluation.reason === 'closed_within_window') {
                        tradesThatClosedInWindow++;
                    }
                }
            });

            if (validCount === 0) {
                console.log(`[${tf.name}] - Sin datos válidos`);
                return;
            }

            const winRate = (winCount / validCount) * 100;
            const avgROI = totalCapital > 0 ? (totalPnL / totalCapital) * 100 : 0;

            // % de trades que realmente se cerraron en esta ventana
            const closureRateInWindow = (tradesThatClosedInWindow / validCount) * 100;

            console.log(`[${tf.name}]`);
            console.log(`  Trades evaluados: ${validCount} (${closureRateInWindow.toFixed(0)}% se cerraron dentro)`);
            console.log(`  Win rate: ${winRate.toFixed(1)}% (${winCount}W/${lossCount}L)`);
            console.log(`  Total PnL: ${totalPnL.toFixed(2)} USDT`);
            console.log(`  Avg ROI: ${avgROI.toFixed(2)}%`);
            console.log('');

            temporalAnalysis.push({
                timeframe: tf.name,
                winRate,
                avgROI,
                closureRate: closureRateInWindow,
                tradeCount: validCount
            });
        });

        // Análisis de patrón temporal
        console.log(`\n🔬 PATRÓN TEMPORAL DETECTADO:`);

        const earlyTF = temporalAnalysis.find(t => t.timeframe === '1h');
        const mediumTF = temporalAnalysis.find(t => t.timeframe === '24h');
        const lateTF = temporalAnalysis.find(t => t.timeframe === '30d');

        if (!earlyTF || !mediumTF || !lateTF) {
            console.log('Datos insuficientes para análisis temporal');
            return;
        }

        const earlyWinRate = earlyTF.winRate || 0;
        const mediumWinRate = mediumTF.winRate || 0;
        const lateWinRate = lateTF.winRate || 0;

        console.log(`1h win rate: ${earlyWinRate.toFixed(1)}%`);
        console.log(`24h win rate: ${mediumWinRate.toFixed(1)}%`);
        console.log(`30d win rate: ${lateWinRate.toFixed(1)}%`);

        if (earlyWinRate > mediumWinRate && mediumWinRate > lateWinRate) {
            console.log(`\n📉 PATRÓN: Win rate DECRECE con el tiempo`);
            console.log(`→ Edge es INMEDIATO (scalping/momentum corto plazo)`);
        } else if (earlyWinRate < mediumWinRate && mediumWinRate < lateWinRate) {
            console.log(`\n📈 PATRÓN: Win rate AUMENTA con el tiempo`);
            console.log(`→ Edge es de MADURACIÓN LENTA (posiciones largas)`);
        } else if (Math.abs(earlyWinRate - lateWinRate) < 10) {
            console.log(`\n➡️ PATRÓN: Win rate ESTABLE en todas las ventanas`);
            console.log(`→ Edge NO depende del timeframe (edge de pares, no de timing)`);
        } else {
            console.log(`\n❓ PATRÓN: Inconsistente`);
        }

        // Conclusión Fase 3
        console.log(`\n📌 CONCLUSIÓN FASE 3:`);
        if (earlyTF.closureRate > 50) {
            console.log(`   ${earlyTF.closureRate.toFixed(0)}% de trades se cierran en < 1h`);
            console.log(`   → Sistema opera en timeframe ULTRA-CORTO`);
        } else if (mediumTF.closureRate > 50) {
            console.log(`   ${mediumTF.closureRate.toFixed(0)}% de trades se cierran en 24h`);
            console.log(`   → Sistema opera en timeframe DIARIO`);
        } else {
            console.log(`   Mayoría de trades duran > 24h`);
            console.log(`   → Sistema opera en timeframe LARGO (swing trading)`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

analyzeTemporalWindow();
