const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log('\n=== CERRAR POSICIONES DEFECTUOSAS Y RESET ===\n');
  
  // 1. Identificar posiciones con TP1 = SL (DEFECTIVAS)
  const now = new Date();
  const defects = [
    'real_spot_pos_1779939033232_ANKRUSDT',
    'real_spot_pos_1779939334529_CATIUSDT'
  ];
  
  console.log('🔴 CERRANDO POSICIONES DEFECTIVAS:');
  for (const posId of defects) {
    const docRef = db.collection('real_spot_positions').doc(posId);
    const doc = await docRef.get();
    
    if (doc.exists) {
      const p = doc.data();
      console.log(`\n   • ${p.symbol}:`);
      console.log(`     TP1: ${p.tp1_price}, SL: ${p.sl_price} ← MISMO PRECIO (DEFECTO)`);
      
      // Cerrar a precio de entrada (sin pérdida, sin ganancia)
      await docRef.update({
        status: 'REAL_CLOSED',
        exit_price: p.entry_price,
        closed_at: now.toISOString(),
        closing_reason: 'FORCE_CLOSE_DEFECTIVE_TP1_SL_MISMATCH',
        pnl_usdt: 0,
        pnl_percent: 0
      });
      
      console.log(`     ✅ Cerrada a precio entrada (PnL = 0)`);
    }
  }
  
  // 2. Reajustar balance
  console.log('\n💰 RESTAURANDO BALANCE:');
  await db.collection('real_spot_config').doc('balance').update({
    available_usdt: 400,
    in_positions_usdt: 0,
    total_usdt: 561.47
  });
  console.log('   ✅ available_usdt: 400');
  console.log('   ✅ in_positions_usdt: 0');
  
  // 3. Reset control flags para nueva sesión
  console.log('\n⚙️ RESET CONTROL FLAGS:');
  await db.collection('real_spot_config').doc('control').update({
    new_entries_enabled: true,
    disable_after_first_entry: false,
    entries_used_this_session: 0,  // RESET para nueva sesión
    strategy_mode: 'OPTIMIZED_GROWTH'
  });
  console.log('   ✅ new_entries_enabled: true');
  console.log('   ✅ disable_after_first_entry: false');
  console.log('   ✅ entries_used_this_session: 0 (RESET)');
  
  console.log('\n✨ SISTEMA LISTO PARA NUEVA SESIÓN DE TRADING');
  console.log('\n📌 PRÓXIMO PASO:');
  console.log('   Cloud Scheduler ejecutará próximo ciclo en ~5 min');
  console.log('   Sistema abrirá nuevas posiciones correctamente');
  
  process.exit(0);
})();
