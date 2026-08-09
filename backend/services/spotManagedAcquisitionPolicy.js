'use strict';

const MANAGED_SPOT_POLICY_VERSION = 'managed_spot_acquisition_policy_v1';
const MAX_MANAGED_SPOT_ASSETS = 4;
const MAX_MANAGED_CAPITAL_USDT = 40;
const MAX_PER_ACQUISITION_USDT = 10;

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveManagedSpotLimits(config = {}) {
  const configuredPerAcquisition = asNumber(config.max_position_usdt, MAX_PER_ACQUISITION_USDT);
  return {
    version: MANAGED_SPOT_POLICY_VERSION,
    max_managed_spot_assets: MAX_MANAGED_SPOT_ASSETS,
    max_total_managed_capital_usdt: MAX_MANAGED_CAPITAL_USDT,
    max_per_acquisition_usdt: Math.min(MAX_PER_ACQUISITION_USDT, Math.max(0, configuredPerAcquisition || MAX_PER_ACQUISITION_USDT)),
    legacy_max_open_positions: asNumber(config.max_open_positions, 0) || null,
    terminology: 'managed_spot_acquisitions'
  };
}

function managedAcquisitionCapacity({ currentManagedAssets = 0, currentManagedCapitalUsdt = 0, config = {} } = {}) {
  const limits = resolveManagedSpotLimits(config);
  const managedAssets = Math.max(0, Math.floor(asNumber(currentManagedAssets, 0)));
  const managedCapital = Math.max(0, asNumber(currentManagedCapitalUsdt, 0));
  const slotsRemaining = Math.max(0, limits.max_managed_spot_assets - managedAssets);
  const capitalRemaining = Math.max(0, limits.max_total_managed_capital_usdt - managedCapital);

  return {
    ...limits,
    managed_assets: managedAssets,
    managed_capital_usdt: managedCapital,
    slots_remaining: slotsRemaining,
    managed_capital_remaining_usdt: capitalRemaining,
    can_acquire: slotsRemaining > 0 && capitalRemaining >= limits.max_per_acquisition_usdt
  };
}

module.exports = {
  MANAGED_SPOT_POLICY_VERSION,
  MAX_MANAGED_SPOT_ASSETS,
  MAX_MANAGED_CAPITAL_USDT,
  MAX_PER_ACQUISITION_USDT,
  resolveManagedSpotLimits,
  managedAcquisitionCapacity
};
