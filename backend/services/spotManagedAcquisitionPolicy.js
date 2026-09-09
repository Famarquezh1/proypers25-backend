'use strict';

const MANAGED_SPOT_POLICY_VERSION = 'managed_spot_acquisition_policy_v4_adaptive_capital';
const MAX_MANAGED_SPOT_ASSETS = 4;

// Legacy/static ceilings remain available for recovery and compatibility paths.
const MAX_MANAGED_CAPITAL_USDT = 80;
const MAX_PER_ACQUISITION_USDT = 25;

// Adaptive live sizing ceilings. These are hard safety limits, not targets.
const ADAPTIVE_HARD_MAX_MANAGED_CAPITAL_USDT = 500;
const ADAPTIVE_HARD_MAX_PER_ACQUISITION_USDT = 100;
const DEFAULT_DEPLOYABLE_CAPITAL_PCT = 0.75;
const DEFAULT_POSITION_CAPITAL_PCT = 0.15;
const MIN_ADAPTIVE_ACQUISITION_USDT = 10;

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, asNumber(value, min)));
}

function resolveManagedSpotLimits(config = {}) {
  const configuredPerAcquisition = asNumber(config.max_position_usdt, 10);
  const perAcquisition = Math.min(MAX_PER_ACQUISITION_USDT, Math.max(0, configuredPerAcquisition || 10));
  const configuredAssets = Math.floor(asNumber(config.max_open_positions, MAX_MANAGED_SPOT_ASSETS));
  const maxManagedAssets = Math.min(MAX_MANAGED_SPOT_ASSETS, Math.max(1, configuredAssets || MAX_MANAGED_SPOT_ASSETS));
  const configuredTotalCapital = asNumber(config.max_total_capital_usdt, perAcquisition * maxManagedAssets);
  const totalCapital = Math.min(
    MAX_MANAGED_CAPITAL_USDT,
    Math.max(perAcquisition, configuredTotalCapital || perAcquisition * maxManagedAssets)
  );
  return {
    version: MANAGED_SPOT_POLICY_VERSION,
    sizing_mode: 'STATIC_COMPATIBILITY',
    max_managed_spot_assets: maxManagedAssets,
    hard_max_managed_spot_assets: MAX_MANAGED_SPOT_ASSETS,
    max_total_managed_capital_usdt: totalCapital,
    hard_max_managed_capital_usdt: MAX_MANAGED_CAPITAL_USDT,
    max_per_acquisition_usdt: perAcquisition,
    hard_max_per_acquisition_usdt: MAX_PER_ACQUISITION_USDT,
    legacy_max_open_positions: asNumber(config.max_open_positions, 0) || null,
    terminology: 'managed_spot_acquisitions'
  };
}

function resolveAdaptiveManagedSpotLimits({ config = {}, operationalCapitalUsdt = 0 } = {}) {
  const staticLimits = resolveManagedSpotLimits(config);
  if (config.dynamic_position_sizing_enabled === false) return staticLimits;

  const operationalCapital = Math.max(0, asNumber(operationalCapitalUsdt));
  if (!(operationalCapital > 0)) return staticLimits;

  const deployablePct = clamp(
    config.dynamic_deployable_capital_pct ?? DEFAULT_DEPLOYABLE_CAPITAL_PCT,
    0.25,
    0.85
  );
  const positionPct = clamp(
    config.dynamic_position_capital_pct ?? DEFAULT_POSITION_CAPITAL_PCT,
    0.05,
    0.20
  );
  const configuredHardTotal = asNumber(
    config.dynamic_hard_max_total_capital_usdt,
    ADAPTIVE_HARD_MAX_MANAGED_CAPITAL_USDT
  );
  const configuredHardPosition = asNumber(
    config.dynamic_hard_max_position_usdt,
    ADAPTIVE_HARD_MAX_PER_ACQUISITION_USDT
  );
  const hardTotal = Math.min(
    ADAPTIVE_HARD_MAX_MANAGED_CAPITAL_USDT,
    Math.max(MAX_MANAGED_CAPITAL_USDT, configuredHardTotal)
  );
  const hardPosition = Math.min(
    ADAPTIVE_HARD_MAX_PER_ACQUISITION_USDT,
    Math.max(MAX_PER_ACQUISITION_USDT, configuredHardPosition)
  );

  const deployableCapital = Math.min(hardTotal, operationalCapital * deployablePct);
  const proportionalPosition = operationalCapital * positionPct;
  const perAcquisition = Math.min(
    hardPosition,
    Math.max(MIN_ADAPTIVE_ACQUISITION_USDT, proportionalPosition)
  );

  return {
    ...staticLimits,
    version: MANAGED_SPOT_POLICY_VERSION,
    sizing_mode: 'ADAPTIVE_OPERATIONAL_CAPITAL',
    operational_capital_usdt: Number(operationalCapital.toFixed(6)),
    deployable_capital_pct: deployablePct,
    position_capital_pct: positionPct,
    max_total_managed_capital_usdt: Number(Math.max(perAcquisition, deployableCapital).toFixed(6)),
    hard_max_managed_capital_usdt: hardTotal,
    max_per_acquisition_usdt: Number(perAcquisition.toFixed(6)),
    hard_max_per_acquisition_usdt: hardPosition,
    min_adaptive_acquisition_usdt: MIN_ADAPTIVE_ACQUISITION_USDT
  };
}

function managedAcquisitionCapacity({ currentManagedAssets = 0, currentManagedCapitalUsdt = 0, config = {}, operationalCapitalUsdt = null, adaptive = false } = {}) {
  const limits = adaptive
    ? resolveAdaptiveManagedSpotLimits({ config, operationalCapitalUsdt })
    : resolveManagedSpotLimits(config);
  const managedAssets = Math.max(0, Math.floor(asNumber(currentManagedAssets, 0)));
  const managedCapital = Math.max(0, asNumber(currentManagedCapitalUsdt, 0));
  const slotsRemaining = Math.max(0, limits.max_managed_spot_assets - managedAssets);
  const capitalRemaining = Math.max(0, limits.max_total_managed_capital_usdt - managedCapital);
  const minimumRequired = limits.min_adaptive_acquisition_usdt || limits.max_per_acquisition_usdt;

  return {
    ...limits,
    managed_assets: managedAssets,
    managed_capital_usdt: managedCapital,
    slots_remaining: slotsRemaining,
    managed_capital_remaining_usdt: capitalRemaining,
    next_acquisition_usdt: Number(Math.min(limits.max_per_acquisition_usdt, capitalRemaining).toFixed(6)),
    can_acquire: slotsRemaining > 0 && capitalRemaining >= minimumRequired
  };
}

module.exports = {
  MANAGED_SPOT_POLICY_VERSION,
  MAX_MANAGED_SPOT_ASSETS,
  MAX_MANAGED_CAPITAL_USDT,
  MAX_PER_ACQUISITION_USDT,
  ADAPTIVE_HARD_MAX_MANAGED_CAPITAL_USDT,
  ADAPTIVE_HARD_MAX_PER_ACQUISITION_USDT,
  DEFAULT_DEPLOYABLE_CAPITAL_PCT,
  DEFAULT_POSITION_CAPITAL_PCT,
  MIN_ADAPTIVE_ACQUISITION_USDT,
  resolveManagedSpotLimits,
  resolveAdaptiveManagedSpotLimits,
  managedAcquisitionCapacity
};
