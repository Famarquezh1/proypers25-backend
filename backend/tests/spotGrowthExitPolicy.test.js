'use strict';

const assert = require('assert');
const { decideCoreGrowthExit } = require('../services/spotGrowthExitPolicy');

const policy = {
  break_even_trigger_pct: 0.05,
  momentum_fail_hours: 1,
  momentum_fail_max_gain_pct: -0.015,
  no_progress_hours: 3,
  no_progress_max_gain_pct: 0.005
};

assert.strictEqual(decideCoreGrowthExit({
  ageHours: 0.9, gainPct: -0.03, recentHighPct: 0.01, policy
}).reason, null);

assert.strictEqual(decideCoreGrowthExit({
  ageHours: 1, gainPct: -0.015, recentHighPct: 0.01, policy
}).reason, 'MOMENTUM_FAILURE');

assert.strictEqual(decideCoreGrowthExit({
  ageHours: 3, gainPct: 0.004, recentHighPct: 0.02, policy
}).reason, 'NO_PROGRESS');

assert.strictEqual(decideCoreGrowthExit({
  ageHours: 3, gainPct: 0.012, recentHighPct: 0.02, policy
}).reason, null);

assert.strictEqual(decideCoreGrowthExit({
  ageHours: 8, gainPct: -0.02, recentHighPct: 0.06, policy
}).reason, null);

console.log('spotGrowthExitPolicy tests passed');
