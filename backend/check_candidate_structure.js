const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
if (!admin.apps.length) {
  try {
    const serviceAccount = require(serviceAccountPath);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount),
    });
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

const db = admin.firestore();

async function checkCandidateStructure() {
  console.log('🔍 VERIFICANDO ESTRUCTURA DE CANDIDATOS\n');

  try {
    const candidateSnap = await db.collection('spot_opportunity_candidates')
      .orderBy('opportunityScore', 'desc')
      .limit(1)
      .get();

    if (candidateSnap.empty) {
      console.log('❌ No hay candidatos');
      process.exit(0);
    }

    const candidate = candidateSnap.docs[0].data();
    const candidateId = candidateSnap.docs[0].id;

    console.log(`📍 ID: ${candidateId}`);
    console.log(`📊 Campos disponibles:`);
    console.log(JSON.stringify(candidate, null, 2));

  } catch (error) {
    console.error('❌ Error:', error.message);
  }

  process.exit(0);
}

checkCandidateStructure();
