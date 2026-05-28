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
  if (value === null || value === undefined || value === '') return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 4) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values
    .map((value) => (value === null || value === undefined || value === '' ? null : Number(value)))
    .filter(Number.isFinite);
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
    row.final_reason ||
    row.skip_reason ||
    row.fail_reason ||
    row.execution_discipline?.reason ||
    row.validation?.reason ||
    row.error_message ||
    ''
  ).trim() || 'unknown';
}

function resolveLifecycle(row = {}) {
  const signalCreatedAt =
    parseDateLike(row.high_conviction_lifecycle?.signal_created_at) ||
    resolveSignalCreatedAt(row);
  const intentAttemptAt = parseDateLike(row.high_conviction_lifecycle?.intent_attempt_at);
  const intentCreatedAt = resolveIntentCreatedAt(row);
  const ageMs = toNumber(
    row.high_conviction_lifecycle?.age_ms ??
      (signalCreatedAt && intentAttemptAt ? intentAttemptAt.getTime() - signalCreatedAt.getTime() : null),
    resolveSignalAgeMs(row)
  );
  const handoffDelayMs = toNumber(
    row.high_conviction_lifecycle?.handoff_delay_ms ??
      (signalCreatedAt && intentCreatedAt ? intentCreatedAt.getTime() - signalCreatedAt.getTime() : null),
    null
  );
  return {
    signal_created_at: signalCreatedAt,
    intent_attempt_at: intentAttemptAt,
    intent_created_at: intentCreatedAt,
    age_ms: ageMs,
    max_entry_window_ms: toNumber(row.high_conviction_lifecycle?.max_entry_window_ms, resolveEntryWindowMs(row)),
    handoff_delay_ms: handoffDelayMs
  };
}

function resolveSourceProfile(row = {}) {
  return String(row.source_profile || row.intent?.source_profile || row.source || '').toLowerCase();
}

function resolveSignalCreatedAt(row = {}) {
  const millis = toNumber(row.execution_trace?.signal_created_at, null);
  if (Number.isFinite(millis)) return new Date(millis);
  return (
    parseDateLike(row.execution_discipline?.signal_time) ||
    parseDateLike(row.execution_audit?.signal_at) ||
    parseDateLike(row.created_at)
  );
}

function resolveIntentCreatedAt(row = {}) {
  const millis = toNumber(row.execution_trace?.intent_created_at, null);
  if (Number.isFinite(millis)) return new Date(millis);
  return parseDateLike(row.created_at);
}

function resolveExpectedMovePct(row = {}) {
  return toNumber(
    row.intent?.expected_move_percent ??
      row.expected_move_percent ??
      row.execution_guard?.expectedMovePercent,
    null
  );
}

function resolveSignalAgeMs(row = {}) {
  return toNumber(
    row.execution_discipline?.signal_age_ms ??
      row.execution_discipline?.execution_delay_ms,
    null
  );
}

function resolveEntryWindowMs(row = {}) {
  return toNumber(row.execution_discipline?.entry_window_seconds, null) != null
    ? Number(row.execution_discipline.entry_window_seconds) * 1000
    : null;
}

function resolvePriceAtSignal(row = {}) {
  const candidates = [
    row.intent?.entry_price,
    row.execution_guard?.signalPrice,
    row.entry_execution_snapshot?.signal_price,
    row.execution_audit?.entry_price
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function resolvePriceAtValidation(row = {}) {
  const candidates = [
    row.entry_execution_snapshot?.execution_reference_price,
    row.execution_guard?.executionReferencePrice,
    row.entry_execution_snapshot?.microstructure?.last_price,
    row.execution_guard?.microstructure?.last_price
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function resolveMoveSinceSignalPct(row = {}) {
  const fromSnapshot = toNumber(
    row.entry_execution_snapshot?.price_deviation_pct ??
      row.execution_guard?.priceDeviationPct,
    null
  );
  if (fromSnapshot != null) return fromSnapshot;
  const signalPrice = resolvePriceAtSignal(row);
  const validationPrice = resolvePriceAtValidation(row);
  if (!Number.isFinite(signalPrice) || signalPrice <= 0 || !Number.isFinite(validationPrice) || validationPrice <= 0) {
    return null;
  }
  return ((validationPrice - signalPrice) / signalPrice) * 100;
}

function inferStopLossMissingReason(row = {}) {
  const stopLoss = toNumber(row.intent?.stop_loss, null);
  const side = String(row.intent?.side || '').toUpperCase();
  const entryPrice = toNumber(row.intent?.entry_price, null);
  if (stopLoss == null) return 'stop_loss_missing';
  if (stopLoss === 0) return 'stop_loss_zero';
  if (stopLoss < 0) return 'stop_loss_negative';
  if (!side) return 'side_missing_for_stop_loss_validation';
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return 'entry_price_missing_for_stop_loss_validation';
  if (side === 'BUY' && stopLoss >= entryPrice) return 'stop_loss_not_below_entry';
  if (side === 'SELL' && stopLoss <= entryPrice) return 'stop_loss_not_above_entry';
  return 'stop_loss_invalid';
}

function isMissingStopLoss(row = {}) {
  const stopLoss = toNumber(row.intent?.stop_loss, null);
  return stopLoss == null || stopLoss === 0;
}

function isInvalidStopLoss(row = {}) {
  const stopLoss = toNumber(row.intent?.stop_loss, null);
  if (stopLoss == null || stopLoss === 0) return false;
  if (stopLoss < 0) return true;
  const side = String(row.intent?.side || '').toUpperCase();
  const entryPrice = toNumber(row.intent?.entry_price, null);
  if (!side || !Number.isFinite(entryPrice) || entryPrice <= 0) return false;
  if (side === 'BUY' && stopLoss >= entryPrice) return true;
  if (side === 'SELL' && stopLoss <= entryPrice) return true;
  return false;
}

function buildLateEntrySample(row = {}) {
  const lifecycle = resolveLifecycle(row);
  const signalCreatedAt = lifecycle.signal_created_at || resolveSignalCreatedAt(row);
  const intentCreatedAt = lifecycle.intent_created_at || resolveIntentCreatedAt(row);
  return {
    intent_id: row.id,
    symbol: row.intent?.symbol || row.symbol || null,
    signal_created_at: signalCreatedAt?.toISOString() || null,
    intent_created_at: intentCreatedAt?.toISOString() || null,
    age_ms: resolveSignalAgeMs(row),
    max_allowed_age_ms: lifecycle.max_entry_window_ms ?? resolveEntryWindowMs(row),
    price_at_signal: round(resolvePriceAtSignal(row), 8),
    price_at_validation: round(resolvePriceAtValidation(row), 8),
    move_since_signal_pct: round(resolveMoveSinceSignalPct(row), 4)
  };
}

function buildStopLossSample(row = {}) {
  return {
    intent_id: row.id,
    symbol: row.intent?.symbol || row.symbol || null,
    stop_loss_value: round(toNumber(row.intent?.stop_loss, null), 8),
    atr: round(toNumber(row.intent?.atr ?? row.intent?.trade_plan?.atr, null), 8),
    volatility: round(
      toNumber(
        row.intent?.volatility_context_score ??
          row.intent?.volatility ??
          row.execution_guard?.entryQualityComponents?.volatility,
        null
      ),
      8
    ),
    side: row.intent?.side || null,
    entry_price: round(toNumber(row.intent?.entry_price, null), 8),
    reason_stop_loss_missing: inferStopLossMissingReason(row)
  };
}

function deriveDiagnosis(report = {}) {
  const late = Number(report.late_entry_blocked || 0);
  const stopLoss = Number(report.stop_loss_required || 0);
  const tradePlanInvalid = Number(report.trade_plan_invalid_count || 0);
  const avgMove = Number(report.avg_price_move_since_signal_pct || 0);
  const avgExpected = Number(report.avg_expected_move_pct || 0);
  const avgHandoffDelay = Number(report.avg_handoff_delay_ms || 0);
  const avgWindow = Number(report.avg_entry_window_ms || 0);

  if ((late > 0 || stopLoss > 0) && tradePlanInvalid > 0) return 'mixed';
  if (tradePlanInvalid > 0) return 'trade_plan_generation_issue';
  if (late > 0 && stopLoss > 0) return 'mixed';
  if (stopLoss > 0) return 'trade_plan_generation_issue';
  if (late > 0 && avgHandoffDelay > 0 && avgWindow > 0 && avgHandoffDelay > avgWindow) return 'high_conviction_handoff_delayed';
  if (late > 0 && avgMove > 0 && avgExpected > 0 && avgMove >= avgExpected * 0.8) {
    return 'market_moved_before_entry';
  }
  if (late > 0 && avgWindow > 0 && avgHandoffDelay > 0 && avgHandoffDelay <= avgWindow) {
    return 'high_conviction_window_too_short';
  }
  if (late > 0) return 'high_conviction_late';
  return 'mixed';
}

async function getHighConvictionBlocksDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return (
      ts &&
      ts >= since &&
      ts <= until &&
      resolveSourceProfile(row) === 'high_conviction'
    );
  });

  const lateRows = intents.filter((row) => normalizeReason(row) === 'late_entry_blocked');
  const stopLossRows = intents.filter((row) => normalizeReason(row) === 'stop_loss_required');
  const tradePlanInvalidRows = intents.filter((row) => normalizeReason(row) === 'trade_plan_invalid');
  const symbolsAffected = Array.from(
    new Set(
      [...lateRows, ...stopLossRows, ...tradePlanInvalidRows]
        .map((row) => String(row.intent?.symbol || row.symbol || '').toUpperCase())
        .filter(Boolean)
    )
  ).sort();
  const lifecycleRows = intents.map((row) => ({ row, lifecycle: resolveLifecycle(row) }));
  const createdCount = lifecycleRows.filter(({ lifecycle }) => lifecycle.signal_created_at).length;
  const attemptedCount = lifecycleRows.filter(({ lifecycle }) => lifecycle.intent_attempt_at || lifecycle.intent_created_at).length;
  const withinWindowCount = lifecycleRows.filter(({ lifecycle }) => {
    return lifecycle.age_ms != null && lifecycle.max_entry_window_ms != null && lifecycle.age_ms <= lifecycle.max_entry_window_ms;
  }).length;
  const lateCount = lifecycleRows.filter(({ lifecycle }) => {
    return lifecycle.age_ms != null && lifecycle.max_entry_window_ms != null && lifecycle.age_ms > lifecycle.max_entry_window_ms;
  }).length;

  const report = {
    total_high_conviction_intents: intents.length,
    high_conviction_created_count: createdCount,
    high_conviction_intent_attempted_count: attemptedCount,
    high_conviction_intent_within_window_count: withinWindowCount,
    high_conviction_intent_late_count: lateCount,
    late_entry_blocked: lateRows.length,
    stop_loss_required: stopLossRows.length,
    trade_plan_invalid_count: tradePlanInvalidRows.length,
    avg_signal_age_ms: round(average(intents.map(resolveSignalAgeMs)), 0),
    avg_price_move_since_signal_pct: round(average(intents.map(resolveMoveSinceSignalPct)), 4),
    avg_expected_move_pct: round(average(intents.map(resolveExpectedMovePct)), 4),
    avg_entry_window_ms: round(average(intents.map(resolveEntryWindowMs)), 0),
    avg_handoff_delay_ms: round(average(lifecycleRows.map(({ lifecycle }) => lifecycle.handoff_delay_ms)), 0),
    missing_stop_loss_count: stopLossRows.filter(isMissingStopLoss).length,
    invalid_stop_loss_count: stopLossRows.filter(isInvalidStopLoss).length,
    symbols_affected: symbolsAffected,
    late_entry_samples: lateRows.slice(0, 5).map(buildLateEntrySample),
    stop_loss_samples: stopLossRows.slice(0, 5).map(buildStopLossSample)
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getHighConvictionBlocksDiagnostic
};
