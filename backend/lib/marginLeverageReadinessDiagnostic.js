const {
  getMarginLeverageReadinessSnapshot,
  hydrateMarginLeverageReadinessFromFirestore
} = require('./binanceFuturesExecutor');

function normalizeSymbols(rawValue) {
  if (!rawValue) return [];
  if (Array.isArray(rawValue)) {
    return rawValue.map((value) => String(value || '').toUpperCase()).filter(Boolean);
  }
  return String(rawValue)
    .split(',')
    .map((value) => String(value || '').trim().toUpperCase())
    .filter(Boolean);
}

function enrichState(state = {}) {
  const lastCheckedAt = state.last_checked_at || null;
  const checkedAtMs = lastCheckedAt ? new Date(lastCheckedAt).getTime() : NaN;
  const ttlMs = Number(state.ttl_ms || 24 * 60 * 60 * 1000);
  const ageMs = Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : null;
  const normalizedSymbol = String(state.symbol || '').toUpperCase() || null;
  const marginType = String(state.margin_type || '').toUpperCase() || null;
  const leverage = Number(state.applied_leverage || state.requested_leverage || 0) || null;
  return {
    ...state,
    normalized_symbol: normalizedSymbol,
    margin_type: marginType,
    leverage,
    target_key: normalizedSymbol && marginType && leverage
      ? `${normalizedSymbol}:${marginType}:${leverage}`
      : null,
    desired_leverage: Number(state.requested_leverage || 0) || null,
    persisted_leverage: Number(state.applied_leverage || state.requested_leverage || 0) || null,
    age_ms: ageMs,
    expired: ageMs == null ? true : ageMs > ttlMs,
    source: 'memory_or_firestore_cache'
  };
}

async function getMarginLeverageReadinessDiagnostic(_db, options = {}) {
  const symbols = normalizeSymbols(options.symbols);
  const memorySnapshot = getMarginLeverageReadinessSnapshot(symbols);
  const firestoreSnapshot = await hydrateMarginLeverageReadinessFromFirestore({ symbols, force: true }).catch(() => ({
    states: [],
    fresh_states: [],
    cloud_run_revision: null,
    instance_id: null
  }));

  const firestoreStates = Array.isArray(firestoreSnapshot.states) ? firestoreSnapshot.states : [];
  const firestoreFreshStates = Array.isArray(firestoreSnapshot.fresh_states) ? firestoreSnapshot.fresh_states : [];
  const firestoreReadySymbols = new Set(
    firestoreFreshStates.filter((item) => item.ready === true).map((item) => item.symbol)
  );
  const memoryReadySymbols = new Set(
    (memorySnapshot.per_symbol || []).filter((item) => item.ready === true).map((item) => item.symbol)
  );
  const symbolsMemoryNotReadyButFirestoreReady = Array.from(firestoreReadySymbols).filter(
    (symbol) => !memoryReadySymbols.has(symbol)
  ).sort();

  let source = 'memory';
  if (firestoreStates.length > 0 && memorySnapshot.per_symbol?.length > 0) source = 'mixed';
  else if (firestoreStates.length > 0) source = 'firestore';

  return {
    ...memorySnapshot,
    per_symbol: (memorySnapshot.per_symbol || []).map(enrichState),
    source,
    cloud_run_revision: String(process.env.K_REVISION || process.env.CLOUD_RUN_REVISION || '').trim() || null,
    instance_id: String(process.env.K_INSTANCE || process.env.HOSTNAME || '').trim() || null,
    firestore_ready_count: firestoreFreshStates.filter((item) => item.ready === true).length,
    memory_ready_count: (memorySnapshot.per_symbol || []).filter((item) => item.ready === true).length,
    symbols_memory_not_ready_but_firestore_ready: symbolsMemoryNotReadyButFirestoreReady
  };
}

module.exports = {
  getMarginLeverageReadinessDiagnostic
};
