const admin = require('firebase-admin');
const fs = require('fs');
const path = require('path');

const key = JSON.parse(fs.readFileSync('.env.json', 'utf8'));
admin.initializeApp({
  credential: admin.credential.cert(key.firebase_service_account_key)
});

const db = admin.firestore();

(async () => {
  console.log('=== CHECKING EXISTING SCANS ===');
  const snaps = await db.collection('spot_opportunity_scans')
    .orderBy('created_at', 'desc')
    .limit(3)
    .get();

  if (snaps.empty) {
    console.log('No scans found');
  } else {
    snaps.forEach(doc => {
      const data = doc.data();
      const created = new Date(data.created_at);
      const ageMin = (Date.now() - created.getTime()) / (60 * 1000);
      console.log(`\nScan: ${data.scan_id || doc.id}`);
      console.log(`Created: ${data.created_at}`);
      console.log(`Age: ${ageMin.toFixed(0)} minutes`);
      console.log(`Candidates: ${data.candidates_count || 'unknown'}`);
    });
  }
  
  process.exit(0);
})().catch(e => {
  console.error(e.message);
  process.exit(1);
});
