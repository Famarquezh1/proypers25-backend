'use strict';

const assert = require('assert');
const { blockerDetails, schedulerIntervalMinutes } = require('../services/spotLiveEvidence');
const { evaluateHistoricalDrawdownRecoveryEntry } = require('../services/spotRealPipelinePolicy');

const startedAt = '2026-07-21T12:00:00.000Z';
const blockers = blockerDetails({
  startedAt,
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: false, blocked: true, exit_engine_healthy: false, failures: [{ symbol: 'XECUSDT', stage: 'SELL', reason: 'MIN_NOTIONAL' }] },
  adaptiveGate: { allowed: true },
  promotionGate: { allowed: false, state: 'OBSERVE', reasons: ['INSUFFICIENT_REAL_SAMPLE'] },
  paperGate: { allowed: false, skipped: true },
  autonomy: { should_halt: false },
  config: { enabled: true, kill_switch: false, new_entries_enabled: true, auto_order_execution: true, real_sells_enabled: true }
});

assert.strictEqual(blockers.length, 2);
assert.strictEqual(blockers[0].component, 'Exit Engine');
assert.strictEqual(blockers[0].reason, 'MIN_NOTIONAL');
assert.strictEqual(blockers[1].component, 'Paper → Real');
assert.strictEqual(blockers[1].reason, 'PAPER_REAL_ENTRY_GATE_BLOCKED');
assert.ok(blockers[1].missing_condition);
assert.ok(!blockers.some((blocker) => blocker.component === 'Strategy Promotion'));

const recoveryEvidenceBlockers = blockerDetails({
  startedAt,
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: {
    allowed: false,
    state: 'DEGRADED',
    reasons: ['DRAWDOWN_TOO_HIGH'],
    adaptive_recovery_entry: true,
    adaptive_recovery_policy: 'historical_drawdown_recovery'
  },
  paperGate: { allowed: true },
  autonomy: { should_halt: false },
  config: { enabled: true, kill_switch: false, new_entries_enabled: true, auto_order_execution: true, real_sells_enabled: true }
});
assert.ok(!recoveryEvidenceBlockers.some((blocker) => blocker.component === 'Adaptive Strategy'));

const unknownRegimeRecovery = evaluateHistoricalDrawdownRecoveryEntry({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: {
    allowed: false,
    state: 'DEGRADED',
    reasons: ['DRAWDOWN_TOO_HIGH'],
    regime: { regime: 'UNKNOWN' }
  },
  paperGate: {
    allowed: true,
    selection_lane: 'EARLY_MOMENTUM',
    technical_confirmation: { allowed: true }
  },
  autonomy: { should_halt: false },
  config: {
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
    max_position_usdt: 10,
    reconciliation_required: false,
    account_consistent: true
  },
  openPositions: 0
});
assert.strictEqual(unknownRegimeRecovery.allowed, false);
assert.ok(unknownRegimeRecovery.blockers.includes('MARKET_REGIME_UNKNOWN'));

assert.strictEqual(schedulerIntervalMinutes({ spot_cycle_interval_minutes: 10 }), 10);
assert.strictEqual(schedulerIntervalMinutes({}), 5);

console.log('spotLiveEvidence tests passed');
