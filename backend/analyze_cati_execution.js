const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function analyzeCATI() {
    console.log('\n🔍 ANALYZING CATI EXECUTION PATH\n');

    try {
        // 1. Get CATI position details
        console.log('1️⃣ CATI POSITION ANALYSIS:');
        const cati = await db.collection('real_spot_positions')
            .where('symbol', '==', 'CATIUSDT')
            .where('status', '==', 'REAL_OPEN')
            .get();

        if (cati.empty) {
            console.log('   No REAL_OPEN CATI found');
            return;
        }

        const catiDoc = cati.docs[0];
        const catiData = catiDoc.data();
        const openedAt = new Date(catiData.opened_at);

        console.log(`\n   ✓ Found CATI position:`);
        console.log(`     Created: ${catiData.opened_at}`);
        console.log(`     Entry Price: ${catiData.entry_price}`);
        console.log(`     Strategy: ${catiData.strategy}`);
        console.log(`     Has Snapshot: ${!!catiData.execution_decision_snapshot}`);
        console.log(`     Has Intent: ${!!catiData.intent_id} (ID: ${catiData.intent_id || 'none'})`);
        console.log(`     Has Order: ${!!catiData.order_id} (ID: ${catiData.order_id || 'none'})`);
        console.log(`     Scan ID: ${catiData.scan_id || 'none'}`);

        // 2. Check if there's an execution intent for this position
        if (catiData.intent_id) {
            console.log(`\n2️⃣ EXECUTION INTENT FOR CATI:`);
            const intent = await db.collection('real_spot_intents')
                .doc(catiData.intent_id)
                .get();

            if (intent.exists) {
                const intentData = intent.data();
                console.log(`   ✓ Intent found:`);
                console.log(`     Status: ${intentData.status}`);
                console.log(`     Created: ${intentData.created_at}`);
                console.log(`     Source: ${intentData.source || 'unknown'}`);
            } else {
                console.log('   ✗ Intent NOT found in Firestore');
            }
        }

        // 3. Check scan that had CATI
        if (catiData.scan_id) {
            console.log(`\n3️⃣ SPOT SCAN THAT FOUND CATI:`);
            const scanRef = await db.collection('spot_scans')
                .doc(catiData.scan_id)
                .get();

            if (scanRef.exists) {
                const scanData = scanRef.data();
                console.log(`   ✓ Scan found:`);
                console.log(`     Created: ${scanData.created_at}`);
                console.log(`     Total Candidates: ${scanData.total_candidates || '?'}`);
            } else {
                console.log('   ✗ Scan NOT found');
            }

            // Check CATI in candidates at that scan
            const catiCandidate = await db.collection('spot_opportunity_candidates')
                .where('scan_id', '==', catiData.scan_id)
                .where('symbol', '==', 'CATIUSDT')
                .get();

            if (!catiCandidate.empty) {
                const candData = catiCandidate.docs[0].data();
                console.log(`\n   CATI Candidate in scan:`);
                console.log(`     Score: ${candData.opportunityScore}`);
                console.log(`     Category: ${candData.category}`);
                console.log(`     Has Snapshot: ${!!candData.execution_decision_snapshot}`);
            }
        }

        // 4. Check config at time of execution
        console.log(`\n4️⃣ CONFIG AT EXECUTION TIME:`);
        const configHist = await db.collection('real_spot_config')
            .doc('control')
            .get();

        if (configHist.exists) {
            const config = configHist.data();
            console.log(`   Min Score: ${config.min_opportunity_score}`);
            console.log(`   Max Position USDT: ${config.max_position_usdt}`);
            console.log(`   Max Open Positions: ${config.max_open_positions}`);
            console.log(`   Allowed Categories: ${JSON.stringify(config.allowed_categories)}`);
        }

        // 5. Timeline comparison
        console.log(`\n5️⃣ TIMELINE ANALYSIS:`);
        const deploymentTime = new Date('2026-05-14T20:50:00Z');
        const catiTime = new Date(catiData.opened_at);
        const diffMinutes = (catiTime - deploymentTime) / (1000 * 60);

        console.log(`   Deployment:  2026-05-14T20:50:00Z`);
        console.log(`   CATI Created: ${catiData.opened_at}`);
        console.log(`   Time Diff: ${diffMinutes.toFixed(0)} minutes AFTER deployment`);
        console.log(`   Conclusion: CATI created ${diffMinutes > 0 ? 'AFTER' : 'BEFORE'} code deployment`);

        if (diffMinutes > 0 && diffMinutes < 60) {
            console.log(`\n   🔴 PROBLEM IDENTIFIED:`);
            console.log(`   CATI was created ${diffMinutes.toFixed(0)} minutes after deployment`);
            console.log(`   BUT has NO execution_decision_snapshot field`);
            console.log(`   This means EITHER:`);
            console.log(`   1. The execution used old code path (different endpoint)`);
            console.log(`   2. buildExecutionDecisionSnapshot() was failing`);
            console.log(`   3. Snapshot was built but lost before saving`);
        }

        console.log('\n✅ Analysis complete\n');
        process.exit(0);
    } catch (err) {
        console.error('❌ Error:', err.message);
        process.exit(1);
    }
}

analyzeCATI();
