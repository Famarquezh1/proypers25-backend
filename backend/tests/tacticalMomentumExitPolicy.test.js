'use strict';

const assert = require('assert');
const {
  isTacticalMomentumPosition,
  resolveAdaptiveProtection,
  buildTacticalWeaknessState,
  determineExit
} = require('../services/controlledSpotExitExecutor');

const nestedTactical = {
  entry_price: 100,
  sl_price: 95,
  tp1_price: 105,
  highest_price: 100,
  opened_at: '2026-08-03T19:00:00.000Z',
  execution_decision_snapshot: {
    paper_gate: {
      entry_mode: 'TACTICAL_MOMENTUM',
      tactical_entry: true
    }
  }
};
assert.strictEqual(isTacticalMomentumPosition(nestedTactical), true);
assert.strictEqual(isTacticalMomentumPosition({ strategy: 'CONTROLLED_PAPER_TO_REAL' }), false);

const twoHoursLater = new Date('2026-08-03T21:00:00.000Z');
const nearEntryWeak = {
  ...nestedTactical,
  momentum_lost: true,
  tactical_momentum_weak_cycles: 10
};
const earlyProtection = resolveAdaptiveProtection(nearEntryWeak, 99.3, 0.01, twoHoursLater);
assert.strictEqual(earlyProtection.protection_mode, 'BASE');
assert.ok(earlyProtection.effective_timeout_at > twoHoursLater.toISOString());
assert.strictEqual(determineExit({ ...nearEntryWeak, ...earlyProtection }, 99.3, twoHoursLater), null);

const armed = resolveAdaptiveProtection(nestedTactical, 105, 0.01, twoHoursLater);
assert.strictEqual(armed.tactical_profit_armed, true);
assert.strictEqual(armed.protection_mode, 'TACTICAL_RUNNER_ARMED');
assert.ok(armed.effective_sl_price > 100);
// Reaching the first target arms the runner; it does not force a full sale.
assert.strictEqual(determineExit({ ...nestedTactical, ...armed }, 105, twoHoursLater), null);

const trailing = resolveAdaptiveProtection({ ...nestedTactical, highest_price: 116 }, 114, 0.01, twoHoursLater);
assert.strictEqual(trailing.protection_mode, 'TACTICAL_TRAILING');
assert.ok(trailing.effective_sl_price > 110);
assert.ok(trailing.effective_sl_price < trailing.highest_price);
assert.strictEqual(
  determineExit({ ...nestedTactical, ...trailing }, trailing.effective_sl_price - 0.01, twoHoursLater),
  'TRAILING_STOP'
);

const sixHoursLater = new Date('2026-08-04T01:30:00.000Z');
const confirmedWeak = {
  ...nestedTactical,
  momentum_lost: true,
  tactical_momentum_weak_cycles: 4,
  opened_at: '2026-08-03T19:00:00.000Z'
};
assert.strictEqual(determineExit(confirmedWeak, 98, sixHoursLater), 'MOMENTUM_LOSS_CONFIRMED');
assert.strictEqual(determineExit({ ...confirmedWeak, tactical_momentum_weak_cycles: 3 }, 98, sixHoursLater), null);
assert.strictEqual(determineExit(confirmedWeak, 99.2, sixHoursLater), null);

const weakness = buildTacticalWeaknessState({
  ...nestedTactical,
  momentum_lost: true,
  current_score: 40,
  exit_score_floor: 50,
  tactical_momentum_weak_cycles: 2,
  tactical_score_weak_cycles: 1
}, twoHoursLater);
assert.strictEqual(weakness.tactical_momentum_weak_cycles, 3);
assert.strictEqual(weakness.tactical_score_weak_cycles, 2);

console.log('tacticalMomentumExitPolicy.test.js PASS');
