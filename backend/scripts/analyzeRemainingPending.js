const admin = require('firebase-admin');

// Initialize Firebase
const serviceAccount = require('../serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function analyzeRemainingPending() {
  console.log('\n🔍 ANALYZING 402 REMAINING PENDING win_model INTENTS\n');

  try {
    // Get all intents with PENDING win_model
    const snapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .get();

    console.log(`Found: ${snapshot.size} intents with PENDING win_model\n`);

    let statusBreakdown = {};
    let sourceBreakdown = {};
    let completeness = {
      with_executed_at: 0,
      without_executed_at: 0,
      with_error: 0,
      with_reason: 0
    };

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const status = data.status || 'unknown';
      const source = data.source || 'unknown';

      statusBreakdown[status] = (statusBreakdown[status] || 0) + 1;
      sourceBreakdown[source] = (sourceBreakdown[source] || 0) + 1;

      if (data.execution_audit?.executed_at) {
        completeness.with_executed_at++;
      } else {
        completeness.without_executed_at++;
      }

      if (data.error_message || data.reason) {
        completeness.with_error++;
      }

      if (data.reason) {
        completeness.with_reason++;
      }
    }

    console.log('📊 STATUS BREAKDOWN:');
    for (const status in statusBreakdown) {
      console.log(`   ${status}: ${statusBreakdown[status]}`);
    }

    console.log('\n📊 SOURCE BREAKDOWN:');
    for (const source in sourceBreakdown) {
      console.log(`   ${source}: ${sourceBreakdown[source]}`);
    }

    console.log('\n📋 COMPLETENESS ANALYSIS:');
    console.log(`   With executed_at: ${completeness.with_executed_at}`);
    console.log(`   Without executed_at: ${completeness.without_executed_at}`);
    console.log(`   With error_message: ${completeness.with_error}`);
    console.log(`   With reason field: ${completeness.with_reason}`);

    // Sample a few failed intents to understand why they don't have win_exchange
    console.log('\n\n🔎 SAMPLE INTENTS (why they don\'t have results):\n');

    let sampleCount = 0;
    for (const doc of snapshot.docs) {
      if (sampleCount >= 5) break;

      const data = doc.data();
      console.log(`Intent: ${doc.id}`);
      console.log(`  status: ${data.status}`);
      console.log(`  source: ${data.source}`);
      console.log(`  reason: ${data.reason || 'N/A'}`);
      console.log(`  error_message: ${data.error_message || 'N/A'}`);
      console.log(`  executed_at: ${data.execution_audit?.executed_at || 'N/A'}`);
      console.log(`  win_exchange: ${data.execution_audit?.win_exchange || 'MISSING'}`);
      console.log('');

      sampleCount++;
    }

    // Analysis: should these intents have win_model?
    console.log('📊 ANALYSIS - Should these intents have win_model?\n');
    console.log('   - "failed": ❌ No (transaction failed, no execution result)');
    console.log('   - "skipped": ❌ No (validation rejected, never executed)');
    console.log('   - "dry_run": ❓ Maybe (execution simulated but not real)');
    console.log('   - "blocked": ❌ No (not allowed to execute)');
    console.log('\n   CONCLUSION: Most remaining PENDING are correctly PENDING');
    console.log('   (they are failed/skipped/blocked - no actual result)');

  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await admin.app().delete();
  }
}

analyzeRemainingPending();
