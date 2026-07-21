'use strict';

const assert = require('assert');
const { blockerDetails, schedulerIntervalMinutes } = require('../services/spotLiveEvidence');

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
assert.strictEqual(blockers[1].component, 'Strategy Promotion');
assert.ok(blockers[1].missing_condition);
assert.strictEqual(schedulerIntervalMinutes({ spot_cycle_interval_minutes: 10 }), 10);

console.log('spotLiveEvidence tests passed');
