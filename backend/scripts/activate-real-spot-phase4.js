#!/usr/bin/env node

/**
 * PHASE 4 ACTIVATION SCRIPT
 * Updates real_spot_config/control for minimal real Binance Spot trading
 * Max 10 USDT, 1 position, Spot only
 */

const admin = require('firebase-admin');
const path = require('path');
const fs = require('fs');

// Initialize Firebase
const serviceAccountPath = path.join(__dirname, '../serviceAccountKey.json');
if (!fs.existsSync(serviceAccountPath)) {
    console.error('❌ serviceAccountKey.json not found at', serviceAccountPath);
    process.exit(1);
}

const credential = admin.credential.cert(require(serviceAccountPath));
admin.initializeApp({ credential });
const db = admin.firestore();

async function activatePhase4() {
    try {
        console.log('📋 PHASE 4B — ACTIVACIÓN REAL MÍNIMA BINANCE SPOT');
        console.log('═'.repeat(70));

        const config = {
            enabled: true,
            kill_switch: false,
            mode: 'REAL_SPOT_CONTROLLED_V1',
            single_trade_session: true,
            max_entries_this_session: 1,
            entries_used_this_session: 0,
            disable_after_first_entry: true,
            disable_after_position_close: true,
            max_total_capital_usdt: 10,
            max_position_usdt: 10,
            max_open_positions: 1,
            allow_symbols_from_paper_scanner_only: true,
            allowed_categories: ['BREAKOUT', 'MOMENTUM', 'ACCUMULATION'],
            min_opportunity_score: 70,
            take_profit_1_pct: 5,
            take_profit_2_pct: 10,
            stop_loss_pct: -5,
            timeout_hours: 24,
            require_recent_scan: true,
            max_scan_age_minutes: 90,
            spot_only: true,
            futures_allowed: false,
            margin_allowed: false,
            leverage_allowed: false,
            withdrawals_allowed: false,
            safety_version: 'real_spot_first_live_10usdt_v1',
            notes: 'Primera activación real mínima. Máximo 10 USDT, 1 sola posición, Spot only.',
            activated_at: new Date().toISOString(),
            activated_by: 'phase4_activation_script'
        };

        const docRef = db.collection('real_spot_config').doc('control');

        console.log('\n✓ Configuration object created:');
        console.log(JSON.stringify(config, null, 2));

        console.log('\n⏳ Writing to Firestore: real_spot_config/control...');
        await docRef.set(config, { merge: false });

        console.log('✅ Configuration successfully written to Firestore!');

        // Verify write
        const written = await docRef.get();
        if (written.exists) {
            console.log('\n✓ Verification: Document exists');
            console.log('  enabled:', written.data().enabled);
            console.log('  kill_switch:', written.data().kill_switch);
            console.log('  max_total_capital_usdt:', written.data().max_total_capital_usdt);
            console.log('  max_open_positions:', written.data().max_open_positions);
        } else {
            console.error('❌ Verification failed: Document not found');
            process.exit(1);
        }

        console.log('\n' + '═'.repeat(70));
        console.log('✅ PHASE 4B — FIRESTORE CONFIGURATION COMPLETE');
        console.log('\nNext steps:');
        console.log('1. PASO 5 — Execute precheck preflight');
        console.log('   GET /api/diagnostico/spot-real-preflight');
        console.log('\n2. PASO 6 — Execute first real cycle');
        console.log('   POST /internal/cron/binance/spot-real-execution');
        console.log('   (Use x-cron-secret from Secret Manager)');
        console.log('\n⚠️  IMPORTANT:');
        console.log('  - Only execute ONCE');
        console.log('  - Max 10 USDT capital');
        console.log('  - Max 1 position');
        console.log('  - Spot only (no Futures, no Margin, no leverage)');
        console.log('═'.repeat(70));

        process.exit(0);
    } catch (error) {
        console.error('❌ Error writing to Firestore:', error.message);
        process.exit(1);
    }
}

activatePhase4();
