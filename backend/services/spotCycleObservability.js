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
  const reasons = compactReasons(
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
      exit_failures: Array.isArray(exits?.failures) ? exits.failures.length : 0,
      duration_ms: asNumber(durationMs, 0)
    },
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
  logSpotCycleDecision,
  inferAction,
  compactReasons
};