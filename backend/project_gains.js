const db = require('./firebase-admin-config.js');

async function projectGains() {
    try {
        // Get open positions
        const openPositions = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .get();

        console.log(`\n💰 PROYECCIÓN DE GANANCIAS\n`);
        console.log(`=`.repeat(60));

        let totalCapital = 0;
        const trades = [];

        openPositions.forEach((doc) => {
            const data = doc.data();
            totalCapital += data.capital_usdt;
            trades.push({
                symbol: data.symbol,
                capital: data.capital_usdt,
                entry: data.entry_price,
                qty: data.executed_quantity,
                tp_targets: data.strategy_info?.tp_targets || [50, 150, 500],
                sl_pct: data.strategy_info?.sl_target || -20
            });
        });

        console.log(`\n📊 POSICIONES ABIERTAS: ${trades.length}`);
        console.log(`💵 CAPITAL TOTAL EN RIESGO: ${totalCapital} USDT\n`);

        // Calculate projections per trade
        let bestCaseTotal = 0;
        let moderateCaseTotal = 0;
        let worstCaseTotal = 0;

        trades.forEach((trade, idx) => {
            console.log(`\n🔹 Trade ${idx + 1}: ${trade.symbol}`);
            console.log(`   Capital: ${trade.capital} USDT`);
            console.log(`   Entry: ${trade.entry}`);
            console.log(`   Quantity: ${trade.qty.toFixed(2)}`);
            console.log(`\n   📈 Escenarios de ganancia:`);

            // TP1
            const tp1Gain = trade.capital * (trade.tp_targets[0] / 100);
            console.log(`      TP1 (+${trade.tp_targets[0]}%): +${tp1Gain.toFixed(2)} USDT | Total: ${(trade.capital + tp1Gain).toFixed(2)} USDT`);

            // TP2
            const tp2Gain = trade.capital * (trade.tp_targets[1] / 100);
            console.log(`      TP2 (+${trade.tp_targets[1]}%): +${tp2Gain.toFixed(2)} USDT | Total: ${(trade.capital + tp2Gain).toFixed(2)} USDT`);

            // TP3 (mejor caso)
            const tp3Gain = trade.capital * (trade.tp_targets[2] / 100);
            console.log(`      TP3 (+${trade.tp_targets[2]}%): +${tp3Gain.toFixed(2)} USDT | Total: ${(trade.capital + tp3Gain).toFixed(2)} USDT`);

            // Stop Loss (peor caso)
            const slLoss = trade.capital * (trade.sl_pct / 100);
            console.log(`      🛑 SL (${trade.sl_pct}%): ${slLoss.toFixed(2)} USDT | Total: ${(trade.capital + slLoss).toFixed(2)} USDT`);

            bestCaseTotal += tp3Gain;
            moderateCaseTotal += tp2Gain;
            worstCaseTotal += slLoss;
        });

        console.log(`\n${'='.repeat(60)}`);
        console.log(`\n🎯 PROYECCIONES TOTALES (para 2 posiciones):\n`);
        console.log(`   🟢 MEJOR CASO (ambas llegan TP3):`);
        console.log(`      Ganancia: +${bestCaseTotal.toFixed(2)} USDT`);
        console.log(`      ROI: ${((bestCaseTotal / totalCapital) * 100).toFixed(2)}%\n`);

        console.log(`   🟡 CASO MODERADO (ambas llegan TP2):`);
        console.log(`      Ganancia: +${moderateCaseTotal.toFixed(2)} USDT`);
        console.log(`      ROI: ${((moderateCaseTotal / totalCapital) * 100).toFixed(2)}%\n`);

        console.log(`   🔴 PEOR CASO (ambas tocan SL):`);
        console.log(`      Pérdida: ${worstCaseTotal.toFixed(2)} USDT`);
        console.log(`      ROI: ${((worstCaseTotal / totalCapital) * 100).toFixed(2)}%\n`);

        console.log(`${'='.repeat(60)}`);
        console.log(`\n📌 CONTEXTO DEL SISTEMA:`);
        console.log(`   Capital total disponible: ~100 USDT`);
        console.log(`   % en riesgo ahora: ${((totalCapital / 100) * 100).toFixed(1)}%`);
        console.log(`   Estrategia: MOONSHOT (30% del capital híbrido)`);
        console.log(`   Riesgo/Recompensa: -20% / +50%-150%-500%`);

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

projectGains();
