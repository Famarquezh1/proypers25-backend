const db = require('./firebase-admin-config.js');

async function forceUpdate() {
    try {
        const docRef = db.collection('real_spot_config').doc('control');
        const doc = await docRef.get();

        if (!doc.exists) {
            console.log('Document real_spot_config/control does not exist.');
            process.exit(1);
        }

        const updates = {
            enabled: true,
            kill_switch: false,
            new_entries_enabled: true,
            newEntriesDisabled: false,
            new_entries_disabled: false,
            ORDER_PLACEMENT_ENABLED: true,
            entries_used_this_session: 0,
            updated_at: new Date().toISOString()
        };

        console.log('Forcing updates to enable everything...');
        await docRef.update(updates);
        
        const newDoc = await docRef.get();
        console.log('New configuration:', JSON.stringify(newDoc.data(), null, 2));

        process.exit(0);
    } catch (error) {
        console.error('Error updating config:', error);
        process.exit(1);
    }
}

forceUpdate();
