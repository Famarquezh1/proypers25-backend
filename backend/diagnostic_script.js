const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function runDiagnostic() {
    console.log("--- STARTING FIRESTORE DIAGNOSTIC ---");

    // 1. spot_opportunity_candidates
    const candidatesSnap = await db.collection("spot_opportunity_candidates").get();
    const candidates = candidatesSnap.docs.map(doc => doc.data());
    
    const scoreRanges = {
        "<50": 0,
        "50-70": 0,
        "70-80": 0,
        "80-90": 0,
        "90-100": 0
    };
    
    const categories = {};
    let highScorers = 0;

    candidates.forEach(c => {
        const score = c.opportunityScore || 0;
        if (score < 50) scoreRanges["<50"]++;
        else if (score < 70) scoreRanges["50-70"]++;
        else if (score < 80) scoreRanges["70-80"]++;
        else if (score < 90) scoreRanges["80-90"]++;
        else scoreRanges["90-100"]++;

        if (score >= 70) highScorers++;

        const cat = c.category || "undefined";
        categories[cat] = (categories[cat] || 0) + 1;
    });

    console.log("\n[1] spot_opportunity_candidates");
    console.table(scoreRanges);
    console.log("\n[2] Categories");
    console.table(categories);
    console.log(`\n[3] Candidates with score >= 70: ${highScorers}`);

    // 2. real_spot_positions
    const positionsSnap = await db.collection("real_spot_positions").get();
    const positions = positionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    
    const totalPos = positions.length;
    const openPos = positions.filter(p => p.status === "REAL_OPEN").length;
    const closedPos = positions.filter(p => p.status === "REAL_CLOSED").length;
    const hasExecutionSnapshot = positions.filter(p => p.execution_decision_snapshot).length;

    console.log("\n[4] real_spot_positions Summary");
    console.table({
        "Total Count": totalPos,
        "REAL_OPEN": openPos,
        "REAL_CLOSED": closedPos,
        "With Execution Snapshot": hasExecutionSnapshot
    });

    console.log("\n[5] Last 3 positions");
    const last3 = positions
        .sort((a, b) => (b.timestamp?.seconds || 0) - (a.timestamp?.seconds || 0))
        .slice(0, 3)
        .map(p => ({
            id: p.id,
            symbol: p.symbol,
            status: p.status,
            time: p.timestamp ? p.timestamp.toDate().toISOString() : "N/A"
        }));
    console.table(last3);

    // 3. real_spot_config/control
    const configDoc = await db.collection("real_spot_config").doc("control").get();
    console.log("\n[6] real_spot_config/control Document");
    if (configDoc.exists) {
        console.table(configDoc.data());
    } else {
        console.log("Document real_spot_config/control NOT FOUND");
    }

    process.exit(0);
}

runDiagnostic().catch(err => {
    console.error(err);
    process.exit(1);
});
