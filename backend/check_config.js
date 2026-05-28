const db = require('./firebase-admin-config.js');

async function checkConfig() {
    try {
        const doc = await db.collection('real_spot_config').doc('control').get();
        if (!doc.exists) {
            console.log('❌ Document does not exist');
            process.exit(1);
        }
        const data = doc.data();
        console.log('📋 Current configuration:');
        console.log(JSON.stringify(data, null, 2));
        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkConfig();
