'use strict';

const assert = require('assert');
const { assertExitConfig } = require('../services/controlledSpotExitExecutor');

const baseConfig = {
  enabled: true,
  kill_switch: true,
  real_sells_enabled: true,
  auto_order_execution: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false
};

// Entry halts must never strand an already-open Spot position. The dedicated
// real_sells_enabled switch remains the explicit control for disabling sells.
assert.doesNotThrow(() => assertExitConfig(baseConfig));
assert.throws(
  () => assertExitConfig({ ...baseConfig, real_sells_enabled: false }),
  /REAL_SELLS_NOT_ENABLED/
);

console.log('spot exit kill-switch safety tests passed');
