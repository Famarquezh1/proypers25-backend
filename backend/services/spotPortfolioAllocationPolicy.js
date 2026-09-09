'use strict';

const { resolveAdaptiveManagedSpotLimits } = require('./spotManagedAcquisitionPolicy');

const VERSION = 'spot_portfolio_allocation_policy_v3_adaptive_capital';

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
  const managedLimits = resolveAdaptiveManagedSpotLimits({ config, operationalCapitalUsdt: totalUsdt });
  const maxManagedAssets = managedLimits.max_managed_spot_assets;
  const reservePct = clamp(1 - Number(managedLimits.deployable_capital_pct || 0.75), 0.15, 0.75);
  const reserveUsdt = Math.max(0, totalUsdt - managedLimits.max_total_managed_capital_usdt);
  const cappedDeployable = managedLimits.max_total_managed_capital_usdt;
  const remainingDeployable = Math.max(0, cappedDeployable - inPositionsUsdt);
  const slotsRemaining = Math.max(0, maxManagedAssets - Math.max(0, Math.floor(asNumber(openPositions))));
  const suggestedPositionUsdt = healthState === 'HEALTHY' && slotsRemaining > 0
    ? Math.floor(Math.min(availableUsdt, remainingDeployable, managedLimits.max_per_acquisition_usdt) * 100) / 100
    : 0;

  const reasons = [];
  if (healthState !== 'HEALTHY') reasons.push('PORTFOLIO_HEALTH_NOT_GREEN');
  if (slotsRemaining <= 0) reasons.push('MAX_MANAGED_SPOT_ASSETS_REACHED');
  if (remainingDeployable < (managedLimits.min_adaptive_acquisition_usdt || 10)) reasons.push('INSUFFICIENT_DEPLOYABLE_CAPITAL');
  if (availableUsdt < (managedLimits.min_adaptive_acquisition_usdt || 10)) reasons.push('INSUFFICIENT_AVAILABLE_USDT');

  return {
    version: VERSION,
    advisory_only: true,
    terminology: 'managed_spot_acquisitions',
    sizing_mode: managedLimits.sizing_mode,
    health_state: healthState,
    entry_allowed: healthState === 'HEALTHY' && suggestedPositionUsdt >= (managedLimits.min_adaptive_acquisition_usdt || 10) && reasons.length === 0,
    total_portfolio_usdt: totalUsdt,
    available_usdt: availableUsdt,
    in_positions_usdt: inPositionsUsdt,
    reserve_pct: reservePct,
    reserve_usdt: reserveUsdt,
    deployable_cap_usdt: cappedDeployable,
    remaining_deployable_usdt: remainingDeployable,
    max_managed_spot_assets: maxManagedAssets,
    max_open_positions: maxManagedAssets,
    managed_spot_assets: Math.max(0, Math.floor(asNumber(openPositions))),
    open_positions: Math.max(0, Math.floor(asNumber(openPositions))),
    slots_remaining: slotsRemaining,
    suggested_position_usdt: suggestedPositionUsdt,
    adaptive_max_position_usdt: managedLimits.max_per_acquisition_usdt,
    operational_capital_usdt: managedLimits.operational_capital_usdt || totalUsdt,
    deployable_capital_pct: managedLimits.deployable_capital_pct || null,
    position_capital_pct: managedLimits.position_capital_pct || null,
    block_reasons: reasons
  };
}

module.exports = {
  VERSION,
  buildPortfolioAllocationPolicy
};
