#!/usr/bin/env node

/**
 * SUPPLEMENTAL AUDIT: Check for Firestore error logs
 * Look for any recorded failures that explain why Lote 3 didn't close
 */

const admin = require('firebase-admin');
const path = require('path');

const serviceAccountPath = path.join(__dirname, '..', 'proypers2025-5b45437299b5.json');
const serviceAccount = require(serviceAccountPath);

admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    projectId: 'proypers2025'
});

const db = admin.firestore();

async function checkForErrors() {
    console.log('\n' + '═'.repeat(80));
    console.log('SUPPLEMENTAL AUDIT: Looking for error records and logs');
    console.log('═'.repeat(80) + '\n');

    try {
        // Check multiple potential error collections
        const errorCollections = [
            'spot_paper_execution_errors',
            'cron_execution_errors',
            'execution_logs',
            'error_logs',
            'system_errors'
        ];

        for (const collection of errorCollections) {
            console.log(`Checking collection: ${collection}`);
            try {
                const snapshot = await db.collection(collection)
                    .orderBy('timestamp', 'desc')
                    .limit(20)
                    .get();

                if (snapshot.empty) {
                    console.log(`  → No documents found\n`);
                    continue;
                }

                console.log(`  → Found ${snapshot.size} documents:\n`);
                for (const doc of snapshot.docs) {
                    const data = doc.data();
                    console.log(`  Document: ${doc.id}`);
                    console.log(`    Timestamp: ${data.timestamp || 'N/A'}`);
                    console.log(`    Error Type: ${data.error_type || data.type || 'N/A'}`);
                    console.log(`    Message: ${data.message || data.error || 'N/A'}`);
                    if (data.stack) {
                        console.log(`    Stack: ${data.stack.substring(0, 200)}...`);
                    }
                    console.log('');
                }
            } catch (err) {
                // Collection doesn't exist or query error
                console.log(`  → Query error: ${err.message}\n`);
            }
        }

        // Check for recent intents with issues
        console.log('\n' + '─'.repeat(80));
        console.log('Checking recent intents that might have failed...\n');

        const intentsSnap = await db.collection('spot_paper_execution_intents')
            .where('scan_id', '==', 'spot_scan_1778194991002')
            .orderBy('created_at', 'desc')
            .get();

        if (!intentsSnap.empty) {
            const intents = intentsSnap.docs.map(d => ({ id: d.id, ...d.data() }));
            console.log(`Found ${intents.length} intents for Lote 3:`);
            for (const intent of intents) {
                console.log(`  Symbol: ${intent.symbol}`);
                console.log(`    Status: ${intent.status}`);
                if (intent.rejection_reason) {
                    console.log(`    Rejection: ${intent.rejection_reason}`);
                }
                if (intent.error) {
                    console.log(`    Error: ${intent.error}`);
                }
                console.log('');
            }
        }

        // Check Cloud Run service health
        console.log('\n' + '─'.repeat(80));
        console.log('Note: To check if the cron endpoint is actually being called:\n');
        console.log('1. Check Google Cloud Run logs for the backend service:');
        console.log('   - Project: proypers2025');
        console.log('   - Service: proypers25-backend');
        console.log('   - Search for: "/internal/cron/binance/spot-paper-execution"\n');

        console.log('2. Manually trigger the endpoint to see errors:');
        console.log('   curl -X POST https://proypers25-backend-h4put26qmq-tl.a.run.app/internal/cron/binance/spot-paper-execution \\');
        console.log('     -H "x-cron-secret: $CRON_SECRET" \\');
        console.log('     -H "Content-Type: application/json"\n');

        console.log('3. Check if Binance API is reachable from Cloud Run:');
        console.log('   - Verify https://api.binance.com/api/v3/klines is accessible');
        console.log('   - May be blocked by firewall or rate limits\n');

    } catch (error) {
        console.error('Error:', error);
    } finally {
        await admin.app().delete();
    }
}

checkForErrors().catch(console.error);