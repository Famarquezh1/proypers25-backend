const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const db = admin.firestore();

async function analyze() {
  try {
    console.log('--- FIRESTORE ANALYSIS REPORT ---');

    // 1, 2, 3: Candidates Analysis
    const candidatesSnapshot = await db.collection('candidates').get();
    const candidates = [];
    candidatesSnapshot.forEach(doc => candidates.push(doc.data()));

    const totalCandidates = candidates.length;
    const ranges = { '[0-50)': 0, '[50-70)': 0, '[70-80)': 0, '[80-90)': 0, '[90-100]': 0 };
    const categories = { BREAKOUT: 0, MOMENTUM: 0, ACCUMULATION: 0, WATCHLIST: 0, NEW_OR_LOW_PRICE: 0 };
    let threshold70 = 0;

    candidates.forEach(c => {
      const score = c.opportunity_score || 0;
      if (score >= 0 && score < 50) ranges['[0-50)']++;
      else if (score >= 50 && score < 70) ranges['[50-70)']++;
      else if (score >= 70 && score < 80) ranges['[70-80)']++;
      else if (score >= 80 && score < 90) ranges['[80-90)']++;
      else if (score >= 90) ranges['[90-100]']++;

      if (score >= 70) threshold70++;

      const cat = c.category;
      if (categories.hasOwnProperty(cat)) categories[cat]++;
    });

    console.log('\n1. Score Ranges:');
    for (const range in ranges) {
      const count = ranges[range];
      const pct = totalCandidates ? ((count / totalCandidates) * 100).toFixed(1) : 0;
      process.stdout.write(`  ${range}: ${count} (${pct}%)\n`);
    }

    console.log('\n2. Categories:');
    for (const cat in categories) {
      const count = categories[cat];
      const pct = totalCandidates ? ((count / totalCandidates) * 100).toFixed(1) : 0;
      process.stdout.write(`  ${cat}: ${count} (${pct}%)\n`);
    }

    console.log('\n3. Total >= 70 (Executable):', threshold70, totalCandidates ? `(${((threshold70 / totalCandidates) * 100).toFixed(1)}%)` : '');

    // 4. Last 5 positions
    console.log('\n4. Last 5 Positions:');
    const positionsSnapshot = await db.collection('positions').orderBy('opened_at', 'desc').limit(5).get();
    if (positionsSnapshot.empty) {
      console.log('  No positions found.');
    } else {
      positionsSnapshot.forEach(doc => {
        const data = doc.data();
        const openedAt = data.opened_at ? (data.opened_at.toDate ? data.opened_at.toDate().toISOString() : data.opened_at) : 'N/A';
        console.log(`  Symbol: ${data.symbol}, Status: ${data.status}, Opened: ${openedAt}`);
      });
    }

    // 5. real_spot_config/control
    console.log('\n5. real_spot_config/control:');
    const configDoc = await db.collection('real_spot_config').doc('control').get();
    if (configDoc.exists) {
      const config = configDoc.data();
      console.log(`  min_opportunity_score: ${config.min_opportunity_score}`);
      console.log(`  allowed_categories: ${JSON.stringify(config.allowed_categories)}`);
      console.log(`  new_entries_enabled: ${config.new_entries_enabled}`);
    } else {
      console.log('  Config doc not found.');
    }

    // 6. Last 3 execution_decision_snapshots
    console.log('\n6. Last 3 execution_decision_snapshots:');
    const snapshotsSnapshot = await db.collection('execution_decision_snapshots')
        .orderBy('timestamp', 'desc')
        .limit(3)
        .get();
    
    if (snapshotsSnapshot.empty) {
      console.log('  No snapshots found.');
    } else {
      snapshotsSnapshot.forEach(doc => {
        const data = doc.data();
        const ts = data.timestamp ? (data.timestamp.toDate ? data.timestamp.toDate().toISOString() : data.timestamp) : 'N/A';
        console.log(`  TS: ${ts}, Action: ${data.action || 'N/A'}, Candidates Count: ${data.candidates_count || 0}`);
      });
    }

  } catch (err) {
    console.error('Error during analysis:', err);
  } finally {
    process.exit();
  }
}

analyze();
