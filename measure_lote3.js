const admin = require('firebase-admin');
const serviceAccount = require('./firebase-service-account.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

(async() => {
    try {
        // Obtener posiciones del Lote 3 (scan_1778194991002)
        const snapshot = await db.collection('spot_paper_positions')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .get();

        console.log('\n=== LOTE 3 (spot_scan_1778194991002) ===');
        console.log(`Total posiciones encontradas: ${snapshot.size}\n`);

        snapshot.forEach(doc => {
            const data = doc.data();
            console.log(`Símbolo: ${data.symbol}`);
            console.log(`  Status: ${data.status}`);
            console.log(`  Entry Price: ${data.entry_price_simulated}`);
            console.log(`  Current Price: ${data.current_price_simulated || 'N/A'}`);
            console.log(`  Cantidad: ${data.simulated_quantity}`);
            console.log(`  PnL Actual: ${data.unrealized_pnl_usdt || 'Cerrada'}`);
            console.log(`  Creada: ${data.created_at}`);
            console.log('');
        });

        // Obtener resultados cerrados del Lote 3
        const resultsSnapshot = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .get();

        console.log(`\n=== RESULTADOS CERRADOS LOTE 3 ===`);
        console.log(`Total cerradas: ${resultsSnapshot.size}\n`);

        resultsSnapshot.forEach(doc => {
            const data = doc.data();
            console.log(`Símbolo: ${data.symbol}`);
            console.log(`  Razón cierre: ${data.close_reason}`);
            console.log(`  PnL Neto: $${data.estimated_net_pnl_usdt || data.gross_pnl_usdt}`);
            console.log(`  ROI: ${data.estimated_net_pnl_pct || data.gross_pnl_pct}%`);
            console.log(`  Cerrada: ${data.closed_at}`);
            console.log('');
        });

        // Resumen Lote 3
        let totalPnl = 0;
        let winCount = 0;
        let lossCount = 0;

        resultsSnapshot.forEach(doc => {
            const data = doc.data();
            const pnl = data.estimated_net_pnl_usdt || data.gross_pnl_usdt;
            totalPnl += pnl;
            if (pnl > 0) winCount++;
            else lossCount++;
        });

        console.log('\n=== RESUMEN LOTE 3 ===');
        console.log(`Posiciones Cerradas: ${resultsSnapshot.size}`);
        console.log(`Posiciones Abiertas: ${snapshot.size}`);
        console.log(`Total PnL: $${totalPnl.toFixed(2)}`);
        if (winCount + lossCount > 0) {
            console.log(`Win Rate: ${((winCount / (winCount + lossCount)) * 100).toFixed(2)}%`);
            console.log(`TP1/SL: ${winCount}W / ${lossCount}L`);
        }

    } catch (error) {
        console.error('Error:', error);
    } finally {
        process.exit(0);
    }
})();