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

function resolveUpdatedMs(row = {}) {
  return (
    parseDateLike(row.updated_at)?.getTime?.() ||
    parseDateLike(row.created_at)?.getTime?.() ||
    0
  );
}

function resolveSymbol(row = {}) {
  return String(row.intent?.symbol || row.symbol || row.live_order_diagnostics?.symbol || '').toUpperCase() || null;
}

function resolveErrorMessage(row = {}) {
  return String(
    row.live_order_diagnostics?.last_error_message ||
    row.last_error_message ||
    row.error_message ||
    row.execution_error ||
    ''
  ).trim() || null;
}

function hasLiveOrderAttempt(row = {}) {
  if (row.live_order_diagnostics?.attempted) return true;
  if (String(row.failure_stage || '').toLowerCase() === 'live_order') return true;
  if (String(row.processing_stage || '').toLowerCase() === 'order_placed') return true;
  if (String(row.status || '').toLowerCase() === 'executed' && row.exchange_response?.order) return true;
  return Boolean(row.exchange_response?.margin || row.exchange_response?.leverage || row.exchange_response?.order);
}

function isLiveOrderSuccess(row = {}) {
  const status = String(row.status || '').toLowerCase();
  const result = String(row.live_order_diagnostics?.result || '').toLowerCase();
  return status === 'executed' || result === 'executed';
}

function isLiveOrderFailed(row = {}) {
  if (!hasLiveOrderAttempt(row)) return false;
  if (String(row.status || '').toLowerCase() === 'failed') return true;
  return String(row.live_order_diagnostics?.result || '').toLowerCase() === 'failed';
}

function getStages(row = {}) {
  return Array.isArray(row.live_order_diagnostics?.stages) ? row.live_order_diagnostics.stages : [];
}

function getStage(row = {}, stageName) {
  return getStages(row).filter((stage) => String(stage?.stage || '') === String(stageName || ''));
}

function classifyLiveOrderFailure(row = {}) {
  const message = String(resolveErrorMessage(row) || '').toLowerCase();
  const reason = String(row.reason || row.fail_reason || row.final_reason || '').toLowerCase();
  const failureStage = String(
    row.live_order_diagnostics?.failure_stage ||
    row.failure_stage ||
    row.processing_stage ||
    ''
  ).toLowerCase();

  if (
    reason.includes('min_notional_risk_blocked') ||
    message.includes('min_notional_risk_blocked')
  ) {
    return 'min_notional_risk_blocked';
  }
  if (
    reason.includes('margin_leverage_not_ready') ||
    message.includes('margin_leverage_not_ready') ||
    failureStage.includes('margin_leverage_preflight') ||
    row.live_order_diagnostics?.margin_leverage_not_ready === true
  ) {
    return 'margin_leverage_not_ready';
  }
  if (
    reason.includes('margin_leverage_setup_failed') ||
    message.includes('margin_leverage_setup_failed')
  ) {
    return 'margin_leverage_setup_failed';
  }
  if (
    message.includes('margin_leverage_setup') ||
    failureStage.includes('margin_leverage_setup') ||
    String(row.live_order_diagnostics?.margin_leverage_setup_result || '').toLowerCase() === 'timeout'
  ) {
    return 'margin_leverage_hot_path_timeout';
  }
  if (message.includes('min_notional') || message.includes('-4164')) return 'min_notional_issue';
  if (message.includes('insufficient_balance') || message.includes('insufficient margin') || message.includes('insufficient')) {
    return 'balance_issue';
  }
  if (message.includes('quantity_invalid') || message.includes('invalid quantity') || message.includes('precision')) {
    return 'quantity_issue';
  }
  if (message.includes('order rejected') || message.includes('order_rejected') || message.includes('binance_order_rejected')) {
    return 'binance_rejection';
  }
  if (message.includes('binance') || message.includes('api') || message.includes('request') || message.includes('timeout')) {
    return 'binance_api_error';
  }
  return 'unknown_live_order_failure';
}

function buildDiagnosis(report = {}) {
  const hotPathCount = Number(report.margin_leverage_setup_timeout || 0);
  const notReadyCount = Number(report.margin_leverage_not_ready || 0);
  const setupFailedCount = Number(report.margin_leverage_setup_failed || 0);
  const minNotionalCount = Number(report.min_notional_failed || 0);
  const minNotionalRiskBlockedCount = Number(report.min_notional_risk_blocked || 0);
  if ((hotPathCount > 0 || notReadyCount > 0 || setupFailedCount > 0) && (minNotionalCount > 0 || minNotionalRiskBlockedCount > 0)) {
    return 'mixed_live_order_issue';
  }
  if (
    hotPathCount === 0 &&
    notReadyCount === 0 &&
    setupFailedCount === 0 &&
    minNotionalCount === 0 &&
    minNotionalRiskBlockedCount === 0 &&
    Number(report.live_order_attempts || 0) > 0
  ) {
    return 'ready_for_order_submit';
  }
  const ranked = [
    ['margin_leverage_hot_path_timeout', hotPathCount],
    ['margin_leverage_not_ready', notReadyCount],
    ['margin_leverage_setup_failed', setupFailedCount],
    ['min_notional_sizing_issue', minNotionalCount],
    ['min_notional_sizing_issue', minNotionalRiskBlockedCount],
    ['quantity_issue', Number(report.quantity_invalid || 0)],
    ['binance_rejection', Number(report.binance_order_rejected || 0)],
    ['balance_issue', Number(report.insufficient_balance || 0)],
    ['binance_api_error', Number(report.binance_api_error || 0)]
  ].sort((a, b) => b[1] - a[1]);
  if (ranked[0]?.[1] > 0) return ranked[0][0];
  return 'unknown_live_order_failure';
}

async function getLiveOrderFailuresDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const liveRows = intents.filter(hasLiveOrderAttempt);
  const successRows = liveRows.filter(isLiveOrderSuccess);
  const failedRows = liveRows.filter(isLiveOrderFailed);
  const marginSetupRows = liveRows.filter((row) => {
    if (row.live_order_diagnostics?.margin_leverage_setup_attempted) return true;
    if (getStage(row, 'margin_type_setup').length > 0 || getStage(row, 'leverage_setup').length > 0) return true;
    return true;
  });
  const marginSetupTimeoutRows = failedRows.filter(
    (row) => classifyLiveOrderFailure(row) === 'margin_leverage_hot_path_timeout'
  );
  const marginSetupFailedRows = failedRows.filter(
    (row) => classifyLiveOrderFailure(row) === 'margin_leverage_setup_failed'
  );
  const marginNotReadyRows = failedRows.filter(
    (row) => classifyLiveOrderFailure(row) === 'margin_leverage_not_ready'
  );
  const marginSetupSuccessRows = marginSetupRows.filter((row) => {
    const result = String(row.live_order_diagnostics?.margin_leverage_setup_result || '').toLowerCase();
    if (result === 'success') return true;
    return !['margin_leverage_hot_path_timeout', 'margin_leverage_setup_failed', 'margin_leverage_not_ready'].includes(
      classifyLiveOrderFailure(row)
    );
  });
  const minNotionalRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'min_notional_issue');
  const minNotionalRiskBlockedRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'min_notional_risk_blocked');
  const balanceRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'balance_issue');
  const quantityRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'quantity_issue');
  const rejectedRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'binance_rejection');
  const apiRows = failedRows.filter((row) => classifyLiveOrderFailure(row) === 'binance_api_error');
  const marginSetupReadyCount = marginSetupRows.filter((row) => Boolean(row.live_order_diagnostics?.margin_setup_ready)).length;
  const leverageSetupReadyCount = marginSetupRows.filter((row) => Boolean(row.live_order_diagnostics?.leverage_setup_ready)).length;
  const hotPathCalls = marginSetupRows.filter((row) => Boolean(row.live_order_diagnostics?.margin_leverage_hot_path_call)).length;
  const minNotionalSnapshots = [...minNotionalRows, ...minNotionalRiskBlockedRows]
    .map((row) => row.live_order_diagnostics?.min_notional_snapshot || null)
    .filter(Boolean);
  const minNotionalAllSnapshots = [...minNotionalRows, ...minNotionalRiskBlockedRows]
    .map((row) => ({
      snapshot: row.live_order_diagnostics?.min_notional_snapshot || null,
      floor: row.live_order_diagnostics?.min_notional_floor_policy || null,
      symbol: resolveSymbol(row)
    }))
    .filter((item) => item.snapshot || item.floor);
  const symbolsMinNotionalFailed = Array.from(
    new Set([...minNotionalRows, ...minNotionalRiskBlockedRows].map(resolveSymbol).filter((value) => String(value || '').trim().length > 0))
  ).sort();
  const symbolsNotReady = Array.from(
    new Set(marginNotReadyRows.map(resolveSymbol).filter((value) => String(value || '').trim().length > 0))
  ).sort();
  const symbolsNotReadyDetail = marginNotReadyRows
    .map((row) => ({
      symbol: resolveSymbol(row),
      requested_margin_type: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_margin_type || null,
      requested_leverage: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_leverage || null,
      requested_target_key: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_target_key || null,
      cached_margin_type: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_margin_type || null,
      cached_leverage: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_leverage || null,
      cached_target_key: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_target_key || null,
      target_match: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.target_match ?? null,
      mismatch_reason: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.mismatch_reason || null,
      readiness_decision_reason: row.live_order_diagnostics?.margin_leverage_readiness_snapshot?.decision_reason || null,
      readiness_snapshot: row.live_order_diagnostics?.margin_leverage_readiness_snapshot || null
    }))
    .filter((item) => item.symbol || item.readiness_snapshot);
  const symbolsAffected = Array.from(
    new Set(failedRows.map(resolveSymbol).filter((value) => String(value || '').trim().length > 0))
  ).sort();
  const minNotionalFloorAppliedRows = liveRows.filter((row) => Boolean(row.live_order_diagnostics?.min_notional_floor_applied));
  const symbolsFloorApplicable = Array.from(
    new Set(
      minNotionalAllSnapshots
        .filter((item) => item.floor?.adjustment_safe === true)
        .map((item) => item.symbol)
        .filter(Boolean)
    )
  ).sort();
  const symbolsFloorBlocked = Array.from(
    new Set(
      minNotionalAllSnapshots
        .filter((item) => item.floor?.blocked === true)
        .map((item) => item.symbol)
        .filter(Boolean)
    )
  ).sort();
  const readinessSourceUsed = Array.from(
    new Set(
      liveRows
        .map((row) => String(row.live_order_diagnostics?.readiness_source_used || '').trim().toLowerCase())
        .filter(Boolean)
    )
  ).sort();
  const symbolsTargetMismatch = Array.from(
    new Set(
      symbolsNotReadyDetail
        .filter((item) => item.target_match === false)
        .map((item) => item.symbol)
        .filter(Boolean)
    )
  ).sort();
  const lastFailedRow = failedRows
    .slice()
    .sort((a, b) => resolveUpdatedMs(b) - resolveUpdatedMs(a))[0] || null;

  const mappedReasonsBreakdown = {};
  for (const row of failedRows) {
    const key = classifyLiveOrderFailure(row);
    mappedReasonsBreakdown[key] = (mappedReasonsBreakdown[key] || 0) + 1;
  }

  const report = {
    live_order_attempts: liveRows.length,
    live_order_success: successRows.length,
    live_order_failed: failedRows.length,
    margin_leverage_setup_attempts: marginSetupRows.length,
    margin_leverage_setup_success: marginSetupSuccessRows.length,
    margin_leverage_setup_timeout: marginSetupTimeoutRows.length,
    margin_leverage_setup_failed: marginSetupFailedRows.length,
    margin_leverage_not_ready: marginNotReadyRows.length,
    avg_margin_setup_ms: round(average(
      marginSetupRows.map((row) => row.live_order_diagnostics?.margin_leverage_setup_duration_ms)
    ), 0),
    margin_setup_ready_count: marginSetupReadyCount,
    leverage_setup_ready_count: leverageSetupReadyCount,
    margin_leverage_hot_path_calls: hotPathCalls,
    min_notional_failed: minNotionalRows.length,
    min_notional_risk_blocked: minNotionalRiskBlockedRows.length,
    min_notional_floor_applied: minNotionalFloorAppliedRows.length,
    avg_notional: round(average(minNotionalSnapshots.map((item) => item.notional)), 8),
    avg_min_notional_required: round(average(minNotionalSnapshots.map((item) => item.min_notional_required)), 8),
    avg_shortfall_pct: round(average(minNotionalSnapshots.map((item) => item.shortfall_pct)), 4),
    symbols_min_notional_failed: symbolsMinNotionalFailed,
    symbols_floor_applicable: symbolsFloorApplicable,
    symbols_floor_blocked: symbolsFloorBlocked,
    symbols_not_ready: symbolsNotReady,
    symbols_not_ready_detail: symbolsNotReadyDetail,
    requested_margin_type: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_margin_type || null,
    requested_leverage: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_leverage || null,
    requested_target_key: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.requested_target_key || null,
    cached_margin_type: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_margin_type || null,
    cached_leverage: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_leverage || null,
    cached_target_key: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.cached_target_key || null,
    target_match: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.target_match ?? null,
    mismatch_reason: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot?.mismatch_reason || null,
    readiness_decision_reason: Array.from(
      new Set(symbolsNotReadyDetail.map((item) => item.readiness_decision_reason).filter(Boolean))
    ).sort(),
    readiness_snapshot: lastFailedRow?.live_order_diagnostics?.margin_leverage_readiness_snapshot || null,
    symbols_target_mismatch: symbolsTargetMismatch,
    readiness_source_used: readinessSourceUsed,
    insufficient_balance: balanceRows.length,
    quantity_invalid: quantityRows.length,
    binance_order_rejected: rejectedRows.length,
    binance_api_error: apiRows.length,
    last_error_message: resolveErrorMessage(lastFailedRow || {}),
    symbols_affected: symbolsAffected,
    repeated_margin_setup: marginSetupRows.some((row) => Boolean(row.live_order_diagnostics?.repeated_margin_setup)),
    repeated_leverage_setup: marginSetupRows.some((row) => Boolean(row.live_order_diagnostics?.repeated_leverage_setup)),
    cacheable_by_symbol: {
      margin_setup_done: Array.from(
        new Set(
          marginSetupRows
            .filter((row) => Boolean(row.live_order_diagnostics?.margin_setup_cacheable))
            .map(resolveSymbol)
            .filter(Boolean)
        )
      ).sort(),
      leverage_setup_done: Array.from(
        new Set(
          marginSetupRows
            .filter((row) => Boolean(row.live_order_diagnostics?.leverage_setup_cacheable))
            .map(resolveSymbol)
            .filter(Boolean)
        )
      ).sort()
    },
    mapped_reasons_breakdown: Object.entries(mappedReasonsBreakdown)
      .sort((a, b) => b[1] - a[1])
      .map(([key, count]) => ({ key, count }))
  };

  return {
    ...report,
    diagnosis: buildDiagnosis(report)
  };
}

module.exports = {
  getLiveOrderFailuresDiagnostic
};
