#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function validateTrades() {
  try {
    console.log('\n=== TRADE VALIDATION ===\n');

    // 1. Look for closed trades in multiple collections
    const trades = [];

    // Check binance_execution_intents for completed trades
    const intentsSnap = await db.collection('binance_execution_intents')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    intentsSnap.docs.forEach(doc => {
      const data = doc.data();
      if (data.exit_price && data.entry_price && (data.status === 'closed' || data.closed_at)) {
        trades.push({
          id: doc.id,
          source: 'binance_execution_intents',
          ...data
        });
      }
    });

    trades.splice(5); // Keep only first 5

    console.log(`📌 Found ${trades.length} closed intents\n`);

    // If no closed intents, check position manager logs
    if (trades.length === 0) {
      console.log('⚠️ No closed execution intents. Checking position manager logs...\n');

      const pmLogsSnap = await db.collection('binance_position_manager_logs')
        .orderBy('timestamp', 'desc')
        .limit(50)
        .get();

      const closedPositions = [];
      pmLogsSnap.docs.forEach(doc => {
        const data = doc.data();
        if (data.action === 'close_position' && data.exit_price && data.entry_price) {
          closedPositions.push({
            id: doc.id,
            source: 'binance_position_manager_logs',
            symbol: data.symbol,
            entry_price: data.entry_price,
            exit_price: data.exit_price,
            quantity: data.quantity,
            direction: data.direction,
            pnl_percent: data.pnl_percent,
            timestamp: data.timestamp,
            exit_reason: data.exit_reason
          });
        }
      });

      console.log(`📋 Found ${closedPositions.length} position closes\n`);

      if (closedPositions.length > 0) {
        trades.push(...closedPositions.slice(0, 5));
      }
    }

    // If still nothing, check execution_events for filled orders
    if (trades.length === 0) {
      console.log('⚠️ No position manager logs. Checking execution events...\n');

      const eventsSnap = await db.collection('execution_events')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      eventsSnap.docs.forEach(doc => {
        const data = doc.data();
        if (data.event_type === 'position_closed' && data.exit_price && data.entry_price) {
          trades.push({
            id: doc.id,
            source: 'execution_events',
            ...data
          });
        }
      });

      trades.splice(5); // Keep only first 5

      console.log(`⚡ Found ${trades.length} closed position events\n`);
    }

    // If still nothing, show available data
    if (trades.length === 0) {
      console.log('❌ NO CLOSED TRADES FOUND\n');
      console.log('Checking what data is available:\n');

      // Check binance_open_positions
      const openSnap = await db.collection('binance_open_positions').limit(5).get();
      console.log(`Open Positions: ${openSnap.size}`);

      // Check velas_audit_snapshots
      const auditSnap = await db.collection('velas_audit_snapshots')
        .orderBy('timestamp', 'desc')
        .limit(5)
        .get();
      console.log(`Audit Snapshots: ${auditSnap.size}`);

      // Check execution_latency_logs
      const latencySnap = await db.collection('execution_latency_logs')
        .orderBy('timestamp', 'desc')
        .limit(5)
        .get();
      console.log(`Execution Latency Logs: ${latencySnap.size}`);

      console.log('\n📌 Reason: No automatic execution has occurred yet.');
      console.log('System is waiting for bot_execution config to be enabled.\n');

      console.log('Next: Execute this command to enable trading:');
      console.log('gcloud firestore documents create system_runtime_config/bot_execution \\');
      console.log('  --data "execution_enabled=true,auto_trade_mode=true"\n');

      console.log('=== END VALIDATION ===\n');
      process.exit(0);
    }

    // Analyze trades
    console.log(`\n=== ANALYZING ${trades.length} TRADES ===\n`);

    let totalWins = 0;
    let totalLosses = 0;
    let totalPnl = 0;
    let totalLatency = 0;
    let latencyCount = 0;
    const exitReasons = {};
    const entryQualities = {};

    const tradeDetails = trades.map((trade, idx) => {
      const entryPrice = trade.entry_price || 0;
      const exitPrice = trade.exit_price || 0;
      const quantity = trade.quantity || 0;
      const direction = trade.direction || 'unknown';

      // Calculate PnL
      let pnl = 0;
      if (exitPrice && entryPrice && quantity > 0) {
        if (direction === 'up' || direction === 'long') {
          pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
        } else if (direction === 'down' || direction === 'short') {
          pnl = ((entryPrice - exitPrice) / entryPrice) * 100;
        }

        if (pnl > 0) {
          totalWins++;
        } else if (pnl < 0) {
          totalLosses++;
        }

        totalPnl += pnl;
      }

      // Calculate latency
      if (trade.signal_time && trade.entry_time) {
        const latency = new Date(trade.entry_time) - new Date(trade.signal_time);
        totalLatency += latency;
        latencyCount++;
      }

      // Entry quality
      const entryQuality = trade.entry_latency_ms
        ? (trade.entry_latency_ms < 100 ? 'on-time' : (trade.entry_latency_ms < 500 ? 'late' : 'very_late'))
        : 'unknown';

      entryQualities[entryQuality] = (entryQualities[entryQuality] || 0) + 1;

      // Exit reason
      const exitReason = trade.exit_reason || 'unknown';
      exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;

      return {
        index: idx + 1,
        symbol: trade.symbol,
        direction: direction,
        entryPrice: Number(entryPrice.toFixed(4)),
        exitPrice: Number(exitPrice.toFixed(4)),
        quantity: Number(quantity.toFixed(4)),
        pnl: Number(pnl.toFixed(2)),
        result: pnl > 0 ? 'WIN' : (pnl < 0 ? 'LOSS' : 'BREAK_EVEN'),
        entryQuality: entryQuality,
        exitReason: exitReason,
        timestamp: trade.timestamp || new Date().toISOString()
      };
    });

    // Report each trade
    tradeDetails.forEach(trade => {
      console.log(`\n[${trade.index}] ${trade.symbol} - ${trade.direction.toUpperCase()}`);
      console.log(`    ENTRY_PRICE: ${trade.entryPrice}`);
      console.log(`    EXIT_PRICE: ${trade.exitPrice}`);
      console.log(`    PNL: ${trade.pnl}%`);
      console.log(`    RESULT: ${trade.result}`);
      console.log(`    ENTRY_QUALITY: ${trade.entryQuality}`);
      console.log(`    EXIT_REASON: ${trade.exitReason}`);
    });

    // Summary
    const winRate = trades.length > 0 ? ((totalWins / trades.length) * 100).toFixed(1) : 0;
    const avgPnl = trades.length > 0 ? (totalPnl / trades.length).toFixed(2) : 0;

    console.log(`\n=== RESUMEN ===\n`);
    console.log(`WIN_RATE: ${winRate}%`);
    console.log(`AVG_PNL: ${avgPnl}%`);
    console.log(`TOTAL_WINS: ${totalWins}/${trades.length}`);
    console.log(`TOTAL_LOSSES: ${totalLosses}/${trades.length}`);

    // Exit reasons distribution
    console.log(`\nEXIT_REASON:`);
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });

    // Entry quality distribution
    console.log(`\nENTRY_QUALITY:`);
    Object.entries(entryQualities).forEach(([quality, count]) => {
      console.log(`  ${quality}: ${count}`);
    });

    // Identify main issue
    console.log(`\n=== DIAGNOSIS ===\n`);

    let mainIssue = 'NONE';
    let priority = 'LOW';

    if (totalWins === 0 && trades.length >= 3) {
      mainIssue = 'Zero wins in sample - model may have low predictive power';
      priority = 'CRITICAL';
    } else if (winRate < 50 && trades.length >= 5) {
      mainIssue = 'Win rate below 50% - entry/exit timing needs adjustment';
      priority = 'HIGH';
    } else if (avgPnl < -1) {
      mainIssue = 'Negative average PnL - stop loss or exit logic too aggressive';
      priority = 'HIGH';
    } else if (trades.length > 0 && Object.values(entryQualities).some(q => q > 2)) {
      mainIssue = 'Some late entries detected - reduce latency or widen entry window';
      priority = 'MEDIUM';
    } else if (trades.length > 0) {
      mainIssue = 'Sample size too small - need more trades to validate (minimum 20)';
      priority = 'MEDIUM';
    } else {
      mainIssue = 'No trades executed yet - execution layer may not be active';
      priority = 'CRITICAL';
    }

    console.log(`MAIN_ISSUE: ${mainIssue}`);
    console.log(`PRIORITY: ${priority}`);

    // Next action
    console.log(`\nNEXT_ACTION:\n`);

    if (mainIssue === 'No trades executed yet - execution layer may not be active') {
      console.log('Enable automatic execution:');
      console.log('gcloud firestore documents create system_runtime_config/bot_execution \\');
      console.log('  --data "execution_enabled=true,auto_trade_mode=true"\n');
    } else if (mainIssue === 'Zero wins in sample - model may have low predictive power') {
      console.log('Review signal quality and model calibration. Check:');
      console.log('1. Signal confidence distribution');
      console.log('2. Entry/exit price spread (slippage)');
      console.log('3. Market conditions (trending vs ranging)\n');
    } else if (winRate < 50) {
      console.log('Adjust entry/exit thresholds:');
      console.log('1. Increase MIN_CONFIDENCE from 0.65 to 0.72');
      console.log('2. Increase MIN_QUANTUM from 0.60 to 0.68');
      console.log('3. Review stop-loss and take-profit ratios\n');
    } else {
      console.log('Continue monitoring. Collect minimum 20 trades for statistical validation.\n');
    }

    console.log('=== END VALIDATION ===\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Validation Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

validateTrades();
