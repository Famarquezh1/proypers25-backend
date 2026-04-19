#!/usr/bin/env node

/**
 * AUDIT: Firestore Signal Flow Tracer
 *
 * Objetivo: Auditar el flujo de señales high conviction desde emisión hasta ejecución
 * y detectar en qué punto se rompe la trazabilidad.
 */

const db = require('../firebase-admin-config');

async function auditHighConvictionSignals() {
  console.log('\n' + '='.repeat(80));
  console.log('AUDIT: Firestore High Conviction Signal Flow');
  console.log('='.repeat(80) + '\n');

  try {
    // ========== STEP 1: Audit high_conviction_signals collection ==========
    console.log('[STEP 1] Auditing HIGH_CONVICTION_SIGNALS collection...\n');

    // First, count total documents
    const signalsCount = await db.collection('high_conviction_signals').count().get();
    const totalSignals = signalsCount.data().count;

    const signalsSnapshot = await db.collection('high_conviction_signals')
      .orderBy('timestamp_emitted', 'desc')
      .limit(200)
      .get();

    const signals = [];
    signalsSnapshot.forEach(doc => {
      signals.push({
        id: doc.id,
        ...doc.data()
      });
    });

    console.log(`📊 Total signals in collection: ${totalSignals}`);
    console.log(`📊 Signals retrieved for analysis: ${signals.length}\n`);

    // Analyze signal structure
    const signalAnalysis = {
      total: signals.length,
      with_symbol: 0,
      with_timestamp: 0,
      with_confidence: 0,
      with_status: 0,
      with_result: 0,
      with_execution_intent_id: 0,
      with_binance_order_id: 0,
      without_result: 0,
      without_status: 0,
      without_execution_ref: 0,
      statuses: {},
      results: {}
    };

    signals.forEach(signal => {
      if (signal.symbol) signalAnalysis.with_symbol++;
      if (signal.timestamp_emitted) signalAnalysis.with_timestamp++;
      if (signal.confidence !== undefined) signalAnalysis.with_confidence++;
      if (signal.status) signalAnalysis.with_status++;
      if (signal.result) signalAnalysis.with_result++;
      if (signal.execution_intent_id || signal.executionIntentId) signalAnalysis.with_execution_intent_id++;
      if (signal.binance_order_id || signal.binanceOrderId) signalAnalysis.with_binance_order_id++;

      if (!signal.result) signalAnalysis.without_result++;
      if (!signal.status) signalAnalysis.without_status++;
      if (!signal.execution_intent_id && !signal.executionIntentId) signalAnalysis.without_execution_ref++;

      if (signal.status) {
        signalAnalysis.statuses[signal.status] = (signalAnalysis.statuses[signal.status] || 0) + 1;
      }
      if (signal.result) {
        signalAnalysis.results[signal.result] = (signalAnalysis.results[signal.result] || 0) + 1;
      }
    });

    console.log('\n📋 Signal Structure Analysis:');
    console.log(`  ✅ with symbol: ${signalAnalysis.with_symbol}/${signalAnalysis.total} (${(signalAnalysis.with_symbol/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with timestamp: ${signalAnalysis.with_timestamp}/${signalAnalysis.total} (${(signalAnalysis.with_timestamp/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with confidence: ${signalAnalysis.with_confidence}/${signalAnalysis.total} (${(signalAnalysis.with_confidence/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with status: ${signalAnalysis.with_status}/${signalAnalysis.total} (${(signalAnalysis.with_status/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with result: ${signalAnalysis.with_result}/${signalAnalysis.total} (${(signalAnalysis.with_result/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  🔗 with execution_intent_id: ${signalAnalysis.with_execution_intent_id}/${signalAnalysis.total} (${(signalAnalysis.with_execution_intent_id/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  🔗 with binance_order_id: ${signalAnalysis.with_binance_order_id}/${signalAnalysis.total} (${(signalAnalysis.with_binance_order_id/signalAnalysis.total*100).toFixed(1)}%)`);

    console.log('\n⚠️  Signal Issues:');
    console.log(`  ❌ without result: ${signalAnalysis.without_result}/${signalAnalysis.total} (${(signalAnalysis.without_result/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ❌ without status: ${signalAnalysis.without_status}/${signalAnalysis.total} (${(signalAnalysis.without_status/signalAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ❌ without execution_intent_id: ${signalAnalysis.without_execution_ref}/${signalAnalysis.total} (${(signalAnalysis.without_execution_ref/signalAnalysis.total*100).toFixed(1)}%)`);

    console.log('\n📊 Status Distribution:');
    Object.entries(signalAnalysis.statuses).forEach(([status, count]) => {
      console.log(`  • ${status}: ${count}`);
    });

    console.log('\n📊 Result Distribution:');
    Object.entries(signalAnalysis.results).forEach(([result, count]) => {
      console.log(`  • ${result}: ${count}`);
    });

    // ========== STEP 2: Audit binance_execution_intents collection ==========
    console.log('\n\n[STEP 2] Auditing BINANCE_EXECUTION_INTENTS collection...\n');

    // First, count total documents
    const intentsCount = await db.collection('binance_execution_intents').count().get();
    const totalIntents = intentsCount.data().count;

    const intentsSnapshot = await db.collection('binance_execution_intents')
      .orderBy('created_at', 'desc')
      .limit(200)
      .get();

    const intents = [];
    intentsSnapshot.forEach(doc => {
      intents.push({
        id: doc.id,
        ...doc.data()
      });
    });

    console.log(`📊 Total intents in collection: ${totalIntents}`);
    console.log(`📊 Intents retrieved for analysis: ${intents.length}\n`);

    // Analyze intent structure
    const intentAnalysis = {
      total: intents.length,
      with_symbol: 0,
      with_intent_created_at: 0,
      with_executed_at: 0,
      with_status: 0,
      with_result: 0,
      with_delay_ms: 0,
      with_signal_id: 0,
      with_high_conviction_signal_id: 0,
      without_result: 0,
      without_status: 0,
      zero_delay_ms: 0,
      with_error: 0,
      statuses: {},
      results: {}
    };

    signals.forEach(intent => {
      if (intent.symbol) intentAnalysis.with_symbol++;
      if (intent.intent_created_at) intentAnalysis.with_intent_created_at++;
      if (intent.executed_at) intentAnalysis.with_executed_at++;
      if (intent.status) intentAnalysis.with_status++;
      if (intent.result) intentAnalysis.with_result++;
      if (intent.delay_ms !== undefined) intentAnalysis.with_delay_ms++;
      if (intent.signal_id || intent.signalId) intentAnalysis.with_signal_id++;
      if (intent.high_conviction_signal_id || intent.highConvictionSignalId) intentAnalysis.with_high_conviction_signal_id++;

      if (!intent.result) intentAnalysis.without_result++;
      if (!intent.status) intentAnalysis.without_status++;
      if (intent.delay_ms === 0) intentAnalysis.zero_delay_ms++;
      if (intent.error) intentAnalysis.with_error++;

      if (intent.status) {
        intentAnalysis.statuses[intent.status] = (intentAnalysis.statuses[intent.status] || 0) + 1;
      }
      if (intent.result) {
        intentAnalysis.results[intent.result] = (intentAnalysis.results[intent.result] || 0) + 1;
      }
    });

    console.log('\n📋 Intent Structure Analysis:');
    console.log(`  ✅ with symbol: ${intentAnalysis.with_symbol}/${intentAnalysis.total} (${(intentAnalysis.with_symbol/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with intent_created_at: ${intentAnalysis.with_intent_created_at}/${intentAnalysis.total} (${(intentAnalysis.with_intent_created_at/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with executed_at: ${intentAnalysis.with_executed_at}/${intentAnalysis.total} (${(intentAnalysis.with_executed_at/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with status: ${intentAnalysis.with_status}/${intentAnalysis.total} (${(intentAnalysis.with_status/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with result: ${intentAnalysis.with_result}/${intentAnalysis.total} (${(intentAnalysis.with_result/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ✅ with delay_ms: ${intentAnalysis.with_delay_ms}/${intentAnalysis.total} (${(intentAnalysis.with_delay_ms/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  🔗 with signal_id: ${intentAnalysis.with_signal_id}/${intentAnalysis.total} (${(intentAnalysis.with_signal_id/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  🔗 with high_conviction_signal_id: ${intentAnalysis.with_high_conviction_signal_id}/${intentAnalysis.total} (${(intentAnalysis.with_high_conviction_signal_id/intentAnalysis.total*100).toFixed(1)}%)`);

    console.log('\n⚠️  Intent Issues:');
    console.log(`  ❌ without result: ${intentAnalysis.without_result}/${intentAnalysis.total} (${(intentAnalysis.without_result/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ❌ without status: ${intentAnalysis.without_status}/${intentAnalysis.total} (${(intentAnalysis.without_status/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ❌ with delay_ms = 0: ${intentAnalysis.zero_delay_ms}/${intentAnalysis.total} (${(intentAnalysis.zero_delay_ms/intentAnalysis.total*100).toFixed(1)}%)`);
    console.log(`  ❌ with error field: ${intentAnalysis.with_error}/${intentAnalysis.total}`);

    console.log('\n📊 Status Distribution:');
    Object.entries(intentAnalysis.statuses).forEach(([status, count]) => {
      console.log(`  • ${status}: ${count}`);
    });

    console.log('\n📊 Result Distribution:');
    Object.entries(intentAnalysis.results).forEach(([result, count]) => {
      console.log(`  • ${result}: ${count}`);
    });

    // ========== STEP 3: Cross-traceability analysis ==========
    console.log('\n\n[STEP 3] Cross-Traceability Analysis...\n');

    // Reread intents collection correctly
    const intentsSnapshotFixed = await db.collection('binance_execution_intents')
      .orderBy('intent_created_at', 'desc')
      .limit(100)
      .get();

    const intentsFixed = [];
    intentsSnapshotFixed.forEach(doc => {
      intentsFixed.push({
        id: doc.id,
        ...doc.data()
      });
    });

    const signalIdMap = {};
    signals.forEach(signal => {
      signalIdMap[signal.id] = signal;
    });

    const intentIdMap = {};
    intentsFixed.forEach(intent => {
      intentIdMap[intent.id] = intent;
    });

    // Track relationships
    const crossAnalysis = {
      intents_with_signal_ref: 0,
      intents_with_valid_signal_ref: 0,
      signals_with_intent_ref: 0,
      signals_with_valid_intent_ref: 0,
      orphaned_intents: 0,
      orphaned_signals: 0,
      mismatches: []
    };

    intentsFixed.forEach(intent => {
      const signalRefId = intent.signal_id || intent.signalId || intent.high_conviction_signal_id || intent.highConvictionSignalId;
      if (signalRefId) {
        crossAnalysis.intents_with_signal_ref++;
        if (signalIdMap[signalRefId]) {
          crossAnalysis.intents_with_valid_signal_ref++;
        } else {
          crossAnalysis.orphaned_intents++;
          crossAnalysis.mismatches.push({
            type: 'orphaned_intent',
            intent_id: intent.id,
            referenced_signal_id: signalRefId,
            reason: 'Referenced signal does not exist'
          });
        }
      } else {
        crossAnalysis.orphaned_intents++;
        crossAnalysis.mismatches.push({
          type: 'orphaned_intent',
          intent_id: intent.id,
          referenced_signal_id: null,
          reason: 'No signal reference found'
        });
      }
    });

    signals.forEach(signal => {
      const intentRefId = signal.execution_intent_id || signal.executionIntentId;
      if (intentRefId) {
        crossAnalysis.signals_with_intent_ref++;
        if (intentIdMap[intentRefId]) {
          crossAnalysis.signals_with_valid_intent_ref++;
        } else {
          crossAnalysis.orphaned_signals++;
          crossAnalysis.mismatches.push({
            type: 'orphaned_signal',
            signal_id: signal.id,
            referenced_intent_id: intentRefId,
            reason: 'Referenced intent does not exist'
          });
        }
      } else {
        crossAnalysis.orphaned_signals++;
      }
    });

    console.log('🔗 Cross-Reference Analysis:');
    console.log(`  Intents with signal reference: ${crossAnalysis.intents_with_signal_ref}/${intentsFixed.length}`);
    console.log(`  Intents with VALID signal reference: ${crossAnalysis.intents_with_valid_signal_ref}/${intentsFixed.length}`);
    console.log(`  Signals with intent reference: ${crossAnalysis.signals_with_intent_ref}/${signals.length}`);
    console.log(`  Signals with VALID intent reference: ${crossAnalysis.signals_with_valid_intent_ref}/${signals.length}`);
    console.log(`  Orphaned intents (no/invalid signal ref): ${crossAnalysis.orphaned_intents}/${intentsFixed.length}`);
    console.log(`  Orphaned signals (no/invalid intent ref): ${crossAnalysis.orphaned_signals}/${signals.length}`);

    if (crossAnalysis.mismatches.length > 0) {
      console.log('\n⚠️  Referential Integrity Issues:');
      crossAnalysis.mismatches.slice(0, 10).forEach(mismatch => {
        console.log(`  • ${mismatch.type}: ${mismatch[mismatch.type === 'orphaned_intent' ? 'intent_id' : 'signal_id']} - ${mismatch.reason}`);
      });
      if (crossAnalysis.mismatches.length > 10) {
        console.log(`  ... and ${crossAnalysis.mismatches.length - 10} more`);
      }
    }

    // ========== STEP 4: Identify break point ==========
    console.log('\n\n[STEP 4] Break Point Analysis...\n');

    console.log('📌 Break Point Detection:\n');

    const breakPoints = [];

    // Point A: Signal created but never updated
    const signalsNeverUpdated = signals.filter(s => s.status === 'emitted' && !s.result);
    if (signalsNeverUpdated.length > 0) {
      breakPoints.push({
        point: 'A',
        name: 'After signal emission',
        severity: 'high',
        count: signalsNeverUpdated.length,
        percentage: (signalsNeverUpdated.length / signals.length * 100).toFixed(1),
        description: 'Signals emitted but never marked as executed or with result'
      });
    }

    // Point B: Signal created but no intent
    const signalsNoIntent = signals.filter(s => !s.execution_intent_id && !s.executionIntentId);
    if (signalsNoIntent.length > 0) {
      breakPoints.push({
        point: 'B',
        name: 'After signal should create intent',
        severity: 'critical',
        count: signalsNoIntent.length,
        percentage: (signalsNoIntent.length / signals.length * 100).toFixed(1),
        description: 'Signals without linked execution intent'
      });
    }

    // Point C: Intent created but never executed
    const intentsNeverExecuted = intentsFixed.filter(i => !i.executed_at && i.status === 'created');
    if (intentsNeverExecuted.length > 0) {
      breakPoints.push({
        point: 'C',
        name: 'After intent creation',
        severity: 'high',
        count: intentsNeverExecuted.length,
        percentage: (intentsNeverExecuted.length / intentsFixed.length * 100).toFixed(1),
        description: 'Intents created but never executed on Binance'
      });
    }

    // Point D: Intent executed but no result recorded
    const intentsNoResult = intentsFixed.filter(i => i.executed_at && !i.result);
    if (intentsNoResult.length > 0) {
      breakPoints.push({
        point: 'D',
        name: 'After Binance execution',
        severity: 'high',
        count: intentsNoResult.length,
        percentage: (intentsNoResult.length / intentsFixed.length * 100).toFixed(1),
        description: 'Intents executed but no WIN/LOSS result recorded'
      });
    }

    // Point E: Zero delay intents (suspicious)
    if (intentAnalysis.zero_delay_ms > 0) {
      breakPoints.push({
        point: 'E',
        name: 'Timing anomaly',
        severity: 'medium',
        count: intentAnalysis.zero_delay_ms,
        percentage: (intentAnalysis.zero_delay_ms / intentsFixed.length * 100).toFixed(1),
        description: 'Intents with delay_ms = 0 (may indicate missing timestamp)'
      });
    }

    // Point F: Referential integrity
    if (crossAnalysis.orphaned_intents > 0 || crossAnalysis.orphaned_signals > 0) {
      breakPoints.push({
        point: 'F',
        name: 'Firestore persistence',
        severity: 'critical',
        count: crossAnalysis.orphaned_intents + crossAnalysis.orphaned_signals,
        percentage: ((crossAnalysis.orphaned_intents + crossAnalysis.orphaned_signals) / (signals.length + intentsFixed.length) * 100).toFixed(1),
        description: 'Orphaned documents - broken references between signals and intents'
      });
    }

    if (breakPoints.length === 0) {
      console.log('✅ No major break points detected!');
    } else {
      breakPoints.sort((a, b) => {
        const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
        return severityOrder[a.severity] - severityOrder[b.severity];
      });

      breakPoints.forEach(bp => {
        const icon = bp.severity === 'critical' ? '🔴' : bp.severity === 'high' ? '🟡' : '🟢';
        console.log(`${icon} [Point ${bp.point}] ${bp.name} - ${bp.severity.toUpperCase()}`);
        console.log(`   Count: ${bp.count} (${bp.percentage}%)`);
        console.log(`   Issue: ${bp.description}\n`);
      });
    }

    // ========== FINAL DIAGNOSIS ==========
    console.log('\n' + '='.repeat(80));
    console.log('FINAL DIAGNOSIS');
    console.log('='.repeat(80) + '\n');

    console.log('📊 STATISTICS:');
    console.log(`  • Signals in Firestore: ${signals.length}`);
    console.log(`  • Intents in Firestore: ${intentsFixed.length}`);
    console.log(`  • Signals without result: ${signalAnalysis.without_result} (${(signalAnalysis.without_result/signals.length*100).toFixed(1)}%)`);
    console.log(`  • Intents without result: ${intentAnalysis.without_result} (${(intentAnalysis.without_result/intentsFixed.length*100).toFixed(1)}%)`);
    console.log(`  • Orphaned relationships: ${crossAnalysis.orphaned_intents + crossAnalysis.orphaned_signals}`);

    if (breakPoints.length === 0) {
      console.log('\n✅ CONCLUSION: All data appears consistent. Flow is intact.');
    } else {
      const criticalBreakPoints = breakPoints.filter(bp => bp.severity === 'critical');
      if (criticalBreakPoints.length > 0) {
        console.log(`\n🔴 CRITICAL ISSUE DETECTED:`);
        console.log(`   Flow breaks at: ${criticalBreakPoints.map(bp => `Point ${bp.point}`).join(', ')}`);
        console.log(`   Most likely cause: ${criticalBreakPoints[0].description}`);
      } else {
        console.log(`\n🟡 ISSUES DETECTED AT: ${breakPoints.map(bp => `Point ${bp.point}`).join(', ')}`);
      }
    }

    console.log('\n👉 RECOMMENDATION:');
    if (signalAnalysis.without_execution_ref > 0) {
      console.log('   1. Check highConvictionSignals.js - ensure execution_intent_id is saved after intent creation');
    }
    if (intentAnalysis.without_result > 0) {
      console.log('   2. Check binanceFuturesExecutor.js - ensure result (WIN/LOSS) is recorded after trade closes');
    }
    if (crossAnalysis.orphaned_intents > 0) {
      console.log('   3. Investigate orphaned intents - they lack signal origin reference');
    }
    if (intentAnalysis.zero_delay_ms > 0) {
      console.log('   4. Check delay_ms calculation - values of 0 suggest timestamp issue');
    }

    console.log('\n' + '='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Audit failed:', error.message);
    console.error(error);
  }

  process.exit(0);
}

// Run audit
auditHighConvictionSignals();
