const db = require('./firebase-admin-config.js');

async function checkSpecific() {
    try {
        // Try to get the specific position from the log
        const docId = 'real_spot_pos_1778704833692_ANKRUSDT';
        const doc = await db.collection('real_spot_positions').doc(docId).get();

        if (doc.exists) {
            const data = doc.data();
            console.log(`✅ Position found: ${docId}`);
            console.log(JSON.stringify(data, null, 2));
        } else {
            console.log(`❌ Position NOT found: ${docId}`);

            // List all documents in the collection
            const allDocs = await db.collection('real_spot_positions').get();
            console.log(`\nTotal documents in real_spot_positions: ${allDocs.size}`);

            if (allDocs.size > 0) {
                console.log('\nAll position IDs:');
                allDocs.forEach(d => {
                    console.log(`  - ${d.id}`);
                });
            }
        }

        process.exit(0);
    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

checkSpecific();
