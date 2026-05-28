const { MongoClient } = require('mongodb');

async function run() {
    const uri = "mongodb://localhost:27017"; // Assuming local mongodb as no uri provided
    const client = new MongoClient(uri);

    try {
        await client.connect();
        const db = client.db('trading_db'); // Assuming trading_db, adjusting if common
        
        console.log("Connected to MongoDB");

        // 1. Close open positions
        const positionsColl = db.collection('real_spot_positions');
        const posResult = await positionsColl.updateMany(
            { status: { $in: ["OPEN", "REAL_OPEN"] } },
            { 
                $set: { 
                    status: "CLOSED",
                    closed_at: new Date(),
                    close_reason: "MANUAL_RESET_FOR_FRESH_CYCLE"
                } 
            }
        );

        // 2. Update config
        const configColl = db.collection('real_spot_config');
        const configResult = await configColl.updateOne(
            { control: { $exists: true } }, // Assuming the document has a 'control' field or is identified by it
            {
                $set: {
                    max_open_positions: 4,
                    new_entries_enabled: true,
                    updated_at: new Date()
                }
            }
        );
        
        // If the above didn't find it, try searching by just the fields or providing a default name
        if (configResult.matchedCount === 0) {
           await configColl.updateOne(
            {}, 
            {
                $set: {
                    max_open_positions: 4,
                    new_entries_enabled: true,
                    updated_at: new Date()
                }
            },
            { upsert: false }
           );
        }

        const updatedConfig = await configColl.findOne({});

        // 3. Report
        console.log("--- RESET REPORT ---");
        console.log(`Number of positions closed: ${posResult.modifiedCount}`);
        console.log(`New max_open_positions value: ${updatedConfig ? updatedConfig.max_open_positions : 'N/A'}`);
        console.log(`new_entries_enabled status: ${updatedConfig ? updatedConfig.new_entries_enabled : 'N/A'}`);
        console.log(`Config update timestamp: ${updatedConfig ? updatedConfig.updated_at : 'N/A'}`);

    } catch (err) {
        console.error("Error:", err);
    } finally {
        await client.close();
    }
}

run();
