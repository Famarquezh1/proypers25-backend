const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkCurrentState() {
  console.log('\n?? CURRENT SYSTEM STATE CHECK\n');
  
  // 1. Get all open positions
  console.log('1??  OPEN POSITIONS:');
  const positionsSnap = await db.collection('real_spot_positions')
    .where('status', 'in', ['open', 'OPEN'])
    .get();
  
  console.log(`   Total open: ${positionsSnap.size}`);
  
  for (const doc of positionsSnap.docs) {
    const pos = doc.data();
    console.log(`   ? ${pos.symbol} (score: ${pos.score}, created: ${pos.created_at?.toDate?.() || pos.created_at})`);
    
    // Check if this position has snapshot
    if (pos.execution_decision_snapshot) {
      console.log(`     +- ? HAS execution_decision_snapshot`);
    } else {
      console.log(`     +- ? NO execution_decision_snapshot`);
    }
  }
  
  // 2. Check near_miss_opportunity_log
  console.log('\n2??  NEAR-MISS OPPORTUNITIES LOG:');
  const nearMissSnap = await db.collection('near_miss_opportunity_log').get();
  console.log(`   Total near-miss entries: ${nearMissSnap.size}`);
  
  if (nearMissSnap.size > 0) {
    const recentMisses = nearMissSnap.docs
      .sort((a, b) => b.data().logged_at - a.data().logged_at)
      .slice(0, 5);
    
    for (const doc of recentMisses) {
      const miss = doc.data();
      console.log(`   ? ${miss.symbol} (score: ${miss.score}, distance: ${miss.distance_to_threshold}, reason: ${miss.rejection_reason})`);
    }
  }
  
  // 3. Get config
  console.log('\n3??  CURRENT CONFIG:');
  const configSnap = await db.collection('real_spot_config').doc('control').get();
  const config = configSnap.data();
  console.log(`   max_open_positions: ${config.max_open_positions}`);
  console.log(`   new_entries_enabled: ${config.new_entries_enabled}`);
  console.log(`   min_score: ${config.min_score}`);
  console.log(`   allowed_categories: ${config.allowed_categories.join(', ')}`);
  
  // 4. Total capital analysis
  console.log('\n4??  CAPITAL STATUS:');
  let totalCapitalUsed = 0;
  for (const doc of positionsSnap.docs) {
    totalCapitalUsed += doc.data().initial_capital || 0;
  }
  console.log(`   Used: ${totalCapitalUsed} USDT`);
  console.log(`   Available: ~${100 - totalCapitalUsed} USDT`);
  
  // 5. Check for any recent candidates
  console.log('\n5??  CANDIDATE POOL:');
  const candidatesSnap = await db.collection('spot_opportunity_candidates')
    .where('score', '>=', config.min_score)
    .limit(5)
    .get();
  console.log(`   Candidates at/above threshold (min_score=${config.min_score}): ${candidatesSnap.size}`);
  
  console.log('\n? STATE CHECK COMPLETE\n');
}

checkCurrentState().catch(err => {
  console.error('? Error:', err.message);
  process.exit(1);
});
