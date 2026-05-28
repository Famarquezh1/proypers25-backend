const db = require('./backend/firebase-admin-config');

(async () => {
  try {
    console.log('📊 ACTUALIZANDO TARGETS...\n');
    
    await db.collection('real_spot_config').doc('control').update({
      stop_loss_pct: 3,
      take_profit_1_pct: 3,
      take_profit_2_pct: 6,
      updated_at: new Date().toISOString(),
      note: 'ADJUSTED: SL -3%, TP1 +3%, TP2 +6% for faster consistent closes'
    });
    
    console.log('✅ CONFIGURACIÓN ACTUALIZADA:');
    console.log('  • Stop Loss: -5% → -3%');
    console.log('  • Take Profit 1: +5% → +3%');
    console.log('  • Take Profit 2: +10% → +6%');
    console.log('');
    console.log('🎯 BENEFICIOS:');
    console.log('  ✓ Cierres más rápidos (no espera 24h)');
    console.log('  ✓ Ganancias consistentes cada 2-8 horas');
    console.log('  ✓ Menos capital congelado');
    console.log('  ✓ Sistema más ágil\n');
    
    process.exit(0);
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
