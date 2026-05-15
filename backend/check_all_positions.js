const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function checkAnyPosition() {
    try {
        const collections = ['real_spot_positions', 'positions', 'live_positions'];
        for (const coll of collections) {
            const snapshot = await db.collection(coll).limit(1).get();
            console.log('--- Collection: ---');
            if (snapshot.empty) {
                console.log('Empty');
            } else {
                snapshot.forEach(doc => console.log(doc.id, JSON.stringify(doc.data(), null, 2)));
            }
        }
        process.exit(0);
    } catch (err) {
        console.error('Error:', err);
        process.exit(1);
    }
}

checkAnyPosition();
