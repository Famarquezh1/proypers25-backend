const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function syncWinExchangeToWinModel() {
  console.log('\n🔄 SYNCHRONIZING win_exchange → win_model FOR ALL SOURCES\n');

  try {
    // Get all intents with PENDING win_model that have win_exchange
    console.log('🔍 Fetching intents with PENDING win_model...');
    const pendingSnapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .get();

    console.log(`✅ Found ${pendingSnapshot.size} intents with PENDING win_model\n`);

    let synced = 0;
    let alreadySet = 0;
    let noWinExchange = 0;
    let errors = 0;

    const batch = db.batch();
    let batchCount = 0;
    const maxBatchOps = 500;

    for (const intentDoc of pendingSnapshot.docs) {
      const intentData = intentDoc.data();
      const winExchange = intentData.execution_audit?.win_exchange;
      const source = intentData.source || 'unknown';

      if (!winExchange || winExchange === 'PENDING') {
        noWinExchange++;
        if (noWinExchange <= 10) {
          console.log(`⚠️  No win_exchange for ${source} intent ${intentDoc.id.substring(0, 20)}`);
        }
        continue;
      }

      if (winExchange === 'PENDING' || !winExchange) {
        alreadySet++;
        continue;
      }

      try {
        // Update win_model from win_exchange
        const winModelValue =
          winExchange === 'WIN' ? 'WIN' :
          winExchange === 'LOSS' ? 'LOSS' :
          winExchange === 'EXPIRED' ? 'EXPIRED' :
          winExchange === 'LUCKY_WIN' ? 'LUCKY_WIN' :
          'UNKNOWN';

        console.log(`✅ SYNCING ${source} intent: win_model = ${winModelValue} (from win_exchange)`);

        batch.update(intentDoc.ref, {
          'execution_audit.win_model': winModelValue,
          'execution_audit.synced_at': new Date(),
          'execution_audit.synced_from': 'win_exchange'
        });

        batchCount++;
        synced++;

        // Commit batch if it reaches limit
        if (batchCount >= maxBatchOps) {
          console.log(`\n📤 Committing batch of ${batchCount} updates...`);
          await batch.commit();
          batchCount = 0;
        }

      } catch (error) {
        console.error(`🔴 Error processing intent ${intentDoc.id}:`, error.message);
        errors++;
      }
    }

    // Commit remaining batch
    if (batchCount > 0) {
      console.log(`\n📤 Committing final batch of ${batchCount} updates...`);
      await batch.commit();
    }

    console.log('\n\n📊 SYNCHRONIZATION COMPLETE:');
    console.log(`   ✅ Synced from win_exchange: ${synced}`);
    console.log(`   ⚠️  No win_exchange to sync: ${noWinExchange}`);
    console.log(`   🔴 Errors: ${errors}`);

    // Verify sync
    console.log('\n\n🔍 VERIFYING FINAL STATE...');
    const verifySnapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .get();

    console.log(`   Remaining PENDING win_models: ${verifySnapshot.size}`);

    if (verifySnapshot.size === 0) {
      console.log('   ✅ ALL INTENTS NOW HAVE win_model VALUES!');
    } else {
      console.log(`   ⚠️  Still ${verifySnapshot.size} intents with PENDING win_model`);
    }

    // Get breakdown by source
    console.log('\n📊 FINAL STATE BY SOURCE:\n');
    const sources = ['high_conviction', 'event_emitted', 'manual_prealert'];

    for (const source of sources) {
      const sourceSnap = await db.collection('binance_execution_intents')
        .where('source', '==', source)
        .get();

      const nonPending = sourceSnap.docs.filter(d =>
        d.data().execution_audit?.win_model &&
        d.data().execution_audit.win_model !== 'PENDING'
      );

      const pending = sourceSnap.docs.filter(d =>
        !d.data().execution_audit?.win_model ||
        d.data().execution_audit.win_model === 'PENDING'
      );

      console.log(`${source}:`);
      console.log(`  - Total: ${sourceSnap.size}`);
      console.log(`  - With win_model: ${nonPending.length} (${Math.round(nonPending.length / sourceSnap.size * 100)}%)`);
      console.log(`  - PENDING: ${pending.length} (${Math.round(pending.length / sourceSnap.size * 100)}%)`);
    }

  } catch (error) {
    console.error('❌ Fatal Error:', error.message);
    console.error(error);
  } finally {
    await admin.app().delete();
  }
}

syncWinExchangeToWinModel();
