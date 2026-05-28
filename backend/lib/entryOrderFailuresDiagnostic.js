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
  const hours = Math.max(0.1, Number(options.hours || 1));
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
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function resolveEntryOrderDiagnostics(row = {}) {
  const diagnostics = row.live_order_diagnostics?.entry_order_diagnostics;
  return diagnostics && typeof diagnostics === 'object' ? diagnostics : null;
}

function inferTimeoutStage(row = {}) {
  const diagnostics = resolveEntryOrderDiagnostics(row) || {};
  if (diagnostics.timeout_stage) return diagnostics.timeout_stage;
  const failureStage = String(row.failure_stage || row.processing_stage || '').toLowerCase();
  if (failureStage.includes('wait_binance_response')) return 'wait_binance_response';
  if (failureStage.includes('send_order_request')) return 'send_order_request';
  if (failureStage.includes('parse_order_response')) return 'parse_order_response';
  const message = String(
    diagnostics.error_message ||
    row.live_order_diagnostics?.last_error_message ||
    row.error_message ||
    row.last_error_message ||
    ''
  ).toLowerCase();
  if (message.includes('(entry_order)')) return 'wait_binance_response';
  return null;
}

function hasEntryOrderAttempt(row = {}) {
  if (resolveEntryOrderDiagnostics(row)) return true;
  const stages = Array.isArray(row.live_order_diagnostics?.stages) ? row.live_order_diagnostics.stages : [];
  return stages.some((stage) => String(stage?.stage || '') === 'order_submit');
}

function classifyEntryOrder(row = {}) {
  const diagnostics = resolveEntryOrderDiagnostics(row) || {};
  const errorMessage = String(
    diagnostics.error_message ||
    row.live_order_diagnostics?.last_error_message ||
    row.error_message ||
    row.last_error_message ||
    ''
  ).toLowerCase();
  const result = String(diagnostics.result || '').toLowerCase();
  if (result === 'success' || String(row.status || '').toLowerCase() === 'executed') return 'success';
  if (errorMessage.includes('timeout') || String(diagnostics.timeout_stage || '').trim()) return 'timeout';
  if (
    Number.isFinite(Number(diagnostics.binance_code)) ||
    errorMessage.includes('rejected') ||
    errorMessage.includes('order rejected')
  ) {
    return 'rejected';
  }
  return 'unknown';
}

function buildDiagnosis(report = {}) {
  if (Number(report.entry_order_timeout || 0) > 0) {
    const stage = String(report.last_timeout_stage || '').toLowerCase();
    if (stage.includes('sign_request')) return 'signed_request_timeout';
    if (stage.includes('wait_binance_response') || stage.includes('send_order_request')) return 'binance_response_timeout';
    if (stage.includes('persist_order_result')) return 'order_persist_timeout';
    if (stage.includes('build_order_payload')) return 'order_payload_issue';
    return 'unknown_entry_order_timeout';
  }
  if (Number(report.entry_order_rejected || 0) > 0) return 'binance_rejection';
  if (Number(report.entry_order_success || 0) > 0) return 'ready_for_order_submit';
  return 'unknown_entry_order_timeout';
}

async function getEntryOrderFailuresDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);
  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const entryRows = intents.filter(hasEntryOrderAttempt);
  const successRows = entryRows.filter((row) => classifyEntryOrder(row) === 'success');
  const timeoutRows = entryRows.filter((row) => classifyEntryOrder(row) === 'timeout');
  const rejectedRows = entryRows.filter((row) => classifyEntryOrder(row) === 'rejected');
  const unknownRows = entryRows.filter((row) => classifyEntryOrder(row) === 'unknown');
  const sortByLatest = (a, b) => {
    const aTs = resolveIntentTimestamp(a)?.getTime?.() || 0;
    const bTs = resolveIntentTimestamp(b)?.getTime?.() || 0;
    return bTs - aTs;
  };
  const lastRow = entryRows
    .slice()
    .sort(sortByLatest)[0] || null;
  const lastFailureRow = [...timeoutRows, ...rejectedRows, ...unknownRows]
    .slice()
    .sort(sortByLatest)[0] || null;
  const lastDiagnostics = resolveEntryOrderDiagnostics((lastFailureRow || lastRow) || {}) || {};
  const symbolsAffected = Array.from(
    new Set(
      entryRows
        .map((row) => String(row.intent?.symbol || row.symbol || '').toUpperCase())
        .filter(Boolean)
    )
  ).sort();

  const report = {
    entry_order_attempts: entryRows.length,
    entry_order_success: successRows.length,
    entry_order_timeout: timeoutRows.length,
    entry_order_rejected: rejectedRows.length,
    entry_order_unknown: unknownRows.length,
    avg_entry_order_duration_ms: round(average(entryRows.map((row) => {
      const diagnostics = resolveEntryOrderDiagnostics(row);
      if (Number.isFinite(Number(diagnostics?.duration_ms))) return diagnostics.duration_ms;
      const stage = Array.isArray(row.live_order_diagnostics?.stages)
        ? row.live_order_diagnostics.stages.find((item) => String(item?.stage || '') === 'order_submit')
        : null;
      return stage?.duration_ms;
    })), 0),
    symbols_affected: symbolsAffected,
    last_error_message:
      lastDiagnostics.error_message ||
      rowOrNull(lastFailureRow?.live_order_diagnostics?.last_error_message) ||
      rowOrNull(lastRow?.live_order_diagnostics?.last_error_message),
    last_http_status: toNumber(lastDiagnostics.http_status, null),
    last_binance_code: toNumber(lastDiagnostics.binance_code, null),
    last_binance_msg: lastDiagnostics.binance_msg || null,
    last_timeout_stage: inferTimeoutStage(lastFailureRow || lastRow || {})
  };

  return {
    ...report,
    diagnosis: buildDiagnosis(report)
  };
}

function rowOrNull(value) {
  return value == null ? null : value;
}

module.exports = {
  getEntryOrderFailuresDiagnostic
};
