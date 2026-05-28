const db = require('./firebase-admin-config.js');

async function forceUpdate() {
    try {
        const docRef = db.collection('real_spot_config').doc('control');

        // Force overwrite with explicit true values
        const updates = {
            new_entries_enabled: true,
            entries_used_this_session: 0,
            disable_after_first_entry: false,
            updated_at: new Date().toISOString()
        };

        console.log('🔥 FORCE updating config...');
        await docRef.set(updates, { merge: true });

        const newDoc = await docRef.get();
        const data = newDoc.data();
        console.log('\n✅ Updated! Current state:');
        console.log('  new_entries_enabled:', data.new_entries_enabled, '(type:', typeof data.new_entries_enabled + ')');
        console.log('  entries_used_this_session:', data.entries_used_this_session);
        console.log('  disable_after_first_entry:', data.disable_after_first_entry);

        // Verify it was set correctly
        if (data.new_entries_enabled === true) {
            console.log('\n✅✅ Config is READY for trading!');
        } else {
            console.log('\n⚠️  WARNING: new_entries_enabled is not true, it is:', data.new_entries_enabled);
        }

        process.exit(0);
    } catch (error) {
        console.error('❌ Error:', error.message);
        process.exit(1);
    }
}

forceUpdate();
