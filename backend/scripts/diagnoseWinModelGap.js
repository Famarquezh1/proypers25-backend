const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function diagnoseWinModelGap() {
  console.log('\n📊 DIAGNOSING WIN_MODEL SYNCHRONIZATION GAP\n');

  try {
    // 1. Get all signals with WIN/LOSS outcomes
    console.log('🔍 Fetching high_conviction_signals with verification_outcome...');
    const signalsSnapshot = await db.collection('high_conviction_signals')
      .where('verification_outcome', 'in', ['WIN', 'LOSS', 'EXPIRED'])
      .limit(100)
      .get();

    const signalsByOutcome = {
      WIN: [],
      LOSS: [],
      EXPIRED: [],
      UNKNOWN: []
    };

    signalsSnapshot.docs.forEach(doc => {
      const data = doc.data();
      const outcome = data.verification_outcome || 'UNKNOWN';
      signalsByOutcome[outcome]?.push({
        id: doc.id,
        prediction_id: data.prediction_id,
        symbol: data.symbol,
        outcome,
        created_at: data.created_at?.toDate?.() || data.created_at
      });
    });

    console.log('\n✅ Signals fetched:');
    console.log(`   WIN: ${signalsByOutcome.WIN.length}`);
    console.log(`   LOSS: ${signalsByOutcome.LOSS.length}`);
    console.log(`   EXPIRED: ${signalsByOutcome.EXPIRED.length}`);

    // 2. For each signal, check if corresponding intent has win_model updated
    console.log('\n🔗 Checking intents for corresponding prediction_ids...\n');

    let intentsWithPendingModel = 0;
    let intentsWithUpdatedModel = 0;
    let intentsNotFound = 0;

    for (const outcome in signalsByOutcome) {
      if (outcome === 'UNKNOWN') continue;

      for (const signal of signalsByOutcome[outcome]) {
        const intentDoc = await db.collection('binance_execution_intents')
          .doc(`${signal.prediction_id}__high_conviction`)
          .get();

        if (!intentDoc.exists) {
          intentsNotFound++;
          console.log(`❌ Intent NOT FOUND for signal ${signal.prediction_id}`);
          continue;
        }

        const intentData = intentDoc.data();
        const winModel = intentData.execution_audit?.win_model || 'UNKNOWN';

        if (winModel === 'PENDING') {
          intentsWithPendingModel++;
          console.log(`⚠️  Intent HAS PENDING win_model (signal=${outcome}) - ${signal.prediction_id}`);
        } else if (winModel === outcome || (outcome === 'EXPIRED' && winModel === 'EXPIRED')) {
          intentsWithUpdatedModel++;
          // console.log(`✅ Intent SYNCED (signal=${outcome}, model=${winModel}) - ${signal.prediction_id}`);
        } else {
          console.log(`🔴 MISMATCH: Signal=${outcome}, but win_model=${winModel} - ${signal.prediction_id}`);
        }
      }
    }

    console.log('\n📋 SYNCHRONIZATION SUMMARY:');
    console.log(`   Total signals analyzed: ${signalsByOutcome.WIN.length + signalsByOutcome.LOSS.length + signalsByOutcome.EXPIRED.length}`);
    console.log(`   Intents NOT FOUND: ${intentsNotFound}`);
    console.log(`   Intents with PENDING win_model: ${intentsWithPendingModel} ⚠️ (SHOULD BE SYNCED)`);
    console.log(`   Intents with UPDATED win_model: ${intentsWithUpdatedModel} ✅`);

    // 3. Find all intents with PENDING win_model regardless of signals
    console.log('\n🔎 Scanning ALL intents with PENDING win_model...');
    const pendingIntentsSnapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .limit(50)
      .get();

    console.log(`   Total intents with PENDING win_model: ${pendingIntentsSnapshot.size}`);

    if (pendingIntentsSnapshot.size > 0) {
      console.log('\n   Sample PENDING intents:');
      let count = 0;
      pendingIntentsSnapshot.docs.forEach(doc => {
        if (count < 5) {
          const data = doc.data();
          console.log(`   - ${doc.id} (prediction_id: ${data.prediction_id}, status: ${data.status})`);
          count++;
        }
      });
    }

    // 4. Field structure analysis
    console.log('\n📐 FIELD STRUCTURE ANALYSIS:');
    const sampleSignal = signalsByOutcome.WIN[0];
    if (sampleSignal) {
      const sigDoc = await db.collection('high_conviction_signals').doc(sampleSignal.id).get();
      const sigData = sigDoc.data();
      console.log('\n   High_conviction_signals fields:');
      console.log(`   - verification_outcome: ${sigData.verification_outcome}`);
      console.log(`   - status: ${sigData.status}`);
      console.log(`   - binance_execution.executed: ${sigData.binance_execution?.executed}`);
      console.log(`   - linked_position_id: ${sigData.linked_position_id ? '✅ EXISTS' : '❌ MISSING'}`);
    }

    const sampleIntent = await db.collection('binance_execution_intents')
      .doc(`${signalsByOutcome.WIN[0]?.prediction_id}__high_conviction`)
      .get();
    if (sampleIntent.exists) {
      const intentData = sampleIntent.data();
      console.log('\n   Binance_execution_intents fields:');
      console.log(`   - status: ${intentData.status}`);
      console.log(`   - execution_audit.win_model: ${intentData.execution_audit?.win_model}`);
      console.log(`   - execution_audit.signal_at: ${intentData.execution_audit?.signal_at}`);
      console.log(`   - execution_audit.executed_at: ${intentData.execution_audit?.executed_at}`);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.error(error);
  } finally {
    await admin.app().delete();
  }
}

diagnoseWinModelGap();
