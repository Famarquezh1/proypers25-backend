/**
 * EXECUTION CONTRACT - SINGLE SOURCE OF TRUTH
 *
 * Defines the official execution contract for binance_execution_intents
 *
 * ⚡ GOLDEN RULE:
 * win_model is the ONLY field frontend reads for results
 *
 * All other fields (execution_audit.win_exchange, verification_outcome) are
 * legacy/historical and must be synced to win_model, never read directly
 */

/**
 * Check if string is valid ISO 8601 datetime
 */
function isValidIsoString(str) {
  if (typeof str !== 'string') return false;
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  if (!isoRegex.test(str)) return false;
  const date = new Date(str);
  return !isNaN(date.getTime());
}

/**
 * Extract the official win_model result from all possible sources
 * Priority: execution_audit.win_exchange > verification_outcome > win_model
 *
 * @param {Object} intent - Intent document
 * @returns {string|null} - WIN, LOSS, BREAKEVEN, or null
 */
function extractOfficialWinModel(intent) {
  if (!intent) return null;

  // Priority 1: execution_audit.win_exchange (most recent source)
  if (intent?.execution_audit?.win_exchange &&
      intent.execution_audit.win_exchange !== 'PENDING' &&
      intent.execution_audit.win_exchange !== 'UNKNOWN') {
    return intent.execution_audit.win_exchange;
  }

  // Priority 2: verification_outcome (high_conviction signals)
  if (intent?.verification_outcome &&
      intent.verification_outcome !== 'PENDING' &&
      intent.verification_outcome !== 'UNKNOWN') {
    return intent.verification_outcome;
  }

  // Priority 3: top-level win_model
  if (intent?.win_model &&
      intent.win_model !== 'PENDING' &&
      intent.win_model !== 'UNKNOWN') {
    return intent.win_model;
  }

  // No result found
  return null;
}

/**
 * Extract timestamp from multiple possible field locations
 * Handles alternative field names from different execution sources
 */
function extractTimestamp(intent, primaryField, fallbackFields = []) {
  // Try primary field
  if (intent?.[primaryField]) {
    const ts = intent[primaryField];
    if (isValidIsoString(ts)) return ts;
  }

  // Try fallback fields
  for (const fallback of fallbackFields) {
    if (intent?.[fallback]) {
      const ts = intent[fallback];
      if (isValidIsoString(ts)) return ts;
    }

    // Also check nested in execution_audit
    if (intent?.execution_audit?.[fallback]) {
      const ts = intent.execution_audit[fallback];
      if (isValidIsoString(ts)) return ts;
    }
  }

  return null;
}

/**
 * Calculate delay in milliseconds
 */
function calculateDelayMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  if (!isValidIsoString(fromIso) || !isValidIsoString(toIso)) return null;

  try {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const delay = to - from;
    return delay >= 0 ? delay : null;
  } catch (err) {
    return null;
  }
}

/**
 * Determine lifecycle status based on timestamps
 */
function determineStatus(created, sent, executed, closed) {
  if (closed) return 'closed';
  if (executed) return 'executed';
  if (sent) return 'sent';
  if (created) return 'created';
  return 'created';
}

/**
 * BUILD EXECUTION CONTRACT - MAIN FUNCTION
 *
 * Creates the official contract for an intent
 * Ensures compliance with single source of truth (win_model)
 *
 * @param {Object} intent - Raw intent document from Firestore
 * @returns {Object} Contract object with all required fields
 */
function buildExecutionContract(intent) {
  if (!intent) return null;

  // Extract timestamps with fallback support
  const intent_created_at = extractTimestamp(
    intent,
    'intent_created_at',
    ['created_at', 'created']
  );

  const sent_to_exchange_at = extractTimestamp(
    intent,
    'sent_to_exchange_at',
    ['sent_at', 'execution_audit.sent_at']
  );

  const executed_at = extractTimestamp(
    intent,
    'executed_at',
    ['execution_time', 'execution_audit.executed_at', 'filled_at']
  );

  const closed_at = extractTimestamp(
    intent,
    'closed_at',
    ['close_time', 'execution_audit.closed_at']
  );

  // Extract official win_model (from any source)
  const win_model = extractOfficialWinModel(intent);

  // Calculate delay
  const delay_ms = calculateDelayMs(intent_created_at, executed_at);

  // Determine status
  const status = determineStatus(intent_created_at, sent_to_exchange_at, executed_at, closed_at);

  // Extract source (if available)
  const source = String(intent?.source_profile || intent?.source || 'high_conviction').toLowerCase();

  // Build contract
  const contract = {
    // Identity
    intent_id: intent?.id || intent?.intent_id || null,
    symbol: intent?.symbol || null,
    source: ['high_conviction', 'event_emitted', 'manual_prealert'].includes(source)
      ? source
      : 'high_conviction',

    // Lifecycle timestamps
    intent_created_at,
    sent_to_exchange_at,
    executed_at,
    closed_at,

    // Metrics
    delay_ms,

    // Result (SINGLE SOURCE OF TRUTH)
    win_model,

    // Status
    status
  };

  return contract;
}

/**
 * Check if intent complies with execution contract
 */
function isValidContract(intent) {
  if (!intent) return false;

  const contract = buildExecutionContract(intent);
  if (!contract) return false;

  // Must have status
  if (!['created', 'sent', 'executed', 'closed'].includes(contract.status)) {
    return false;
  }

  // If executed or closed, must have executed_at
  if ((contract.status === 'executed' || contract.status === 'closed') && !contract.executed_at) {
    return false;
  }

  // If executed or closed and we have result, must have win_model
  if ((contract.status === 'executed' || contract.status === 'closed') &&
      (contract.win_model === null || contract.win_model === 'PENDING')) {
    return false;
  }

  return true;
}

/**
 * Build Firestore update object to enforce contract
 * Updates win_model and other fields to match contract
 */
function buildContractUpdate(intent) {
  const contract = buildExecutionContract(intent);
  if (!contract) return null;

  // Build update object with dot notation for nested fields
  const update = {
    'intent_created_at': contract.intent_created_at,
    'sent_to_exchange_at': contract.sent_to_exchange_at,
    'executed_at': contract.executed_at,
    'closed_at': contract.closed_at,
    'delay_ms': contract.delay_ms,
    'win_model': contract.win_model,
    'status': contract.status,
    'source': contract.source,

    // Also update nested execution_audit for consistency
    'execution_audit.intent_created_at': contract.intent_created_at,
    'execution_audit.sent_to_exchange_at': contract.sent_to_exchange_at,
    'execution_audit.executed_at': contract.executed_at,
    'execution_audit.closed_at': contract.closed_at,
    'execution_audit.delay_ms': contract.delay_ms,
    'execution_audit.win_model': contract.win_model,
    'execution_audit.status': contract.status,
    'execution_audit.source': contract.source
  };

  return update;
}

/**
 * Batch validate contracts for multiple intents
 */
function validateContractsBatch(intents) {
  if (!Array.isArray(intents)) return { valid: 0, invalid: 0, details: [] };

  const result = {
    valid: 0,
    invalid: 0,
    details: []
  };

  for (const intent of intents) {
    const valid = isValidContract(intent);
    if (valid) {
      result.valid++;
    } else {
      result.invalid++;
      const contract = buildExecutionContract(intent);
      result.details.push({
        id: intent?.id,
        issues: {
          status: contract.status,
          missing_created_at: !contract.intent_created_at,
          missing_executed_at: !contract.executed_at,
          missing_win_model: contract.status === 'executed' && !contract.win_model,
          zero_delay: contract.delay_ms === 0
        }
      });
    }
  }

  return result;
}

/**
 * Get detailed status of an intent against contract
 */
function getContractStatus(intent) {
  const contract = buildExecutionContract(intent);
  const valid = isValidContract(intent);

  return {
    valid,
    contract,
    compliance: {
      has_intent_created_at: !!contract.intent_created_at,
      has_sent_to_exchange_at: !!contract.sent_to_exchange_at,
      has_executed_at: !!contract.executed_at,
      has_closed_at: !!contract.closed_at,
      has_delay_ms: contract.delay_ms !== null,
      has_win_model: contract.win_model !== null,
      status_valid: ['created', 'sent', 'executed', 'closed'].includes(contract.status)
    }
  };
}

module.exports = {
  buildExecutionContract,
  isValidContract,
  buildContractUpdate,
  validateContractsBatch,
  getContractStatus,
  extractOfficialWinModel,
  extractTimestamp,
  calculateDelayMs,
  determineStatus,
  isValidIsoString
};
