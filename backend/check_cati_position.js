const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount)
  });
}

const db = admin.firestore();

async function checkCATI() {
  console.log('\n?? SEARCHING FOR CATI POSITION AND RECENT EXECUTIONS\n');
  
  try {
    // 1. Search for CATI position (any status)
    console.log('1?? CATI POSITION:');
    const catiPos = await db.collection('real_spot_positions')
      .where('symbol', '==', 'CATIUSDT')
      .get();
    
    if (catiPos.size > 0) {
      for (const doc of catiPos.docs) {
        const pos = doc.data();
        console.log(`   ? Found CATIUSDT position:`);
        console.log(`     ID: ${doc.id}`);
        console.log(`     Status: ${pos.status}`);
        console.log(`     Entry Price: ${pos.entry_price}`);
        console.log(`     Quantity: ${pos.quantity}`);
        console.log(`     Entry Time: ${pos.entry_timestamp}`);
        console.log(`     Created At: ${pos.created_at}`);
        console.log(`     Strategy: ${pos.strategy}`);
        
        if (pos.execution_decision_snapshot) {
          console.log(`     ? HAS execution_decision_snapshot`);
        } else {
          console.log(`     ? NO execution_decision_snapshot`);
        }
      }
    } else {
      console.log('   ? No CATIUSDT position found');
    }
    
    // 2. Get all open positions (regardless of type)
    console.log('\n2?? ALL OPEN POSITIONS:');
    const allOpen = await db.collection('real_spot_positions')
      .where('status', 'in', ['open', 'OPEN'])
      .get();
    
    console.log(`   Total open: ${allOpen.size}`);
    for (const doc of allOpen.docs) {
      const pos = doc.data();
      console.log(`   - ${pos.symbol} (status: ${pos.status}, entry: ${pos.entry_timestamp})`);
    }
    
    // 3. Get recent execution results
    console.log('\n3?? RECENT EXECUTION RESULTS:');
    const results = await db.collection('real_spot_execution_results')
      .orderBy('executed_at', 'desc')
      .limit(5)
      .get();
    
    if (results.size > 0) {
      console.log(`   Found ${results.size} recent executions:`);
      for (const doc of results.docs) {
        const res = doc.data();
        console.log(`   - ${res.symbol} (executed_at: ${res.executed_at})`);
      }
    } else {
      console.log('   No execution results found');
    }
    
    // 4. Check creation timeline
    console.log('\n4?? POSITION CREATION TIMELINE:');
    const allPos = await db.collection('real_spot_positions')
      .orderBy('created_at', 'desc')
      .limit(10)
      .get();
    
    for (const doc of allPos.docs) {
      const pos = doc.data();
      const createdAt = pos.created_at ? new Date(pos.created_at).toISOString() : 'Unknown';
      console.log(`   - ${pos.symbol} (${pos.status}) created: ${createdAt}`);
    }
    
    console.log('\n? Check complete\n');
    process.exit(0);
  } catch (err) {
    console.error('? Error:', err.message);
    process.exit(1);
  }
}

checkCATI();
