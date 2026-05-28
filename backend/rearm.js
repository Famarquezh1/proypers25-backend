const db = require('./firebase-admin-config');

(async () => {
  console.log('=== REARMING SYSTEM ===');
  try {
    await db.collection('real_spot_config').doc('control').update({
      enabled: true,
      kill_switch: false,
      new_entries_enabled: true,
      auto_order_execution: true,
      max_position_usdt: 15,
      max_total_capital_usdt: 40,
      max_open_positions: 2,
      updated_at: new Date().toISOString(),
      notes: 'Reactivated with controlled position sizing'
    });
    console.log('✓ System REARMED');
    process.exit(0);
  } catch (e) {
    console.error('✗ Error:', e.message);
    process.exit(1);
  }
})();
