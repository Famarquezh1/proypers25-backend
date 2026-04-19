/**
 * LIFECYCLE NORMALIZATION UTILITY
 *
 * Ensures all binance_execution_intents have consistent:
 * - Lifecycle stages (created → sent → executed → closed)
 * - Timestamp fields for each stage
 * - Accurate delay_ms calculations
 * - Consistent status and win_model
 *
 * Handles fragmented field patterns from different execution sources
 */

/**
 * Extract timestamp from multiple possible field locations
 * Priority order: specific field → fallback → now
 */
function extractTimestamp(intent, primaryField, fallbackFields = [], includeNow = false) {
  // Try primary field first
  if (intent?.[primaryField]) {
    const ts = intent[primaryField];
    if (isValidIsoString(ts)) return ts;
  }

  // Try fallback fields in order
  for (const fallback of fallbackFields) {
    if (intent?.[fallback]) {
      const ts = intent[fallback];
      if (isValidIsoString(ts)) return ts;
    }

    // Also check nested execution_audit
    if (intent?.execution_audit?.[fallback]) {
      const ts = intent.execution_audit[fallback];
      if (isValidIsoString(ts)) return ts;
    }
  }

  // Return now if allowed and nothing found
  return includeNow ? new Date().toISOString() : null;
}

/**
 * Check if string is valid ISO 8601 datetime
 */
function isValidIsoString(str) {
  if (typeof str !== 'string') return false;
  // Must match ISO format: YYYY-MM-DDTHH:mm:ss
  const isoRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
  if (!isoRegex.test(str)) return false;
  // Must be valid date
  const date = new Date(str);
  return !isNaN(date.getTime());
}

/**
 * Calculate delay in milliseconds between two ISO strings
 */
function calculateDelayMs(fromIso, toIso) {
  if (!fromIso || !toIso) return null;
  if (!isValidIsoString(fromIso) || !isValidIsoString(toIso)) return null;

  try {
    const from = new Date(fromIso).getTime();
    const to = new Date(toIso).getTime();
    const delay = to - from;
    // Return null if calculation results in negative or unreasonable value
    return delay >= 0 ? delay : null;
  } catch (err) {
    return null;
  }
}

/**
 * Extract win result from multiple field locations
 */
function extractWinModel(intent) {
  // Try execution_audit.win_exchange first (most reliable)
  if (intent?.execution_audit?.win_exchange && intent.execution_audit.win_exchange !== 'PENDING') {
    return intent.execution_audit.win_exchange;
  }

  // Try top-level win_exchange
  if (intent?.win_exchange && intent.win_exchange !== 'PENDING') {
    return intent.win_exchange;
  }

  // Try execution_audit.win_model
  if (intent?.execution_audit?.win_model && intent.execution_audit.win_model !== 'PENDING') {
    return intent.execution_audit.win_model;
  }

  // Try top-level win_model
  if (intent?.win_model && intent.win_model !== 'PENDING') {
    return intent.win_model;
  }

  // Try verification_outcome
  if (intent?.verification_outcome && intent.verification_outcome !== 'PENDING') {
    return intent.verification_outcome;
  }

  // Default to PENDING if no result found
  return 'PENDING';
}

/**
 * Determine lifecycle status based on timestamps
 */
function determineStatus(timestamps) {
  const { closed_at, executed_at, sent_to_exchange_at } = timestamps;

  if (closed_at) return 'closed';
  if (executed_at) return 'executed';
  if (sent_to_exchange_at) return 'sent';
  return 'created';
}

/**
 * MAIN FUNCTION: Normalize complete lifecycle of an intent
 *
 * Extracts and validates all lifecycle fields, ensuring consistency
 *
 * @param {Object} intent - Intent document data
 * @returns {Object} Normalized lifecycle object with all fields
 */
function normalizeLifecycle(intent) {
  if (!intent) return null;

  // Extract created timestamp (should always exist)
  const intent_created_at = extractTimestamp(
    intent,
    'intent_created_at',
    ['created_at', 'created'],
    false
  );

  // Extract sent timestamp (when sent to Binance)
  const sent_to_exchange_at = extractTimestamp(
    intent,
    'sent_to_exchange_at',
    ['sent_at', 'execution_audit.sent_at'],
    false
  );

  // Extract executed timestamp (when order filled)
  const executed_at = extractTimestamp(
    intent,
    'executed_at',
    ['execution_time', 'execution_audit.executed_at', 'filled_at'],
    false
  );

  // Extract closed timestamp (when position closed)
  const closed_at = extractTimestamp(
    intent,
    'closed_at',
    ['close_time', 'execution_audit.closed_at'],
    false
  );

  // Calculate delay from creation to execution (ms)
  const delay_ms = calculateDelayMs(intent_created_at, executed_at);

  // Extract win model (result)
  const win_model = extractWinModel(intent);

  // Determine status based on available timestamps
  const status = determineStatus({ closed_at, executed_at, sent_to_exchange_at });

  // Build normalized object
  const normalized = {
    // Lifecycle timestamps
    intent_created_at: intent_created_at || null,
    sent_to_exchange_at: sent_to_exchange_at || null,
    executed_at: executed_at || null,
    closed_at: closed_at || null,

    // Metrics
    delay_ms: delay_ms,

    // Result
    win_model: win_model,

    // Status
    status: status,

    // Normalization metadata
    normalized: true,
    normalized_at: new Date().toISOString()
  };

  return normalized;
}

/**
 * Check if intent needs normalization
 *
 * An intent needs normalization if:
 * - Missing any lifecycle timestamps
 * - Has inconsistent status
 * - Has PENDING win_model but result exists
 * - delay_ms is missing or 0
 */
function needsNormalization(intent) {
  if (!intent) return false;

  const missing = !intent.intent_created_at || !intent.sent_to_exchange_at || !intent.executed_at;
  const inconsistentStatus = intent.status && !['created', 'sent', 'executed', 'closed'].includes(intent.status);
  const pendingButHasResult = intent.win_model === 'PENDING' && (
    intent?.execution_audit?.win_exchange ||
    intent?.execution_audit?.win_model ||
    intent?.verification_outcome
  );
  const zeroDelay = intent.delay_ms === 0;

  return missing || inconsistentStatus || pendingButHasResult || zeroDelay;
}

/**
 * Build Firestore update object from normalized lifecycle
 * Uses dot notation for nested fields
 */
function buildLifecycleUpdate(normalized) {
  if (!normalized) return null;

  return {
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
}

/**
 * Batch normalize multiple intents
 *
 * @param {Array} intents - Array of intent documents
 * @returns {Array} Array of {docId, normalized, update} objects
 */
function batchNormalizeLifecycles(intents) {
  if (!Array.isArray(intents)) return [];

  const results = [];

  for (const intent of intents) {
    if (!intent.id && !intent.docId) continue;

    const docId = intent.id || intent.docId;
    const normalized = normalizeLifecycle(intent);

    if (!normalized) continue;

    const update = buildLifecycleUpdate(normalized);

    results.push({
      docId,
      normalized,
      update
    });
  }

  return results;
}

/**
 * Comprehensive status for an intent
 * Returns all lifecycle details for debugging/analysis
 */
function getLifecycleStatus(intent) {
  const normalized = normalizeLifecycle(intent);

  return {
    // Current state
    current: {
      intent_created_at: intent?.intent_created_at || null,
      sent_to_exchange_at: intent?.sent_to_exchange_at || null,
      executed_at: intent?.executed_at || null,
      closed_at: intent?.closed_at || null,
      delay_ms: intent?.delay_ms || null,
      win_model: intent?.win_model || 'PENDING',
      status: intent?.status || 'unknown'
    },

    // Normalized state
    normalized: normalized,

    // Needs fixing?
    needsNormalization: needsNormalization(intent),

    // Gaps identified
    gaps: {
      missing_intent_created_at: !intent?.intent_created_at,
      missing_sent_to_exchange_at: !intent?.sent_to_exchange_at,
      missing_executed_at: !intent?.executed_at,
      missing_closed_at: !intent?.closed_at && intent?.status === 'closed',
      zero_or_missing_delay_ms: !intent?.delay_ms || intent?.delay_ms === 0,
      pending_win_model: intent?.win_model === 'PENDING',
      inconsistent_status: intent?.status && !['created', 'sent', 'executed', 'closed'].includes(intent?.status)
    }
  };
}

module.exports = {
  normalizeLifecycle,
  needsNormalization,
  buildLifecycleUpdate,
  batchNormalizeLifecycles,
  getLifecycleStatus,
  extractTimestamp,
  extractWinModel,
  calculateDelayMs,
  isValidIsoString,
  determineStatus
};
