const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();
async function list() {
  const colls = await db.listCollections();
  console.log('Collections:', colls.map(c => c.id));
  process.exit();
}
list();
