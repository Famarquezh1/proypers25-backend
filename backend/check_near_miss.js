const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkNearMiss() {
  try {
    const snapshot = await db.collection('near_miss_opportunity_log')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    const countSnapshot = await db.collection('near_miss_opportunity_log').count().get();
    console.log('--- FIRESTORE NEAR MISS LOG ---');
    console.log('Total documents:', countSnapshot.data().count);

    if (snapshot.empty) {
      console.log('No recent near-miss logs found.');
    } else {
      snapshot.forEach(doc => {
        console.log('Recent Log ID:', doc.id);
        console.log('Content:', JSON.stringify(doc.data(), null, 2));
      });
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkNearMiss();
