const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function analyzeResultFlow() {
  console.log('\n🔄 ANALYZING RESULT FLOW FOR DIFFERENT INTENT SOURCES\n');

  try {
    // Get intents by source
    console.log('🔍 Fetching intents by source...\n');

    const sources = ['high_conviction', 'event_emitted', 'manual_prealert'];
    const sourceStats = {};

    for (const source of sources) {
      const snapshot = await db.collection('binance_execution_intents')
        .where('source', '==', source)
        .limit(100)
        .get();

      console.log(`\n📋 SOURCE: "${source}" (${snapshot.size} docs sampled)\n`);

      let withResult = 0;
      let withWinModel = 0;
      let statusBreakdown = {};
      let resultFields = new Set();

      for (const doc of snapshot.docs) {
        const data = doc.data();
        const status = data.status || 'unknown';
        statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;

        // Check for result fields
        if (data.result || data.win_model || data.execution_audit?.win_model) {
          withResult++;
        }
        if (data.execution_audit?.win_model && data.execution_audit.win_model !== 'PENDING') {
          withWinModel++;
        }

        // Find result-related fields
        if (data.trade_close || data.execution_audit?.win_exchange || data.result) {
          resultFields.add('has_result_field');
        }
        if (data.execution_audit?.executed_at) {
          resultFields.add('has_executed_at');
        }
        if (data.execution_audit?.win_model) {
          resultFields.add('has_win_model');
        }

        // Show sample docs for each source
        if (snapshot.docs.indexOf(doc) < 2) {
          console.log(`   Sample: ${doc.id}`);
          console.log(`   - status: ${data.status}`);
          console.log(`   - win_model: ${data.execution_audit?.win_model || 'N/A'}`);
          console.log(`   - executed_at: ${data.execution_audit?.executed_at ? '✅' : '❌'}`);
          console.log(`   - trade_close: ${data.trade_close ? '✅' : '❌'}`);
          console.log(`   - result: ${data.result ? '✅' : '❌'}`);
          console.log('');
        }
      }

      sourceStats[source] = {
        total: snapshot.size,
        withResult,
        withWinModel,
        statusBreakdown,
        resultFields: Array.from(resultFields)
      };

      console.log(`   ✅ With non-PENDING win_model: ${withWinModel}`);
      console.log(`   📊 Status breakdown:`, statusBreakdown);
      console.log(`   📐 Result fields found:`, Array.from(resultFields));
    }

    // Detailed analysis
    console.log('\n\n🔎 DETAILED RESULT FIELD ANALYSIS:\n');

    // Check where results are actually stored
    console.log('Checking a few EXECUTED intents to see where results go...\n');

    const executedSnapshot = await db.collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .limit(5)
      .get();

    for (const doc of executedSnapshot.docs) {
      const data = doc.data();
      console.log(`Intent: ${doc.id}`);
      console.log(`  status: ${data.status}`);
      console.log(`  source: ${data.source}`);
      console.log(`  execution_audit.win_model: ${data.execution_audit?.win_model}`);
      console.log(`  execution_audit.executed_at: ${data.execution_audit?.executed_at}`);
      console.log(`  trade_close fields: ${data.trade_close ? JSON.stringify(data.trade_close).substring(0, 100) : 'NONE'}`);
      console.log(`  execution_audit.win_exchange: ${data.execution_audit?.win_exchange || 'NONE'}`);
      console.log('');
    }

    // Check if there's a separate collection for trade results
    console.log('🔍 Checking for result-related collections...\n');
    const collections = await db.listCollections();
    const resultCollections = [];
    for (const col of collections) {
      const name = col.id;
      if (name.includes('result') || name.includes('trade') || name.includes('close') || name.includes('pnl') || name.includes('execution_result')) {
        resultCollections.push(name);
      }
    }

    if (resultCollections.length > 0) {
      console.log(`   ✅ Found potential result collections:\n   ${resultCollections.join('\n   ')}`);
    } else {
      console.log('   ❌ No obvious result collections found');
    }

    // Summary
    console.log('\n\n📊 SUMMARY:\n');
    for (const source in sourceStats) {
      const stats = sourceStats[source];
      console.log(`${source}:`);
      console.log(`  - Total: ${stats.total}`);
      console.log(`  - Intents with results: ${stats.withResult}/${stats.total}`);
      console.log(`  - Intents with non-PENDING win_model: ${stats.withWinModel}/${stats.total}`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await admin.app().delete();
  }
}

analyzeResultFlow();
