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
        console.error('❌ Firebase init error:', error.message);
        process.exit(1);
    }
}

const db = admin.firestore();

async function checkStatuses() {
    try {
        console.log('🔍 CHECKING POSITION STATUSES...\n');

        const positionsRef = db.collection('real_spot_positions');
        const allSnapshot = await positionsRef.get();

        console.log(`Total positions: ${allSnapshot.size}\n`);

        const statusMap = {};

        allSnapshot.forEach(doc => {
            const data = doc.data();
            const status = data.status || 'UNDEFINED';

            console.log(`- ${data.symbol || 'N/A'}: status="${status}"`);

            if (!statusMap[status]) {
                statusMap[status] = 0;
            }
            statusMap[status]++;
        });

        console.log('\n📊 Status Summary:');
        Object.entries(statusMap).forEach(([status, count]) => {
            console.log(`   ${status}: ${count}`);
        });

        console.log('\nUnique statuses found:', Object.keys(statusMap).join(', '));

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

checkStatuses();
