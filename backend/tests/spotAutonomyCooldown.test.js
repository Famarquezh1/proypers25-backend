'use strict';

const assert = require('assert');
const {
  buildAutonomyHaltState,
  buildAutonomyControlPatch,
  LOSS_STREAK_COOLDOWN_MINUTES
} = require('../services/spotAutonomyController');

assert.strictEqual(LOSS_STREAK_COOLDOWN_MINUTES, 180);

const recentLossStreak = buildAutonomyHaltState({
  consecutiveLosses: 3,
  totalPnl: -0.44,
  latestClosedAt: Date.parse('2026-08-16T12:00:00.000Z'),
  now: '2026-08-16T13:00:00.000Z'
});
assert.strictEqual(recentLossStreak.should_halt, true);
assert.strictEqual(recentLossStreak.halt_reason, 'THREE_CONSECUTIVE_LOSSES');
assert.strictEqual(recentLossStreak.loss_streak_cooldown_active, true);

const expiredLossStreak = buildAutonomyHaltState({
  consecutiveLosses: 3,
  totalPnl: -0.44,
  latestClosedAt: Date.parse('2026-08-16T08:00:00.000Z'),
  now: '2026-08-16T13:00:00.000Z'
});
assert.strictEqual(expiredLossStreak.should_halt, false);
assert.strictEqual(expiredLossStreak.halt_reason, null);
assert.strictEqual(expiredLossStreak.loss_streak_cooldown_active, false);

const hardLossLimit = buildAutonomyHaltState({
  consecutiveLosses: 3,
  totalPnl: -3.01,
  latestClosedAt: Date.parse('2026-08-16T08:00:00.000Z'),
  now: '2026-08-16T13:00:00.000Z'
});
assert.strictEqual(hardLossLimit.should_halt, true);
assert.strictEqual(hardLossLimit.halt_reason, 'MAX_SESSION_LOSS_REACHED');

const releasePatch = buildAutonomyControlPatch({
  enabled: true,
  kill_switch: true,
  new_entries_enabled: false,
  autonomy_halt_reason: 'THREE_CONSECUTIVE_LOSSES',
  autonomy_halted_at: '2026-08-09T23:25:00.000Z',
  reconciliation_required: false,
  account_consistent: true
}, {
  should_halt: false,
  current_stage: 'CONTROLLED_10_USDT',
  loss_streak_cooldown_until: '2026-08-10T02:25:00.000Z'
}, '2026-08-16T13:00:00.000Z');
assert.strictEqual(releasePatch.kill_switch, false);
assert.strictEqual(releasePatch.new_entries_enabled, true);
assert.strictEqual(releasePatch.autonomy_halt_reason, null);
assert.strictEqual(releasePatch.autonomy_halted_at, null);
assert.strictEqual(releasePatch.autonomy_resume_after, null);

console.log('spot autonomy cooldown tests passed');
