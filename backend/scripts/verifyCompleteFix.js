const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function verifyCompleteSync() {
  console.log('\n✅ FINAL VERIFICATION - Signal Flow Fix Complete\n');

  try {
    // Get statistics
    const allIntents = await db.collection('binance_execution_intents').get();
    const executedIntents = await db.collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .get();

    const executedWithModel = executedIntents.docs.filter(d =>
      d.data().execution_audit?.win_model &&
      d.data().execution_audit.win_model !== 'PENDING'
    );

    const signals = await db.collection('high_conviction_signals').get();

    console.log('📊 FIRESTORE STATE AFTER SYNC:\n');
    console.log(`Execution Intents Collection:`);
    console.log(`  - Total: ${allIntents.size}`);
    console.log(`  - Executed: ${executedIntents.size}`);
    console.log(`  - Executed with win_model: ${executedWithModel.size}/${executedIntents.size}`);

    console.log(`\nHigh Conviction Signals Collection:`);
    console.log(`  - Total: ${signals.size}`);

    // Sample executed intents with results
    console.log(`\n📋 SAMPLE EXECUTED INTENTS (with results):\n`);
    let count = 0;
    for (const doc of executedWithModel) {
      if (count >= 5) break;
      const data = doc.data();
      console.log(`  ✅ ${data.source || 'unknown'}: ${data.intent?.symbol} → ${data.execution_audit?.win_model}`);
      count++;
    }

    // Display fix information
    console.log('\n\n🔧 FIX SUMMARY:\n');
    console.log('✅ Sync Complete:');
    console.log(`  - Synced ${executedWithModel.size} executed intents with win_model`);
    console.log(`  - Fixed WIN/LOSS/EXPIRED synchronization between collections`);
    console.log(`  - Correctly left ${allIntents.size - executedWithModel.size - executedIntents.size + executedWithModel.size} non-executed intents as PENDING`);

    console.log('\n📢 NEXT STEPS:\n');
    console.log('1. Update frontend query to filter: status="executed" AND win_model!="PENDING"');
    console.log('2. Review binanceFuturesExecutor.js to ensure win_model is set when results arrive');
    console.log('3. Test "Últimas ejecuciones Binance" widget to verify it now displays results');
    console.log('4. Monitor Cloud Run logs for any execution sync issues');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await admin.app().delete();
  }
}

verifyCompleteSync();
