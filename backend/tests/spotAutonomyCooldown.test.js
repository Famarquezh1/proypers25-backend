'use strict';

const assert = require('assert');
const {
  buildAutonomyHaltState,
  buildPerformanceRecoveryState,
  buildGrowthState,
  buildAutonomyControlPatch,
  LOSS_STREAK_COOLDOWN_MINUTES,
  RECOVERY_POSITION_USDT,
  GROWTH_POSITION_USDT,
  MAX_OPEN_POSITIONS,
  RECOVERY_MAX_OPEN_POSITIONS,
  RECOVERY_MAX_TOTAL_CAPITAL_USDT,
  SESSION_WINDOW_HOURS
} = require('../services/spotAutonomyController');
const {
  buildLearningProfile,
  evaluateLearnedEntry,
  scoreBand
} = require('../services/spotRealLearningPolicy');
const {
  buildEntrySafetyFailures,
  evaluateLearnedRecoveryOverride
} = require('../services/spotRealPipelinePolicy');

assert.strictEqual(LOSS_STREAK_COOLDOWN_MINUTES, 180);
assert.strictEqual(RECOVERY_POSITION_USDT, 25);
assert.strictEqual(GROWTH_POSITION_USDT, 20);
assert.strictEqual(MAX_OPEN_POSITIONS, 4);
assert.strictEqual(RECOVERY_MAX_OPEN_POSITIONS, 2);
assert.strictEqual(RECOVERY_MAX_TOTAL_CAPITAL_USDT, 50);
assert.strictEqual(SESSION_WINDOW_HOURS, 24);
assert.strictEqual(scoreBand(91.73), 'SCORE_85_PLUS');
assert.strictEqual(scoreBand(63.06), 'SCORE_50_69');

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

const staleHistoricalLoss = buildAutonomyHaltState({
  consecutiveLosses: 0,
  totalPnl: 0,
  latestClosedAt: Date.parse('2026-08-14T08:00:00.000Z'),
  now: '2026-08-16T13:00:00.000Z'
});
assert.strictEqual(staleHistoricalLoss.should_halt, false);

const recovery = buildPerformanceRecoveryState({ completedTrades: 30, totalPnl: -1.43, winRate: 26.79 });
assert.strictEqual(recovery.performance_recovery_mode, true);
assert.strictEqual(recovery.performance_recovery_position_usdt, 25);
assert.strictEqual(recovery.performance_recovery_reason, 'RECENT_REAL_PERFORMANCE_DEGRADED');

const positiveRecovery = buildPerformanceRecoveryState({ completedTrades: 30, totalPnl: 0.25, winRate: 30 });
assert.strictEqual(positiveRecovery.performance_recovery_mode, false);
assert.strictEqual(positiveRecovery.performance_recovery_position_usdt, 10);

const insufficientSample = buildPerformanceRecoveryState({ completedTrades: 9, totalPnl: -2, winRate: 0 });
assert.strictEqual(insufficientSample.performance_recovery_mode, false);

const growth = buildGrowthState({ completedTrades: 18, totalPnl: 2.4, winRate: 55, profitFactor: 1.4, recoveryMode: false });
assert.strictEqual(growth.growth_mode, true);
assert.strictEqual(growth.growth_position_usdt, 20);
const blockedGrowth = buildGrowthState({ completedTrades: 18, totalPnl: -0.1, winRate: 55, profitFactor: 1.4, recoveryMode: false });
assert.strictEqual(blockedGrowth.growth_mode, false);

const learningTrades = [];
for (let index = 0; index < 20; index += 1) {
  learningTrades.push({ entry_score: 60, net_pnl_usdt: index < 4 ? 0.05 : -0.08, closing_reason: index < 4 ? 'TRAILING_STOP' : 'STOP_LOSS' });
}
for (let index = 0; index < 8; index += 1) {
  learningTrades.push({ entry_score: 90, net_pnl_usdt: index < 4 ? 0.12 : -0.04, closing_reason: index < 4 ? 'TRAILING_STOP' : 'STOP_LOSS' });
}
const learningProfile = buildLearningProfile(learningTrades);
assert.strictEqual(learningProfile.active, true);
const badBand = learningProfile.score_bands.find((item) => item.band === 'SCORE_50_69');
assert.strictEqual(badBand.state, 'NEGATIVE_EXPECTANCY');
const learnedBlock = evaluateLearnedEntry({ score: 63 }, learningProfile);
assert.strictEqual(learnedBlock.allowed, false);
assert.strictEqual(learnedBlock.reason, 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY');
const learnedPositive = evaluateLearnedEntry({ score: 91 }, learningProfile);
assert.strictEqual(learnedPositive.allowed, true);
const tinyProfile = buildLearningProfile(learningTrades.slice(0, 5));
assert.strictEqual(evaluateLearnedEntry({ score: 63 }, tinyProfile).allowed, true);

const recoveryLearningConfig = {
  enabled: true,
  kill_switch: false,
  new_entries_enabled: true,
  auto_order_execution: true,
  real_sells_enabled: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false,
  max_position_usdt: 25,
  max_total_capital_usdt: 50,
  max_open_positions: 2,
  reconciliation_required: false,
  account_consistent: true,
  autonomy_stage: 'RECOVERY_25_USDT'
};
const recoveryLearningCandidate = {
  symbol: 'ARBUSDT',
  score: 65.2,
  selection_lane: 'EARLY_MOMENTUM',
  earlyMomentumScore: 88.08,
  earlyMomentum: {
    valid: true,
    score: 88.08,
    change_5m_pct: 0.9848,
    change_15m_pct: 2.9197,
    change_1h_pct: 2.8259,
    relative_volume_15m: 2.163,
    confirmations: 3,
    accelerating: true
  }
};
const recoveryLearningAdaptiveGate = {
  allowed: false,
  state: 'DEGRADED',
  reasons: ['DRAWDOWN_TOO_HIGH'],
  regime: { regime: 'BULL_TREND' }
};
const recoveryLearningPaperGate = {
  allowed: true,
  reasons: [],
  selection_lane: 'EARLY_MOMENTUM',
  candidate: recoveryLearningCandidate,
  technical_confirmation: { allowed: true, score: 82, confirmations: 3 }
};
const recoveryLearningAutonomy = {
  should_halt: false,
  current_stage: 'RECOVERY_25_USDT',
  learning_profile: learningProfile
};
const healthyReconciliation = { account_consistent: true, entries_blocked: false };
const healthyExits = { ok: true, blocked: false, exit_engine_healthy: true, failures: [] };
const recoveryNegativeLearning = evaluateLearnedEntry(recoveryLearningCandidate, learningProfile);
assert.strictEqual(recoveryNegativeLearning.allowed, false);
assert.strictEqual(recoveryNegativeLearning.reason, 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY');

const learnedRecoveryOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(learnedRecoveryOverride.allowed, true);
assert.strictEqual(learnedRecoveryOverride.learning_remains_active, true);
assert.strictEqual(learnedRecoveryOverride.risk_signal, 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY');
assert.strictEqual(learnedRecoveryOverride.max_position_usdt, 25);
assert.strictEqual(learnedRecoveryOverride.metrics.early_momentum_score, 88.08);
assert.strictEqual(learnedRecoveryOverride.metrics.confirmations, 3);
assert.strictEqual(learnedRecoveryOverride.metrics.relative_volume_15m, 2.163);

const recoveryLearningFailures = buildEntrySafetyFailures({
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: { ...recoveryLearningAdaptiveGate, regime: { regime: 'BULL_TREND' } },
  paperGate: { ...recoveryLearningPaperGate, candidate: { ...recoveryLearningCandidate, earlyMomentum: { ...recoveryLearningCandidate.earlyMomentum } } },
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.deepStrictEqual(recoveryLearningFailures, []);

const annotatedRecoveryPaperGate = { ...recoveryLearningPaperGate, candidate: { ...recoveryLearningCandidate, earlyMomentum: { ...recoveryLearningCandidate.earlyMomentum } } };
buildEntrySafetyFailures({
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: { ...recoveryLearningAdaptiveGate, regime: { regime: 'BULL_TREND' } },
  paperGate: annotatedRecoveryPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(annotatedRecoveryPaperGate.learned_entry_raw_allowed, false);
assert.strictEqual(annotatedRecoveryPaperGate.learned_entry_allowed, true);
assert.strictEqual(annotatedRecoveryPaperGate.learned_entry_risk_signal, 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY');
assert.strictEqual(annotatedRecoveryPaperGate.learned_entry_recovery_override.allowed, true);

const oneOpenRecovery = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 1
});
assert.strictEqual(oneOpenRecovery.allowed, true);

const twoOpenRecovery = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 2
});
assert.strictEqual(twoOpenRecovery.allowed, false);
assert(twoOpenRecovery.adaptive_recovery.blockers.includes('RECOVERY_MAX_MANAGED_SPOT_ASSETS_REACHED'));

const controlledStageOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: { ...recoveryLearningAutonomy, current_stage: 'CONTROLLED_10_USDT' },
  config: { ...recoveryLearningConfig, autonomy_stage: 'CONTROLLED_10_USDT', max_position_usdt: 10, max_total_capital_usdt: 40, max_open_positions: 4 },
  openPositions: 0
});
assert.strictEqual(controlledStageOverride.allowed, false);
assert(controlledStageOverride.blockers.includes('LEARNING_OVERRIDE_REQUIRES_RECOVERY_25_USDT'));

const weakMomentumOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: {
    ...recoveryLearningPaperGate,
    candidate: {
      ...recoveryLearningCandidate,
      earlyMomentumScore: 84.99,
      earlyMomentum: { ...recoveryLearningCandidate.earlyMomentum, score: 84.99 }
    }
  },
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(weakMomentumOverride.allowed, false);
assert(weakMomentumOverride.blockers.includes('LEARNING_OVERRIDE_MOMENTUM_BELOW_85'));

const weakVolumeOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: {
    ...recoveryLearningPaperGate,
    candidate: {
      ...recoveryLearningCandidate,
      earlyMomentum: { ...recoveryLearningCandidate.earlyMomentum, relative_volume_15m: 1.49 }
    }
  },
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(weakVolumeOverride.allowed, false);
assert(weakVolumeOverride.blockers.includes('LEARNING_OVERRIDE_RELATIVE_VOLUME_TOO_LOW'));

const insufficientConfirmationsOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: {
    ...recoveryLearningPaperGate,
    candidate: {
      ...recoveryLearningCandidate,
      earlyMomentum: { ...recoveryLearningCandidate.earlyMomentum, confirmations: 2 }
    }
  },
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(insufficientConfirmationsOverride.allowed, false);
assert(insufficientConfirmationsOverride.blockers.includes('LEARNING_OVERRIDE_CONFIRMATIONS_BELOW_3'));

const bearRegimeOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: healthyExits,
  adaptiveGate: { ...recoveryLearningAdaptiveGate, regime: { regime: 'BEAR_TREND' } },
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(bearRegimeOverride.allowed, false);
assert(bearRegimeOverride.blockers.includes('LEARNING_OVERRIDE_MARKET_REGIME_BLOCKED'));

const unhealthyExitOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: healthyReconciliation,
  exits: { ok: false, blocked: true, exit_engine_healthy: false, failures: [{ reason: 'EXIT_ENGINE_NOT_HEALTHY' }] },
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(unhealthyExitOverride.allowed, false);
assert(unhealthyExitOverride.blockers.includes('LEARNING_OVERRIDE_EXIT_ENGINE_NOT_HEALTHY'));

const reconciliationBlockedOverride = evaluateLearnedRecoveryOverride({
  learnedDecision: recoveryNegativeLearning,
  reconciliation: { account_consistent: false, entries_blocked: true },
  exits: healthyExits,
  adaptiveGate: recoveryLearningAdaptiveGate,
  paperGate: recoveryLearningPaperGate,
  autonomy: recoveryLearningAutonomy,
  config: recoveryLearningConfig,
  openPositions: 0
});
assert.strictEqual(reconciliationBlockedOverride.allowed, false);
assert(reconciliationBlockedOverride.blockers.includes('LEARNING_OVERRIDE_RECONCILIATION_NOT_PASS'));

const throttledPatch = buildAutonomyControlPatch({
  enabled: true,
  max_position_usdt: 10,
  new_entries_enabled: true,
  kill_switch: false
}, {
  should_halt: false,
  performance_recovery_mode: true,
  performance_recovery_reason: 'RECENT_REAL_PERFORMANCE_DEGRADED',
  current_stage: 'RECOVERY_25_USDT'
}, '2026-08-28T16:00:00.000Z');
assert.strictEqual(throttledPatch.max_position_usdt, 25);
assert.strictEqual(throttledPatch.max_total_capital_usdt, 50);
assert.strictEqual(throttledPatch.max_open_positions, 2);
assert.strictEqual(throttledPatch.adaptive_position_usdt, 25);
assert.strictEqual(throttledPatch.kill_switch, undefined);
assert.strictEqual(throttledPatch.new_entries_enabled, undefined);

const growthPatch = buildAutonomyControlPatch({
  enabled: true,
  max_position_usdt: 10,
  new_entries_enabled: true,
  kill_switch: false
}, {
  should_halt: false,
  performance_recovery_mode: false,
  growth_mode: true,
  current_stage: 'GROWTH_20_USDT'
}, '2026-08-28T16:00:00.000Z');
assert.strictEqual(growthPatch.max_position_usdt, 20);
assert.strictEqual(growthPatch.max_total_capital_usdt, 80);
assert.strictEqual(growthPatch.max_open_positions, 4);

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
  current_stage: 'RECOVERY_25_USDT',
  loss_streak_cooldown_until: '2026-08-10T02:25:00.000Z'
}, '2026-08-16T13:00:00.000Z');
assert.strictEqual(releasePatch.kill_switch, false);
assert.strictEqual(releasePatch.new_entries_enabled, true);
assert.strictEqual(releasePatch.max_position_usdt, 25);
assert.strictEqual(releasePatch.max_total_capital_usdt, 50);
assert.strictEqual(releasePatch.max_open_positions, 2);
assert.strictEqual(releasePatch.autonomy_halt_reason, null);
assert.strictEqual(releasePatch.autonomy_halted_at, null);
assert.strictEqual(releasePatch.autonomy_resume_after, null);

console.log('spot autonomy cooldown and real learning tests passed');
