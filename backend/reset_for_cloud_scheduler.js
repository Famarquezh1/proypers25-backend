const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function resetForCloudScheduler() {
  console.log('\n🔄 RESETTING FOR CLOUD SCHEDULER CYCLE\n');
  
  const now = new Date();
  
  // 1. Close all open positions
  console.log('1️⃣ Closing all open positions...');
  const posSnap = await db.collection('real_spot_positions')
    .where('status', 'in', ['open', 'OPEN'])
    .get();
  
  const batch = db.batch();
  let closedCount = 0;
  
  for (const doc of posSnap.docs) {
    batch.update(doc.ref, {
      status: 'CLOSED',
      closed_at: now,
      close_reason: 'RESET_FOR_CLOUD_SCHEDULER_TEST'
    });
    closedCount++;
  }
  
  if (closedCount > 0) {
    await batch.commit();
    console.log(`   ✅ Closed ${closedCount} position(s)`);
  } else {
    console.log(`   ℹ️  No open positions to close`);
  }
  
  // 2. Enable new entries and reset session counter
  console.log('\n2️⃣ Configuring for fresh Cloud Scheduler execution...');
  const configRef = db.collection('real_spot_config').doc('control');
  
  await configRef.update({
    new_entries_enabled: true,
    entries_used_this_session: 0,
    last_entry_at: null,
    last_entry_symbol: null,
    disable_after_first_entry: false,
    updated_at: now,
    reset_note: 'Reset by diagnose script for Cloud Scheduler test'
  });
  
  console.log('   ✅ Config updated:');
  console.log('      new_entries_enabled: true');
  console.log('      entries_used_this_session: 0');
  console.log('      disable_after_first_entry: false');
  
  // 3. Verify state
  console.log('\n3️⃣ Verification:');
  const openPos = await db.collection('real_spot_positions')
    .where('status', 'in', ['open', 'OPEN'])
    .get();
  
  console.log(`   Open positions: ${openPos.size}`);
  
  const config = (await configRef.get()).data();
  console.log(`   new_entries_enabled: ${config.new_entries_enabled}`);
  console.log(`   entries_used_this_session: ${config.entries_used_this_session}`);
  
  console.log('\n✅ SYSTEM READY FOR CLOUD SCHEDULER EXECUTION');
  console.log('   ⏳ Waiting for next automatic cycle (~15 min from now)...\n');
  
  process.exit(0);
}

resetForCloudScheduler().catch(err => {
  console.error('❌ Error:', err.message);
  process.exit(1);
});
