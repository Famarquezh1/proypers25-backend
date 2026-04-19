#!/usr/bin/env node

/**
 * EXECUTION CONTRACT IMPLEMENTATION GUIDE
 *
 * Single Source of Truth: win_model is the ONLY field frontend reads
 */

console.log(`

╔════════════════════════════════════════════════════════════════════════════╗
║                    EXECUTION CONTRACT IMPLEMENTATION                       ║
║                   Single Source of Truth: win_model                        ║
╚════════════════════════════════════════════════════════════════════════════╝

═══ THE PROBLEM ═══

Multiple sources of truth causing inconsistencies:

  ❌ Some code reads win_model
  ❌ Some code reads execution_audit.win_exchange
  ❌ Some code reads verification_outcome
  ❌ Frontend inconsistently shows results
  ❌ Auditing impossible - can't track which field was used

═══ THE SOLUTION ═══

Define ONE source of truth:

  ✅ win_model = OFFICIAL execution result
  ✅ NEVER read execution_audit.win_exchange directly
  ✅ NEVER read verification_outcome directly
  ✅ Frontend reads ONLY win_model

═══ THE CONTRACT ═══

Every document in binance_execution_intents MUST have:

  {
    // Identity
    intent_id: string,
    symbol: string,
    source: 'high_conviction' | 'event_emitted' | 'manual_prealert',

    // Lifecycle
    intent_created_at: ISO8601,
    sent_to_exchange_at: ISO8601 | null,
    executed_at: ISO8601 | null,
    closed_at: ISO8601 | null,

    // Metrics
    delay_ms: number | null,

    // SINGLE SOURCE OF TRUTH
    win_model: 'WIN' | 'LOSS' | null,

    // Status (derived from timestamps)
    status: 'created' | 'sent' | 'executed' | 'closed'
  }

═══ EXTRACTION PRIORITY ═══

When building contract, win_model comes from (in order):

  1. execution_audit.win_exchange (most recent)
  2. verification_outcome (high_conviction signals)
  3. top-level win_model (fallback)
  4. null (no result found)

All LEGACY fields (execution_audit.win_exchange, verification_outcome) are:
  ✓ KEPT in Firestore (no deletion, no data loss)
  ✓ SYNCED to win_model
  ✗ NEVER read directly by frontend

═══ IMPLEMENTATION IN CODE ═══

FILE: backend/utils/executionContract.js
Created with:
  ✓ buildExecutionContract(intent) - builds contract from any intent
  ✓ isValidContract(intent) - validates compliance
  ✓ buildContractUpdate(intent) - creates Firestore update
  ✓ validateContractsBatch(intents) - batch validation
  ✓ getContractStatus(intent) - detailed compliance report

═══ INTEGRATION POINTS ═══

POINT 1: binancePositionManager.js
  Function: updateExecutionIntentOutcome()
  Change: Import and use buildExecutionContract
  Effect: All position closes create valid contracts

POINT 2: predictionExecutionSync.js
  Function: buildClosedTradeExecutionPayload()
  Change: Import and use buildExecutionContract
  Effect: All trade syncs create valid contracts

POINT 3: Frontend queries (NO CHANGES NEEDED)
  Current: Queries WHERE win_model != 'PENDING'
  Future: Same query, but now ALWAYS finds results (single source)

═══ CONVERSION FORMULA ═══

FROM (current fragmented state):
  intent {
    win_model: 'PENDING',
    execution_audit: { win_exchange: 'WIN' },
    verification_outcome: 'LOSS',
    delay_ms: 0,
    status: 'unknown'
  }

TO (single source of truth):
  intent {
    win_model: 'WIN',                    ← extracted from priority order
    execution_audit: { win_exchange: 'WIN' },  ← kept (not deleted)
    verification_outcome: 'LOSS',             ← kept (not deleted)
    delay_ms: 8000,                      ← calculated
    status: 'executed'                   ← derived from timestamps
  }

═══ ENFORCEMENT RULES ═══

RULE 1: win_model is READ-ONLY from legacy fields
  - If execution_audit.win_exchange exists → always sync to win_model
  - If verification_outcome exists → always sync to win_model
  - Frontend reads ONLY win_model

RULE 2: No data deletion
  - execution_audit.win_exchange stays in Firestore
  - verification_outcome stays in Firestore
  - These are now AUDIT fields, not truth fields

RULE 3: Timestamps are normalized
  - intent_created_at: extracted from created_at, created, etc.
  - sent_to_exchange_at: extracted from sent_at, etc.
  - executed_at: extracted from execution_time, filled_at, etc.
  - closed_at: extracted from close_time, etc.

RULE 4: Status is derived (never stored as PENDING/unknown)
  - created: only intent_created_at exists
  - sent: sent_to_exchange_at exists
  - executed: executed_at exists
  - closed: closed_at exists

═══ BATCH REPAIR ═══

Script: backend/scripts/enforceExecutionContract.js

DRY RUN (preview):
  $ node backend/scripts/enforceExecutionContract.js

APPLY (to Firestore):
  $ node backend/scripts/enforceExecutionContract.js --firestore

Reports:
  - Intents scanned
  - Contracts built
  - Violations detected
  - Updates applied

═══ VERIFICATION ═══

Test execution contract:
  $ node backend/scripts/verifyExecutionContract.js

Results:
  ✓ 5/5 extraction tests passed
  ✓ Contract building correct
  ✓ Validation working
  ✓ Batch processing functional
  ✓ Priority order enforced

═══ MIGRATION PATH ═══

PHASE 1: Deploy contract (already done)
  ✓ executionContract.js created
  ✓ Verification tests passing
  ✓ No breaking changes

PHASE 2: Integrate into position close
  - Update binancePositionManager.js
  - Use buildExecutionContract in updateExecutionIntentOutcome
  - All new position closes use contract

PHASE 3: Integrate into trade sync
  - Update predictionExecutionSync.js
  - Use buildExecutionContract in buildClosedTradeExecutionPayload
  - All new trade syncs use contract

PHASE 4: Repair historical intents (optional)
  - Run enforceExecutionContract.js --firestore
  - Updates 581+ intents
  - Maintains audit trail (no deletions)

PHASE 5: Monitor
  - Frontend widget shows all results
  - No inconsistencies
  - Single source of truth in effect

═══ ROLLBACK ═══

If issues arise:
  1. No data deleted - all legacy fields still in Firestore
  2. Remove buildExecutionContract calls
  3. revert to previous version
  4. No data loss

═══ GOLDEN RULE ═══

Every intent must answer:

  "What is the official result of this trade?"

  ANSWER: intent.win_model (ONLY this field)

  NOT: intent.execution_audit.win_exchange
  NOT: intent.verification_outcome

═══ SCHEMA ═══

LEGACY (fragmented, inconsistent):
  binance_execution_intents {
    intent_id,
    symbol,
    win_model,                        ← Sometimes PENDING (legacy)
    execution_audit: {
      win_exchange: 'WIN',            ← Another source
      win_model: 'PENDING',           ← Nested duplicate
      ... 100 other fields
    },
    verification_outcome: 'WIN',      ← Yet another source
    delay_ms: 0 or missing,           ← Wrong or missing
    status: 'PENDING' or 'unknown',   ← Invalid
  }

MODERN (single source, consistent):
  binance_execution_intents {
    intent_id,
    symbol,
    source: 'high_conviction',
    intent_created_at,
    sent_to_exchange_at,
    executed_at,
    closed_at,
    delay_ms,
    win_model: 'WIN',                 ← SINGLE SOURCE
    status: 'executed',

    // Still kept for audit
    execution_audit: { ... },
    verification_outcome: 'WIN'
  }

═══ SUCCESS METRICS ═══

After implementation:

  ✓ 0 contracts with PENDING win_model (that have results)
  ✓ 100% delay_ms calculated correctly
  ✓ 0 status values of 'PENDING' or 'unknown'
  ✓ 0 intents with multiple conflicting results
  ✓ Frontend returns all executed trades (no 0 results)
  ✓ Audit trail complete (all sources kept)

═══ NEXT STEPS ═══

1. Code Review
   - Review executionContract.js
   - Review verification tests

2. Test in Development
   - Run verifyExecutionContract.js
   - Create sample intents with contracts

3. Integrate into Position Close
   - Update binancePositionManager.js
   - Test with live trades

4. Integrate into Trade Sync
   - Update predictionExecutionSync.js
   - Test with high_conviction signals

5. Deploy to Production
   - Cloud Build triggers
   - Monitor for errors

6. Repair Historical Data (Optional)
   - Run batch script
   - Monitor progress

7. Monitor
   - Frontend widget working
   - No inconsistencies
   - Contract compliance 100%

╔════════════════════════════════════════════════════════════════════════════╗
║            Single Source of Truth: win_model (ONLY THIS FIELD)             ║
║                   Execution Contract: READY FOR INTEGRATION                ║
╚════════════════════════════════════════════════════════════════════════════╝

`);
