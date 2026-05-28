const db = require("./firebase-admin-config.js");

function formatTime(val) {
    if (!val) return "N/A";
    if (typeof val.toDate === "function") return val.toDate().toISOString();
    if (val._seconds) return new Date(val._seconds * 1000).toISOString();
    return "N/A";
}

function getTimestamp(p) {
    // Try multiple fields
    const fields = ["created_at", "opened_at", "timestamp", "createdAt", "updated_at"];
    for (const f of fields) {
        if (p[f]) return p[f];
    }
    // Try to extract from ID if it looks like real_spot_pos_1778514617046_...
    const match = p.id.match(/(\d{13})/);
    if (match) {
        return { _seconds: parseInt(match[1]) / 1000 };
    }
    return null;
}

function getMillis(val) {
    if (!val) return 0;
    if (typeof val.toMillis === "function") return val.toMillis();
    if (val._seconds) return val._seconds * 1000;
    if (typeof val === "number") return val;
    return 0;
}

async function runReport() {
    try {
        const snapshot = await db.collection("real_spot_positions").get();
        const positions = [];
        snapshot.forEach(doc => {
            positions.push({ id: doc.id, ...doc.data() });
        });

        console.log("\n--- ALL POSITIONS ---");
        console.table(positions.map(p => ({
            id: p.id,
            status: p.status,
            symbol: p.symbol,
            entry: p.entry_price || p.opened_price,
            qty: p.quantity,
            created: formatTime(getTimestamp(p)),
            has_snapshot: !!p.execution_decision_snapshot
        })));

        const openCount = positions.filter(p => p.status === "REAL_OPEN" || p.status === "open").length;
        const closedCount = positions.filter(p => p.status === "REAL_CLOSED" || p.status === "closed").length;
        console.log("\nTOTAL POSITIONS: " + positions.length);
        console.log("REAL_OPEN/open: " + openCount);
        console.log("REAL_CLOSED/closed: " + closedCount);

        const sorted = [...positions].sort((a, b) => {
            return getMillis(getTimestamp(b)) - getMillis(getTimestamp(a));
        });
        console.log("\n--- 3 MOST RECENT POSITIONS ---");
        console.table(sorted.slice(0, 3).map(p => ({
            id: p.id,
            symbol: p.symbol,
            created: formatTime(getTimestamp(p))
        })));

        const targetId = "XECUSDT_1778771833075";
        const exists = positions.some(p => p.id === targetId || p.id.includes(targetId));
        console.log("\nPosition " + targetId + " exists: " + exists);

        const withSnapshot = positions.filter(p => p.execution_decision_snapshot);
        console.log("\nPositions with execution_decision_snapshot: " + withSnapshot.length);
        if (withSnapshot.length > 0) {
            console.log("IDs with snapshots: " + withSnapshot.map(p => p.id).join(", "));
        }

    } catch (error) {
        console.error("Error:", error);
    } finally {
        process.exit();
    }
}

runReport();
