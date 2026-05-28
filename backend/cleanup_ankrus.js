const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log('\n=== CERRAR ANKRUSDT DEFECTUOSA ===\n');
  
  // Cerrar la posición defectuosa
  const now = new Date();
  await db.collection('real_spot_positions').doc('real_spot_pos_1779939033232_ANKRUSDT').update({
    status: 'REAL_CLOSED',
    exit_price: 0.00446,
    closed_at: now.toISOString(),
    closing_reason: 'FORCE_CLOSE_QUANTITY_UNDEFINED',
    pnl_usdt: 0,
    pnl_percent: 0
  });
  
  // Restaurar balance
  await db.collection('real_spot_config').doc('balance').update({
    available_usdt: 400,
    in_positions_usdt: 0,
    holdings_usdt: 161.47,
    total_usdt: 561.47
  });
  
  // Reset control
  await db.collection('real_spot_config').doc('control').update({
    new_entries_enabled: true,
    disable_after_first_entry: false,
    entries_used_this_session: 0
  });
  
  console.log('✅ ANKRUSDT cerrada');
  console.log('✅ Balance restaurado');
  console.log('✅ Config reseteada');
  
  process.exit(0);
})();
