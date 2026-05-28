const admin = require('firebase-admin');
const axios = require('axios');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();

(async () => {
  console.log('\n╔════════════════════════════════════════════════════════════╗');
  console.log('║   AUDITORÍA COMPLETA DE FONDOS - SPOT TRADING              ║');
  console.log('╚════════════════════════════════════════════════════════════╝\n');
  
  // 1. Balance registrado en Firestore
  console.log('📊 BALANCE REGISTRADO EN FIRESTORE:');
  const bal = await db.collection('real_spot_config').doc('balance').get();
  const balance = bal.data() || {};
  console.log(`   available_usdt:     ${balance.available_usdt} USDT`);
  console.log(`   in_positions_usdt:  ${balance.in_positions_usdt} USDT`);
  console.log(`   holdings_usdt:      ${balance.holdings_usdt || 0} USDT`);
  console.log(`   total_usdt:         ${balance.total_usdt} USDT`);
  
  // 2. Holdings específicos
  console.log('\n💰 HOLDINGS REGISTRADOS:');
  const holdings = await db.collection('real_spot_config').doc('holdings').get();
  const h = holdings.data() || {};
  console.log(JSON.stringify(h, null, 2));
  
  // 3. Posiciones abiertas
  console.log('\n📈 POSICIONES ABIERTAS (REAL_OPEN):');
  const open = await db.collection('real_spot_positions').where('status','==','REAL_OPEN').get();
  console.log(`   Total: ${open.size} posiciones`);
  let capitalEnPosiciones = 0;
  for (const doc of open.docs) {
    const p = doc.data();
    const inverso = p.entry_price * (p.quantity || 0);
    capitalEnPosiciones += inverso;
    console.log(`   • ${p.symbol}: ${p.quantity || 0} @ ${p.entry_price} = ${inverso.toFixed(4)} USDT`);
  }
  console.log(`   TOTAL EN POSICIONES: ${capitalEnPosiciones.toFixed(2)} USDT`);
  
  // 4. Últimas 5 posiciones cerradas
  console.log('\n📋 ÚLTIMAS 5 POSICIONES CERRADAS:');
  const closed = await db.collection('real_spot_positions')
    .where('status','==','REAL_CLOSED')
    .orderBy('closed_at','desc')
    .limit(5)
    .get();
  
  let totalPnL = 0;
  for (const doc of closed.docs) {
    const p = doc.data();
    const pnl = p.pnl_usdt || 0;
    totalPnL += pnl;
    const entrada = new Date(p.opened_at).toLocaleString('es-ES');
    const salida = new Date(p.closed_at).toLocaleString('es-ES');
    console.log(`   ${p.symbol}:`);
    console.log(`      Entrada: ${entrada}`);
    console.log(`      Salida:  ${salida}`);
    console.log(`      PnL:     ${pnl > 0 ? '✅' : pnl < 0 ? '❌' : '⚫'} ${pnl.toFixed(4)} USDT`);
    console.log(`      Razón:   ${p.closing_reason}`);
  }
  console.log(`   TOTAL PnL HISTÓRICO: ${totalPnL > 0 ? '✅' : '❌'} ${totalPnL.toFixed(4)} USDT`);
  
  // 5. Resumen matemático
  console.log('\n🧮 VERIFICACIÓN MATEMÁTICA:');
  const esperado = balance.available_usdt + balance.in_positions_usdt + (balance.holdings_usdt || 0);
  console.log(`   available:  ${(balance.available_usdt || 0).toFixed(2)}`);
  console.log(`   in_pos:     ${(balance.in_positions_usdt || 0).toFixed(2)}`);
  console.log(`   holdings:   ${(balance.holdings_usdt || 0).toFixed(2)}`);
  console.log(`   ───────────────────`);
  console.log(`   SUMA:       ${esperado.toFixed(2)} USDT`);
  console.log(`   REGISTRADO: ${(balance.total_usdt || 0).toFixed(2)} USDT`);
  console.log(`   DIFERENCIA: ${(esperado - (balance.total_usdt || 0)).toFixed(2)} USDT`);
  
  if (Math.abs(esperado - (balance.total_usdt || 0)) > 0.01) {
    console.log('   ⚠️  ALERTA: Desbalance detectado');
  } else {
    console.log('   ✅ Balances consistentes');
  }
  
  // 6. Capital utilizado vs disponible
  console.log('\n💵 ESTADO DEL CAPITAL:');
  const totalInvertido = capitalEnPosiciones + (balance.holdings_usdt || 0);
  const totalDisponible = 561.47;
  const porcentajeUso = (totalInvertido / totalDisponible * 100).toFixed(1);
  console.log(`   Total capital:       561.47 USDT (inicial)`);
  console.log(`   Capital invertido:   ${totalInvertido.toFixed(2)} USDT`);
  console.log(`   Capital disponible:  ${(balance.available_usdt || 0).toFixed(2)} USDT`);
  console.log(`   % de uso:            ${porcentajeUso}%`);
  
  process.exit(0);
})();
