#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function auditExecution() {
  try {
    console.log('\n=== EXECUTION AUDIT ===\n');

    // 0. List all collections to find execution data
    console.log('📋 Available Collections:');
    const collections = await db.listCollections();
    const collectionNames = collections.map(c => c.id);
    console.log(collectionNames.join(', '));
    console.log('\n');

    // 1. Try multiple collection names for execution intents
    let intentsSnap;
    let collectionName = 'binance_execution_intents';

    try {
      intentsSnap = await db.collection(collectionName)
        .orderBy('timestamp', 'desc')
        .limit(10)
        .get();
    } catch (e) {
      console.log(`⚠️ Collection "${collectionName}" not found, trying alternatives...\n`);

      // Try alternative names
      const alternativeNames = ['execution_intents', 'trades', 'binance_trades', 'orders'];
      for (const name of alternativeNames) {
        try {
          const snap = await db.collection(name).limit(1).get();
          if (snap.size > 0) {
            collectionName = name;
            intentsSnap = await db.collection(collectionName)
              .orderBy('timestamp', 'desc')
              .limit(10)
              .get();
            console.log(`✓ Using collection: "${collectionName}"\n`);
            break;
          }
        } catch (err) {
          // Continue trying
        }
      }

      // If still nothing, default to empty
      if (!intentsSnap) {
        intentsSnap = { docs: [] };
      }
    }

    const intents = intentsSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`📊 Fetched ${intents.length} execution intents from "${collectionName}"\n`);

    // If no execution intents, check signals and execution events instead
    if (intents.length === 0) {
      console.log('⚠️ No execution intents found. Analyzing signal emission and execution events instead...\n');

      // Get high conviction signals
      const signalsSnap = await db.collection('high_conviction_signals')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      const signals = signalsSnap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      console.log(`📡 High Conviction Signals: ${signals.length}`);

      // Get execution events
      const eventsSnap = await db.collection('execution_events')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      const events = eventsSnap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      console.log(`⚡ Execution Events: ${events.length}`);

      // Get velas predictions for context
      const predictionsSnap = await db.collection('velas_predicciones')
        .orderBy('timestamp', 'desc')
        .limit(20)
        .get();

      const predictions = predictionsSnap.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      console.log(`🔮 Velas Predictions: ${predictions.length}\n`);

      // Analyze signals
      const symbolCounts = {};
      const directionCounts = {};
      let totalSignalConfidence = 0;
      let signalCount = 0;

      signals.forEach(sig => {
        symbolCounts[sig.symbol] = (symbolCounts[sig.symbol] || 0) + 1;
        directionCounts[sig.direction] = (directionCounts[sig.direction] || 0) + 1;
        if (sig.confidence) {
          totalSignalConfidence += sig.confidence;
          signalCount++;
        }
      });

      const avgSignalConfidence = signalCount > 0 ? (totalSignalConfidence / signalCount).toFixed(4) : 0;

      console.log('\n=== SIGNAL EMISSION ANALYSIS ===\n');
      console.log(`TOTAL_SIGNALS: ${signals.length}`);
      console.log(`AVG_CONFIDENCE: ${avgSignalConfidence}`);
      console.log(`\nBY_SYMBOL:`);
      Object.entries(symbolCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .forEach(([symbol, count]) => {
          console.log(`  ${symbol}: ${count}`);
        });

      console.log(`\nBY_DIRECTION:`);
      Object.entries(directionCounts).forEach(([dir, count]) => {
        console.log(`  ${dir}: ${count}`);
      });

      // Analyze execution events
      console.log(`\n=== EXECUTION EVENTS ANALYSIS ===\n`);

      const eventTypes = {};
      const executionStatus = {};
      let totalExecutionLatency = 0;
      let executionCount = 0;

      events.forEach(evt => {
        eventTypes[evt.event_type] = (eventTypes[evt.event_type] || 0) + 1;
        executionStatus[evt.status] = (executionStatus[evt.status] || 0) + 1;

        if (evt.entry_latency_ms) {
          totalExecutionLatency += evt.entry_latency_ms;
          executionCount++;
        }
      });

      const avgExecutionLatency = executionCount > 0 ? Math.round(totalExecutionLatency / executionCount) : 0;

      console.log(`TOTAL_EVENTS: ${events.length}`);
      console.log(`AVG_ENTRY_LATENCY: ${avgExecutionLatency}ms`);
      console.log(`\nEVENT_TYPES:`);
      Object.entries(eventTypes).forEach(([type, count]) => {
        console.log(`  ${type}: ${count}`);
      });

      console.log(`\nEXECUTION_STATUS:`);
      Object.entries(executionStatus).forEach(([status, count]) => {
        console.log(`  ${status}: ${count}`);
      });

      // Recent signal details
      console.log(`\n=== RECENT SIGNALS (Last 5) ===\n`);
      console.log('Symbol\t\tDir\tConfidence\tQuantum\t\tTiming\t\tTimestamp');
      console.log('─'.repeat(80));

      signals.slice(0, 5).forEach(sig => {
        const ts = new Date(sig.timestamp).toISOString().split('T')[1];
        const conf = (sig.confidence || 0).toFixed(4);
        const quantum = (sig.quantum_score || 0).toFixed(4);
        const timing = (sig.timing_score || 0).toFixed(4);
        console.log(`${(sig.symbol || 'N/A').padEnd(15)}\t${sig.direction}\t${conf}\t\t${quantum}\t${timing}\t${ts}`);
      });

      // Root cause for signal-only mode
      console.log(`\n📋 ROOT CAUSE ANALYSIS:\n`);
      console.log(`ROOT_CAUSE: System in SIGNAL-ONLY mode (no automatic execution)`);
      console.log(`SIGNALS_EMITTED: ${signals.length} over last session`);
      console.log(`SIGNAL_QUALITY: ${avgSignalConfidence} average confidence`);

      if (avgSignalConfidence < 0.65) {
        console.log(`⚠️ Signal confidence below MIN_CONFIDENCE threshold (0.65)`);
      } else if (avgSignalConfidence > 0.75) {
        console.log(`✓ Signal quality is GOOD`);
      }

      console.log(`\nNEXT_ACTION:\n`);
      console.log(`1. Verify Binance API credentials in cloud config`);
      console.log(`2. Check execution_discipline_logs for execution permission blocks`);
      console.log(`3. Enable bot execution with: gcloud firestore documents update system_runtime_config/bot_execution --update execution_enabled=true`);

      console.log('\n=== END AUDIT ===\n');
      process.exit(0);
    }

    // 4. Analyze trades
    let totalTrades = 0;
    let winTrades = 0;
    let lossTrades = 0;
    let totalPnl = 0;
    let totalLatency = 0;
    let latencyCount = 0;
    const exitReasons = {};
    const tradeDetails = [];

    // Build trade profile from intents
    for (const intent of intents) {
      if (!intent.executed || intent.status === 'cancelled') continue;

      totalTrades++;

      const entryPrice = intent.entry_price || 0;
      const exitPrice = intent.exit_price;
      const quantity = intent.quantity || 0;
      const direction = intent.direction || 'unknown';

      // Calculate PnL
      let pnl = 0;
      if (exitPrice && entryPrice && quantity > 0) {
        if (direction === 'up' || direction === 'long') {
          pnl = ((exitPrice - entryPrice) / entryPrice) * 100;
        } else if (direction === 'down' || direction === 'short') {
          pnl = ((entryPrice - exitPrice) / entryPrice) * 100;
        }

        if (pnl > 0) {
          winTrades++;
        } else if (pnl < 0) {
          lossTrades++;
        }

        totalPnl += pnl;
      }

      // Calculate entry latency
      if (intent.signal_time && intent.entry_time) {
        const latency = new Date(intent.entry_time) - new Date(intent.signal_time);
        totalLatency += latency;
        latencyCount++;
      }

      // Track exit reason
      const exitReason = intent.exit_reason || 'unknown';
      exitReasons[exitReason] = (exitReasons[exitReason] || 0) + 1;

      // Detailed trade info
      tradeDetails.push({
        symbol: intent.symbol,
        direction: intent.direction,
        entryPrice: Number(entryPrice.toFixed(4)),
        exitPrice: exitPrice ? Number(exitPrice.toFixed(4)) : null,
        quantity: Number(quantity.toFixed(4)),
        pnl: Number(pnl.toFixed(2)),
        status: intent.status,
        exitReason: exitReason,
        timestamp: intent.timestamp
      });
    }

    // 5. Calculate statistics
    const winRate = totalTrades > 0 ? ((winTrades / totalTrades) * 100).toFixed(2) : 0;
    const avgPnl = totalTrades > 0 ? (totalPnl / totalTrades).toFixed(2) : 0;
    const avgLatency = latencyCount > 0 ? Math.round(totalLatency / latencyCount) : 0;

    // 6. Report
    console.log(`TOTAL_TRADES: ${totalTrades}`);
    console.log(`WIN: ${winTrades}`);
    console.log(`LOSS: ${lossTrades}`);
    console.log(`WIN_RATE: ${winRate}%`);
    console.log(`AVG_PNL: ${avgPnl}%`);
    console.log(`ENTRY_LATENCY: ${avgLatency}ms`);

    console.log(`\nEXIT_REASON:`);
    Object.entries(exitReasons).forEach(([reason, count]) => {
      console.log(`  ${reason}: ${count}`);
    });

    // 7. Detect issues
    console.log(`\n🔍 ISSUE DETECTION:\n`);

    let issues = [];

    // Late entries (> 500ms)
    if (avgLatency > 500) {
      issues.push(`⚠️ LATE ENTRIES: Average latency ${avgLatency}ms (threshold: 500ms)`);
    }

    // Premature exits
    const prematureExits = Object.entries(exitReasons)
      .filter(([reason]) => reason.includes('premature') || reason.includes('stop') || reason.includes('error'))
      .reduce((sum, [, count]) => sum + count, 0);

    if (prematureExits > totalTrades * 0.2) {
      issues.push(`⚠️ PREMATURE EXITS: ${prematureExits} trades (${((prematureExits/totalTrades)*100).toFixed(0)}%)`);
    }

    // High slippage detection
    const highSlippageTrades = tradeDetails.filter(trade => {
      if (!trade.exitPrice || !trade.entryPrice) return false;
      const slippage = Math.abs(trade.exitPrice - trade.entryPrice) / trade.entryPrice * 100;
      return slippage > 0.5; // > 0.5% slippage
    });

    if (highSlippageTrades.length > 0) {
      issues.push(`⚠️ HIGH SLIPPAGE: ${highSlippageTrades.length} trades with >0.5% slippage`);
    }

    // Failed executions
    const failedTrades = tradeDetails.filter(t => t.status === 'failed' || t.status === 'cancelled');
    if (failedTrades.length > 0) {
      issues.push(`⚠️ EXECUTION FAILURES: ${failedTrades.length} failed/cancelled trades`);
    }

    // Negative PnL trend
    if (avgPnl < -0.5) {
      issues.push(`⚠️ NEGATIVE PNL: Average ${avgPnl}% (losing money)`);
    }

    if (issues.length === 0) {
      console.log('✅ No critical issues detected\n');
    } else {
      issues.forEach(issue => console.log(issue + '\n'));
    }

    // 8. Root cause analysis
    console.log(`\n📋 ROOT CAUSE ANALYSIS:\n`);

    let rootCause = 'NONE';
    let priority = 'NONE';

    if (avgLatency > 1000) {
      rootCause = 'Network latency or scheduler delay preventing timely market entry';
      priority = 'CRITICAL';
    } else if (avgPnl < -1) {
      rootCause = 'Signal quality too low or entry/exit thresholds misaligned';
      priority = 'HIGH';
    } else if (prematureExits > totalTrades * 0.3) {
      rootCause = 'Exit logic triggering too early (stop-loss or timeout too aggressive)';
      priority = 'HIGH';
    } else if (winRate < 40 && totalTrades >= 5) {
      rootCause = 'Win rate below statistical significance; may indicate model drift';
      priority = 'MEDIUM';
    } else {
      rootCause = 'System performing within normal parameters';
      priority = 'LOW';
    }

    console.log(`ROOT_CAUSE: ${rootCause}`);
    console.log(`PRIORITY: ${priority}`);

    // 9. Next action
    console.log(`\nNEXT_ACTION:\n`);

    if (priority === 'CRITICAL') {
      console.log('Reduce market entry timeout from 5s to 2s and monitor latency distribution');
    } else if (priority === 'HIGH' && avgPnl < -1) {
      console.log('Adjust quality gate thresholds: MIN_CONFIDENCE 0.65→0.70, MIN_QUANTUM 0.60→0.65');
    } else if (priority === 'HIGH') {
      console.log('Review exit_reason distribution and adjust stop-loss/take-profit ratios');
    } else if (priority === 'MEDIUM') {
      console.log('Analyze signal-to-noise ratio; consider retraining model with recent data');
    } else {
      console.log('Continue monitoring; system is performing nominally');
    }

    // 10. Detailed trade table
    console.log(`\n📈 LAST 5 TRADES DETAIL:\n`);
    console.log('Symbol\t\tDir\tEntry\t\tExit\t\tPnL\tStatus\t\tReason');
    console.log('─'.repeat(90));

    tradeDetails.slice(0, 5).forEach(trade => {
      const exitStr = trade.exitPrice ? trade.exitPrice.toFixed(2) : 'OPEN';
      const pnlStr = trade.pnl > 0 ? `+${trade.pnl}%` : `${trade.pnl}%`;
      console.log(`${trade.symbol.padEnd(15)}\t${trade.direction}\t${trade.entryPrice}\t${exitStr}\t\t${pnlStr}\t${trade.status}\t\t${trade.exitReason}`);
    });

    console.log('\n=== END AUDIT ===\n');

    process.exit(0);
  } catch (error) {
    console.error('❌ Audit Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

auditExecution();
