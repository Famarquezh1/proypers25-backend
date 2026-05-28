const admin = require('firebase-admin');
const path = require('path');
const serviceAccount = require('../proypers2025-5b45437299b5.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async() => {
    try {
        console.log('\n╔════════════════════════════════════════════════════╗');
        console.log('║          MONITOREO LOTE 3 - SPOT PAPER              ║');
        console.log('║     Scan ID: spot_scan_1778194991002                ║');
        console.log('╚════════════════════════════════════════════════════╝\n');

        // PASO 2: Obtener posiciones ABIERTAS del Lote 3
        const openSnapshot = await db.collection('spot_paper_positions')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .where('status', '==', 'PAPER_OPEN')
            .get();

        console.log('📂 POSICIONES ABIERTAS:');
        console.log(`   Total: ${openSnapshot.size}\n`);

        const openPositions = [];
        openSnapshot.forEach(doc => {
            const data = doc.data();
            openPositions.push(data);
            console.log(`   • ${data.symbol}`);
            console.log(`     Entry: $${data.entry_price_simulated}`);
            console.log(`     Current: $${data.current_price_simulated || 'N/A'}`);
            console.log(`     Qty: ${data.simulated_quantity.toFixed(2)}`);
            console.log(`     Capital: $${data.simulated_capital_usdt}`);
            console.log(`     Creada: ${data.created_at}\n`);
        });

        // Obtener posiciones CERRADAS del Lote 3
        const closedSnapshot = await db.collection('spot_paper_positions')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .where('status', '==', 'PAPER_CLOSED')
            .get();

        console.log(`\n📊 POSICIONES CERRADAS: ${closedSnapshot.size}\n`);
        closedSnapshot.forEach(doc => {
            const data = doc.data();
            console.log(`   • ${data.symbol} (${data.close_reason || 'N/A'})`);
            console.log(`     PnL: $${data.unrealized_pnl_usdt || 0}`);
            console.log(`     Duración: ${data.closed_at ? new Date(data.closed_at).toISOString().split('T')[0] : 'N/A'}\n`);
        });

        // PASO 2 (cont): Obtener RESULTADOS de Lote 3
        const resultsSnapshot = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .get();

        console.log(`\n🎯 RESULTADOS EJECUTADOS: ${resultsSnapshot.size}\n`);

        let lote3Trades = [];
        let totalPnL = 0;
        let winCount = 0;
        let lossCount = 0;
        let tpCount = { TP1: 0, TP2: 0, SL: 0, TIMEOUT: 0 };

        resultsSnapshot.forEach(doc => {
            const data = doc.data();
            lote3Trades.push(data);

            const pnl = data.estimated_net_pnl_usdt || data.gross_pnl_usdt;
            totalPnL += pnl;

            if (pnl > 0) winCount++;
            else if (pnl < 0) lossCount++;

            if (data.close_reason) tpCount[data.close_reason] = (tpCount[data.close_reason] || 0) + 1;

            const createdDate = new Date(data.created_at);
            const closedDate = new Date(data.closed_at);
            const duration = Math.round((closedDate - createdDate) / 3600000); // horas

            console.log(`   • ${data.symbol}`);
            console.log(`     Razón: ${data.close_reason}`);
            console.log(`     Entry: $${data.entry_price_simulated} → Exit: $${data.exit_price_simulated}`);
            console.log(`     PnL: $${pnl.toFixed(2)} (${data.estimated_net_pnl_pct?.toFixed(2) || data.gross_pnl_pct}%)`);
            console.log(`     Duración: ${duration}h\n`);
        });

        // PASO 3: Reportar métricas del Lote 3
        console.log('╔════════════════════════════════════════════════════╗');
        console.log('║              RESUMEN LOTE 3                        ║');
        console.log('╚════════════════════════════════════════════════════╝\n');

        const totalTrades = winCount + lossCount;
        const winRate = totalTrades > 0 ? ((winCount / totalTrades) * 100).toFixed(2) : 0;
        const profitFactor = lossCount > 0 ? (winCount / lossCount).toFixed(2) : (winCount > 0 ? '∞' : '0');

        console.log(`✅ ESTADO:`);
        console.log(`   Posiciones Abiertas: ${openSnapshot.size}`);
        console.log(`   Posiciones Cerradas: ${closedSnapshot.size}`);
        console.log(`   Trades Totales: ${totalTrades}\n`);

        console.log(`💰 FINANCIERO:`);
        console.log(`   PnL Total: $${totalPnL.toFixed(2)}`);
        console.log(`   PnL %: ${((totalPnL / 300) * 100).toFixed(2)}%`); // 3 posiciones × $100 = $300
        console.log(`   Ganadores: ${winCount}`);
        console.log(`   Perdedores: ${lossCount}`);
        console.log(`   Win Rate: ${winRate}%`);
        console.log(`   Profit Factor: ${profitFactor}x\n`);

        console.log(`📍 CIERRE DE POSICIONES:`);
        console.log(`   TP1: ${tpCount.TP1 || 0}`);
        console.log(`   TP2: ${tpCount.TP2 || 0}`);
        console.log(`   SL: ${tpCount.SL || 0}`);
        console.log(`   TIMEOUT: ${tpCount.TIMEOUT || 0}\n`);

        // PASO 4: Comparación con otros lotes
        console.log('\n╔════════════════════════════════════════════════════╗');
        console.log('║        COMPARACIÓN CON OTROS LOTES                 ║');
        console.log('╚════════════════════════════════════════════════════╝\n');

        // Lote 1
        const lote1Results = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', 'spot_scan_1778113621996')
            .get();

        let lote1PnL = 0;
        let lote1Win = 0;
        lote1Results.forEach(doc => {
            const pnl = doc.data().estimated_net_pnl_usdt || doc.data().gross_pnl_usdt;
            lote1PnL += pnl;
            if (pnl > 0) lote1Win++;
        });

        const lote1WR = lote1Results.size > 0 ? ((lote1Win / lote1Results.size) * 100).toFixed(2) : 0;

        // Lote 2
        const lote2Results = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', 'spot_scan_1778163124046')
            .get();

        let lote2PnL = 0;
        let lote2Win = 0;
        lote2Results.forEach(doc => {
            const pnl = doc.data().estimated_net_pnl_usdt || doc.data().gross_pnl_usdt;
            lote2PnL += pnl;
            if (pnl > 0) lote2Win++;
        });

        const lote2WR = lote2Results.size > 0 ? ((lote2Win / lote2Results.size) * 100).toFixed(2) : 0;

        console.log(`LOTE 1 (spot_scan_1778113621996):`);
        console.log(`   Trades: ${lote1Results.size}`);
        console.log(`   PnL: $${lote1PnL.toFixed(2)}`);
        console.log(`   Win Rate: ${lote1WR}%\n`);

        console.log(`LOTE 2 (spot_scan_1778163124046):`);
        console.log(`   Trades: ${lote2Results.size}`);
        console.log(`   PnL: $${lote2PnL.toFixed(2)}`);
        console.log(`   Win Rate: ${lote2WR}%\n`);

        console.log(`LOTE 3 (ACTUAL - spot_scan_1778194991002):`);
        console.log(`   Trades: ${totalTrades}`);
        console.log(`   PnL: $${totalPnL.toFixed(2)}`);
        console.log(`   Win Rate: ${winRate}%\n`);

        const acumuladoTotal = lote1PnL + lote2PnL + totalPnL;
        const totalTradeCounts = lote1Results.size + lote2Results.size + totalTrades;
        const totalWins = lote1Win + lote2Win + winCount;
        const acumuladoWR = totalTradeCounts > 0 ? ((totalWins / totalTradeCounts) * 100).toFixed(2) : 0;

        console.log(`ACUMULADO TOTAL (L1 + L2 + L3):`);
        console.log(`   Trades: ${totalTradeCounts}`);
        console.log(`   PnL: $${acumuladoTotal.toFixed(2)}`);
        console.log(`   Win Rate: ${acumuladoWR}%\n`);

        // PASO 5: Conclusión
        console.log('\n╔════════════════════════════════════════════════════╗');
        console.log('║              CONCLUSIÓN                            ║');
        console.log('╚════════════════════════════════════════════════════╝\n');

        if (openSnapshot.size === 0 && closedSnapshot.size > 0) {
            console.log('✅ LOTE 3 COMPLETAMENTE CERRADO\n');
            if (totalPnL > 0) {
                console.log(`   Estado: ✅ POSITIVO`);
                console.log(`   Resultado: +$${totalPnL.toFixed(2)} ganancia\n`);
            } else if (totalPnL < 0) {
                console.log(`   Estado: ❌ NEGATIVO`);
                console.log(`   Resultado: -$${Math.abs(totalPnL).toFixed(2)} pérdida\n`);
            } else {
                console.log(`   Estado: ➖ NEUTRAL`);
                console.log(`   Resultado: $0.00 sin ganancia ni pérdida\n`);
            }
        } else if (openSnapshot.size > 0) {
            console.log(`⏳ LOTE 3 PARCIALMENTE ABIERTO`);
            console.log(`   ${openSnapshot.size} posiciones aún en ejecución`);
            console.log(`   ${closedSnapshot.size} posiciones ya cerradas\n`);
        }

        if (winRate == 66.67 && (tpCount.TP1 === 2 && tpCount.SL === 1)) {
            console.log('📊 PATRÓN 2W/1L MANTENIDO ✅');
            console.log('   Consistencia: El sistema mantiene el patrón esperado de 66.67% win rate');
        } else if (totalTrades > 0) {
            console.log(`📊 PATRÓN MODIFICADO`);
            console.log(`   Win Rate: ${winRate}% (esperado: 66.67%)`);
            console.log(`   Distribución: ${winCount}W / ${lossCount}L (esperado: 2W / 1L)`);
        }

        console.log('\n' + '═'.repeat(54) + '\n');

    } catch (error) {
        console.error('Error:', error.message);
    } finally {
        process.exit(0);
    }
})();