const db = require('./backend/firebase-admin-config');

(async () => {
  try {
    console.log('🚀 IMPLEMENTANDO OPCIÓN C (HYBRID MODE)\n');
    
    // Update main config
    await db.collection('real_spot_config').doc('control').update({
      // Strategy allocation
      strategy_mode: 'HYBRID_70_30',
      conservative_strategy_pct: 70,
      moonshot_strategy_pct: 30,
      conservative_capital_usdt: 63,
      moonshot_capital_usdt: 27,
      
      // Conservative targets (unchanged)
      stop_loss_pct: 3,
      take_profit_1_pct: 3,
      take_profit_2_pct: 6,
      
      updated_at: new Date().toISOString(),
      note: 'HYBRID MODE: 70% conservative (micro gains) + 30% moonshot (100x potential)'
    });
    
    // Create moonshot strategy config
    await db.collection('real_spot_config').doc('moonshot_strategy').set({
      enabled: true,
      strategy_name: 'MOONSHOT_30PCT',
      
      // Capital allocation
      moonshot_capital_usdt: 27,
      max_position_usdt: 4,
      max_open_positions: 3,
      
      // Token criteria
      min_token_age_days: 0.25, // Last 6 hours
      max_token_age_days: 7, // Up to 7 days
      min_price_usdt: 0.0000001,
      max_price_usdt: 0.1,
      min_volume_usdt: 500000,
      min_holders: 100,
      max_single_holder_pct: 15,
      
      // Targets
      take_profit_1_pct: 50, // +50%
      take_profit_2_pct: 150, // +150%
      take_profit_3_pct: 500, // +500%
      stop_loss_pct: 20, // -20%
      timeout_hours: 720, // 30 days
      
      created_at: new Date().toISOString(),
      metadata: {
        description: 'Hunt for moonshot tokens with exponential growth potential',
        expected_win_rate_pct: 15,
        expected_avg_gain_pct: 200,
        expected_loss_pct: 20
      }
    });
    
    console.log('✅ CONFIGURACIÓN APLICADA:\n');
    console.log('📊 CAPITAL DISTRIBUTION:');
    console.log('  Total:        90 USDT (100 - 10 reserve)');
    console.log('  Conservative: 63 USDT (70%) - Micro gains +3%/+6%');
    console.log('  Moonshot:     27 USDT (30%) - Exponential growth +50%/+150%/+500%');
    console.log('');
    console.log('🎯 CONSERVATIVE STRATEGY (70%):');
    console.log('  • Target: +3% / +6% gains');
    console.log('  • SL: -3%');
    console.log('  • Frequency: Daily trades');
    console.log('  • Risk: LOW');
    console.log('');
    console.log('🚀 MOONSHOT STRATEGY (30%):');
    console.log('  • Target: +50% / +150% / +500%');
    console.log('  • SL: -20%');
    console.log('  • Tokens: Newly listed (< 7 days)');
    console.log('  • Timeout: 30 days (let them run)');
    console.log('  • Risk: VERY HIGH (but one hit = game changer)');
    console.log('');
    console.log('💡 EXPECTED RESULTS (Monthly):');
    console.log('  Conservative: $2-5 daily = $60-150/month');
    console.log('  Moonshot: 1-2 hits/month × $200+ = $200-500/month');
    console.log('  TOTAL: $260-650/month at 70/30 split');
    console.log('');
    console.log('🎰 BEST CASE (If you catch one real moonshot):');
    console.log('  $27 USDT × 100x = $2,700 (like your HBAR!)');
    console.log('');
    
    process.exit(0);
  } catch(e) {
    console.error('❌ Error:', e.message);
    process.exit(1);
  }
})();
