
const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}
const db = admin.firestore();

async function runDiagnostic() {
    console.log("--- Detailed Firestore Diagnostic ---");

    const spotRef = db.collection("real_spot_positions");
    const spotSnap = await spotRef.get();
    console.log(`\nreal_spot_positions total count: ${spotSnap.size}`);

    const docs = spotSnap.docs.map(doc => ({id: doc.id, data: doc.data()}));
    
    docs.forEach(item => {
        const d = item.data;
        console.log(`\n- Document ID: ${item.id}`);
        console.log(`  Keys: ${Object.keys(d).join(", ")}`);
        
        // Find any timestamp candidate
        const tsKey = Object.keys(d).find(k => k.toLowerCase().includes("time") || k.toLowerCase().includes("date") || k.toLowerCase().includes("created"));
        if (tsKey) {
            const val = d[tsKey];
            console.log(`  Timestamp candidate (${tsKey}): ${val && val.toDate ? val.toDate().toISOString() : val}`);
        }
        
        console.log(`  Has execution_decision_snapshot: ${d.execution_decision_snapshot !== undefined}`);
        if (d.execution_decision_snapshot) {
           console.log(`  Snapshot Type: ${typeof d.execution_decision_snapshot}`);
        }
    });

    const missRef = db.collection("near_miss_opportunity_log");
    const missSnap = await missRef.get();
    console.log(`\nnear_miss_opportunity_log total count: ${missSnap.size}`);

    process.exit(0);
}
runDiagnostic().catch(err => { console.error(err); process.exit(1); });

