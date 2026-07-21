'use strict';

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function firstNonEmpty(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '') ?? null;
}

function compactReasons(...groups) {
  return [...new Set(groups.flat().filter(Boolean).map((value) => String(value)))];
}

function inferAction(entries, exits) {
  const opened = asNumber(entries?.positions_opened ?? entries?.opened_positions ?? entries?.orders_created, 0);
  const closed = asNumber(exits?.positions_closed ?? exits?.closed_positions ?? exits?.orders_executed, 0);
  if (closed > 0 && opened > 0) return 'SELL_AND_BUY';
  if (closed > 0) return 'SELL';
  if (opened > 0 || entries?.order_id || entries?.executed === true) return 'BUY';
  return 'NO_ACTION';
}

function normalizeExitFailure(failure, index) {
  const source = failure && typeof failure === 'object' ? failure : { message: failure };
  const error = source.error && typeof source.error === 'object' ? source.error : {};

  return {
    index,
    symbol: firstNonEmpty(source.symbol, source.pair, source.position?.symbol, source.asset),
    position_id: firstNonEmpty(source.position_id, source.positionId, source.position?.id, source.id),
    stage: firstNonEmpty(source.stage, source.phase, source.operation, source.action),
    reason: firstNonEmpty(source.reason, source.code, error.code, source.status),
    message: firstNonEmpty(source.message, error.message, typeof source.error === 'string' ? source.error : null),
    retryable: source.retryable === true,
    retry_state: firstNonEmpty(source.retry_state, source.retryState, source.next_state, source.nextState),
    attempt: asNumber(source.attempt ?? source.retry_count ?? source.retryCount, 0) || null
  };
}

function buildExitDiagnostics(exits = {}) {
  const failures = Array.isArray(exits?.failures) ? exits.failures : [];
  const normalizedFailures = failures.slice(0, 10).map(normalizeExitFailure);

  return {
    ok: exits?.ok !== false,
    blocked: exits?.blocked === true,
    healthy: exits?.exit_engine_healthy !== false,
    failure_count: failures.length,
    failure_reasons: compactReasons(normalizedFailures.map((failure) => failure.reason || failure.message)),
    failures: normalizedFailures,
    last_error: firstNonEmpty(exits?.last_error, exits?.lastError, exits?.error),
    recovery_state: firstNonEmpty(exits?.recovery_state, exits?.recoveryState, exits?.status),
    retryable_failures: normalizedFailures.filter((failure) => failure.retryable).length
  };
}

function buildSpotCycleDecisionLog(input = {}) {
  const {
    reconciliation = {},
    exits = {},
    autonomy = {},
    adaptiveGate = {},
    promotionGate = {},
    paperGate = {},
    entries = {},
    openPositionsAfterCycle = 0,
    durationMs = 0,
    config = {}
  } = input;

  const candidate = paperGate?.candidate || entries?.candidate || null;
  const action = inferAction(entries, exits);
  const exitDiagnostics = buildExitDiagnostics(exits);
  const reasons = compactReasons(
    exitDiagnostics.failure_reasons,
    entries?.reason,
    entries?.gate_reasons || [],
    paperGate?.reasons || [],
    adaptiveGate?.reasons || [],
    promotionGate?.reasons || [],
    autonomy?.halt_reason,
    reconciliation?.entries_blocked ? 'ACCOUNT_RECONCILIATION_BLOCKED' : null,
    exits?.blocked ? 'EXIT_ENGINE_BLOCKED' : null
  );

  return {
    event: 'SPOT_REAL_CYCLE_DECISION',
    timestamp: new Date().toISOString(),
    action,
    decision: action === 'NO_ACTION' ? 'SKIP' : 'EXECUTED',
    reason: reasons[0] || null,
    reasons,
    candidate: candidate ? {
      symbol: firstNonEmpty(candidate.symbol, entries?.symbol),
      score: firstNonEmpty(candidate.score, candidate.opportunityScore, candidate.opportunity_score),
      category: firstNonEmpty(candidate.category),
      scan_id: firstNonEmpty(candidate.scan_id, paperGate?.latest_scan_id)
    } : null,
    gates: {
      reconciliation: reconciliation?.account_consistent === true && reconciliation?.entries_blocked !== true ? 'PASS' : 'BLOCK',
      exit_engine: exits?.ok !== false && exits?.blocked !== true && exits?.exit_engine_healthy !== false ? 'PASS' : 'BLOCK',
      autonomy: autonomy?.should_halt === true ? 'BLOCK' : 'PASS',
      adaptive: adaptiveGate?.allowed === false ? 'BLOCK' : 'PASS',
      promotion: promotionGate?.allowed === true ? 'PASS' : 'BLOCK',
      paper_to_real: paperGate?.allowed === true ? 'PASS' : (paperGate?.skipped ? 'SKIPPED' : 'BLOCK')
    },
    market: {
      regime: firstNonEmpty(adaptiveGate?.regime, adaptiveGate?.market_regime, adaptiveGate?.state),
      promoted_symbol: firstNonEmpty(promotionGate?.symbol),
      promotion_state: firstNonEmpty(promotionGate?.state, promotionGate?.status)
    },
    execution: {
      positions_opened: asNumber(entries?.positions_opened ?? entries?.opened_positions, 0),
      positions_closed: asNumber(exits?.positions_closed ?? exits?.closed_positions, 0),
      open_positions_after_cycle: asNumber(openPositionsAfterCycle, 0),
      exit_failures: exitDiagnostics.failure_count,
      duration_ms: asNumber(durationMs, 0)
    },
    exit_diagnostics: exitDiagnostics,
    safety: {
      spot_only: config?.spot_only === true,
      max_position_usdt: asNumber(config?.max_position_usdt ?? config?.max_capital_per_trade_usdt, 0),
      futures_allowed: config?.futures_allowed === true,
      margin_allowed: config?.margin_allowed === true,
      leverage_allowed: config?.leverage_allowed === true,
      withdrawals_allowed: config?.withdrawals_allowed === true
    }
  };
}

function logSpotCycleDecision(summary, logger = console) {
  logger.log(JSON.stringify(summary));
  return summary;
}

module.exports = {
  buildSpotCycleDecisionLog,
  buildExitDiagnostics,
  normalizeExitFailure,
  logSpotCycleDecision,
  inferAction,
  compactReasons
};