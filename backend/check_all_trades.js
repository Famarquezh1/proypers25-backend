const db = require('./firebase-admin-config.js');

async function checkAllTrades() {
    try {
        // Get last 10 positions ordered by created_at desc
        const snapshot = await db.collection('real_spot_positions')
            .orderBy('created_at', 'desc')
            .limit(10)
            .get();

        console.log(`\n📊 Last 10 Positions:\n`);

        if (snapshot.empty) {
            console.log('❌ No positions found at all');
        } else {
            snapshot.forEach((doc) => {
                const data = doc.data();
                console.log(`ID: ${doc.id}`);
                console.log(`  Symbol: ${data.symbol}`);
                console.log(`  Order ID: ${data.order_id}`);
                console.log(`  Created: ${data.created_at}`);
                console.log(`  Status: ${data.status}`);
                console.log(`  Entry: ${data.entry_price} @ ${data.quantity} tokens\n`);
            });
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkAllTrades();
