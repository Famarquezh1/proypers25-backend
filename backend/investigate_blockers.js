#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function investigateExecutionBlocks() {
  try {
    console.log('\n=== EXECUTION BLOCKER INVESTIGATION ===\n');

    // 1. Check execution discipline logs
    const disciplineSnap = await db.collection('execution_discipline_logs')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    const disciplineLogs = disciplineSnap.docs.map(doc => ({
      id: doc.id,
      ...doc.data()
    }));

    console.log(`📋 Execution Discipline Logs: ${disciplineLogs.length}\n`);

    if (disciplineLogs.length > 0) {
      const blockedCount = disciplineLogs.filter(log => log.blocked === true).length;
      const executedCount = disciplineLogs.filter(log => log.executed === true).length;
      const blockReasons = {};

      disciplineLogs.forEach(log => {
        if (log.block_reason) {
          blockReasons[log.block_reason] = (blockReasons[log.block_reason] || 0) + 1;
        }
      });

      console.log(`Blocked Executions: ${blockedCount}`);
      console.log(`Executed: ${executedCount}`);
      console.log(`\nBlock Reasons:`);
      Object.entries(blockReasons).forEach(([reason, count]) => {
        console.log(`  ${reason}: ${count}`);
      });
    }

    // 2. Check system runtime config
    console.log(`\n📌 System Runtime Config:\n`);
    const configDoc = await db.collection('system_runtime_config').doc('bot_execution').get();

    if (configDoc.exists) {
      const config = configDoc.data();
      console.log('bot_execution settings:');
      Object.entries(config).forEach(([key, value]) => {
        console.log(`  ${key}: ${value}`);
      });
    } else {
      console.log('⚠️ bot_execution config not found');
    }

    // 3. Check Binance bot config
    console.log(`\n🔐 Binance Bot Config:\n`);
    const binanceConfigSnap = await db.collection('binance_bot_config').limit(5).get();

    if (binanceConfigSnap.size > 0) {
      binanceConfigSnap.docs.forEach(doc => {
        const data = doc.data();
        console.log(`${doc.id}:`);
        // Don't log API keys, just status
        if (data.enabled !== undefined) {
          console.log(`  enabled: ${data.enabled}`);
        }
        if (data.api_key_configured) {
          console.log(`  api_key_configured: ${data.api_key_configured}`);
        }
        if (data.status) {
          console.log(`  status: ${data.status}`);
        }
      });
    } else {
      console.log('⚠️ No Binance bot config found');
    }

    // 4. Check execution latency logs
    console.log(`\n⏱️ Execution Latency Logs (last 10):\n`);
    const latencySnap = await db.collection('execution_latency_logs')
      .orderBy('timestamp', 'desc')
      .limit(10)
      .get();

    if (latencySnap.size > 0) {
      let totalLatency = 0;
      const latencies = latencySnap.docs.map(doc => {
        const data = doc.data();
        totalLatency += data.latency_ms || 0;
        return data;
      });

      const avgLatency = Math.round(totalLatency / latencies.length);
      console.log(`Average Latency: ${avgLatency}ms`);
      console.log(`Sample latencies: ${latencies.slice(0, 3).map(l => l.latency_ms + 'ms').join(', ')}`);
    } else {
      console.log('No execution latency logs');
    }

    // 5. Check execution events from logs
    console.log(`\n⚡ Execution Events Analysis:\n`);
    const eventsSnap = await db.collection('execution_events')
      .orderBy('timestamp', 'desc')
      .limit(20)
      .get();

    if (eventsSnap.size > 0) {
      const events = eventsSnap.docs.map(doc => doc.data());
      const statusCount = {};

      events.forEach(evt => {
        statusCount[evt.status] = (statusCount[evt.status] || 0) + 1;
      });

      console.log(`Total Events: ${events.length}`);
      console.log(`Status Distribution:`);
      Object.entries(statusCount).forEach(([status, count]) => {
        console.log(`  ${status}: ${count}`);
      });

      // Show recent event
      console.log(`\nMost Recent Event:`);
      const recent = events[0];
      console.log(`  Symbol: ${recent.symbol}`);
      console.log(`  Type: ${recent.event_type}`);
      console.log(`  Status: ${recent.status}`);
      console.log(`  Timestamp: ${recent.timestamp}`);
    } else {
      console.log('❌ NO EXECUTION EVENTS - Bot is NOT connecting to Binance');
    }

    // 6. Summary and diagnosis
    console.log(`\n=== DIAGNOSIS ===\n`);

    if (eventsSnap.size === 0 && disciplineLogs.length > 0 && disciplineLogs[0].blocked) {
      console.log(`🔴 PROBLEM: Execution is BLOCKED by discipline engine`);
      console.log(`REASON: ${disciplineLogs[0].block_reason}`);
      console.log(`SOLUTION: Review block_reason and enable if safe, or adjust discipline thresholds`);
    } else if (eventsSnap.size === 0) {
      console.log(`🔴 PROBLEM: Bot is NOT executing - possible causes:`);
      console.log(`  1. Binance API credentials not configured`);
      console.log(`  2. execution_enabled = false in system_runtime_config`);
      console.log(`  3. Network connectivity issue`);
      console.log(`  4. Manual trading mode (signals only)`);
    } else {
      console.log(`✅ Bot IS executing trades`);
    }

    process.exit(0);
  } catch (error) {
    console.error('❌ Investigation Error:', error.message);
    console.error(error.stack);
    process.exit(1);
  }
}

investigateExecutionBlocks();
