/**
 * AUTO-SYNC WIN_MODEL HOOK
 *
 * This module provides a hook that automatically syncs win_model
 * whenever win_exchange is updated in binance_execution_intents.
 *
 * This ensures all intents have consistent win_model values
 * regardless of the source (high_conviction, event_emitted, etc.)
 */

/**
 * Auto-sync win_model when win_exchange is set
 * Called from updateExecutionIntentOutcome in binancePositionManager
 *
 * @param {Object} updatePayload - The payload being written to the intent
 * @returns {Object} - Augmented payload with win_model synced
 */
function syncWinModelFromExchange(updatePayload) {
  if (!updatePayload) return updatePayload;

  const winExchange = updatePayload.win_exchange;

  // If win_exchange is being set, also sync win_model
  if (winExchange && winExchange !== 'PENDING' && winExchange !== 'UNKNOWN') {
    return {
      ...updatePayload,
      // Top-level fields
      win_model: winExchange,
      // Nested in execution_audit
      execution_audit: {
        ...(updatePayload.execution_audit || {}),
        win_model: winExchange
      }
    };
  }

  return updatePayload;
}

/**
 * Build normalized sync payload for intents with win_exchange
 *
 * Used when we detect an intent has win_exchange but win_model is PENDING
 *
 * @param {Object} intentData - Intent document data
 * @returns {Object|null} - Update payload to fix the mismatch
 */
function buildWinModelSyncPayload(intentData) {
  if (!intentData) return null;

  const winExchange = intentData?.execution_audit?.win_exchange;
  const winModel = intentData?.execution_audit?.win_model;

  // Only sync if we have a result in win_exchange but win_model is still PENDING
  if (!winExchange || winExchange === 'PENDING' || !winModel || winModel === 'PENDING') {
    return null;
  }

  // If already matching, no need to sync
  if (winModel === winExchange) {
    return null;
  }

  // Build sync payload
  return {
    'execution_audit.win_model': winExchange,
    'win_model': winExchange,
    'execution_audit.synced_at': new Date().toISOString(),
    'execution_audit.synced_from': 'auto_exchange_sync'
  };
}

/**
 * Batch sync win_model for all intents with win_exchange mismatch
 * Can be run periodically to fix any intents that slipped through
 * CENTRALIZED: Uses executionContractService for all writes
 *
 * @param {Object} db - Firestore instance
 * @param {Object} options - Options for sync operation
 * @returns {Promise<Object>} - Sync statistics
 */
async function batchSyncWinModelsFromExchange(db, options = {}) {
  if (!db) return { scanned: 0, synced: 0, errors: 0 };

  const limit = Math.min(500, Number(options.limit || 100));
  const showProgress = Boolean(options.showProgress);

  try {
    // Import here to avoid circular dependency
    const { updateIntent } = require('./executionContractService');

    // Find all intents with win_exchange set but win_model still PENDING
    const snapshot = await db.collection('binance_execution_intents')
      .where('execution_audit.win_model', '==', 'PENDING')
      .where('execution_audit.win_exchange', '!=', 'PENDING')
      .limit(limit)
      .get();

    let synced = 0;
    let errors = 0;

    for (const doc of snapshot.docs) {
      const data = doc.data();
      const payload = buildWinModelSyncPayload(data);

      if (!payload) continue;

      try {
        // CENTRALIZED: Use executionContractService instead of direct batch.update
        const result = await updateIntent(doc.id, payload);
        if (result.success) {
          synced++;
          if (showProgress && synced % 50 === 0) {
            console.log(`[WIN_MODEL_SYNC] Synced ${synced} intents...`);
          }
        } else {
          console.error(`[WIN_MODEL_SYNC] Contract validation failed for ${doc.id}:`, result.validationErrors);
          errors++;
        }
      } catch (err) {
        console.error(`[WIN_MODEL_SYNC] Error updating intent ${doc.id}:`, err.message);
        errors++;
      }
    }

    return {
      scanned: snapshot.size,
      synced,
      errors
    };
  } catch (error) {
    console.error('[WIN_MODEL_SYNC] Batch sync error:', error.message);
    return { scanned: 0, synced: 0, errors: 1 };
  }
}

module.exports = {
  syncWinModelFromExchange,
  buildWinModelSyncPayload,
  batchSyncWinModelsFromExchange
};
