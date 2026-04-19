/**
 * NORMALIZE EXECUTION RESULT
 *
 * Unifies result persistence across all intent sources:
 * - high_conviction → verification_outcome
 * - event_emitted / manual_prealert → win_exchange
 *
 * All paths should update win_model consistently
 */

/**
 * Normalize execution result from any source
 * Extracts win_model from verification_outcome or win_exchange
 *
 * @param {Object} intent - Intent or signal document data
 * @param {Object} options - Normalization options
 * @returns {Object|null} - Normalized result {win_model, status, executed_at} or null if no result
 */
function normalizeExecutionResult(intent, options = {}) {
  if (!intent) return null;

  // Try multiple sources for result
  const winExchange = intent?.execution_audit?.win_exchange;
  const verificationOutcome = intent?.verification_outcome;
  const winModel = intent?.execution_audit?.win_model;

  // Determine the actual result
  let resultValue = null;

  if (winExchange && winExchange !== 'PENDING') {
    resultValue = winExchange;
  } else if (verificationOutcome && verificationOutcome !== 'PENDING') {
    resultValue = verificationOutcome;
  }

  // If no result found or already has non-PENDING win_model, skip
  if (!resultValue) {
    return null;
  }

  // Already has correct win_model, no normalization needed
  if (winModel && winModel === resultValue && winModel !== 'PENDING') {
    return null;
  }

  const executedAt =
    intent?.execution_audit?.executed_at ||
    intent?.completed_at ||
    intent?.updated_at ||
    new Date().toISOString();

  const status = intent?.status || 'executed';

  return {
    win_model: resultValue,
    status: status === 'executed' ? 'executed' : status,
    executed_at: executedAt,
    // Track that this was normalized
    normalized: true,
    normalized_at: new Date().toISOString()
  };
}

/**
 * Check if an intent needs result normalization
 *
 * @param {Object} intent - Intent document data
 * @returns {boolean} - true if normalization is needed
 */
function needsNormalization(intent) {
  if (!intent) return false;

  const winModel = intent?.execution_audit?.win_model;
  const winExchange = intent?.execution_audit?.win_exchange;
  const verificationOutcome = intent?.verification_outcome;

  // If win_model is already set to a real result, no normalization needed
  if (winModel && winModel !== 'PENDING') {
    return false;
  }

  // If there's a result in win_exchange or verification_outcome, needs normalization
  if ((winExchange && winExchange !== 'PENDING') ||
      (verificationOutcome && verificationOutcome !== 'PENDING')) {
    return true;
  }

  return false;
}

/**
 * Build Firestore update object for normalized result
 *
 * @param {Object} normalized - Normalized result from normalizeExecutionResult()
 * @returns {Object} - Firestore update object with dot notation
 */
function buildNormalizedUpdate(normalized) {
  if (!normalized) return null;

  return {
    'execution_audit.win_model': normalized.win_model,
    'status': normalized.status,
    'execution_audit.executed_at': normalized.executed_at,
    'execution_audit.normalized': true,
    'execution_audit.normalized_at': normalized.normalized_at
  };
}

/**
 * Batch normalize multiple intents
 * Returns array of {docId, normalized, update}
 *
 * @param {Array} intents - Array of intent docs or data with id
 * @returns {Array} - Normalization results
 */
function batchNormalizeResults(intents) {
  if (!Array.isArray(intents)) return [];

  return intents
    .map(intent => {
      const data = intent.data ? intent.data() : intent;
      const docId = intent.id || intent.docId;

      if (!needsNormalization(data)) {
        return null;
      }

      const normalized = normalizeExecutionResult(data);
      if (!normalized) {
        return null;
      }

      return {
        docId,
        normalized,
        update: buildNormalizedUpdate(normalized)
      };
    })
    .filter(Boolean);
}

module.exports = {
  normalizeExecutionResult,
  needsNormalization,
  buildNormalizedUpdate,
  batchNormalizeResults
};
