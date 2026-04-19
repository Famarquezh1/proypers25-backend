#!/usr/bin/env node

/**
 * BATCH REPAIR SCRIPT: Normalize Existing Intents
 *
 * Scans binance_execution_intents collection and normalizes:
 * - Missing lifecycle fields
 * - Inconsistent status
 * - PENDING win_model with actual results
 * - Zero delay_ms
 *
 * Usage: node backend/scripts/batchNormalizeIntents.js
 * Or with Firestore: node backend/scripts/batchNormalizeIntents.js --firestore
 */

const admin = require('firebase-admin');
const {
  normalizeLifecycle,
  needsNormalization,
  batchNormalizeLifecycles
} = require('../utils/normalizeLifecycle');

const args = process.argv.slice(2);
const useFirestore = args.includes('--firestore');

console.log('\n=== BATCH NORMALIZE INTENTS ===\n');

if (!useFirestore) {
  console.log('DRY RUN MODE (no Firestore changes)\n');
  console.log('To actually update Firestore, run with: --firestore\n');
}

/**
 * Scan and normalize intents
 */
async function batchNormalizeIntents(db = null) {
  const stats = {
    scanned: 0,
    needsNormalization: 0,
    normalized: 0,
    updated: 0,
    errors: 0,
    gaps: {
      missing_intent_created_at: 0,
      missing_sent_to_exchange_at: 0,
      missing_executed_at: 0,
      missing_closed_at: 0,
      zero_or_missing_delay_ms: 0,
      pending_win_model: 0,
      inconsistent_status: 0
    }
  };

  // If Firestore available, query real data
  if (db && useFirestore) {
    console.log('Querying binance_execution_intents from Firestore...\n');

    try {
      const snapshot = await db
        .collection('binance_execution_intents')
        .limit(100)  // Batch of 100
        .get();

      console.log(`Found ${snapshot.size} intents to process\n`);
      stats.scanned = snapshot.size;

      const batch = db.batch();
      let batchOps = 0;

      for (const doc of snapshot.docs) {
        const intent = doc.data();

        if (needsNormalization(intent)) {
          stats.needsNormalization++;

          const normalized = normalizeLifecycle(intent);
          if (!normalized) continue;

          stats.normalized++;

          // Count gaps
          if (!intent.intent_created_at) stats.gaps.missing_intent_created_at++;
          if (!intent.sent_to_exchange_at) stats.gaps.missing_sent_to_exchange_at++;
          if (!intent.executed_at) stats.gaps.missing_executed_at++;
          if (intent.status === 'closed' && !intent.closed_at) stats.gaps.missing_closed_at++;
          if (!intent.delay_ms || intent.delay_ms === 0) stats.gaps.zero_or_missing_delay_ms++;
          if (intent.win_model === 'PENDING') stats.gaps.pending_win_model++;
          if (intent.status && !['created', 'sent', 'executed', 'closed'].includes(intent.status)) {
            stats.gaps.inconsistent_status++;
          }

          // Build update
          const updateObj = {
            'intent_created_at': normalized.intent_created_at,
            'sent_to_exchange_at': normalized.sent_to_exchange_at,
            'executed_at': normalized.executed_at,
            'closed_at': normalized.closed_at,
            'delay_ms': normalized.delay_ms,
            'win_model': normalized.win_model,
            'status': normalized.status,
            'execution_audit.intent_created_at': normalized.intent_created_at,
            'execution_audit.sent_to_exchange_at': normalized.sent_to_exchange_at,
            'execution_audit.executed_at': normalized.executed_at,
            'execution_audit.closed_at': normalized.closed_at,
            'execution_audit.delay_ms': normalized.delay_ms,
            'execution_audit.win_model': normalized.win_model,
            'execution_audit.status': normalized.status,
            'execution_audit.normalized_at': normalized.normalized_at
          };

          batch.update(doc.ref, updateObj);
          batchOps++;
          stats.updated++;

          if (batchOps >= 100) {
            await batch.commit();
            console.log(`✓ Committed batch of ${batchOps} updates`);
            batchOps = 0;
          }
        }
      }

      // Commit remaining
      if (batchOps > 0) {
        await batch.commit();
        console.log(`✓ Committed final batch of ${batchOps} updates`);
      }

      return stats;

    } catch (error) {
      console.error('Firestore error:', error.message);
      stats.errors++;
      return stats;
    }

  } else {
    // Dry run with sample data
    const sampleIntents = [
      {
        id: 'sample_001',
        created_at: '2026-04-15T10:00:00Z',
        execution_time: '2026-04-15T10:00:05Z',
        win_exchange: 'WIN',
        delay_ms: 0
      },
      {
        id: 'sample_002',
        intent_created_at: '2026-04-15T11:00:00Z',
        executed_at: '2026-04-15T11:00:10Z',
        win_model: 'PENDING',
        execution_audit: { win_exchange: 'LOSS' },
        status: 'unknown'
      },
      {
        id: 'sample_003',
        intent_created_at: '2026-04-15T12:00:00Z',
        sent_to_exchange_at: '2026-04-15T12:00:03Z',
        executed_at: '2026-04-15T12:00:08Z',
        closed_at: '2026-04-15T12:05:00Z',
        win_model: 'WIN',
        status: 'closed'
      }
    ];

    console.log(`Processing ${sampleIntents.length} sample intents...\n`);
    stats.scanned = sampleIntents.length;

    for (const intent of sampleIntents) {
      if (needsNormalization(intent)) {
        stats.needsNormalization++;

        const normalized = normalizeLifecycle(intent);
        if (!normalized) continue;

        stats.normalized++;
        stats.updated++;

        // Count gaps
        if (!intent.intent_created_at) stats.gaps.missing_intent_created_at++;
        if (!intent.sent_to_exchange_at) stats.gaps.missing_sent_to_exchange_at++;
        if (!intent.executed_at) stats.gaps.missing_executed_at++;
        if (intent.status === 'closed' && !intent.closed_at) stats.gaps.missing_closed_at++;
        if (!intent.delay_ms || intent.delay_ms === 0) stats.gaps.zero_or_missing_delay_ms++;
        if (intent.win_model === 'PENDING') stats.gaps.pending_win_model++;
        if (intent.status && !['created', 'sent', 'executed', 'closed'].includes(intent.status)) {
          stats.gaps.inconsistent_status++;
        }

        console.log(`\nIntent: ${intent.id}`);
        console.log('Before:', JSON.stringify({
          intent_created_at: intent.intent_created_at,
          sent_to_exchange_at: intent.sent_to_exchange_at,
          executed_at: intent.executed_at,
          delay_ms: intent.delay_ms,
          win_model: intent.win_model,
          status: intent.status
        }, null, 2));

        console.log('After:', JSON.stringify({
          intent_created_at: normalized.intent_created_at,
          sent_to_exchange_at: normalized.sent_to_exchange_at,
          executed_at: normalized.executed_at,
          delay_ms: normalized.delay_ms,
          win_model: normalized.win_model,
          status: normalized.status
        }, null, 2));

        console.log('Would update ✓');
      }
    }

    return stats;
  }
}

// Run if invoked directly
if (require.main === module) {
  const db = useFirestore ? admin.firestore() : null;

  batchNormalizeIntents(db)
    .then(stats => {
      console.log('\n=== BATCH NORMALIZATION REPORT ===\n');
      console.log(`Scanned: ${stats.scanned}`);
      console.log(`Needs normalization: ${stats.needsNormalization}`);
      console.log(`Normalized: ${stats.normalized}`);
      console.log(`Updated: ${stats.updated}`);
      console.log(`Errors: ${stats.errors}`);

      console.log('\nGaps Found:');
      console.log(`  Missing intent_created_at: ${stats.gaps.missing_intent_created_at}`);
      console.log(`  Missing sent_to_exchange_at: ${stats.gaps.missing_sent_to_exchange_at}`);
      console.log(`  Missing executed_at: ${stats.gaps.missing_executed_at}`);
      console.log(`  Missing closed_at: ${stats.gaps.missing_closed_at}`);
      console.log(`  Zero/missing delay_ms: ${stats.gaps.zero_or_missing_delay_ms}`);
      console.log(`  PENDING win_model: ${stats.gaps.pending_win_model}`);
      console.log(`  Inconsistent status: ${stats.gaps.inconsistent_status}`);

      if (useFirestore) {
        console.log('\n✓ Firestore updated');
      } else {
        console.log('\nTo apply changes to Firestore, run with: --firestore');
      }

      console.log('\n');
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { batchNormalizeIntents };
