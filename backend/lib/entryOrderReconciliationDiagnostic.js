function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 6));
  const windowMs = sinceExplicit
    ? Math.max(1, until.getTime() - sinceExplicit.getTime())
    : options.days
      ? days * 24 * 60 * 60 * 1000
      : hours * 60 * 60 * 1000;

  return {
    since: sinceExplicit || new Date(until.getTime() - windowMs),
    until
  };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.updated_at) || parseDateLike(row.created_at);
}

function reconciliationOf(row = {}) {
  const data = row.entry_order_reconciliation;
  return data && typeof data === 'object' ? data : null;
}

function classifyReconciliationRow(row = {}) {
  const reconciliation = reconciliationOf(row) || {};
  const result = String(reconciliation.result || '').trim();
  if (row.needs_reconciliation === true && (!result || result === 'pending_reconciliation')) {
    return 'pending_due_to_no_production_trigger';
  }
  if (result === 'order_found_after_timeout' || result === 'order_filled_after_timeout') {
    return 'order_found_after_timeout';
  }
  if (result === 'order_not_found_after_timeout') return 'order_not_found_after_timeout';
  if (result === 'order_rejected_after_timeout') return 'order_rejected_after_timeout';
  if (result === 'binance_lookup_timeout') return 'binance_lookup_timeout';
  if (result === 'binance_lookup_error') return 'binance_lookup_error';
  if (result === 'still_unknown' || result === 'still_unknown_after_lookup') return 'still_unknown_after_lookup';
  return result || null;
}

async function getEntryOrderReconciliationDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'updated_at', maxDocs);
  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });
  const reconciliationRows = intents.filter((row) => row.needs_reconciliation === true || reconciliationOf(row));
  const pendingRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'pending_due_to_no_production_trigger');
  const foundRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'order_found_after_timeout');
  const notFoundRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'order_not_found_after_timeout');
  const filledRows = reconciliationRows.filter((row) => String(reconciliationOf(row)?.result || '') === 'order_filled_after_timeout');
  const rejectedRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'order_rejected_after_timeout');
  const lookupTimeoutRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'binance_lookup_timeout');
  const lookupErrorRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'binance_lookup_error');
  const stillUnknownRows = reconciliationRows.filter((row) => classifyReconciliationRow(row) === 'still_unknown_after_lookup');
  const latest = reconciliationRows
    .slice()
    .sort((a, b) => (resolveIntentTimestamp(b)?.getTime?.() || 0) - (resolveIntentTimestamp(a)?.getTime?.() || 0))[0] || null;
  const symbolsAffected = Array.from(new Set(
    reconciliationRows.map((row) => String(row.intent?.symbol || row.symbol || '').toUpperCase()).filter(Boolean)
  )).sort();

  const samples = reconciliationRows
    .slice()
    .sort((a, b) => (resolveIntentTimestamp(b)?.getTime?.() || 0) - (resolveIntentTimestamp(a)?.getTime?.() || 0))
    .slice(0, 5)
    .map((row) => {
      const reconciliation = reconciliationOf(row) || {};
      return {
        intent_id: row.id,
        symbol: String(row.intent?.symbol || row.symbol || '').toUpperCase() || null,
        side: row.intent?.side || null,
        client_order_id:
          row.live_order_diagnostics?.entry_order_diagnostics?.client_order_id ||
          reconciliation.client_order_id ||
          null,
        order_status_local: row.status || null,
        created_at: parseDateLike(row.created_at)?.toISOString() || null,
        last_reconciliation_at: reconciliation.reconciled_at || null,
        last_error_message:
          reconciliation.error_message ||
          row.live_order_diagnostics?.last_error_message ||
          row.error_message ||
          null,
        classification: classifyReconciliationRow(row)
      };
    });

  return {
    pending_reconciliation_count: pendingRows.length,
    reconciled_found_count: foundRows.length,
    reconciled_not_found_count: notFoundRows.length,
    reconciled_filled_count: filledRows.length,
    reconciled_rejected_count: rejectedRows.length,
    still_unknown_count: stillUnknownRows.length,
    pending_due_to_no_production_trigger_count: pendingRows.length,
    binance_lookup_timeout_count: lookupTimeoutRows.length,
    binance_lookup_error_count: lookupErrorRows.length,
    still_unknown_after_lookup_count: stillUnknownRows.length,
    symbols_affected: symbolsAffected,
    avg_reconciliation_delay_ms: round(average(
      reconciliationRows.map((row) => reconciliationOf(row)?.reconciliation_delay_ms)
    ), 0),
    last_reconciliation_result: classifyReconciliationRow(latest || {}),
    samples
  };
}

module.exports = {
  getEntryOrderReconciliationDiagnostic
};
