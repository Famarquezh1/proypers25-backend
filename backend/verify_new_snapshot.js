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

async function verifySnapshot() {
    try {
        console.log('🔍 VERIFYING NEW POSITION AND SNAPSHOTS...\n');

        // Check the new position
        console.log('📍 Position: real_spot_pos_1778797368165_XECUSDT\n');
        const posRef = db.collection('real_spot_positions').doc('real_spot_pos_1778797368165_XECUSDT');
        const posSnap = await posRef.get();

        if (!posSnap.exists) {
            console.log('   ❌ Position not found');
        } else {
            const data = posSnap.data();
            console.log(`   ✅ Position exists`);
            console.log(`   Symbol: ${data.symbol}`);
            console.log(`   Status: ${data.status || 'N/A'}`);
            console.log(`   Entry: ${data.entry_price || data.price || 'N/A'}`);

            if (data.execution_decision_snapshot) {
                console.log(`   ✅ HAS execution_decision_snapshot:`);
                console.log(`      ${JSON.stringify(data.execution_decision_snapshot, null, 2)}`);
            } else {
                console.log(`   ❌ NO execution_decision_snapshot field`);
            }
        }

        // Check near_miss logs
        console.log('\n📋 near_miss_opportunity_log Collection:\n');
        const missRef = db.collection('near_miss_opportunity_log');
        const missSnap = await missRef.get();
        console.log(`   Total documents: ${missSnap.size}`);

        if (missSnap.size > 0) {
            console.log(`   ✅ Found ${missSnap.size} near-miss log(s):`);
            missSnap.forEach(doc => {
                const data = doc.data();
                console.log(`\n   - Cycle ID: ${data.cycle_id || doc.id}`);
                console.log(`     Reason: ${data.rejection_reason}`);
                console.log(`     Count: ${data.near_miss_count}`);
            });
        } else {
            console.log(`   ℹ️  No near-miss logs (expected - no rejections yet)`);
        }

        console.log('\n✅ VERIFICATION COMPLETE');
        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

verifySnapshot();
