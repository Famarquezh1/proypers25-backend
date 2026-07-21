'use strict';

const assert = require('assert');
const {
  buildSpotCycleDecisionLog,
  buildExitDiagnostics,
  normalizeExitFailure,
  inferAction,
  compactReasons
} = require('../services/spotCycleObservability');

assert.strictEqual(inferAction({ positions_opened: 1 }, {}), 'BUY');
assert.strictEqual(inferAction({}, { positions_closed: 1 }), 'SELL');
assert.strictEqual(inferAction({ positions_opened: 1 }, { positions_closed: 1 }), 'SELL_AND_BUY');
assert.strictEqual(inferAction({ skipped: true }, {}), 'NO_ACTION');

assert.deepStrictEqual(compactReasons('A', ['A', 'B'], null), ['A', 'B']);

const normalizedFailure = normalizeExitFailure({
  symbol: 'XECUSDT',
  positionId: 'pos_1',
  stage: 'SELL_ORDER',
  error: { code: 'MIN_NOTIONAL', message: 'Order value below minimum' },
  retryable: true,
  retryState: 'EXIT_RETRY_READY',
  retryCount: 2
}, 0);

assert.deepStrictEqual(normalizedFailure, {
  index: 0,
  symbol: 'XECUSDT',
  position_id: 'pos_1',
  stage: 'SELL_ORDER',
  reason: 'MIN_NOTIONAL',
  message: 'Order value below minimum',
  retryable: true,
  retry_state: 'EXIT_RETRY_READY',
  attempt: 2
});

const diagnostics = buildExitDiagnostics({
  ok: false,
  blocked: true,
  exit_engine_healthy: false,
  failures: [{ symbol: 'XECUSDT', reason: 'INSUFFICIENT_BALANCE', retryable: false }],
  recovery_state: 'BLOCKED'
});

assert.strictEqual(diagnostics.failure_count, 1);
assert.strictEqual(diagnostics.failure_reasons[0], 'INSUFFICIENT_BALANCE');
assert.strictEqual(diagnostics.failures[0].symbol, 'XECUSDT');
assert.strictEqual(diagnostics.recovery_state, 'BLOCKED');

const skipped = buildSpotCycleDecisionLog({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, exit_engine_healthy: true, positions_closed: 0, failures: [] },
  autonomy: { should_halt: false },
  adaptiveGate: { allowed: true, regime: 'SIDEWAYS_LOW_VOL' },
  promotionGate: { allowed: false, state: 'OBSERVE', reasons: ['INSUFFICIENT_PAPER_EVIDENCE'] },
  paperGate: { allowed: false, skipped: true, reasons: ['ENTRY_PRECONDITIONS_NOT_MET'] },
  entries: { skipped: true, reason: 'STRATEGY_NOT_PROMOTED' },
  openPositionsAfterCycle: 1,
  durationMs: 8500,
  config: {
    spot_only: true,
    max_position_usdt: 10,
    futures_allowed: false,
    margin_allowed: false,
    leverage_allowed: false,
    withdrawals_allowed: false
  }
});

assert.strictEqual(skipped.event, 'SPOT_REAL_CYCLE_DECISION');
assert.strictEqual(skipped.action, 'NO_ACTION');
assert.strictEqual(skipped.decision, 'SKIP');
assert.strictEqual(skipped.reason, 'STRATEGY_NOT_PROMOTED');
assert.strictEqual(skipped.gates.promotion, 'BLOCK');
assert.strictEqual(skipped.gates.paper_to_real, 'SKIPPED');
assert.strictEqual(skipped.market.regime, 'SIDEWAYS_LOW_VOL');
assert.strictEqual(skipped.execution.open_positions_after_cycle, 1);
assert.strictEqual(skipped.execution.exit_failures, 0);
assert.strictEqual(skipped.exit_diagnostics.failure_count, 0);
assert.strictEqual(skipped.safety.max_position_usdt, 10);
assert.strictEqual(skipped.safety.spot_only, true);

const failedExit = buildSpotCycleDecisionLog({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: {
    ok: false,
    blocked: true,
    exit_engine_healthy: false,
    failures: [{
      symbol: 'XECUSDT',
      stage: 'SELL_ORDER',
      reason: 'INSUFFICIENT_BALANCE',
      message: 'Available balance lower than tracked quantity',
      retryable: false
    }]
  },
  entries: { skipped: true, reason: 'EXIT_ENGINE_NOT_HEALTHY' },
  openPositionsAfterCycle: 1
});

assert.strictEqual(failedExit.gates.exit_engine, 'BLOCK');
assert.strictEqual(failedExit.execution.exit_failures, 1);
assert.strictEqual(failedExit.reason, 'INSUFFICIENT_BALANCE');
assert.strictEqual(failedExit.exit_diagnostics.failures[0].symbol, 'XECUSDT');
assert.strictEqual(failedExit.exit_diagnostics.failures[0].stage, 'SELL_ORDER');
assert.strictEqual(failedExit.exit_diagnostics.failures[0].message, 'Available balance lower than tracked quantity');

const bought = buildSpotCycleDecisionLog({
  reconciliation: { account_consistent: true },
  exits: { ok: true, exit_engine_healthy: true, failures: [] },
  autonomy: { should_halt: false },
  adaptiveGate: { allowed: true, regime: 'TRENDING_UP' },
  promotionGate: { allowed: true, symbol: 'SOLUSDT', state: 'PROMOTED_LIMITED' },
  paperGate: {
    allowed: true,
    candidate: { symbol: 'SOLUSDT', score: 94.2, category: 'MOMENTUM', scan_id: 'scan_1' }
  },
  entries: { ok: true, positions_opened: 1, symbol: 'SOLUSDT' },
  openPositionsAfterCycle: 1,
  durationMs: 9100,
  config: { spot_only: true, max_position_usdt: 10 }
});

assert.strictEqual(bought.action, 'BUY');
assert.strictEqual(bought.decision, 'EXECUTED');
assert.strictEqual(bought.candidate.symbol, 'SOLUSDT');
assert.strictEqual(bought.gates.promotion, 'PASS');
assert.strictEqual(bought.gates.paper_to_real, 'PASS');

console.log('spotCycleObservability tests passed');