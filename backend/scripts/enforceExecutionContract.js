#!/usr/bin/env node

/**
 * BATCH ENFORCE EXECUTION CONTRACT
 *
 * Applies single source of truth contract to all intents in Firestore
 * Usage: node backend/scripts/enforceExecutionContract.js [--firestore]
 */

const admin = require('firebase-admin');
const {
  buildExecutionContract,
  buildContractUpdate,
  isValidContract,
  validateContractsBatch
} = require('../utils/executionContract');

const args = process.argv.slice(2);
const useFirestore = args.includes('--firestore');
const dryRun = !useFirestore;

console.log('\n=== ENFORCE EXECUTION CONTRACT ===\n');

if (dryRun) {
  console.log('DRY RUN MODE (no Firestore changes)\n');
  console.log('To apply changes, run with: --firestore\n');
}

/**
 * Enforce contract on batch of intents
 */
async function enforceBatch(db = null) {
  const stats = {
    scanned: 0,
    valid: 0,
    invalid: 0,
    fixed: 0,
    errors: 0,
    details: {
      missing_win_model: 0,
      missing_timestamps: 0,
      invalid_status: 0,
      zero_delay: 0
    }
  };

  if (db && useFirestore) {
    console.log('Connecting to Firestore...\n');

    try {
      // Query intents that might violate contract
      const snapshot = await db
        .collection('binance_execution_intents')
        .limit(50)  // Batch of 50
        .get();

      console.log(`Found ${snapshot.size} intents to process\n`);
      stats.scanned = snapshot.size;

      const batch = db.batch();
      let batchOps = 0;
      let inBatch = db.batch();

      for (const doc of snapshot.docs) {
        const intent = { id: doc.id, ...doc.data() };

        if (!isValidContract(intent)) {
          stats.invalid++;

          const contract = buildExecutionContract(intent);
          const update = buildContractUpdate(intent);

          if (!update) continue;

          try {
            inBatch.update(doc.ref, update);
            batchOps++;
            stats.fixed++;

            if (batchOps >= 25) {
              await inBatch.commit();
              inBatch = db.batch();
              batchOps = 0;
              console.log(`✓ Committed 25 contract updates`);
            }
          } catch (err) {
            console.error(`Error updating ${doc.id}:`, err.message);
            stats.errors++;
          }
        } else {
          stats.valid++;
        }
      }

      // Commit remaining
      if (batchOps > 0) {
        await inBatch.commit();
        console.log(`✓ Committed final ${batchOps} contract updates`);
      }

      return stats;

    } catch (error) {
      console.error('Firestore error:', error.message);
      stats.errors++;
      return stats;
    }

  } else {
    // DRY RUN with sample data showing real contract violations
    // Violations: status=executed but no win_model result
    const sampleIntents = [
      {
        id: 'real_violation_001',
        symbol: 'BTC/USDT',
        intent_created_at: '2026-04-16T10:00:00Z',
        executed_at: '2026-04-16T10:00:05Z',
        win_model: 'PENDING',
        status: 'executed',
        delay_ms: 5000
        // VIOLATION: status=executed but win_model=PENDING (no result)
      },
      {
        id: 'real_violation_002',
        symbol: 'ETH/USDT',
        intent_created_at: '2026-04-16T11:00:00Z',
        executed_at: '2026-04-16T11:00:05Z',
        closed_at: '2026-04-16T11:05:00Z',
        win_model: 'PENDING',
        status: 'closed',
        delay_ms: 5000
        // VIOLATION: status=closed but win_model=PENDING (no result)
      },
      {
        id: 'compliant_sample_001',
        symbol: 'SOL/USDT',
        intent_created_at: '2026-04-16T12:00:00Z',
        executed_at: '2026-04-16T12:00:05Z',
        win_model: 'WIN',
        status: 'executed',
        delay_ms: 5000
        // COMPLIANT: status=executed with win_model=WIN
      },
      {
        id: 'compliant_sample_002',
        symbol: 'XRP/USDT',
        intent_created_at: '2026-04-16T13:00:00Z',
        sent_to_exchange_at: '2026-04-16T13:00:01Z',
        executed_at: '2026-04-16T13:00:05Z',
        closed_at: '2026-04-16T13:05:00Z',
        win_model: 'LOSS',
        status: 'closed',
        delay_ms: 5000
        // COMPLIANT: status=closed with win_model=LOSS
      }
    ];

    console.log(`Processing ${sampleIntents.length} sample intents...\n`);
    stats.scanned = sampleIntents.length;

    for (const intent of sampleIntents) {
      const valid = isValidContract(intent);
      const contract = buildExecutionContract(intent);

      if (valid) {
        stats.valid++;
        console.log(`✓ ${intent.id} (${intent.symbol}) - Already compliant`);
      } else {
        stats.invalid++;
        console.log(`\n⚠ ${intent.id} (${intent.symbol}) - Contract violation detected`);
        console.log('┌─ CURRENT STATE:');
        console.log(`│   win_model: ${intent.win_model}`);
        console.log(`│   status: ${intent.status}`);
        console.log(`│   delay_ms: ${intent.delay_ms || 'N/A'}`);
        if (intent.execution_audit?.win_exchange) {
          console.log(`│   execution_audit.win_exchange: ${intent.execution_audit.win_exchange}`);
        }
        if (intent.verification_outcome) {
          console.log(`│   verification_outcome: ${intent.verification_outcome}`);
        }

        console.log('│');
        console.log('└─ EXTRACTED CONTRACT:');
        console.log(`    win_model: ${contract.win_model}`);
        console.log(`    status: ${contract.status}`);
        console.log(`    delay_ms: ${contract.delay_ms}`);
        console.log(`    intent_created_at: ${contract.intent_created_at}`);
        console.log(`    executed_at: ${contract.executed_at}`);

        // Count what would be fixed
        if (intent.win_model !== contract.win_model) {
          stats.details.missing_win_model++;
          console.log(`    → win_model will update: ${intent.win_model} → ${contract.win_model}`);
        }
        if (!intent.intent_created_at || !intent.executed_at) stats.details.missing_timestamps++;
        if (intent.status !== contract.status) {
          stats.details.invalid_status++;
          console.log(`    → status will update: ${intent.status} → ${contract.status}`);
        }
        if (!intent.delay_ms || intent.delay_ms === 0) stats.details.zero_delay++;

        stats.fixed++;
      }
    }

    console.log('\n');
    return stats;
  }
}

// Run if invoked directly
if (require.main === module) {
  const db = useFirestore ? admin.firestore() : null;

  enforceBatch(db)
    .then(stats => {
      console.log('\n=== CONTRACT ENFORCEMENT REPORT ===\n');
      console.log(`Scanned: ${stats.scanned}`);
      console.log(`Currently valid: ${stats.valid}`);
      console.log(`Invalid (need fixing): ${stats.invalid}`);
      console.log(`Would fix: ${stats.fixed}`);
      console.log(`Errors: ${stats.errors}`);

      if (stats.details && Object.keys(stats.details).length > 0) {
        console.log('\nViolations found:');
        console.log(`  Missing win_model: ${stats.details.missing_win_model}`);
        console.log(`  Missing timestamps: ${stats.details.missing_timestamps}`);
        console.log(`  Invalid status: ${stats.details.invalid_status}`);
        console.log(`  Zero/missing delay_ms: ${stats.details.zero_delay}`);
      }

      if (useFirestore) {
        console.log('\n✓ Firestore updated with contract enforcement');
      } else {
        console.log('\nTo apply changes to Firestore, run with: --firestore');
      }

      console.log('\n✓ Contract enforcement completed\n');
      process.exit(0);
    })
    .catch(err => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}

module.exports = { enforceBatch };
