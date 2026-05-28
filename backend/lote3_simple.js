#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('../proypers2025-5b45437299b5.json');

admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

const LOTE3_SCAN_ID = 'spot_scan_1778194991002';

async function main() {
    try {
        console.log('\n═══════════════════════════════════════════════════');
        console.log('          MONITOREO LOTE 3 - SPOT PAPER              ');
        console.log('═══════════════════════════════════════════════════\n');

        // Query: Posiciones ABIERTAS del Lote 3
        const openPos = await db.collection('spot_paper_positions')
            .where('scan_id', '==', LOTE3_SCAN_ID)
            .where('status', '==', 'PAPER_OPEN')
            .get();

        // Query: Posiciones CERRADAS del Lote 3
        const closedPos = await db.collection('spot_paper_positions')
            .where('scan_id', '==', LOTE3_SCAN_ID)
            .where('status', '==', 'PAPER_CLOSED')
            .get();

        // Query: Resultados de Lote 3
        const results = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', LOTE3_SCAN_ID)
            .get();

        console.log('📂 POSICIONES DEL LOTE 3:');
        console.log(`   Abiertas: ${openPos.size}`);
        console.log(`   Cerradas: ${closedPos.size}\n`);

        if (openPos.size > 0) {
            console.log('🔓 ABIETAS:');
            openPos.forEach(doc => {
                const d = doc.data();
                console.log(`   • ${d.symbol}`);
            });
            console.log();
        }

        // Analizar resultados
        let stats = {
            totalPnL: 0,
            wins: 0,
            losses: 0,
            tp1: 0,
            tp2: 0,
            sl: 0,
            trades: []
        };

        results.forEach(doc => {
            const d = doc.data();
            const pnl = d.estimated_net_pnl_usdt || d.gross_pnl_usdt;

            stats.totalPnL += pnl;
            if (pnl > 0) stats.wins++;
            else stats.losses++;

            if (d.close_reason === 'TP1') stats.tp1++;
            else if (d.close_reason === 'TP2') stats.tp2++;
            else if (d.close_reason === 'SL') stats.sl++;

            stats.trades.push({
                symbol: d.symbol,
                reason: d.close_reason,
                pnl: pnl
            });
        });

        console.log('🎯 TRADES EJECUTADOS:');
        console.log(`   Total: ${results.size}`);
        if (results.size > 0) {
            stats.trades.forEach(t => {
                const sign = t.pnl > 0 ? '✓' : '✗';
                console.log(`   ${sign} ${t.symbol}: ${t.reason} ($${t.pnl.toFixed(2)})`);
            });
        }

        console.log('\n📊 MÉTRICAS:');
        console.log(`   PnL Total: $${stats.totalPnL.toFixed(2)}`);
        if (results.size > 0) {
            console.log(`   Win Rate: ${((stats.wins / results.size) * 100).toFixed(2)}%`);
            console.log(`   Ganadores: ${stats.wins}`);
            console.log(`   Perdedores: ${stats.losses}`);
            console.log(`   TP1: ${stats.tp1}`);
            console.log(`   TP2: ${stats.tp2}`);
            console.log(`   SL: ${stats.sl}`);
        }

        console.log('\n✅ STATUS:');
        if (openPos.size === 0 && results.size > 0) {
            console.log('   Lote 3: COMPLETAMENTE CERRADO');
            if (stats.totalPnL > 0) {
                console.log(`   Resultado: ✅ POSITIVO (+$${stats.totalPnL.toFixed(2)})`);
            } else if (stats.totalPnL < 0) {
                console.log(`   Resultado: ❌ NEGATIVO (-$${Math.abs(stats.totalPnL).toFixed(2)})`);
            }
        } else if (openPos.size > 0) {
            console.log('   Lote 3: PARCIALMENTE ABIERTO');
            console.log(`   ${openPos.size} posiciones en ejecución`);
        } else {
            console.log('   Lote 3: NO HAY DATOS');
        }

        console.log('\n═══════════════════════════════════════════════════\n');

    } catch (err) {
        console.error('ERROR:', err.message);
    } finally {
        process.exit(0);
    }
}

main();