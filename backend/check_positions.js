const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkPositions() {
  try {
    const snapshot = await db.collection('real_spot_positions')
      .orderBy('timestamp', 'desc')
      .limit(1)
      .get();

    console.log('--- RECENT POSITION ---');
    if (snapshot.empty) {
      console.log('No recent positions found.');
    } else {
      snapshot.forEach(doc => {
        console.log('Position ID:', doc.id);
        console.log('Content:', JSON.stringify(doc.data(), null, 2));
      });
    }
    process.exit(0);
  } catch (err) {
    console.error('Error:', err);
    process.exit(1);
  }
}

checkPositions();
