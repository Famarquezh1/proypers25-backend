const db = require('./backend/firebase-admin-config');

(async () => {
  try {
    const trades = await db.collection('spot_trades_real').orderBy('executed_at', 'desc').limit(10).get();
    
    console.log('═══════════════════════════════════════════════════');
    console.log('ÚLTIMOS 10 TRADES REALES');
    console.log('═══════════════════════════════════════════════════\n');
    
    let count = 0;
    trades.forEach(doc => {
      const t = doc.data();
      count++;
      console.log(`${count}. ${t.symbol} - ${t.side} @ ${t.price} USDT`);
      console.log(`   Qty: ${t.quantity} | Status: ${t.status}`);
      if(t.net_pnl_usdt !== undefined) {
        console.log(`   PnL: ${t.net_pnl_usdt} USDT (${t.pnl_pct}%)`);
      }
      console.log(`   Time: ${t.executed_at}\n`);
    });
    
    if(count === 0) {
      console.log('❌ NO TRADES REGISTRADOS');
    }
    
    process.exit(0);
  } catch(e) {
    console.error('Error:', e.message);
    process.exit(1);
  }
})();
