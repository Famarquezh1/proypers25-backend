'use strict';

const VERSION = 'spot_portfolio_health_v1';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, number(value, min)));
}

function calculateSuggestedAllocation(balance, config, healthState) {
  const available = Math.max(0, number(balance?.available_usdt));
  const inPositions = Math.max(0, number(balance?.in_positions_usdt));
  const total = Math.max(0, number(balance?.total_usdt, available + inPositions));
  const reservePct = clamp(config?.portfolio_reserve_pct ?? 0.25, 0.15, 0.5);
  const maxPositions = Math.round(clamp(config?.portfolio_max_positions ?? 4, 2, 6));
  const maxPositionPct = clamp(config?.portfolio_max_position_pct ?? 0.2, 0.08, 0.3);
  const hardCap = clamp(config?.portfolio_position_cap_usdt ?? 100, 10, 150);
  const reserve = total * reservePct;
  const deployable = Math.max(0, total - reserve);
  const remaining = Math.max(0, deployable - inPositions);
  const suggested = healthState === 'HEALTHY'
    ? Math.floor(Math.min(available, remaining, deployable / maxPositions, total * maxPositionPct, hardCap) * 100) / 100
    : 0;
  return {
    advisory_only: true,
    total_portfolio_usdt: total,
    available_usdt: available,
    in_positions_usdt: inPositions,
    reserve_usdt: reserve,
    reserve_pct: reservePct,
    deployable_total_usdt: deployable,
    remaining_deployable_usdt: remaining,
    suggested_max_open_positions: maxPositions,
    suggested_position_usdt: suggested >= 10 ? suggested : 0
  };
}

function assessPortfolioHealth({ config, reconciliation, exitStatus, balance, adaptive, promotion }) {
  const critical = [];
  const degraded = [];

  if (config?.enabled !== true) critical.push('REAL_SPOT_NOT_ENABLED');
  if (config?.kill_switch === true) critical.push('KILL_SWITCH_ACTIVE');
  if (config?.real_sells_enabled !== true) critical.push('REAL_SELLS_NOT_ENABLED');
  if (config?.auto_order_execution !== true) critical.push('AUTO_ORDER_EXECUTION_DISABLED');
  if (config?.spot_only !== true) critical.push('SPOT_ONLY_GUARD_FAILED');
  if (config?.futures_allowed === true) critical.push('FUTURES_ALLOWED');
  if (config?.margin_allowed === true) critical.push('MARGIN_ALLOWED');
  if (config?.leverage_allowed === true) critical.push('LEVERAGE_ALLOWED');
  if (config?.withdrawals_allowed !== false) critical.push('WITHDRAWALS_NOT_DISABLED');
  if (config?.account_consistent === false || config?.reconciliation_required === true) critical.push('ACCOUNT_RECONCILIATION_REQUIRED');
  if (reconciliation?.account_consistent === false || number(reconciliation?.inconsistencies) > 0) critical.push('LAST_RECONCILIATION_FAILED');
  if (exitStatus?.blocked === true || exitStatus?.exit_engine_healthy === false || exitStatus?.ok === false) critical.push('EXIT_ENGINE_UNHEALTHY');
  if (!balance) critical.push('BALANCE_UNAVAILABLE');

  if (adaptive?.state && !['ACTIVE', 'HEALTHY', 'GREEN'].includes(String(adaptive.state).toUpperCase())) degraded.push('ADAPTIVE_STRATEGY_DEGRADED');
  if (promotion?.state && promotion.state !== 'PROMOTED_LIMITED') degraded.push('RESEARCH_NOT_PROMOTED');

  const state = critical.length ? 'CRITICAL' : degraded.length ? 'DEGRADED' : 'HEALTHY';
  const exitBlockingReasons = new Set([
    'REAL_SELLS_NOT_ENABLED',
    'AUTO_ORDER_EXECUTION_DISABLED',
    'SPOT_ONLY_GUARD_FAILED',
    'FUTURES_ALLOWED',
    'MARGIN_ALLOWED',
    'LEVERAGE_ALLOWED',
    'WITHDRAWALS_NOT_DISABLED'
  ]);

  return {
    state,
    entry_allowed: state === 'HEALTHY',
    exit_allowed: !critical.some((reason) => exitBlockingReasons.has(reason)),
    critical_reasons: critical,
    degraded_reasons: degraded,
    version: VERSION
  };
}

module.exports = {
  VERSION,
  assessPortfolioHealth,
  calculateSuggestedAllocation
};