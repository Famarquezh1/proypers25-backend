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

function round(value, decimals = 4) {
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

function normalizeReason(row = {}) {
  return String(
    row.reason ||
    row.final_evaluation?.reason ||
    row.validation?.reason ||
    row.execution_discipline?.reason ||
    row.error_message ||
    ''
  ).trim() || 'unknown';
}

function deriveDiagnosis(report = {}) {
  if (report.execution_score != null && report.minimum_required != null && report.execution_score < report.minimum_required) {
    return 'execution_score_issue';
  }
  if (report.protection_flags?.price_moved_too_much) return 'late_entry';
  if (report.protection_flags?.slippage_too_high) return 'slippage_issue';
  if (report.protection_flags?.spread_too_high) return 'spread_issue';
  if (report.protection_flags?.low_liquidity) return 'liquidity_issue';
  return 'spread_issue';
}

async function getExecutionProtectionDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);
  const blocked = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until && normalizeReason(row) === 'execution_protection_mode';
  });

  const latest = blocked[0] || {};
  const details = latest.execution_discipline || {};
  const guard = latest.execution_guard || {};
  const snapshot = latest.entry_execution_snapshot || {};
  const micro = snapshot.microstructure || guard.microstructure || {};

  const spreadValues = blocked
    .map((row) => toNumber(row.entry_execution_snapshot?.microstructure?.spread_bps, null))
    .filter(Number.isFinite)
    .map((bps) => bps / 100);
  const slippageValues = blocked
    .map((row) => toNumber(row.entry_execution_snapshot?.estimated_slippage_pct ?? row.execution_guard?.estimatedSlippagePct, null))
    .filter(Number.isFinite);
  const moveSinceSignalValues = blocked
    .map((row) => toNumber(row.entry_execution_snapshot?.price_deviation_pct ?? row.execution_guard?.priceDeviationPct, null))
    .filter(Number.isFinite);
  const volatilityValues = blocked
    .map((row) => toNumber(row.entry_execution_snapshot?.microstructure?.velocity, null))
    .filter(Number.isFinite);
  const depthValues = blocked
    .map((row) => toNumber(row.entry_execution_snapshot?.microstructure?.recent_trades_window ?? row.execution_guard?.microstructure?.recent_trades_window, null))
    .filter(Number.isFinite);
  const markVsLastValues = blocked
    .map((row) => {
      const last = toNumber(row.entry_execution_snapshot?.microstructure?.last_price, null);
      const ref = toNumber(row.entry_execution_snapshot?.execution_reference_price ?? row.execution_guard?.executionReferencePrice, null);
      if (!Number.isFinite(last) || !Number.isFinite(ref) || last <= 0) return null;
      return Math.abs(((ref - last) / last) * 100);
    })
    .filter(Number.isFinite);

  const executionScore = toNumber(details.execution_score, null);
  const minimumRequired = toNumber(details.minimum_required, null);

  const report = {
    spread_pct: round(average(spreadValues)),
    slippage_estimate_pct: round(average(slippageValues)),
    mark_vs_last_diff_pct: round(average(markVsLastValues)),
    volatility_short_window: round(average(volatilityValues)),
    orderbook_depth: round(average(depthValues), 2),
    price_move_since_signal_pct: round(average(moveSinceSignalValues)),
    protection_flags: {
      spread_too_high: spreadValues.some((value) => value > 0.08),
      slippage_too_high: slippageValues.some((value) => value > 0.45),
      price_moved_too_much: moveSinceSignalValues.some((value) => value > 0.75),
      low_liquidity: depthValues.some((value) => value < 1),
      volatility_spike: volatilityValues.some((value) => Math.abs(value) > 7)
    },
    execution_score: executionScore,
    minimum_required: minimumRequired,
    block_source: executionScore != null && minimumRequired != null && executionScore < minimumRequired
      ? 'execution_score_guard'
      : 'microstructure_guard'
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getExecutionProtectionDiagnostic
};
