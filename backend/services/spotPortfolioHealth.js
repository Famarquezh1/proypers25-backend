'use strict';

const { buildPortfolioAllocationPolicy } = require('./spotPortfolioAllocationPolicy');

const VERSION = 'spot_portfolio_health_v2';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function calculateSuggestedAllocation(balance, config, healthState, openPositions = 0) {
  const policy = buildPortfolioAllocationPolicy({
    balance,
    config,
    healthState,
    openPositions
  });
  return {
    advisory_only: true,
    total_portfolio_usdt: policy.total_portfolio_usdt,
    available_usdt: policy.available_usdt,
    in_positions_usdt: policy.in_positions_usdt,
    reserve_usdt: policy.reserve_usdt,
    reserve_pct: policy.reserve_pct,
    deployable_total_usdt: policy.deployable_cap_usdt,
    remaining_deployable_usdt: policy.remaining_deployable_usdt,
    suggested_max_open_positions: policy.max_open_positions,
    open_positions: policy.open_positions,
    slots_remaining: policy.slots_remaining,
    suggested_position_usdt: policy.suggested_position_usdt,
    entry_allowed: policy.entry_allowed,
    block_reasons: policy.block_reasons,
    policy_version: policy.version
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