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

async function resetAndExpand() {
    console.log('🔄 RESETTING OPEN POSITIONS AND EXPANDING CONFIG...\n');

    try {
        // 1. Close all open positions
        console.log('📍 Step 1: Closing all open positions...');
        const positionsRef = db.collection('real_spot_positions');
        const openSnapshot = await positionsRef
            .where('status', 'in', ['open', 'OPEN', 'REAL_OPEN'])
            .get();

        const closedCount = openSnapshot.size;
        const now = new Date().toISOString();

        const batch = db.batch();
        openSnapshot.forEach(doc => {
            batch.update(doc.ref, {
                status: 'CLOSED',
                closed_at: now,
                close_reason: 'MANUAL_RESET_FOR_FRESH_CYCLE'
            });
        });

        if (closedCount > 0) {
            await batch.commit();
            console.log(`   ✅ Closed ${closedCount} positions\n`);

            openSnapshot.forEach(doc => {
                const data = doc.data();
                console.log(`      - ${data.symbol} (ID: ${doc.id})`);
            });
        } else {
            console.log('   ℹ️  No open positions found\n');
        }

        // 2. Update config
        console.log('\n⚙️  Step 2: Updating config...');
        const configRef = db.collection('real_spot_config').doc('control');
        const configSnap = await configRef.get();
        const currentConfig = configSnap.data() || {};

        await configRef.update({
            max_open_positions: 4,
            new_entries_enabled: true,
            updated_at: now,
            last_reset_at: now,
            reset_reason: 'MANUAL_EXPANSION_FOR_FRESH_CYCLE'
        });

        console.log(`   ✅ Config updated\n`);
        console.log(`   New Settings:`);
        console.log(`      max_open_positions: ${currentConfig.max_open_positions} → 4`);
        console.log(`      new_entries_enabled: false → true`);
        console.log(`      updated_at: ${now}\n`);

        // 3. Verify
        console.log('✨ Step 3: Verification...');
        const updatedConfig = (await configRef.get()).data();
        const remainingOpen = await positionsRef
            .where('status', 'in', ['OPEN', 'REAL_OPEN'])
            .get();

        console.log(`   Open positions remaining: ${remainingOpen.size}`);
        console.log(`   max_open_positions: ${updatedConfig.max_open_positions}`);
        console.log(`   new_entries_enabled: ${updatedConfig.new_entries_enabled}`);

        console.log('\n✅ RESET AND EXPANSION COMPLETE');
        console.log('   System ready for fresh cycle!\n');

    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

resetAndExpand().then(() => process.exit(0));
