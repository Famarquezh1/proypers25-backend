const db = require('./firebase-admin-config.js');

/**
 * AUDITORÍA FASE 2: VALIDACIÓN DEL SCORE
 * Agrupa trades por score y valida si correlaciona con resultados
 */

async function validateScoreCorrelation() {
    try {
        console.log('\n' + '='.repeat(80));
        console.log('📊 AUDITORÍA FASE 2: VALIDACIÓN DEL SCORE');
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

        // Agrupar por score (bandas de 10)
        const scoreBands = {
            '40-49': [],
            '50-59': [],
            '60-69': [],
            '70-79': [],
            '80-89': [],
            '90-99': []
        };

        closedTrades.forEach(trade => {
            // El score debería estar en strategy_info o metadata
            const score = trade.strategy_info?.confidence_score || trade.confidence_score || 70;

            if (score < 50) scoreBands['40-49'].push(trade);
            else if (score < 60) scoreBands['50-59'].push(trade);
            else if (score < 70) scoreBands['60-69'].push(trade);
            else if (score < 80) scoreBands['70-79'].push(trade);
            else if (score < 90) scoreBands['80-89'].push(trade);
            else scoreBands['90-99'].push(trade);
        });

        console.log(`\n📈 ANÁLISIS POR SCORE:`);
        console.log(`Total trades cerrados: ${closedTrades.length}\n`);

        let scoreAnalysis = [];

        Object.keys(scoreBands).forEach(band => {
            const trades = scoreBands[band];

            if (trades.length === 0) {
                console.log(`[${band}] - Sin datos`);
                return;
            }

            const wins = trades.filter(t => (t.pnl || 0) > 0.01);
            const losses = trades.filter(t => (t.pnl || 0) < -0.01);
            const breakeven = trades.filter(t => Math.abs(t.pnl || 0) <= 0.01);

            const totalPnL = trades.reduce((s, t) => s + (t.pnl || 0), 0);
            const totalCapital = trades.reduce((s, t) => s + (t.capital_usdt || 0), 0);
            const avgROI = (totalPnL / totalCapital) * 100;

            const winRate = (wins.length / trades.length) * 100;
            const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + (t.pnl || 0), 0) / wins.length : 0;
            const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + (t.pnl || 0), 0) / losses.length : 0;

            const expectancy = (winRate / 100 * avgWin) - ((100 - winRate) / 100 * Math.abs(avgLoss));

            console.log(`[${band}] - ${trades.length} trades`);
            console.log(`  Win rate: ${winRate.toFixed(1)}% (${wins.length}W/${losses.length}L/${breakeven.length}BE)`);
            console.log(`  Avg win: ${avgWin.toFixed(2)} USDT | Avg loss: ${avgLoss.toFixed(2)} USDT`);
            console.log(`  Total PnL: ${totalPnL.toFixed(2)} USDT | Avg ROI: ${avgROI.toFixed(2)}%`);
            console.log(`  Expectancy: ${expectancy.toFixed(2)} USDT`);
            console.log('');

            scoreAnalysis.push({
                band,
                count: trades.length,
                winRate,
                avgROI,
                expectancy
            });
        });

        // Verificar si hay correlación score → results
        console.log(`\n🔬 CORRELACIÓN SCORE → RESULTADOS:`);

        const bandWithData = scoreAnalysis.filter(b => b.count > 0);
        const expectancies = bandWithData.map(b => b.expectancy);
        const avgExpectancy = expectancies.reduce((a, b) => a + b) / expectancies.length;

        // Simple trend analysis
        const lowScoreBands = bandWithData.filter(b => ['40-49', '50-59', '60-69'].includes(b.band));
        const highScoreBands = bandWithData.filter(b => ['70-79', '80-89', '90-99'].includes(b.band));

        const lowScoreAvgExpectancy = lowScoreBands.length > 0 ?
            lowScoreBands.reduce((s, b) => s + b.expectancy, 0) / lowScoreBands.length :
            0;

        const highScoreAvgExpectancy = highScoreBands.length > 0 ?
            highScoreBands.reduce((s, b) => s + b.expectancy, 0) / highScoreBands.length :
            0;

        console.log(`Scores bajos (40-69) promedio expectancy: ${lowScoreAvgExpectancy.toFixed(2)}`);
        console.log(`Scores altos (70-99) promedio expectancy: ${highScoreAvgExpectancy.toFixed(2)}`);

        if (highScoreAvgExpectancy > lowScoreAvgExpectancy * 1.2) {
            console.log(`✅ CORRELACIÓN POSITIVA: Scores altos tienen mejor expectancy`);
        } else if (Math.abs(highScoreAvgExpectancy - lowScoreAvgExpectancy) < 1) {
            console.log(`❌ SIN CORRELACIÓN: Scores altos/bajos tienen similar expectancy`);
        } else {
            console.log(`❓ CORRELACIÓN DÉBIL o INVERTIDA`);
        }

        // Conclusión Fase 2
        console.log(`\n📌 CONCLUSIÓN FASE 2:`);
        if (bandWithData.length < 3) {
            console.log(`   ⚠️ MUESTRA INSUFICIENTE en bandas de score`);
        } else if (highScoreAvgExpectancy > lowScoreAvgExpectancy * 1.2) {
            console.log(`   ✅ SCORE ES PREDICTIVO: Correlaciona con resultados reales`);
        } else {
            console.log(`   ❌ SCORE NO ES PREDICTIVO: No correlaciona bien`);
            console.log(`   Puede significar que el modelo predice pares buenos pero no timing`);
        }

    } catch (error) {
        console.error('Error:', error.message);
    }
}

validateScoreCorrelation();
