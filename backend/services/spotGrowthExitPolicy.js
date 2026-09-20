'use strict';

function n(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function decideCoreGrowthExit({
  ageHours = 0,
  gainPct = 0,
  recentHighPct = 0,
  policy = {}
} = {}) {
  const breakEvenTriggerPct = n(policy.break_even_trigger_pct, 0.05);
  const momentumFailHours = n(policy.momentum_fail_hours, 1.5);
  const momentumFailMaxGainPct = n(policy.momentum_fail_max_gain_pct, -0.015);
  const noProgressHours = n(policy.no_progress_hours, 6);
  const noProgressMaxGainPct = n(policy.no_progress_max_gain_pct, 0.005);

  const age = Math.max(0, n(ageHours, 0));
  const gain = n(gainPct, 0);
  const high = n(recentHighPct, 0);
  const neverReachedBreakEven = high < breakEvenTriggerPct;

  if (neverReachedBreakEven && age >= momentumFailHours && gain <= momentumFailMaxGainPct) {
    return { reason: 'MOMENTUM_FAILURE' };
  }

  if (neverReachedBreakEven && age >= noProgressHours && gain <= noProgressMaxGainPct) {
    return { reason: 'NO_PROGRESS' };
  }

  return { reason: null };
}

module.exports = { decideCoreGrowthExit };
