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
  const closed = asNumber(exits?.positions_closed ?? exits?.closed_positions ?? exits?.sold ?? exits?.orders_executed, 0);
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

function summarizeCandidateAudit(paperGate = {}) {
  const audit = Array.isArray(paperGate?.candidate_pool_audit) ? paperGate.candidate_pool_audit : [];
  const tacticalReady = audit.filter((candidate) => candidate.tactical_allowed === true);
  const earlyReady = audit.filter((candidate) => candidate.early_momentum_allowed === true);
  const standardReady = audit.filter((candidate) => candidate.standard_allowed === true);
  const tacticalRejections = audit.flatMap((candidate) => candidate.tactical_reasons || []);
  const earlyRejections = audit.flatMap((candidate) => candidate.early_momentum_reasons || []);
  const countReasons = (reasons) => reasons.reduce((acc, reason) => {
    acc[reason] = (acc[reason] || 0) + 1;
    return acc;
  }, {});
  const topReasons = (counts) => Object.entries(counts)
    .sort((left, right) => right[1] - left[1])
    .slice(0, 5)
    .map(([reason, count]) => ({ reason, count }));
  return {
    audited_candidates: audit.length,
    standard_ready_count: standardReady.length,
    early_momentum_ready_count: earlyReady.length,
    early_momentum_ready_symbols: earlyReady.slice(0, 10).map((candidate) => candidate.symbol),
    tactical_ready_count: tacticalReady.length,
    tactical_ready_symbols: tacticalReady.slice(0, 10).map((candidate) => candidate.symbol),
    top_early_momentum_rejection_reasons: topReasons(countReasons(earlyRejections)),
    top_tactical_rejection_reasons: topReasons(countReasons(tacticalRejections))
  };
}

function buildSpotCycleDecisionLog(input = {}) {
  const {
    reconciliation = {}, exits = {}, autonomy = {}, adaptiveGate = {}, promotionGate = {}, paperGate = {}, entries = {},
    openPositionsAfterCycle = 0, durationMs = 0, config = {}, discovery = {}, paperValidation = {}, safetyFailures = []
  } = input;
  const candidate = paperGate?.candidate || entries?.candidate || entries?.entry_diagnostic?.approved_candidate || null;
  const action = inferAction(entries, exits);
  const exitDiagnostics = buildExitDiagnostics(exits);
  const opportunityAudit = summarizeCandidateAudit(paperGate);
  const explicitFailures = Array.isArray(entries?.failed_conditions) && entries.failed_conditions.length ? entries.failed_conditions : safetyFailures;
  const exactFailureCodes = explicitFailures.map((failure) => failure.code || failure.condition).filter(Boolean);
  const reasons = compactReasons(
    exitDiagnostics.failure_reasons,
    exactFailureCodes,
    entries?.reason,
    entries?.gate_reasons || [],
    paperGate?.reasons || [],
    adaptiveGate?.reasons || [],
    autonomy?.halt_reason,
    reconciliation?.entries_blocked ? 'ACCOUNT_RECONCILIATION_BLOCKED' : null,
    exits?.blocked ? 'EXIT_ENGINE_BLOCKED' : null
  );
  const entryMode = firstNonEmpty(paperGate?.entry_mode, candidate?.entry_mode, entries?.entry_mode);
  const selectionLane = firstNonEmpty(paperGate?.selection_lane, candidate?.selection_lane, entries?.selection_lane);

  return {
    event: 'SPOT_REAL_CYCLE_DECISION',
    timestamp: new Date().toISOString(),
    action,
    decision: action === 'NO_ACTION' ? 'SKIP' : 'EXECUTED',
    reason: reasons[0] || null,
    reasons,
    failed_conditions: explicitFailures,
    entry_mode: entryMode,
    selection_lane: selectionLane,
    tactical_entry: entryMode === 'TACTICAL_MOMENTUM',
    early_momentum_entry: selectionLane === 'EARLY_MOMENTUM',
    candidate: candidate ? {
      symbol: firstNonEmpty(candidate.symbol, entries?.symbol, entries?.selected_symbol),
      score: firstNonEmpty(candidate.score, candidate.opportunityScore, candidate.opportunity_score),
      category: firstNonEmpty(candidate.category),
      scan_id: firstNonEmpty(candidate.scan_id, paperGate?.latest_scan_id),
      entry_mode: entryMode,
      selection_lane: selectionLane,
      price_change_24h: firstNonEmpty(candidate.priceChange24h, candidate.price_change_24h),
      impulse_score: firstNonEmpty(candidate.impulseScore, candidate.impulse_score),
      liquidity_score: firstNonEmpty(candidate.liquidityScore, candidate.liquidity_score),
      risk_score: firstNonEmpty(candidate.riskScore, candidate.risk_score),
      early_momentum_score: firstNonEmpty(candidate.earlyMomentumScore, candidate.early_momentum_score),
      early_momentum: candidate.earlyMomentum || candidate.early_momentum || null
    } : null,
    gates: {
      reconciliation: reconciliation?.account_consistent === true && reconciliation?.entries_blocked !== true ? 'PASS' : 'BLOCK',
      exit_engine: exits?.ok !== false && exits?.blocked !== true && exits?.exit_engine_healthy !== false ? 'PASS' : 'BLOCK',
      autonomy: autonomy?.should_halt === true ? 'BLOCK' : 'PASS',
      adaptive: adaptiveGate?.allowed === false ? 'BLOCK' : 'PASS',
      promotion: promotionGate?.high_confidence === true ? 'CONFIDENCE_HIGH' : 'CONFIDENCE_LOW',
      promotion_blocks_entry: false,
      paper_to_real: paperGate?.allowed === true ? 'PASS' : 'BLOCK',
      early_momentum: selectionLane === 'EARLY_MOMENTUM' ? (paperGate?.allowed === true ? 'PASS' : 'BLOCK') : 'NOT_SELECTED',
      tactical_momentum: entryMode === 'TACTICAL_MOMENTUM' ? (paperGate?.allowed === true ? 'PASS' : 'BLOCK') : 'NOT_SELECTED',
      technical_confirmation: paperGate?.technical_confirmation?.allowed === true ? 'PASS' : paperGate?.technical_confirmation ? 'BLOCK' : 'NOT_REACHED'
    },
    market: {
      regime: firstNonEmpty(adaptiveGate?.regime?.regime, adaptiveGate?.regime, adaptiveGate?.market_regime, adaptiveGate?.state),
      promoted_symbol: firstNonEmpty(promotionGate?.symbol),
      promotion_state: firstNonEmpty(promotionGate?.state, promotionGate?.status),
      promotion_indicator_only: true,
      discovery_scan_id: discovery?.scan_id || null,
      assets_analyzed: asNumber(discovery?.total_symbols_scanned, 0),
      candidates_ranked: asNumber(discovery?.candidates_saved, 0),
      top_symbol: discovery?.top_symbol || null,
      top_score: discovery?.top_score ?? null,
      early_momentum_radar: paperGate?.early_momentum_radar || null,
      opportunity_audit: opportunityAudit
    },
    paper_validation: {
      latest_scan_id: paperValidation?.latest_scan_id || discovery?.scan_id || null,
      intents_created: asNumber(paperValidation?.intents_created, 0),
      intents_rejected: asNumber(paperValidation?.intents_rejected, 0),
      positions_closed: asNumber(paperValidation?.positions_closed, 0)
    },
    execution: {
      positions_opened: asNumber(entries?.positions_opened ?? entries?.opened_positions, 0),
      positions_closed: asNumber(exits?.positions_closed ?? exits?.closed_positions ?? exits?.sold, 0),
      open_positions_after_cycle: asNumber(openPositionsAfterCycle, 0),
      exit_failures: exitDiagnostics.failure_count,
      order_created: entries?.order_created === true,
      selected_symbol: entries?.selected_symbol || entries?.symbol || candidate?.symbol || null,
      entry_mode: entryMode,
      selection_lane: selectionLane,
      duration_ms: asNumber(durationMs, 0)
    },
    exit_diagnostics: exitDiagnostics,
    safety: {
      spot_only: config?.spot_only === true,
      max_position_usdt: asNumber(config?.max_position_usdt ?? config?.max_capital_per_trade_usdt, 0),
      max_open_positions: asNumber(config?.max_open_positions, 0),
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
  compactReasons,
  summarizeCandidateAudit
};
