const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function diagnose() {
  console.log('\n🔍 DEEP DIAGNOSTIC\n');
  
  // 1. Get FULL config document
  console.log('1️⃣ REAL_SPOT_CONFIG/CONTROL (FULL):');
  const configSnap = await db.collection('real_spot_config').doc('control').get();
  if (configSnap.exists) {
    const config = configSnap.data();
    console.log(JSON.stringify(config, null, 2));
  } else {
    console.log('   ❌ Config document does not exist!');
  }
  
  // 2. Get XECUSDT position with ALL fields
  console.log('\n2️⃣ XECUSDT POSITION (FULL):');
  const posSnap = await db.collection('real_spot_positions')
    .where('symbol', '==', 'XECUSDT')
    .get();
  
  if (posSnap.size > 0) {
    for (const doc of posSnap.docs) {
      console.log(`   Document ID: ${doc.id}`);
      console.log(JSON.stringify(doc.data(), null, 2));
    }
  } else {
    console.log('   ❌ No XECUSDT position found');
  }
  
  // 3. Check Cloud Run logs (if accessible)
  console.log('\n3️⃣ RECENT FIRESTORE WRITES:');
  const recentWrites = await db.collection('real_spot_positions')
    .orderBy('created_at', 'desc')
    .limit(3)
    .get();
  
  console.log(`   Recent positions (last 3):`);
  for (const doc of recentWrites.docs) {
    const data = doc.data();
    console.log(`   - ${data.symbol} (created_at: ${data.created_at})`);
  }
  
  process.exit(0);
}

diagnose().catch(err => {
  console.error('❌ Error:', err.message);
  console.error(err);
  process.exit(1);
});
