const db = require('./firebase-admin-config.js');

async function updateConfig() {
    try {
        const docRef = db.collection('real_spot_config').doc('control');
        const doc = await docRef.get();

        if (!doc.exists) {
            console.log('Document real_spot_config/control does not exist.');
            process.exit(1);
        }

        const data = doc.data();
        console.log('Current configuration:', JSON.stringify(data, null, 2));

        let updated = false;
        const updates = {};

        // Check for flags that might prevent new orders
        if (data.enabled === false) {
            updates.enabled = true;
            updated = true;
            console.log('Flag "enabled" is false. Updating to true.');
        }

        if (data.kill_switch === true) {
            updates.kill_switch = false;
            updated = true;
            console.log('Flag "kill_switch" is true. Updating to false.');
        }

        if (data.newEntriesDisabled === true) {
            updates.newEntriesDisabled = false;
            updated = true;
            console.log('Flag "newEntriesDisabled" is true. Updating to false.');
        }

        if (data.new_entries_disabled === true) {
            updates.new_entries_disabled = false;
            updated = true;
            console.log('Flag "new_entries_disabled" is true. Updating to false.');
        }

        if (data.ORDER_PLACEMENT_ENABLED === false) {
            updates.ORDER_PLACEMENT_ENABLED = true;
            updated = true;
            console.log('Flag "ORDER_PLACEMENT_ENABLED" is false. Updating to true.');
        }

        if (updated) {
            updates.updated_at = new Date().toISOString();
            await docRef.update(updates);
            console.log('Configuration updated successfully.');
            
            const newDoc = await docRef.get();
            console.log('New configuration:', JSON.stringify(newDoc.data(), null, 2));
        } else {
            console.log('No blocking flags found. Configuration is already enabled.');
        }

        process.exit(0);
    } catch (error) {
        console.error('Error updating config:', error);
        process.exit(1);
    }
}

updateConfig();
