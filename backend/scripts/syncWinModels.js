const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function syncWinModelsWithSignalOutcomes() {
  console.log('\n🔄 SYNCHRONIZING win_model FROM signal verification_outcome\n');

  try {
    // Get all intents with PENDING win_model
    console.log('🔍 Fetching intents with PENDING win_model...');
    const pendingIntentsSnapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .get();

    console.log(`✅ Found ${pendingIntentsSnapshot.size} intents with PENDING win_model\n`);

    let synced = 0;
    let notFound = 0;
    let errors = 0;
    let alreadySynced = 0;

    const batch = db.batch();
    let batchCount = 0;
    const maxBatchOps = 500; // Firestore batch limit

    for (const intentDoc of pendingIntentsSnapshot.docs) {
      const intentData = intentDoc.data();
      const prediction_id = intentData.prediction_id;

      if (!prediction_id) {
        console.log(`⚠️  Skipping intent ${intentDoc.id} - no prediction_id`);
        continue;
      }

      try {
        // Get corresponding signal
        const signalDoc = await db.collection('high_conviction_signals')
          .doc(prediction_id)
          .get();

        if (!signalDoc.exists) {
          console.log(`❌ Signal NOT FOUND for intent ${intentDoc.id} (prediction_id: ${prediction_id})`);
          notFound++;
          continue;
        }

        const signalData = signalDoc.data();
        const verification_outcome = signalData.verification_outcome;

        if (!verification_outcome || verification_outcome === 'PENDING') {
          console.log(`⚠️  Signal has no outcome yet for ${prediction_id}`);
          continue;
        }

        // Update intent with win_model from signal
        console.log(`✅ SYNCING: ${prediction_id} → win_model = ${verification_outcome}`);

        batch.update(intentDoc.ref, {
          'execution_audit.win_model': verification_outcome,
          'execution_audit.synced_at': new Date(),
          'execution_audit.synced_from': 'signal_verification_outcome'
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
    console.log(`   ✅ Synced: ${synced}`);
    console.log(`   ❌ Not found: ${notFound}`);
    console.log(`   🔴 Errors: ${errors}`);
    console.log(`   ⏳ Already synced: ${alreadySynced}`);

    // Verify sync
    console.log('\n\n🔍 VERIFYING SYNC...');
    const verifySnapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .get();

    console.log(`   Remaining PENDING win_models: ${verifySnapshot.size}`);

    if (verifySnapshot.size === 0) {
      console.log('   ✅ ALL INTENTS SYNCED SUCCESSFULLY!');
    } else {
      console.log('   ⚠️  Some intents still have PENDING win_model');
      let remaining = 0;
      verifySnapshot.docs.forEach(doc => {
        if (remaining < 5) {
          console.log(`     - ${doc.id}`);
          remaining++;
        }
      });
      if (verifySnapshot.size > 5) {
        console.log(`     ... and ${verifySnapshot.size - 5} more`);
      }
    }

  } catch (error) {
    console.error('❌ Fatal Error:', error.message);
    console.error(error);
  } finally {
    await admin.app().delete();
  }
}

syncWinModelsWithSignalOutcomes();
