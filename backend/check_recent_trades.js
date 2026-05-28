const db = require('./firebase-admin-config.js');

async function checkTrades() {
    try {
        const now = new Date();
        const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);

        // Query recent positions
        const query = db.collection('real_spot_positions')
            .where('created_at', '>=', tenMinutesAgo.toISOString());

        const snapshot = await query.get();

        console.log(`\n📊 Recent Trades (last 10 minutes) - Found ${snapshot.size} position(s):\n`);

        if (snapshot.empty) {
            console.log('❌ No recent positions found');
        } else {
            snapshot.forEach((doc) => {
                const data = doc.data();
                console.log(`✅ Position ID: ${doc.id}`);
                console.log(`   Symbol: ${data.symbol}`);
                console.log(`   Order ID: ${data.order_id}`);
                console.log(`   Entry Price: ${data.entry_price}`);
                console.log(`   Quantity: ${data.quantity}`);
                console.log(`   Capital: ${data.capital_usdt}`);
                console.log(`   Created: ${data.created_at}`);
                console.log(`   Status: ${data.status}`);
                console.log('');
            });
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkTrades();
