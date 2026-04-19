/**
 * EXECUTION CONTRACT SERVICE
 *
 * SINGLE POINT OF TRUTH for all binance_execution_intents writes
 *
 * All intent updates MUST go through this service.
 * This ensures:
 * ✓ Single source of truth (win_model always authoritative)
 * ✓ Consistent normalization (all timestamps, status, delay_ms)
 * ✓ Complete audit trail (no fragmented data)
 * ✓ Automatic contract enforcement (no manual field manipulation)
 */

const {
  buildExecutionContract,
  buildContractUpdate,
  isValidContract
} = require('../../utils/executionContract');

const {
  normalizeLifecycle,
  buildLifecycleUpdate,
  needsNormalization
} = require('../../utils/normalizeLifecycle');

const db = require('../../firebase-admin-config');

const CONTRACT_MANAGED_FIELDS = new Set([
  'intent_created_at',
  'sent_to_exchange_at',
  'executed_at',
  'closed_at',
  'delay_ms',
  'win_model',
  'status',
  'source',
  'updated_at',
  'updated_by'
]);

const CONTRACT_MANAGED_AUDIT_FIELDS = new Set([
  'intent_created_at',
  'sent_to_exchange_at',
  'executed_at',
  'closed_at',
  'delay_ms',
  'win_model',
  'status',
  'source',
  'normalized_at'
]);

function buildPassthroughUpdate(partialData = {}) {
  const update = {};

  for (const [key, value] of Object.entries(partialData)) {
    if (key === 'execution_audit') continue;
    if (CONTRACT_MANAGED_FIELDS.has(key)) continue;
    update[key] = value;
  }

  const executionAudit = partialData.execution_audit;
  if (executionAudit && typeof executionAudit === 'object' && !Array.isArray(executionAudit)) {
    for (const [key, value] of Object.entries(executionAudit)) {
      if (CONTRACT_MANAGED_AUDIT_FIELDS.has(key)) continue;
      update[`execution_audit.${key}`] = value;
    }
  }

  return update;
}

/**
 * UPDATE INTENT - CENTRALIZED SINGLE POINT OF TRUTH
 *
 * All binance_execution_intents updates MUST go through this function.
 * This ensures automatic contract enforcement and normalization.
 *
 * @param {string} intentId - Intent document ID
 * @param {Object} partialData - Partial data to merge
 * @returns {Promise<{success: boolean, contract: Object, validationErrors: string[]}>}
 */
async function updateIntent(intentId, partialData = {}) {
  try {
    // 🚫 PROTECTION: Detect direct write attempts
    if (partialData.win_model && !partialData.execution_audit?.win_exchange) {
      console.warn('[FORBIDDEN_DIRECT_WRITE_ATTEMPT] Caller attempted to set win_model directly:', {
        intentId,
        win_model: partialData.win_model,
        caller_stack: new Error().stack.split('\n').slice(2, 4).join('\n')
      });
      // Still process but log as suspicious - win_model will be overridden by contract
    }

    // 1. Fetch current intent state
    const intentRef = db.collection('binance_execution_intents').doc(intentId);
    const intentSnap = await intentRef.get();

    if (!intentSnap.exists) {
      return {
        success: false,
        error: `Intent ${intentId} not found`,
        validationErrors: [`Document does not exist: ${intentId}`]
      };
    }

    const currentIntent = { id: intentSnap.id, ...intentSnap.data() };

    // 2. Merge partial data with current state
    const mergedIntent = {
      ...currentIntent,
      ...partialData,
      id: intentId
    };

    // 🚫 PROTECTION: Detect attempts to bypass contract fields
    const forbiddenFieldsBypass = [];

    if (partialData.status && !partialData.execution_audit) {
      forbiddenFieldsBypass.push('status (without execution_audit context)');
    }
    if (partialData.delay_ms && !partialData.created_at && !partialData.execution_audit?.sent_to_exchange_at) {
      forbiddenFieldsBypass.push('delay_ms (direct manipulation detected)');
    }
    if (partialData.updated_by && partialData.updated_by !== 'executionContractService') {
      forbiddenFieldsBypass.push('updated_by (caller attempted to set identity)');
    }

    if (forbiddenFieldsBypass.length > 0) {
      console.warn('[FORBIDDEN_BYPASS_ATTEMPT] Suspicious field manipulation:', {
        intentId,
        fields: forbiddenFieldsBypass,
        caller_data: Object.keys(partialData).filter(k => !['execution_audit', 'created_at', 'updated_at'].includes(k))
      });
    }

    // 3. Build official contract from merged data
    const contract = buildExecutionContract(mergedIntent);

    if (!contract) {
      return {
        success: false,
        error: 'Failed to build execution contract',
        validationErrors: ['Contract building failed - invalid intent data']
      };
    }

    // 4. Validate contract compliance
    const validationErrors = validateContractCompliance(contract, mergedIntent);

    if (validationErrors.length > 0) {
      console.warn(`⚠ Contract validation warnings for ${intentId}:`, validationErrors);
      // Don't fail, just warn - contract is still valid
    }

    // 5. Build Firestore update payload with all normalizations
    const normalizedLifecycle = normalizeLifecycle(mergedIntent);
    const contractUpdate = buildContractUpdate(mergedIntent);
    const lifecycleUpdate = buildLifecycleUpdate(normalizedLifecycle);
    const passthroughUpdate = buildPassthroughUpdate(partialData);

    // Merge both updates
    const finalUpdate = {
      ...passthroughUpdate,
      ...contractUpdate,
      ...lifecycleUpdate,
      updated_at: new Date().toISOString(),
      updated_by: 'executionContractService'
    };

    // 6. Apply update to Firestore
    await intentRef.update(finalUpdate);

    // Log for audit trail
    console.log(`✓ Intent ${intentId} updated with contract enforcement`);
    console.log(`  win_model: ${contract.win_model}`);
    console.log(`  status: ${contract.status}`);
    console.log(`  delay_ms: ${contract.delay_ms}`);

    return {
      success: true,
      contract,
      validationErrors: []
    };

  } catch (error) {
    console.error(`❌ Error updating intent ${intentId}:`, error.message);
    return {
      success: false,
      error: error.message,
      validationErrors: [error.message]
    };
  }
}

/**
 * BATCH UPDATE INTENTS - Centralized batch processing
 *
 * @param {Object[]} updates - Array of {intentId, partialData} objects
 * @returns {Promise<{scanned, success, failed, errors[]}>}
 */
async function batchUpdateIntents(updates = []) {
  const results = {
    scanned: updates.length,
    success: 0,
    failed: 0,
    errors: []
  };

  for (const update of updates) {
    const { intentId, partialData } = update;

    try {
      const result = await updateIntent(intentId, partialData);

      if (result.success) {
        results.success++;
      } else {
        results.failed++;
        results.errors.push({
          intentId,
          error: result.error
        });
      }
    } catch (error) {
      results.failed++;
      results.errors.push({
        intentId,
        error: error.message
      });
    }
  }

  return results;
}

/**
 * QUERY INTENTS - Wrapper for safe querying
 *
 * @param {Object} whereConditions - Firestore where conditions
 * @returns {Promise<Object[]>}
 */
async function queryIntents(whereConditions = {}) {
  try {
    let query = db.collection('binance_execution_intents');

    // Apply conditions if provided
    for (const [field, value] of Object.entries(whereConditions)) {
      query = query.where(field, '==', value);
    }

    const snapshot = await query.get();
    return snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('Error querying intents:', error.message);
    return [];
  }
}

/**
 * GET INTENT - Safe retrieval
 *
 * @param {string} intentId
 * @returns {Promise<Object|null>}
 */
async function getIntent(intentId) {
  try {
    const snap = await db.collection('binance_execution_intents').doc(intentId).get();
    if (!snap.exists) return null;
    return { id: snap.id, ...snap.data() };
  } catch (error) {
    console.error(`Error getting intent ${intentId}:`, error.message);
    return null;
  }
}

/**
 * VALIDATE CONTRACT COMPLIANCE
 *
 * @param {Object} contract - Execution contract
 * @param {Object} originalIntent - Original intent data (for context)
 * @returns {string[]} - Array of validation warnings
 */
function validateContractCompliance(contract, originalIntent = {}) {
  const warnings = [];

  // Check status
  if (!['created', 'sent', 'executed', 'closed'].includes(contract.status)) {
    warnings.push(`Invalid status: ${contract.status}`);
  }

  // Check executed/closed requirements
  if ((contract.status === 'executed' || contract.status === 'closed')) {
    if (!contract.executed_at) {
      warnings.push(`Status is ${contract.status} but executed_at is missing`);
    }
    if (contract.win_model === null || contract.win_model === 'PENDING') {
      warnings.push(`Status is ${contract.status} but win_model is not set`);
    }
  }

  // Check delay_ms
  if (contract.delay_ms !== null && contract.delay_ms < 0) {
    warnings.push(`Negative delay_ms: ${contract.delay_ms}`);
  }

  return warnings;
}

/**
 * DELETE INTENT - RESTRICTED (only for data cleanup)
 *
 * Intents should NEVER be deleted in production.
 * This is only for administrative cleanup with explicit approval.
 *
 * @param {string} intentId - Intent to delete
 * @param {string} reason - Reason for deletion (required)
 * @returns {Promise<{success: boolean}>}
 */
async function deleteIntent(intentId, reason = '') {
  if (!reason) {
    throw new Error('Deletion requires explicit reason');
  }

  console.warn(`⚠ DELETING intent ${intentId} - Reason: ${reason}`);

  try {
    await db.collection('binance_execution_intents').doc(intentId).delete();
    console.log(`✓ Intent ${intentId} deleted`);
    return { success: true };
  } catch (error) {
    console.error(`Error deleting intent ${intentId}:`, error.message);
    return { success: false, error: error.message };
  }
}

/**
 * RESTORE FROM BACKUP - Recover deleted/corrupted intent
 *
 * @param {string} intentId
 * @param {Object} backupData - Full intent backup
 * @returns {Promise<{success: boolean}>}
 */
async function restoreFromBackup(intentId, backupData = {}) {
  if (!backupData.id) {
    throw new Error('Backup data must include intent id');
  }

  console.log(`↩ Restoring intent ${intentId} from backup`);

  try {
    const restore = {
      ...backupData,
      restored_at: new Date().toISOString(),
      restored_from_backup: true
    };

    await db.collection('binance_execution_intents').doc(intentId).set(restore, { merge: true });
    console.log(`✓ Intent ${intentId} restored from backup`);
    return { success: true };
  } catch (error) {
    console.error(`Error restoring intent ${intentId}:`, error.message);
    return { success: false, error: error.message };
  }
}

module.exports = {
  updateIntent,
  batchUpdateIntents,
  queryIntents,
  getIntent,
  validateContractCompliance,
  deleteIntent,
  restoreFromBackup
};
