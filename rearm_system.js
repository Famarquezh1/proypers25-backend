const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase from backend directory context
const projectRoot = path.join(__dirname, 'backend');
process.chdir(projectRoot);

const initializeApp = require('./firebase-admin-config');
const db = initializeApp;

(async () => {
  console.log('=== REARMING SYSTEM WITH CONTROLLED LIMITS ===');
  console.log('New configuration:');
  console.log('  - enabled: true');
  console.log('  - kill_switch: false');
  console.log('  - new_entries_enabled: true');
  console.log('  - auto_order_execution: true');
  console.log('  - max_position_usdt: 15');
  console.log('  - max_total_capital_usdt: 40');
  console.log('  - max_open_positions: 2');
  console.log('');

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
      notes: 'Reactivated with controlled position sizing: 15 USDT per position, 40 USDT total capital, 2 open positions max'
    });

    console.log('✓ Configuration updated successfully');
    console.log('✓ System ARMED and ready for live trading');
    
    // Verify the update
    const snap = await db.collection('real_spot_config').doc('control').get();
    const data = snap.data();
    console.log('\nVerification:');
    console.log('  enabled:', data.enabled);
    console.log('  kill_switch:', data.kill_switch);
    console.log('  new_entries_enabled:', data.new_entries_enabled);
    console.log('  auto_order_execution:', data.auto_order_execution);
    console.log('  max_position_usdt:', data.max_position_usdt);
    console.log('  max_total_capital_usdt:', data.max_total_capital_usdt);
    console.log('  max_open_positions:', data.max_open_positions);

    process.exit(0);
  } catch (error) {
    console.error('✗ Error updating configuration:', error.message);
    process.exit(1);
  }
})();
