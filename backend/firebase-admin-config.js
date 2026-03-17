const admin = require('firebase-admin');
const { getFirestore } = require('firebase-admin/firestore');
const fs = require('fs');
const path = require('path');

if (!admin.apps.length) {
  const serviceAccountPath = path.join(__dirname, 'serviceAccountKey.json');
  const credential = fs.existsSync(serviceAccountPath)
    ? admin.credential.cert(require(serviceAccountPath))
    : admin.credential.applicationDefault();

  admin.initializeApp({
    credential
  });
}

const db = getFirestore();
db.settings({ ignoreUndefinedProperties: true });

module.exports = db;

