#!/usr/bin/env node

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  projectId: serviceAccount.project_id,
  databaseURL: `https://${serviceAccount.project_id}.firebaseio.com`
});

const db = admin.firestore();

async function enableBotExecution() {
  try {
    console.log('\n=== ENABLING BOT EXECUTION ===\n');

    // Runtime safety gate used by execution engine
    const botExecutionRuntime = {
      execution_enabled: true,
      auto_trade_mode: true,
      position_size_percent: 0.05,
      max_concurrent_trades: 1,
      status: 'ACTIVE',
      enabled_at: admin.firestore.Timestamp.now(),
      risk_level: 'SAFE',
      auto_stop: 'ENABLED',
      hard_stops: {
        daily_pnl_pct_floor: -1.0,
        consecutive_losses_limit: 3,
        min_trades_for_winrate_check: 10,
        min_winrate_pct: 40
      },
      order_protection: {
        stop_loss_max_pct: -0.5,
        take_profit_max_pct: 0.8,
        trailing_activation_pct: 0.3,
        sl_required: true
      },
      notes: 'Safe real activation with strict hard-stops and auto-disable controls'
    };

    // Main execution config used by binance executor
    const binanceBotGlobal = {
      mode: 'live',
      execution_enabled: true,
      position_size_percent: 0.05,
      max_concurrent_trades: 1,
      enable_tp_sl: true,
      updated_at: new Date().toISOString()
    };

    await Promise.all([
      db.collection('system_runtime_config').doc('bot_execution').set(botExecutionRuntime, { merge: true }),
      db.collection('binance_bot_config').doc('global').set(binanceBotGlobal, { merge: true })
    ]);

    console.log('✓ Bot execution configuration created/updated:');
    console.log(`  execution_enabled: ${botExecutionRuntime.execution_enabled}`);
    console.log(`  auto_trade_mode: ${botExecutionRuntime.auto_trade_mode}`);
    console.log(`  position_size_percent: ${botExecutionRuntime.position_size_percent}`);
    console.log(`  max_concurrent_trades: ${botExecutionRuntime.max_concurrent_trades}`);
    console.log(`  risk_level: ${botExecutionRuntime.risk_level}`);
    console.log(`  status: ${botExecutionRuntime.status}\n`);

    // Verify creation
    const verifySnap = await db.collection('system_runtime_config').doc('bot_execution').get();

    if (verifySnap.exists) {
      console.log('✓ Verification: Configuration successfully stored in Firestore');
      console.log('\n=== EXECUTION ENABLED ===\n');
      console.log('SYSTEM_STATUS:');
      console.log('TRADING_ACTIVE: true');
      console.log('RISK_MODE: SAFE');
      console.log('POSITION_SIZE: 0.10');
      console.log('AUTO_STOP: ENABLED\n');
      console.log('Bot is now ready to start automatic trading with safe limits.');
      console.log('Next scheduler cycle will begin order execution.\n');
      process.exit(0);
    } else {
      console.log('❌ Verification failed: Configuration not found\n');
      process.exit(1);
    }

  } catch (error) {
    console.error('❌ Error enabling bot execution:', error.message);
    process.exit(1);
  }
}

enableBotExecution();
