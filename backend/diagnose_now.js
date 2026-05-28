const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

async function diagnose() {
  try {
    console.log('\n====== DIAGNOSTICO SISTEMA - 27 MAYO 2026 ======\n');

    // 1. Posiciones REAL_OPEN
    console.log('1. POSICIONES ABIERTAS (REAL_OPEN):');
    const open = await db.collection('real_spot_positions')
      .where('status', '==', 'REAL_OPEN')
      .get();
    
    console.log(`   Total: ${open.size}`);
    let totalCapitalOpen = 0;
    open.forEach(doc => {
      const d = doc.data();
      console.log(`   - ${d.symbol}: ${d.capital_usdt || 'N/A'} USDT @ ${d.entry_price}`);
      totalCapitalOpen += (d.capital_usdt || 0);
    });

    // 2. Posiciones REAL_CLOSED (últimas 5)
    console.log('\n2. POSICIONES CERRADAS (últimas 5):');
    const closed = await db.collection('real_spot_positions')
      .where('status', '==', 'REAL_CLOSED')
      .orderBy('closed_at', 'desc')
      .limit(5)
      .get();
    
    let totalPnL = 0;
    closed.forEach(doc => {
      const d = doc.data();
      const pnl = d.pnl_usdt || 0;
      console.log(`   - ${d.symbol}: PnL ${pnl > 0 ? '+' : ''}${pnl} USDT`);
      totalPnL += pnl;
    });
    console.log(`   Total PnL: ${totalPnL > 0 ? '+' : ''}${totalPnL} USDT`);

    // 3. Configuración
    console.log('\n3. CONFIGURACION:');
    const config = await db.collection('real_spot_config').doc('control').get();
    const cfg = config.data();
    console.log(`   Capital total: ${cfg.total_capital} USDT`);
    console.log(`   Operativo: ${cfg.capital_usdt_operational} USDT`);
    console.log(`   En riesgo: ${totalCapitalOpen} USDT`);
    console.log(`   Disponible: ${cfg.capital_usdt_operational - totalCapitalOpen} USDT`);
    console.log(`   new_entries_enabled: ${cfg.new_entries_enabled}`);
    console.log(`   Holdings CATI: ${cfg.emerging_holdings?.CATI?.quantity || 0} tokens`);
    console.log(`   CATI value: ${cfg.emerging_holdings?.CATI?.value_usdt || 0} USDT`);

    console.log('\n====== FIN DIAGNOSTICO ======\n');
    process.exit(0);
  } catch (err) {
    console.error('ERROR:', err.message);
    process.exit(1);
  }
}

diagnose();
