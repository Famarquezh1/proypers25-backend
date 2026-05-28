const admin = require("firebase-admin");
const serviceAccount = require("./serviceAccountKey.json");

if (!admin.apps.length) {
    admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
    });
}

const db = admin.firestore();

async function runDiagnostic() {
    try {
        const candidatesSnap = await db.collection("spot_opportunity_candidates").get();
        const candidates = candidatesSnap.docs.map(doc => doc.data());
        
        const scoreRanges = { "<50": 0, "50-70": 0, "70-80": 0, "80-90": 0, "90-100": 0 };
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

        console.log("\n[1] SCORE RANGES:");
        Object.entries(scoreRanges).forEach(([k, v]) => console.log(`${k}: ${v}`));
        
        console.log("\n[2] CATEGORIES:");
        Object.entries(categories).forEach(([k, v]) => console.log(`${k}: ${v}`));
        
        console.log(`\n[3] SCORE >= 70: ${highScorers}`);

        const positionsSnap = await db.collection("real_spot_positions").get();
        const positions = positionsSnap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
        
        const openPos = positions.filter(p => p.status === "REAL_OPEN").length;
        const closedPos = positions.filter(p => p.status === "REAL_CLOSED").length;
        const hasSnapshot = positions.filter(p => p.execution_decision_snapshot).length;

        console.log("\n[4] POSITIONS SUMMARY:");
        console.log(`Total: ${positions.length}`);
        console.log(`REAL_OPEN: ${openPos}`);
        console.log(`REAL_CLOSED: ${closedPos}`);
        console.log(`With Execution Snapshot: ${hasSnapshot}`);

        console.log("\n[5] LAST 3 POSITIONS:");
        positions.sort((a, b) => {
            const timeA = a.timestamp?.seconds || 0;
            const timeB = b.timestamp?.seconds || 0;
            return timeB - timeA;
        }).slice(0, 3).forEach(p => {
            const date = p.timestamp ? p.timestamp.toDate().toISOString() : "N/A";
            console.log(`${date} | ${p.symbol} | ${p.status}`);
        });

        const configDoc = await db.collection("real_spot_config").doc("control").get();
        console.log("\n[6] CONFIG (control):");
        if (configDoc.exists) {
            console.log(JSON.stringify(configDoc.data(), null, 2));
        } else {
            console.log("NOT FOUND");
        }
    } catch (e) {
        console.error(e);
    } finally {
        process.exit(0);
    }
}
runDiagnostic();
