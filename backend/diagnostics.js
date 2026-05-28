const db = require("./firebase-admin-config");

async function runDiagnostics() {
  const DEPLOY_TIME = new Date("2026-05-14T20:50:00Z");
  console.log("--- STARTING DIAGNOSTICS ---");
  console.log(`Current Time (UTC): ${new Date().toISOString()}`);
  console.log(`Deploy Time (UTC): ${DEPLOY_TIME.toISOString()}`);
  console.log("----------------------------\n");

  // 1. real_spot_positions
  console.log("== [real_spot_positions] ==");
  const positionsSnapshot = await db.collection("real_spot_positions").get();
  let lastTradeOpened = null;
  
  if (positionsSnapshot.empty) {
    console.log("No positions found.");
  } else {
    positionsSnapshot.forEach(doc => {
      const data = doc.data();
      const entryTime = data.entry_timestamp ? (data.entry_timestamp.toDate ? data.entry_timestamp.toDate() : new Date(data.entry_timestamp)) : null;
      const openedAt = data.opened_at ? (data.opened_at.toDate ? data.opened_at.toDate() : new Date(data.opened_at)) : null;
      
      const isNewer = (entryTime && entryTime > DEPLOY_TIME) || (openedAt && openedAt > DEPLOY_TIME);
      if (openedAt && (!lastTradeOpened || openedAt > lastTradeOpened)) {
        lastTradeOpened = openedAt;
      }

      const hasSnapshot = data.execution_decision_snapshot ? "Y" : "N";
      const ageHours = entryTime ? ((new Date() - entryTime) / (1000 * 60 * 60)).toFixed(2) : "N/A";
      
      console.log(`- ID: ${doc.id}`);
      console.log(`  Status: ${data.status} | Symbol: ${data.symbol}`);
      console.log(`  Entry: ${entryTime ? entryTime.toISOString() : "N/A"} | Opened: ${openedAt ? openedAt.toISOString() : "N/A"}`);
      console.log(`  Has Snapshot: ${hasSnapshot} | Age: ${ageHours} hrs | Newer than Deploy: ${isNewer ? "YES" : "NO"}`);
      console.log(`  PnL: ${data.pnl || data.current_pnl || "N/A"}`);
      console.log("  ---");
    });
  }
  console.log(`Last trade opened at: ${lastTradeOpened ? lastTradeOpened.toISOString() : "N/A"}\n`);

  // 2. near_miss_opportunity_log
  console.log("== [near_miss_opportunity_log] ==");
  const nearMissSnapshot = await db.collection("near_miss_opportunity_log").orderBy("timestamp", "desc").limit(1).get();
  const totalNearMiss = (await db.collection("near_miss_opportunity_log").count().get()).data().count;
  
  console.log(`Total count: ${totalNearMiss}`);
  if (!nearMissSnapshot.empty) {
    const lastNearMiss = nearMissSnapshot.docs[0].data();
    const ts = lastNearMiss.timestamp ? (lastNearMiss.timestamp.toDate ? lastNearMiss.timestamp.toDate() : new Date(lastNearMiss.timestamp)) : null;
    console.log(`Most recent entry: ${ts ? ts.toISOString() : "N/A"}`);
    console.log(`Rejection reason: ${lastNearMiss.rejection_reason || lastNearMiss.reason || "N/A"}`);
  } else {
    console.log("No near misses found.");
  }
  console.log("");

  // 3. real_spot_config/control
  console.log("== [real_spot_config/control] ==");
  const configDoc = await db.collection("real_spot_config").doc("control").get();
  if (configDoc.exists) {
    const cfg = configDoc.data();
    const updatedTs = cfg.updated_at ? (cfg.updated_at.toDate ? cfg.updated_at.toDate() : new Date(cfg.updated_at)) : null;
    console.log(`new_entries_enabled: ${cfg.new_entries_enabled}`);
    console.log(`min_opportunity_score: ${cfg.min_opportunity_score}`);
    console.log(`updated_at: ${updatedTs ? updatedTs.toISOString() : "N/A"}`);
  } else {
    console.log("Config document 'real_spot_config/control' not found.");
  }
  
  console.log("\n--- DIAGNOSTICS COMPLETE ---");
  process.exit(0);
}

runDiagnostics().catch(err => {
  console.error("DIAGNOSTICS FAILED:", err);
  process.exit(1);
});
