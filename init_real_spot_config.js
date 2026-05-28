const admin = require('firebase-admin');
const serviceAccount = require('./proypers2025-5b45437299b5.json');

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'proypers2025'
});

const db = admin.firestore();

async function initConfig() {
    try {
        const config = {
            enabled: false,
            kill_switch: true,
            mode: 'REAL_SPOT_CONTROLLED_V1',
            max_total_capital_usdt: 100,
            max_position_usdt: 15,
            max_open_positions: 2,
            take_profit_1_pct: 5,
            take_profit_2_pct: 10,
            stop_loss_pct: -5,
            timeout_hours: 24,
            require_paper_pattern_confirmed: true,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        await db.collection('real_spot_config').doc('control').set(config, { merge: true });
        console.log('✓ real_spot_config/control created successfully');
        process.exit(0);
    } catch (error) {
        console.error('✗ Failed to create config:', error.message);
        process.exit(1);
    }
}

initConfig();