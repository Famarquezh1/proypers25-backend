const db = require('../firebase-admin-config');

async function main() {
  const snapshot = await db.collection('velas_predicciones').orderBy('created_at', 'desc').limit(20).get();
  snapshot.forEach((doc) => {
    console.log(doc.id, doc.data().simbolo, doc.data().execution_mode, doc.data().created_at);
  });
}

main().catch(console.error);
