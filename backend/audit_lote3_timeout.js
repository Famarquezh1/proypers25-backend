#!/usr/bin/env node

/**
 * AUDIT SCRIPT: Why Lote 3 positions remain open after 24+ hours
 * DIAGNOSTIC ONLY - NO MODIFICATIONS
 * 
 * Usage: node audit_lote3_timeout.js
 */

const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase
const serviceAccountPath = path.join(__dirname, '..', 'proypers2025-5b45437299b5.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'proypers2025'
});

const db = admin.firestore();

// Configuration
const TARGET_SCAN_ID = 'spot_scan_1778194991002';
const TARGET_SYMBOLS = ['NILUSDT', 'NOTUSDT', 'TONUSDT'];
const TIMEOUT_HOURS = 24;

async function auditLote3() {
    console.log('\n' + '═'.repeat(80));
    console.log('AUDIT: LOTE 3 TIMEOUT ANALYSIS');
    console.log('═'.repeat(80));
    console.log(`\nTarget Scan ID: ${TARGET_SCAN_ID}`);
    console.log(`Target Symbols: ${TARGET_SYMBOLS.join(', ')}`);
    console.log(`Configured Timeout: ${TIMEOUT_HOURS} hours`);
    console.log(`\nCurrent Time: ${new Date().toISOString()}\n`);

    try {
        // PASO 1: Query positions for this scan_id
        console.log('PASO 1: Querying Firestore for Lote 3 positions...\n');

        const positionsSnap = await db.collection('spot_paper_positions')
            .where('scan_id', '==', TARGET_SCAN_ID)
            .get();

        if (positionsSnap.empty) {
            console.log('❌ No positions found for scan_id: ' + TARGET_SCAN_ID);
            return;
        }

        const positions = positionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        console.log(`✓ Found ${positions.length} positions\n`);

        // PASO 2: Analyze each position
        console.log('PASO 2: Detailed analysis of each position:\n');

        const now = new Date();
        const timeoutThresholdMs = TIMEOUT_HOURS * 60 * 60 * 1000;

        for (const pos of positions) {
            console.log('─'.repeat(80));
            console.log(`Symbol: ${pos.symbol} (ID: ${pos.id.substring(0, 50)}...)`);
            console.log('─'.repeat(80));

            // Status
            console.log(`Status: ${pos.status}`);

            // Created/Opened time
            const createdAt = pos.created_at ? new Date(pos.created_at) : null;
            const openedAt = pos.opened_at ? new Date(pos.opened_at) : createdAt;

            if (!openedAt) {
                console.log('⚠️  WARNING: No opened_at or created_at timestamp found');
                console.log('');
                continue;
            }

            console.log(`Created At: ${createdAt ? createdAt.toISOString() : 'N/A'}`);
            console.log(`Opened At: ${openedAt.toISOString()}`);

            // Age calculation
            const ageMs = now.getTime() - openedAt.getTime();
            const ageHours = ageMs / (60 * 60 * 1000);
            const ageDays = ageHours / 24;
            console.log(`Age: ${ageHours.toFixed(2)} hours (${ageDays.toFixed(3)} days)`);

            // Timeout calculation
            const timeoutAt = new Date(openedAt.getTime() + timeoutThresholdMs);
            const timeoutPassed = now.getTime() > timeoutAt.getTime();
            const timeoutIn = timeoutAt.getTime() - now.getTime();
            const timeoutInHours = timeoutIn / (60 * 60 * 1000);

            console.log(`Timeout At: ${timeoutAt.toISOString()}`);
            console.log(`Timeout Passed: ${timeoutPassed ? '✅ YES' : '⏳ NO'} (${timeoutInHours.toFixed(2)} hours ${timeoutInHours < 0 ? 'ago' : 'remaining'})`);

            // Entry price
            console.log(`Entry Price: ${pos.entry_price_simulated || 'N/A'}`);
            console.log(`Capital (USDT): ${pos.simulated_capital_usdt || 'N/A'}`);
            console.log(`Quantity: ${pos.simulated_quantity || 'N/A'}`);

            // Latest market price
            console.log(`Latest Market Price: ${pos.latest_market_price || 'N/A'}`);

            // Take profit levels
            if (pos.take_profit_levels && Array.isArray(pos.take_profit_levels)) {
                console.log(`Take Profit Levels:`);
                for (const tp of pos.take_profit_levels) {
                    const status = tp.status === 'hit' ? '✅ HIT' : '⏳ PENDING';
                    console.log(`  - ${tp.label}: ${tp.price} ${status}`);
                }
            } else {
                console.log('Take Profit Levels: N/A');
            }

            // Stop loss
            console.log(`Stop Loss Price: ${pos.stop_loss_price_simulated || 'N/A'}`);
            console.log(`Stop Loss Hit: ${pos.stop_loss_hit ? '✅ YES' : '⏳ NO'}`);

            // Favorable/Adverse moves
            console.log(`Max Favorable Move: ${pos.max_favorable_move_pct ? pos.max_favorable_move_pct.toFixed(2) + '%' : 'N/A'}`);
            console.log(`Max Adverse Move: ${pos.max_adverse_move_pct ? pos.max_adverse_move_pct.toFixed(2) + '%' : 'N/A'}`);

            // Updated at
            console.log(`Last Updated At: ${pos.updated_at ? new Date(pos.updated_at).toISOString() : 'N/A'}`);

            // CRITICAL: Why still open?
            console.log('\n⚠️  CRITICAL ANALYSIS:');
            if (pos.status === 'PAPER_OPEN') {
                if (timeoutPassed) {
                    console.log(`  1. ❌ TIMEOUT EXCEEDED: Position should have been closed ${Math.abs(timeoutInHours).toFixed(2)} hours ago`);
                    console.log(`     Expected timeout: ${TIMEOUT_HOURS} hours from ${openedAt.toISOString()}`);
                    console.log(`     Timeout should trigger at: ${timeoutAt.toISOString()}`);
                } else {
                    console.log(`  1. ⏳ Still within timeout window: ${timeoutInHours.toFixed(2)} hours remaining`);
                }

                // Check if TP/SL hit but not closed
                const tpHit = pos.take_profit_levels ?.some(tp => tp.status === 'hit');
                if (tpHit) {
                    console.log(`  2. ⚠️  Take profit hit but position still OPEN`);
                }
                if (pos.stop_loss_hit) {
                    console.log(`  2. ⚠️  Stop loss hit but position still OPEN`);
                }
            } else {
                console.log(`  Position is ${pos.status}`);
            }

            console.log('');
        }

        // PASO 3: Check for corresponding results
        console.log('\n' + '═'.repeat(80));
        console.log('PASO 3: Checking for closed results with same scan_id...\n');

        const resultsSnap = await db.collection('spot_paper_execution_results')
            .where('scan_id', '==', TARGET_SCAN_ID)
            .get();

        if (resultsSnap.empty) {
            console.log('❌ No results found (no positions closed yet)');
        } else {
            const results = resultsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
            console.log(`✓ Found ${results.length} closed results:\n`);
            for (const result of results) {
                console.log(`  Symbol: ${result.symbol}`);
                console.log(`  Close Reason: ${result.close_reason}`);
                console.log(`  PnL: ${result.estimated_net_pnl_usdt} USDT (${result.estimated_net_pnl_pct.toFixed(2)}%)`);
                console.log(`  Closed At: ${new Date(result.closed_at).toISOString()}\n`);
            }
        }

        // PASO 4: Code analysis
        console.log('═'.repeat(80));
        console.log('PASO 4: CODE ANALYSIS\n');

        console.log('TIMEOUT Configuration:');
        console.log('  Location: backend/lib/spotPaperRiskRules.js');
        console.log('  Value: const TIMEOUT_HOURS = 24');
        console.log('  ✓ TIMEOUT is configured\n');

        console.log('Timeout Logic in binanceSpotPaperExecutor.js:');
        console.log('  Function: evaluatePositionExit() [line ~230]');
        console.log('  Logic: if (!exitReason && timeoutAt && timeoutAt <= now && latestClose > 0)');
        console.log('         → exitReason = "TIMEOUT"');
        console.log('  ✓ Timeout evaluation exists\n');

        console.log('Execution Flow:');
        console.log('  1. runSpotPaperExecutionCycle() [line 652]');
        console.log('  2. → updateOpenPaperPositions() [line 482]');
        console.log('  3. → evaluatePositionExit() [line ~200]');
        console.log('  4. → if exit_reason exists: closePaperPosition() [line 419]');
        console.log('  5. → Updates spot_paper_positions → PAPER_CLOSED');
        console.log('  6. → Creates record in spot_paper_execution_results\n');

        console.log('Cron Entry Point:');
        console.log('  Route: POST /internal/cron/binance/spot-paper-execution [line 92 in velasCron.js]');
        console.log('  ✓ Endpoint exists and calls runSpotPaperExecutionCycle\n');

        // PASO 5: Conclusion
        console.log('═'.repeat(80));
        console.log('PASO 5: ROOT CAUSE ANALYSIS\n');

        const allOpen = positions.every(p => p.status === 'PAPER_OPEN');
        const allTimedOut = positions.every(p => {
            const openedAt = p.opened_at ? new Date(p.opened_at) : p.created_at ? new Date(p.created_at) : null;
            if (!openedAt) return false;
            const ageMs = now.getTime() - openedAt.getTime();
            return ageMs > timeoutThresholdMs;
        });

        if (allOpen && allTimedOut) {
            console.log('❌ CRITICAL BUG IDENTIFIED:\n');
            console.log('✗ All Lote 3 positions are PAPER_OPEN');
            console.log('✗ All positions have EXCEEDED 24-hour timeout');
            console.log('✗ No closed results exist for this scan_id');
            console.log('✗ The cron /internal/cron/binance/spot-paper-execution is NOT closing them\n');

            console.log('Likely Causes:');
            console.log('  1. Cron is not being triggered (no scheduled job)\n');
            console.log('  2. Cron is failing silently (exception caught but not logged)\n');
            console.log('  3. Position klines fetch is failing (latestClose = 0, blocks TIMEOUT close)\n');
            console.log('  4. DB write permission issue (Firestore rejection)\n');

            console.log('How to verify:');
            console.log('  - Check Cloud Run logs for /internal/cron/binance/spot-paper-execution');
            console.log('  - Check if errors exist in Firestore');
            console.log('  - Manually trigger: curl -X POST $URL/internal/cron/binance/spot-paper-execution \\');
            console.log('                     -H "x-cron-secret: $SECRET"');

        } else if (allOpen && !allTimedOut) {
            console.log('⏳ POSITIONS STILL WITHIN TIMEOUT WINDOW\n');
            console.log('All positions are PAPER_OPEN and have NOT yet exceeded 24 hours.');
            console.log('Timeout mechanism will trigger when the 24-hour window expires.');

            positions.forEach(p => {
                const openedAt = p.opened_at ? new Date(p.opened_at) : p.created_at ? new Date(p.created_at) : null;
                if (openedAt) {
                    const ageMs = now.getTime() - openedAt.getTime();
                    const ageHours = ageMs / (60 * 60 * 1000);
                    const timeoutIn = TIMEOUT_HOURS - ageHours;
                    console.log(`  ${p.symbol}: ${timeoutIn.toFixed(1)} hours until timeout`);
                }
            });
        } else {
            console.log('⚠️  MIXED STATE\n');
            const openCount = positions.filter(p => p.status === 'PAPER_OPEN').length;
            const closedCount = positions.filter(p => p.status === 'PAPER_CLOSED').length;
            console.log(`Open: ${openCount}, Closed: ${closedCount}`);
        }

        console.log('\n' + '═'.repeat(80) + '\n');

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        console.error(error.stack);
    } finally {
        await admin.app().delete();
    }
}

// Run
auditLote3().catch(err => {
    console.error('Unhandled error:', err);
    process.exit(1);
});
