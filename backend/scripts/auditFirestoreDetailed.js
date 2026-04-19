#!/usr/bin/env node

/**
 * DETAILED FIRESTORE AUDIT
 * Muestra exactamente qué hay en cada colección sin asumir nombres de campos
 */

const db = require('../firebase-admin-config');

async function detailedAudit() {
  console.log('\n' + '='.repeat(100));
  console.log('DETAILED FIRESTORE AUDIT - HIGH CONVICTION SIGNALS & EXECUTION INTENTS');
  console.log('='.repeat(100) + '\n');

  try {
    // ========== HIGH CONVICTION SIGNALS ==========
    console.log('🔍 COLLECTION: high_conviction_signals\n');

    const hcsCount = await db.collection('high_conviction_signals').count().get();
    console.log(`Total documents: ${hcsCount.data().count}\n`);

    const hcsSnapshot = await db.collection('high_conviction_signals')
      .limit(10)
      .get();

    console.log('📋 Sample documents (first 10):\n');
    let signalCount = 0;
    hcsSnapshot.forEach((doc, idx) => {
      signalCount++;
      const data = doc.data();
      console.log(`[${idx + 1}] Document ID: ${doc.id}`);
      console.log(`    Keys (${Object.keys(data).length}): ${Object.keys(data).slice(0, 15).join(', ')}`);

      // Print all values nicely
      Object.entries(data).forEach(([key, value]) => {
        if (value === null || value === undefined) {
          console.log(`    • ${key}: null`);
        } else if (typeof value === 'object' && value.toDate) {
          console.log(`    • ${key}: ${value.toDate().toISOString()}`);
        } else if (typeof value === 'object') {
          const valStr = JSON.stringify(value).substring(0, 80);
          console.log(`    • ${key}: ${valStr}...`);
        } else {
          console.log(`    • ${key}: ${value}`);
        }
      });
      console.log('');
    });

    // Statistics
    console.log('\n📊 STATISTICS - high_conviction_signals:');

    // Get first 200 for statistics
    const allSignals = [];
    const signalsSnapshot = await db.collection('high_conviction_signals')
      .limit(200)
      .get();

    signalsSnapshot.forEach(doc => {
      allSignals.push(doc.data());
    });

    const stats = {
      total: allSignals.length,
      with_result: 0,
      with_status: 0,
      with_execution_id: 0,
      with_confidence: 0,
      results: {},
      statuses: {}
    };

    allSignals.forEach(sig => {
      // Check for result field (could be 'result', 'resulta', or others)
      Object.keys(sig).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('result')) stats.with_result++;
        if (lowerKey.includes('status')) stats.with_status++;
        if (lowerKey.includes('execution') || lowerKey.includes('intent')) stats.with_execution_id++;
        if (lowerKey.includes('confidence')) stats.with_confidence++;
      });
    });

    console.log(`  • Total signals analyzed: ${stats.total}`);
    console.log(`  • With result/win/loss field: ${stats.with_result}`);
    console.log(`  • With status field: ${stats.with_status}`);
    console.log(`  • With execution/intent reference: ${stats.with_execution_id}`);
    console.log(`  • With confidence: ${stats.with_confidence}`);

    // ========== BINANCE EXECUTION INTENTS ==========
    console.log('\n\n🔍 COLLECTION: binance_execution_intents\n');

    const beiCount = await db.collection('binance_execution_intents').count().get();
    console.log(`Total documents: ${beiCount.data().count}\n`);

    const beiSnapshot = await db.collection('binance_execution_intents')
      .limit(10)
      .get();

    console.log('📋 Sample documents (first 10):\n');
    beiSnapshot.forEach((doc, idx) => {
      const data = doc.data();
      console.log(`[${idx + 1}] Document ID: ${doc.id}`);
      console.log(`    Keys (${Object.keys(data).length}): ${Object.keys(data).slice(0, 15).join(', ')}`);

      // Print important fields
      Object.entries(data).forEach(([key, value]) => {
        if (value === null || value === undefined) {
          console.log(`    • ${key}: null`);
        } else if (typeof value === 'object' && value.toDate) {
          console.log(`    • ${key}: ${value.toDate().toISOString()}`);
        } else if (typeof value === 'object') {
          const valStr = JSON.stringify(value).substring(0, 80);
          console.log(`    • ${key}: ${valStr}...`);
        } else {
          console.log(`    • ${key}: ${value}`);
        }
      });
      console.log('');
    });

    // Statistics
    console.log('\n📊 STATISTICS - binance_execution_intents:');

    const allIntents = [];
    const intentsSnapshot = await db.collection('binance_execution_intents')
      .limit(200)
      .get();

    intentsSnapshot.forEach(doc => {
      allIntents.push(doc.data());
    });

    const intentStats = {
      total: allIntents.length,
      with_result: 0,
      with_status: 0,
      with_execution_date: 0,
      with_signal_ref: 0,
      statuses: {},
      results: {}
    };

    allIntents.forEach(intent => {
      Object.keys(intent).forEach(key => {
        const lowerKey = key.toLowerCase();
        if (lowerKey.includes('result') || lowerKey.includes('win') || lowerKey.includes('loss')) {
          intentStats.with_result++;
          if (intent[key]) intentStats.results[intent[key]] = (intentStats.results[intent[key]] || 0) + 1;
        }
        if (lowerKey.includes('status')) {
          intentStats.with_status++;
          if (intent[key]) intentStats.statuses[intent[key]] = (intentStats.statuses[intent[key]] || 0) + 1;
        }
        if (lowerKey.includes('executed') || lowerKey.includes('completed')) intentStats.with_execution_date++;
        if (lowerKey.includes('signal') || lowerKey.includes('high_conviction') || lowerKey.includes('prediction')) intentStats.with_signal_ref++;
      });
    });

    console.log(`  • Total intents analyzed: ${intentStats.total}`);
    console.log(`  • With result/win/loss field: ${intentStats.with_result}`);
    console.log(`  • With status field: ${intentStats.with_status}`);
    console.log(`  • With execution date field: ${intentStats.with_execution_date}`);
    console.log(`  • With signal/prediction reference: ${intentStats.with_signal_ref}`);

    if (Object.keys(intentStats.statuses).length > 0) {
      console.log(`\n  Status values found: ${Object.entries(intentStats.statuses).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    if (Object.keys(intentStats.results).length > 0) {
      console.log(`  Result values found: ${Object.entries(intentStats.results).map(([k, v]) => `${k}(${v})`).join(', ')}`);
    }

    console.log('\n' + '='.repeat(100) + '\n');

  } catch (error) {
    console.error('❌ Audit failed:', error.message);
    console.error(error.stack);
  }

  process.exit(0);
}

detailedAudit();
