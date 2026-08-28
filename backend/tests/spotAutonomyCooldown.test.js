'use strict';

const assert = require('assert');
const {
  buildAutonomyHaltState,
  buildPerformanceRecoveryState,
  buildAutonomyControlPatch,
  LOSS_STREAK_COOLDOWN_MINUTES,
  RECOVERY_POSITION_USDT
} = require('../services/spotAutonomyController');

assert.strictEqual(LOSS_STREAK_COOLDOWN_MINUTES, 180);
assert.strictEqual(RECOVERY_POSITION_USDT, 5);

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

const recovery = buildPerformanceRecoveryState({
  completedTrades: 30,
  totalPnl: -1.43,
  winRate: 26.79
});
assert.strictEqual(recovery.performance_recovery_mode, true);
assert.strictEqual(recovery.performance_recovery_position_usdt, 5);
assert.strictEqual(recovery.performance_recovery_reason, 'RECENT_REAL_PERFORMANCE_DEGRADED');

const positiveRecovery = buildPerformanceRecoveryState({
  completedTrades: 30,
  totalPnl: 0.25,
  winRate: 30
});
assert.strictEqual(positiveRecovery.performance_recovery_mode, false);
assert.strictEqual(positiveRecovery.performance_recovery_position_usdt, 10);

const insufficientSample = buildPerformanceRecoveryState({
  completedTrades: 9,
  totalPnl: -2,
  winRate: 0
});
assert.strictEqual(insufficientSample.performance_recovery_mode, false);

const throttledPatch = buildAutonomyControlPatch({
  enabled: true,
  max_position_usdt: 10,
  new_entries_enabled: true,
  kill_switch: false
}, {
  should_halt: false,
  performance_recovery_mode: true,
  performance_recovery_reason: 'RECENT_REAL_PERFORMANCE_DEGRADED',
  current_stage: 'RECOVERY_5_USDT'
}, '2026-08-28T16:00:00.000Z');
assert.strictEqual(throttledPatch.max_position_usdt, 5);
assert.strictEqual(throttledPatch.max_total_capital_usdt, 5);
assert.strictEqual(throttledPatch.adaptive_position_usdt, 5);
assert.strictEqual(throttledPatch.kill_switch, undefined);
assert.strictEqual(throttledPatch.new_entries_enabled, undefined);

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
  performance_recovery_mode: true,
  performance_recovery_reason: 'RECENT_REAL_PERFORMANCE_DEGRADED',
  current_stage: 'RECOVERY_5_USDT',
  loss_streak_cooldown_until: '2026-08-10T02:25:00.000Z'
}, '2026-08-16T13:00:00.000Z');
assert.strictEqual(releasePatch.kill_switch, false);
assert.strictEqual(releasePatch.new_entries_enabled, true);
assert.strictEqual(releasePatch.max_position_usdt, 5);
assert.strictEqual(releasePatch.max_total_capital_usdt, 5);
assert.strictEqual(releasePatch.autonomy_halt_reason, null);
assert.strictEqual(releasePatch.autonomy_halted_at, null);
assert.strictEqual(releasePatch.autonomy_resume_after, null);

console.log('spot autonomy cooldown tests passed');
