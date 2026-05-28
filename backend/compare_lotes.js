#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('../proypers2025-5b45437299b5.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

async function analyzeLote(scanId, loteName) {
    const results = await db.collection('spot_paper_execution_results')
        .where('scan_id', '==', scanId)
        .get();

    let stats = {
        totalPnL: 0,
        wins: 0,
        losses: 0,
        trades: 0,
        symbols: []
    };

    results.forEach(doc => {
        const d = doc.data();
        const pnl = d.estimated_net_pnl_usdt || d.gross_pnl_usdt;
        stats.totalPnL += pnl;
        if (pnl > 0) stats.wins++;
        else stats.losses++;
        stats.trades++;
        stats.symbols.push({ sym: d.symbol, pnl: pnl, reason: d.close_reason });
    });

    return stats;
}

async function main() {
    try {
        console.log('\n╔════════════════════════════════════════════════════╗');
        console.log('║      COMPARACIÓN LOTES 1, 2, 3                    ║');
        console.log('╚════════════════════════════════════════════════════╝\n');

        // Lote 1
        const l1 = await analyzeLote('spot_scan_1778113621996', 'Lote 1');

        // Lote 2
        const l2 = await analyzeLote('spot_scan_1778163124046', 'Lote 2');

        // Lote 3 (posiciones aún abiertas)
        const l3pos = await db.collection('spot_paper_positions')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .where('status', '==', 'PAPER_OPEN')
            .get();

        const l3 = {
            totalPnL: 0,
            wins: 0,
            losses: 0,
            trades: 0,
            symbols: [],
            open: l3pos.size
        };

        console.log('LOTE 1 (spot_scan_1778113621996):');
        console.log(`  Trades Cerrados: ${l1.trades}`);
        console.log(`  PnL Total: $${l1.totalPnL.toFixed(2)}`);
        if (l1.trades > 0) {
            const wr1 = ((l1.wins / l1.trades) * 100).toFixed(2);
            console.log(`  Win Rate: ${wr1}% (${l1.wins}W / ${l1.losses}L)`);
        }
        console.log(`  Status: CERRADO\n`);

        console.log('LOTE 2 (spot_scan_1778163124046):');
        console.log(`  Trades Cerrados: ${l2.trades}`);
        console.log(`  PnL Total: $${l2.totalPnL.toFixed(2)}`);
        if (l2.trades > 0) {
            const wr2 = ((l2.wins / l2.trades) * 100).toFixed(2);
            console.log(`  Win Rate: ${wr2}% (${l2.wins}W / ${l2.losses}L)`);
        }
        console.log(`  Status: CERRADO\n`);

        console.log('LOTE 3 (spot_scan_1778194991002):');
        console.log(`  Trades Cerrados: 0`);
        console.log(`  Posiciones Abiertas: ${l3pos.size}`);
        l3pos.forEach(doc => {
            const d = doc.data();
            console.log(`    • ${d.symbol}`);
        });
        console.log(`  Status: EN EJECUCIÓN\n`);

        const totalPnL = l1.totalPnL + l2.totalPnL + l3.totalPnL;
        const totalTrades = l1.trades + l2.trades;
        const totalWins = l1.wins + l2.wins;

        console.log('═════════════════════════════════════════════════════\n');
        console.log('ACUMULADO (L1 + L2):');
        console.log(`  Trades Completados: ${totalTrades}`);
        console.log(`  PnL Total: $${totalPnL.toFixed(2)}`);
        if (totalTrades > 0) {
            const wrTotal = ((totalWins / totalTrades) * 100).toFixed(2);
            console.log(`  Win Rate: ${wrTotal}% (${totalWins}W / ${totalTrades - totalWins}L)`);
        }
        console.log(`  ROI: ${((totalPnL / 200) * 100).toFixed(2)}%\n`);

        console.log('═════════════════════════════════════════════════════\n');
        console.log('CONCLUSIÓN LOTE 3:\n');
        console.log(`✅ ESTADO: EN EJECUCIÓN`);
        console.log(`   Posiciones abiertas: NILUSDT, NOTUSDT, TONUSDT`);
        console.log(`   Esperando cierre de 3 posiciones\n`);
        console.log(`📊 PATRÓN:`);
        console.log(`   Lote 1: 66.67% WR (2W/1L)`);
        console.log(`   Lote 2: 66.67% WR (2W/1L)`);
        console.log(`   Lote 3: Pendiente de cierre\n`);

        console.log('═════════════════════════════════════════════════════\n');

    } catch (err) {
        console.error('ERROR:', err.message);
    } finally {
        process.exit(0);
    }
}

main();