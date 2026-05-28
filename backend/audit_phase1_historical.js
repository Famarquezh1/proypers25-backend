const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FASE 1: HISTÓRICO COMPLETO DE TRADES
 * Extrae todos los trades y calcula métricas estadísticas reales
 */

async function auditHistoricalTrades() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('🔍 AUDITORÍA FASE 1: HISTÓRICO COMPLETO DE TRADES');
        console.log('='.repeat(80));

        // Obtener TODOS los trades (abiertos + cerrados)
        const allPositions = await db.collection('real_spot_positions').get();

        const trades = [];
        const openTrades = [];
        const closedTrades = [];

        allPositions.forEach(doc => {
            const trade = { id: doc.id, ...doc.data() };
            trades.push(trade);

            if (trade.status === 'REAL_OPEN') {
                openTrades.push(trade);
            } else if (trade.status === 'CLOSED') {
                closedTrades.push(trade);
            }
        });

        console.log(`\n📊 ESTADÍSTICAS GENERALES:`);
        console.log(`   Total trades: ${trades.length}`);
        console.log(`   Abiertos: ${openTrades.length}`);
        console.log(`   Cerrados: ${closedTrades.length}`);

        // Calcular métricas base
        let totalCapital = 0;
        let totalProfit = 0;
        let winCount = 0;
        let lossCount = 0;
        let breakEvenCount = 0;
        let avgWin = 0;
        let avgLoss = 0;
        let maxWin = -Infinity;
        let maxLoss = Infinity;
        let maxDrawdown = 0;
        let tradeDurations = [];

        closedTrades.forEach(trade => {
            const { capital_usdt, entry_price, pnl, closed_price, opened_at, closed_at } = trade;

            totalCapital += capital_usdt;
            totalProfit += (pnl || 0);

            const pnlPct = ((pnl || 0) / capital_usdt) * 100;

            if (pnl > 0.01) {
                winCount++;
                avgWin += pnl;
                maxWin = Math.max(maxWin, pnl);
            } else if (pnl < -0.01) {
                lossCount++;
                avgLoss += pnl;
                maxLoss = Math.min(maxLoss, pnl);
            } else {
                breakEvenCount++;
            }

            // Duraciones
            if (opened_at && closed_at) {
                const duration = new Date(closed_at) - new Date(opened_at);
                tradeDurations.push(duration / 1000 / 60); // en minutos
            }
        });

        avgWin = winCount > 0 ? avgWin / winCount : 0;
        avgLoss = lossCount > 0 ? avgLoss / lossCount : 0;

        const winRate = closedTrades.length > 0 ? (winCount / closedTrades.length) * 100 : 0;
        const lossRate = closedTrades.length > 0 ? (lossCount / closedTrades.length) * 100 : 0;

        // Expectancy = (%win × avgWin) - (%loss × |avgLoss|)
        const expectancy = (winRate / 100 * avgWin) - (lossRate / 100 * Math.abs(avgLoss));

        // Profit Factor = ganancias totales / pérdidas totales
        const totalWinPnL = closedTrades.filter(t => (t.pnl || 0) > 0).reduce((s, t) => s + (t.pnl || 0), 0);
        const totalLossPnL = Math.abs(closedTrades.filter(t => (t.pnl || 0) < 0).reduce((s, t) => s + (t.pnl || 0), 0));
        const profitFactor = totalLossPnL > 0 ? totalWinPnL / totalLossPnL : 0;

        const avgDuration = tradeDurations.length > 0 ? tradeDurations.reduce((a, b) => a + b) / tradeDurations.length : 0;

        console.log(`\n💰 MÉTRICAS DE RENTABILIDAD:`);
        console.log(`   Capital total usado: ${totalCapital.toFixed(2)} USDT`);
        console.log(`   Profit neto: ${totalProfit >= 0 ? '+' : ''}${totalProfit.toFixed(2)} USDT`);
        console.log(`   ROI total: ${totalCapital > 0 ? (totalProfit / totalCapital * 100).toFixed(2) : 0}%`);

        console.log(`\n📈 ESTADÍSTICAS DE TRADES CERRADOS:`);
        console.log(`   Win rate: ${winRate.toFixed(2)}% (${winCount} ganancias)`);
        console.log(`   Loss rate: ${lossRate.toFixed(2)}% (${lossCount} pérdidas)`);
        console.log(`   Break-even: ${breakEvenCount}`);
        console.log(`   Avg win: ${avgWin.toFixed(2)} USDT (${avgWin > 0 ? ((avgWin / (totalCapital / closedTrades.length || 1)) * 100).toFixed(2) : 0}%)`);
        console.log(`   Avg loss: ${avgLoss.toFixed(2)} USDT (${avgLoss < 0 ? ((avgLoss / (totalCapital / closedTrades.length || 1)) * 100).toFixed(2) : 0}%)`);
        console.log(`   Max win: ${maxWin.toFixed(2)} USDT`);
        console.log(`   Max loss: ${maxLoss.toFixed(2)} USDT`);

        console.log(`\n🎯 EXPECTANCY Y FACTOR:`);
        console.log(`   Expectancy: ${expectancy.toFixed(2)} USDT (esperado por trade)`);
        console.log(`   Profit Factor: ${profitFactor.toFixed(2)}x`);
        console.log(`   Duración promedio: ${avgDuration.toFixed(0)} minutos (${(avgDuration / 60).toFixed(1)} horas)`);

        // Distribución de ganancias
        console.log(`\n📊 DISTRIBUCIÓN DE GANANCIAS (trades cerrados):`);
        let dist = {
            'explosive_500plus': 0,
            'moonshot_50_500': 0,
            'large_20_50': 0,
            'medium_5_20': 0,
            'small_1_5': 0,
            'breakeven': 0,
            'small_loss_1_5': 0,
            'medium_loss_5_20': 0,
            'large_loss_20_plus': 0
        };

        closedTrades.forEach(trade => {
            const pnlPct = ((trade.pnl || 0) / trade.capital_usdt) * 100;

            if (pnlPct >= 500) dist.explosive_500plus++;
            else if (pnlPct >= 50) dist.moonshot_50_500++;
            else if (pnlPct >= 20) dist.large_20_50++;
            else if (pnlPct >= 5) dist.medium_5_20++;
            else if (pnlPct >= 1) dist.small_1_5++;
            else if (pnlPct > -1) dist.breakeven++;
            else if (pnlPct >= -5) dist.small_loss_1_5++;
            else if (pnlPct >= -20) dist.medium_loss_5_20++;
            else dist.large_loss_20_plus++;
        });

        console.log(`   +500%+: ${dist.explosive_500plus}`);
        console.log(`   +50% a +500%: ${dist.moonshot_50_500}`);
        console.log(`   +20% a +50%: ${dist.large_20_50}`);
        console.log(`   +5% a +20%: ${dist.medium_5_20}`);
        console.log(`   +1% a +5%: ${dist.small_1_5}`);
        console.log(`   Break-even: ${dist.breakeven}`);
        console.log(`   -1% a -5%: ${dist.small_loss_1_5}`);
        console.log(`   -5% a -20%: ${dist.medium_loss_5_20}`);
        console.log(`   -20%+: ${dist.large_loss_20_plus}`);

        // Análisis de compensación: ¿pocos grandes ganan muchos pequeños?
        const explosiveWins = closedTrades.filter(t => ((t.pnl || 0) / t.capital_usdt) >= 0.5).reduce((s, t) => s + (t.pnl || 0), 0);
        const smallLosses = closedTrades.filter(t => {
            const pnlPct = ((t.pnl || 0) / t.capital_usdt);
            return pnlPct < 0 && pnlPct >= -0.05;
        }).reduce((s, t) => s + (t.pnl || 0), 0);

        console.log(`\n💥 ANÁLISIS DE COMPENSACIÓN:`);
        console.log(`   Ganancias explosivas (+50%+): ${explosiveWins.toFixed(2)} USDT`);
        console.log(`   Pequeñas pérdidas (-1% a -5%): ${smallLosses.toFixed(2)} USDT`);
        console.log(`   Ratio: ${explosiveWins > 0 ? (explosiveWins / Math.abs(smallLosses || 1)).toFixed(2) : 0}x`);

        // Conclusión de Fase 1
        console.log(`\n📌 CONCLUSIÓN FASE 1:`);
        if (closedTrades.length < 5) {
            console.log(`   ⚠️ MUESTRA INSUFICIENTE (${closedTrades.length} trades cerrados)`);
            console.log(`   No hay suficientes datos para conclusiones estadísticas`);
        } else if (winRate < 40) {
            console.log(`   ⚠️ Win rate bajo (${winRate.toFixed(2)}%)`);
            console.log(`   Sistema solo gana < 40% de los trades`);
            if (profitFactor > 2) {
                console.log(`   ✅ PERO profit factor alto (${profitFactor.toFixed(2)}x)`);
                console.log(`   → Indica MODELO ASIMÉTRICO: pocos grandes ganan muchos pequeños`);
            } else {
                console.log(`   ❌ Profit factor bajo: SIN EDGE suficiente`);
            }
        } else {
            console.log(`   ✅ Win rate aceptable (${winRate.toFixed(2)}%)`);
        }

        return {
            totalTrades: trades.length,
            openTrades: openTrades.length,
            closedTrades: closedTrades.length,
            winRate,
            lossRate,
            avgWin,
            avgLoss,
            totalProfit,
            expectancy,
            profitFactor,
            distribution: dist
        };

    } catch (error) {
        console.error('Error:', error.message);
    }
}

auditHistoricalTrades();
