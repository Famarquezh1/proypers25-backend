#!/usr/bin/env node

/**
 * TEST SCRIPT: Execute paper-only TIMEOUT closure directly
 * Tests the new timeout logic for Lote 3
 */

const admin = require('firebase-admin');
const path = require('path');
const { runSpotPaperExecutionCycle } = require('./services/binanceSpotPaperExecutor');

const serviceAccountPath = path.join(__dirname, '..', 'proypers2025-5b45437299b5.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'proypers2025'
});

const db = admin.firestore();

async function testTimeoutClosure() {
    console.log('\n' + '═'.repeat(80));
    console.log('TEST: PAPER-ONLY TIMEOUT CLOSURE');
    console.log('═'.repeat(80));
    console.log('\nExecuting spot paper execution cycle to close timed-out positions...\n');

    try {
        const result = await runSpotPaperExecutionCycle(db, {
            paper_only: true
        });

        console.log('\n' + '═'.repeat(80));
        console.log('CYCLE RESULTS');
        console.log('═'.repeat(80));
        console.log(`Open positions seen: ${result.open_positions_seen}`);
        console.log(`Positions closed: ${result.positions_closed}`);
        console.log(`Positions updated: ${result.open_positions_updated}`);
        console.log(`New intents created: ${result.intents_created}`);

        if (result.diagnostic) {
            console.log('\n' + '─'.repeat(80));
            console.log('DIAGNOSTIC SUMMARY');
            console.log('─'.repeat(80));
            console.log(`Total open paper positions: ${result.diagnostic.open_paper_positions}`);
            console.log(`Total closed paper positions: ${result.diagnostic.closed_paper_positions}`);
            console.log(`Total net PnL: $${result.diagnostic.total_net_pnl_usdt}`);
            console.log(`Win rate: ${result.diagnostic.win_rate}%`);

            if (result.diagnostic.recent_paper_trades && result.diagnostic.recent_paper_trades.length > 0) {
                console.log('\n' + '─'.repeat(80));
                console.log('RECENT TRADES (Last 5)');
                console.log('─'.repeat(80));
                for (const trade of result.diagnostic.recent_paper_trades.slice(0, 5)) {
                    console.log(`  ${trade.symbol}: ${trade.close_reason} → ${trade.estimated_net_pnl_usdt} USDT (${trade.estimated_net_pnl_pct.toFixed(2)}%)`);
                    if (trade.fallback_price_used) {
                        console.log(`    [Used fallback price]`);
                    }
                }
            }
        }

        console.log('\n' + '═'.repeat(80));
        console.log('✓ CYCLE COMPLETED SUCCESSFULLY');
        console.log('═'.repeat(80) + '\n');

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        console.error(error.stack);
    } finally {
        await admin.app().delete();
    }
}

testTimeoutClosure().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});