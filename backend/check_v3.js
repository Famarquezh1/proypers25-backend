const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function check() {
  try {
    const colName = 'real_spot_positions';
    const snapshot = await db.collection(colName).orderBy('timestamp', 'desc').limit(5).get();
    console.log(`Checking ${colName}...`);
    if (snapshot.empty) {
      console.log('No documents found.');
    } else {
      snapshot.forEach(doc => {
        console.log(`ID: ${doc.id}`);
        console.log(`Data: ${JSON.stringify(doc.data(), null, 2)}`);
      });
    }
    process.exit(0);
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
}

check();
