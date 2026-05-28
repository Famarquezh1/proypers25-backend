const db = require('./firebase-admin-config.js');

async function fixConfig() {
    try {
        const docRef = db.collection('real_spot_config').doc('control');

        const updates = {
            new_entries_enabled: true,
            entries_used_this_session: 0,
            single_trade_session: false,
            max_entries_this_session: 20,
            disable_after_first_entry: false,
            updated_at: new Date().toISOString()
        };

        console.log('🔄 Updating configuration to allow multiple trades...');
        await docRef.update(updates);

        const newDoc = await docRef.get();
        console.log('\n✅ Configuration updated!');
        console.log('\nKey changes:');
        console.log('  - new_entries_enabled:', newDoc.data().new_entries_enabled);
        console.log('  - entries_used_this_session:', newDoc.data().entries_used_this_session);
        console.log('  - max_entries_this_session:', newDoc.data().max_entries_this_session);
        console.log('  - single_trade_session:', newDoc.data().single_trade_session);

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

fixConfig();
