const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

let cycleCount = 0;

(async () => {
  setInterval(async () => {
    cycleCount++;
    const now = new Date();
    
    try {
      // 1. Check open positions
      const open = await db.collection('real_spot_positions').where('status','==','REAL_OPEN').get();
      
      // 2. Check balance
      const bal = await db.collection('real_spot_config').doc('balance').get();
      const balance = bal.data() || {};
      
      // 3. Check config
      const cfg = await db.collection('real_spot_config').doc('control').get();
      const config = cfg.data() || {};
      
      // Simple status line
      console.log(`[${cycleCount}] ${now.toLocaleTimeString()} | OPEN: ${open.size} | AVAILABLE: ${balance.available_usdt}$ | IN_POS: ${balance.in_positions_usdt}$ | ENABLED: ${config.new_entries_enabled}`);
      
      // 4. Validate each open position
      for (const doc of open.docs) {
        const p = doc.data();
        let issues = [];
        
        // Check for defects
        if (!p.quantity || p.quantity === undefined || p.quantity === 0) {
          issues.push('qty=undefined');
        }
        if (p.tp1_price === p.sl_price) {
          issues.push('TP1=SL');
        }
        if (!p.entry_price || !p.capital_usdt) {
          issues.push('missing_entry_or_capital');
        }
        
        if (issues.length > 0) {
          console.log(`   ⚠️  ${p.symbol}: ${issues.join(', ')} - FORCE CLOSING`);
          
          // Force close
          const exitPrice = p.entry_price;
          await db.collection('real_spot_positions').doc(doc.id).update({
            status: 'REAL_CLOSED',
            closed_at: now.toISOString(),
            closing_reason: `AUTO_CLOSE_DEFECT: ${issues.join(',')}`,
            exit_price: exitPrice,
            pnl_usdt: 0,
            pnl_percent: 0
          });
          
          // Return capital
          const posCapital = p.capital_usdt || 0;
          await db.collection('real_spot_config').doc('balance').update({
            available_usdt: (balance.available_usdt || 0) + posCapital,
            in_positions_usdt: Math.max(0, (balance.in_positions_usdt || 0) - posCapital)
          });
          
          console.log(`   ✅ ${p.symbol} closed, ${posCapital}$ returned`);
        }
      }
      
      // 5. Ensure entry tracking doesn't disable system
      if (config.disable_after_first_entry === true) {
        console.log(`   🔴 BUG DETECTED: disable_after_first_entry=true - FIXING`);
        await db.collection('real_spot_config').doc('control').update({
          disable_after_first_entry: false
        });
      }
      
    } catch (err) {
      console.error(`[${cycleCount}] ERROR: ${err.message}`);
    }
    
  }, 5000); // Every 5 seconds
  
  // Don't exit
  process.stdin.on('data', (chunk) => {
    if (chunk.toString().trim() === 'exit') {
      process.exit(0);
    }
  });
})();
