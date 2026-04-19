/**
 * SETUP SCRIPT: Inicializa Firestore para el sistema de auto-calibración
 *
 * Uso:
 *   node scripts/setup-autocalibration.js
 *
 * Crea:
 * - system_runtime_config/trading_params_live
 * - system_runtime_config/symbol_params_live
 * - system_runtime_metrics/global_metrics_latest
 * - Colecciones vacías: symbol_runtime_metrics, autocalibration_history, autocalibration_logs
 */

const admin = require('firebase-admin');
const db = require('../firebase-admin-config');

const DEFAULT_GLOBAL_CONFIG = {
  confidence_min: 0.65,
  quantum_min: 0.60,
  timing_min: 0.55,
  rr_min: 1.20,
  min_expected_move_pct: 0.25,
  execution_score_min: 50,
  pause_execution: false,
  pause_until: null,
  autocalibration_enabled: true,
  updated_at: new Date(),
  updated_by: 'setup_script',
  _description: 'Global trading parameters - auto-calibrated by runtime engine'
};

const DEFAULT_SYMBOL_CONFIG = {
  // Template - will be populated with specific symbols as needed
};

const DEFAULT_GLOBAL_METRICS = {
  closed_trades_count: 0,
  wins: 0,
  losses: 0,
  winrate: 0,
  avg_pnl: 0,
  loss_rate: 0,
  avg_duration_minutes: 0,
  tp_hit_ratio: 0,
  sl_hit_ratio: 0,
  sample_window_size: 10,
  updated_at: new Date(),
  _description: 'Global trade metrics - calculated from closed trades'
};

async function setupAutocalibration() {
  try {
    console.log('🤖 Setting up autocalibration system...');

    // 1. Create trading_params_live
    console.log('📝 Creating trading_params_live...');
    await db.collection('system_runtime_config').doc('trading_params_live').set(DEFAULT_GLOBAL_CONFIG, {
      merge: true
    });
    console.log('✅ trading_params_live created');

    // 2. Create symbol_params_live
    console.log('📝 Creating symbol_params_live...');
    await db.collection('system_runtime_config').doc('symbol_params_live').set(DEFAULT_SYMBOL_CONFIG, {
      merge: true
    });
    console.log('✅ symbol_params_live created');

    // 3. Create global_metrics_latest
    console.log('📝 Creating global_metrics_latest...');
    await db.collection('system_runtime_metrics').doc('global_metrics_latest').set(DEFAULT_GLOBAL_METRICS, {
      merge: true
    });
    console.log('✅ global_metrics_latest created');

    // 4. Create empty collections (just reference them)
    console.log('📝 Creating empty collections...');
    // These will be created automatically on first write, but we document them:
    const emptyCollections = [
      'symbol_runtime_metrics',
      'autocalibration_history',
      'autocalibration_logs'
    ];
    emptyCollections.forEach(col => {
      console.log(`  - ${col} (will be created on first write)`);
    });

    console.log('\n✅ Autocalibration system initialized successfully!');
    console.log('\n📊 Next steps:');
    console.log('  1. Deploy the updated backend code');
    console.log('  2. Monitor /api/system/runtime-calibration-health for status');
    console.log('  3. View calibration history at /api/system/calibration-history');
    console.log('  4. Adjust parameters manually via /api/system/runtime-config/update-global');

    process.exit(0);
  } catch (err) {
    console.error('❌ Setup failed:', err);
    process.exit(1);
  }
}

setupAutocalibration();
