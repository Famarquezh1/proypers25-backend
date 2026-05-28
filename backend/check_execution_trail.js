const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function checkExecutionTrail() {
    console.log('\n🔎 CHECKING FULL EXECUTION TRAIL FOR CATI\n');

    try {
        // 1. Get the CATI position
        const catiPos = await db.collection('real_spot_positions')
            .where('symbol', '==', 'CATIUSDT')
            .where('status', '==', 'REAL_OPEN')
            .get();

        const catiData = catiPos.docs[0].data();
        const intendId = catiData.intent_id;
        const scanId = catiData.scan_id;
        const orderId = catiData.order_id;

        console.log(`CATI Position:`);
        console.log(`  Order ID: ${orderId}`);
        console.log(`  Intent ID: ${intendId}`);
        console.log(`  Scan ID: ${scanId}`);
        console.log(`  Opened At: ${catiData.opened_at}`);

        // 2. Look for ANY spot scans around that time
        console.log(`\n1️⃣ Searching for spot_scans around ${catiData.opened_at}:`);
        const allScans = await db.collection('spot_scans').get();
        console.log(`   Total spot_scans in DB: ${allScans.size}`);

        if (allScans.size > 0) {
            console.log(`   Sample scans:`);
            for (const doc of allScans.docs.slice(0, 5)) {
                const data = doc.data();
                console.log(`   - ${doc.id} (created: ${data.created_at || 'unknown'})`);
            }
        }

        // 3. Look for ANY real_spot_intents
        console.log(`\n2️⃣ Searching for real_spot_intents around ${catiData.opened_at}:`);
        const allIntents = await db.collection('real_spot_intents').get();
        console.log(`   Total real_spot_intents in DB: ${allIntents.size}`);

        if (allIntents.size > 0) {
            console.log(`   Sample intents:`);
            for (const doc of allIntents.docs.slice(0, 5)) {
                const data = doc.data();
                console.log(`   - ${doc.id}`);
            }
        }

        // 4. Check if there are ANY candidates from scan_1778798704029
        console.log(`\n3️⃣ Searching for candidates from scan ${scanId}:`);
        const candidates = await db.collection('spot_opportunity_candidates')
            .where('scan_id', '==', scanId)
            .get();

        console.log(`   Candidates found: ${candidates.size}`);
        if (candidates.size > 0) {
            console.log(`   First candidate:`);
            const firstCand = candidates.docs[0].data();
            console.log(`   - Symbol: ${firstCand.symbol}`);
            console.log(`   - Score: ${firstCand.opportunityScore}`);
            console.log(`   - Has Snapshot: ${!!firstCand.execution_decision_snapshot}`);
        }

        // 5. Check if configuration might have changed between code deployment and execution
        console.log(`\n4️⃣ Checking for config history:`);
        const configHistory = await db.collection('real_spot_config')
            .doc('control')
            .collection('history')
            .orderBy('timestamp', 'desc')
            .limit(5)
            .get();

        console.log(`   Config history entries: ${configHistory.size}`);
        for (const doc of configHistory.docs) {
            const data = doc.data();
            console.log(`   - ${data.timestamp}`);
        }

        // 6. Analyze the problem
        console.log(`\n5️⃣ ROOT CAUSE ANALYSIS:`);
        console.log(`\n   Theory 1: Execution used code WITHOUT snapshot support`);
        console.log(`   - Evidence: CATI created 120 min after deployment`);
        console.log(`   - But: Code DOES have snapshots, should work`);

        console.log(`\n   Theory 2: Execution succeeded but scan/intent writes failed`);
        console.log(`   - Evidence: Intent doesn't exist, scan doesn't exist`);
        console.log(`   - But: Position WAS created successfully`);
        console.log(`   - Likely: Database permission issue or Cloud Run timeout`);

        console.log(`\n   Theory 3: Cloud Scheduler uses a different endpoint`);
        console.log(`   - Evidence: Timestamp matches scheduler cycle time`);
        console.log(`   - But: Endpoint should use same code`);

        // 7. Check if there's a pattern in other positions
        console.log(`\n6️⃣ Checking other positions for same pattern:`);
        const allPositions = await db.collection('real_spot_positions')
            .where('status', '==', 'REAL_OPEN')
            .get();

        console.log(`   Total REAL_OPEN positions: ${allPositions.size}`);
        for (const doc of allPositions.docs) {
            const pos = doc.data();
            const hasSnapshot = !!pos.execution_decision_snapshot;
            const intentExists = pos.intent_id ? await db.collection('real_spot_intents').doc(pos.intent_id).get().then(d => d.exists) : false;
            console.log(`   - ${pos.symbol}: snapshot=${hasSnapshot}, intent_exists=${intentExists}`);
        }

        console.log('\n✅ Analysis complete\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

checkExecutionTrail();
