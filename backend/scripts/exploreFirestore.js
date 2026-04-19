#!/usr/bin/env node

/**
 * FIRESTORE COLLECTION EXPLORER
 *
 * Objetivo: Descubrir todas las colecciones disponibles en Firestore
 * y sus documentos.
 */

const db = require('../firebase-admin-config');

async function exploreDatabaseStructure() {
  console.log('\n' + '='.repeat(80));
  console.log('FIRESTORE DATABASE STRUCTURE EXPLORER');
  console.log('='.repeat(80) + '\n');

  try {
    // Get all collections at root level
    const collections = await db.listCollections();

    console.log(`📚 Found ${collections.length} collections at root level:\n`);

    for (const collection of collections) {
      const collectionName = collection.id;
      console.log(`\n📂 Collection: "${collectionName}"`);

      try {
        const snapshot = await collection.limit(5).get();
        const docCount = await collection.count().get();

        console.log(`   └─ Total documents: ${docCount.data().count}`);

        if (snapshot.empty) {
          console.log(`   └─ (empty)`);
        } else {
          console.log(`   └─ Sample documents (showing first 5):`);

          snapshot.forEach((doc, index) => {
            const data = doc.data();
            const keys = Object.keys(data).slice(0, 10);
            console.log(`      [${index + 1}] ID: ${doc.id}`);
            console.log(`          Keys: ${keys.join(', ')}`);

            // Show some field values
            if (data.symbol) console.log(`          • symbol: ${data.symbol}`);
            if (data.status) console.log(`          • status: ${data.status}`);
            if (data.result) console.log(`          • result: ${data.result}`);
            if (data.timestamp_emitted) console.log(`          • timestamp_emitted: ${data.timestamp_emitted}`);
            if (data.created_at) console.log(`          • created_at: ${data.created_at}`);
            if (data.intent_created_at) console.log(`          • intent_created_at: ${data.intent_created_at}`);
          });
        }

        // Check for subcollections in first document
        if (!snapshot.empty) {
          const firstDoc = snapshot.docs[0];
          const subCollections = await firstDoc.ref.listCollections();
          if (subCollections.length > 0) {
            console.log(`   └─ Subcollections in first doc:`);
            subCollections.forEach(subCol => {
              console.log(`      • ${subCol.id}`);
            });
          }
        }
      } catch (error) {
        console.log(`   └─ Error reading collection: ${error.message}`);
      }
    }

    // Try to find predictions collection structure
    console.log('\n\n' + '='.repeat(80));
    console.log('SEARCHING FOR PREDICTION-RELATED DATA');
    console.log('='.repeat(80) + '\n');

    const predictionsCollections = collections.filter(c =>
      c.id.toLowerCase().includes('predict') ||
      c.id.toLowerCase().includes('signal') ||
      c.id.toLowerCase().includes('high') ||
      c.id.toLowerCase().includes('execution') ||
      c.id.toLowerCase().includes('binance')
    );

    if (predictionsCollections.length > 0) {
      console.log(`🎯 Found ${predictionsCollections.length} prediction-related collections:\n`);
      predictionsCollections.forEach(col => {
        console.log(`  • ${col.id}`);
      });
    } else {
      console.log('❌ No prediction-related collections found');
      console.log('\n💡 Possible reasons:');
      console.log('  1. Collections might be named differently');
      console.log('  2. No high conviction signals have been emitted yet');
      console.log('  3. Data might be in a different Firestore database or project');
    }

  } catch (error) {
    console.error('❌ Explorer failed:', error.message);
    console.error(error);
  }

  process.exit(0);
}

// Run explorer
exploreDatabaseStructure();
