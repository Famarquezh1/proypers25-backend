const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   DIAGNÓSTICO FINAL ANTES DE MONITORING                    ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  // 1. Capital
  const bal = await db.collection('real_spot_config').doc('balance').get();
  const balance = bal.data() || {};
  console.log('💰 CAPITAL:');
  console.log(`   Total:           ${balance.total_usdt}`);
  console.log(`   Disponible:      ${balance.available_usdt}`);
  console.log(`   En posiciones:   ${balance.in_positions_usdt}`);
  console.log(`   Holdings:        ${balance.holdings_usdt}`);
  console.log(`   Suma (check):    ${(balance.available_usdt + balance.in_positions_usdt + (balance.holdings_usdt || 0))}`);
  
  // 2. Config
  const cfg = await db.collection('real_spot_config').doc('control').get();
  const config = cfg.data() || {};
  console.log('\n⚙️  CONFIGURACIÓN:');
  console.log(`   new_entries_enabled:        ${config.new_entries_enabled}`);
  console.log(`   disable_after_first_entry:  ${config.disable_after_first_entry}`);
  console.log(`   auto_order_execution:       ${config.auto_order_execution}`);
  console.log(`   entries_used_this_session:  ${config.entries_used_this_session}`);
  
  // 3. Posiciones
  const open = await db.collection('real_spot_positions').where('status','==','REAL_OPEN').get();
  console.log(`\n📈 POSICIONES ABIERTAS: ${open.size}`);
  for (const doc of open.docs) {
    const p = doc.data();
    console.log(`   ${p.symbol}:`);
    console.log(`      Entry: ${p.entry_price}, Qty: ${p.quantity}, Capital: ${p.capital_usdt}$`);
    console.log(`      TP1: ${p.tp1_price}, TP2: ${p.tp2_price}, SL: ${p.sl_price}`);
    console.log(`      Timeout: ${new Date(p.timeout_at).toLocaleString('es-ES')}`);
  }
  
  // 4. Estadísticas
  const closed = await db.collection('real_spot_positions').where('status','==','REAL_CLOSED').get();
  console.log(`\n📋 POSICIONES CERRADAS: ${closed.size}`);
  
  let totalPnL = 0;
  let wins = 0;
  let losses = 0;
  
  for (const doc of closed.docs) {
    const pnl = doc.data().pnl_usdt || 0;
    totalPnL += pnl;
    if (pnl > 0) wins++;
    if (pnl < 0) losses++;
  }
  
  console.log(`   Total PnL: ${totalPnL > 0 ? '✅' : '❌'} ${totalPnL.toFixed(4)} USDT`);
  console.log(`   Wins: ${wins}, Losses: ${losses}`);
  
  console.log('\n✨ SISTEMA LISTO PARA MONITOREO EN VIVO');
  console.log('   Inicializando monitor cada 5 segundos...\n');
  
  process.exit(0);
})();
