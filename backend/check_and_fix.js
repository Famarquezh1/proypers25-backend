const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log('\n=== DIAGNÓSTICO Y CORRECCIÓN ===\n');
  
  // 1. Ver posición abierta
  const open = await db.collection('real_spot_positions').where('status','==','REAL_OPEN').get();
  console.log('📊 POSICIONES ABIERTAS:', open.size);
  for (const doc of open.docs) {
    const p = doc.data();
    console.log('   ID:', doc.id);
    console.log('   Symbol:', p.symbol);
    console.log('   Entrada:', p.entry_price);
    console.log('   TP1:', p.tp1_price, 'TP2:', p.tp2_price, 'SL:', p.sl_price);
  }
  
  // 2. Configuración
  const cfg = await db.collection('real_spot_config').doc('control').get();
  const c = cfg.data() || {};
  console.log('\n⚙️ CONFIG ACTUAL:');
  console.log('   new_entries_enabled:', c.new_entries_enabled);
  console.log('   disable_after_first_entry:', c.disable_after_first_entry);
  console.log('   entries_used_this_session:', c.entries_used_this_session);
  
  // 3. CORREGIR: Forzar config correcta
  console.log('\n🔧 CORRIGIENDO...');
  await db.collection('real_spot_config').doc('control').update({
    new_entries_enabled: true,
    disable_after_first_entry: false,
    entries_used_this_session: 1
  });
  
  console.log('\n✅ CORREGIDO:');
  console.log('   new_entries_enabled: true');
  console.log('   disable_after_first_entry: false');
  console.log('\n📌 ACCIÓN NECESARIA:');
  console.log('   - Sistema abrió 1 posición ANKRUSDT');
  console.log('   - Debe permitir apertura de más posiciones');
  console.log('   - Próximo ciclo Cloud Scheduler puede abrir más');
  
  process.exit(0);
})();
