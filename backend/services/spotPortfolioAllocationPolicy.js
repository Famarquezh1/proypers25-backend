'use strict';

const VERSION = 'spot_portfolio_allocation_policy_v1';

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, asNumber(value, min)));
}

function buildPortfolioAllocationPolicy({ balance = {}, config = {}, openPositions = 0, healthState = 'CRITICAL' } = {}) {
  const availableUsdt = Math.max(0, asNumber(balance.available_usdt));
  const inPositionsUsdt = Math.max(0, asNumber(balance.in_positions_usdt));
  const totalUsdt = Math.max(0, asNumber(balance.total_usdt, availableUsdt + inPositionsUsdt));
  const reservePct = clamp(config.portfolio_reserve_pct ?? 0.25, 0.15, 0.5);
  const maxOpenPositions = Math.round(clamp(config.portfolio_max_positions ?? config.max_open_positions ?? 4, 1, 6));
  const maxPositionPct = clamp(config.portfolio_max_position_pct ?? 0.2, 0.05, 0.3);
  const hardPositionCap = clamp(config.portfolio_position_cap_usdt ?? 100, 10, 150);
  const configuredTotalCap = Math.max(0, asNumber(config.max_total_capital_usdt, totalUsdt));
  const reserveUsdt = totalUsdt * reservePct;
  const portfolioDeployable = Math.max(0, totalUsdt - reserveUsdt);
  const cappedDeployable = configuredTotalCap > 0 ? Math.min(portfolioDeployable, configuredTotalCap) : portfolioDeployable;
  const remainingDeployable = Math.max(0, cappedDeployable - inPositionsUsdt);
  const slotsRemaining = Math.max(0, maxOpenPositions - Math.max(0, Math.floor(asNumber(openPositions))));
  const perSlotBudget = slotsRemaining > 0 ? remainingDeployable / slotsRemaining : 0;
  const suggestedPositionUsdt = healthState === 'HEALTHY'
    ? Math.floor(Math.min(availableUsdt, perSlotBudget, totalUsdt * maxPositionPct, hardPositionCap) * 100) / 100
    : 0;

  const reasons = [];
  if (healthState !== 'HEALTHY') reasons.push('PORTFOLIO_HEALTH_NOT_GREEN');
  if (slotsRemaining <= 0) reasons.push('MAX_OPEN_POSITIONS_REACHED');
  if (remainingDeployable < 10) reasons.push('INSUFFICIENT_DEPLOYABLE_CAPITAL');
  if (availableUsdt < 10) reasons.push('INSUFFICIENT_AVAILABLE_USDT');

  return {
    version: VERSION,
    advisory_only: true,
    health_state: healthState,
    entry_allowed: healthState === 'HEALTHY' && suggestedPositionUsdt >= 10 && reasons.length === 0,
    total_portfolio_usdt: totalUsdt,
    available_usdt: availableUsdt,
    in_positions_usdt: inPositionsUsdt,
    reserve_pct: reservePct,
    reserve_usdt: reserveUsdt,
    deployable_cap_usdt: cappedDeployable,
    remaining_deployable_usdt: remainingDeployable,
    max_open_positions: maxOpenPositions,
    open_positions: Math.max(0, Math.floor(asNumber(openPositions))),
    slots_remaining: slotsRemaining,
    suggested_position_usdt: suggestedPositionUsdt >= 10 ? suggestedPositionUsdt : 0,
    block_reasons: reasons
  };
}

module.exports = {
  VERSION,
  buildPortfolioAllocationPolicy
};