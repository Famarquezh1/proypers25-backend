'use strict';

const assert = require('assert');
const { buildSpotCycleDecisionLog, buildExitDiagnostics, normalizeExitFailure, inferAction, compactReasons } = require('../services/spotCycleObservability');

assert.strictEqual(inferAction({ positions_opened: 1 }, {}), 'BUY');
assert.strictEqual(inferAction({}, { sold: 1 }), 'SELL');
assert.strictEqual(inferAction({ positions_opened: 1 }, { sold: 1 }), 'SELL_AND_BUY');
assert.strictEqual(inferAction({ skipped: true }, {}), 'NO_ACTION');
assert.deepStrictEqual(compactReasons('A', ['A', 'B'], null), ['A', 'B']);

const normalizedFailure = normalizeExitFailure({
  symbol: 'XECUSDT', positionId: 'pos_1', stage: 'SELL_ORDER',
  error: { code: 'MIN_NOTIONAL', message: 'Order value below minimum' },
  retryable: true, retryState: 'EXIT_RETRY_READY', retryCount: 2
}, 0);
assert.strictEqual(normalizedFailure.reason, 'MIN_NOTIONAL');
assert.strictEqual(normalizedFailure.retry_state, 'EXIT_RETRY_READY');

const diagnostics = buildExitDiagnostics({ ok: false, blocked: true, exit_engine_healthy: false, failures: [{ symbol: 'XECUSDT', reason: 'INSUFFICIENT_BALANCE' }] });
assert.strictEqual(diagnostics.failure_count, 1);
assert.strictEqual(diagnostics.failure_reasons[0], 'INSUFFICIENT_BALANCE');

const skipped = buildSpotCycleDecisionLog({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, exit_engine_healthy: true, sold: 0, failures: [] },
  autonomy: { should_halt: false },
  adaptiveGate: { allowed: true, regime: { regime: 'SIDEWAYS_LOW_VOL' } },
  promotionGate: { indicator_only: true, blocks_entry: false, high_confidence: false, state: 'OBSERVE', reasons: ['QUANT_CHAMPION_NOT_ELIGIBLE'] },
  paperGate: { allowed: false, reasons: ['TECHNICAL_VOLUME_NOT_CONFIRMED'], technical_confirmation: { allowed: false } },
  entries: { skipped: true, reason: 'TECHNICAL_VOLUME_NOT_CONFIRMED', failed_conditions: [{ component: 'Technical Confirmation', code: 'TECHNICAL_VOLUME_NOT_CONFIRMED' }] },
  discovery: { scan_id: 'scan_1', total_symbols_scanned: 200, candidates_saved: 200, top_symbol: 'SOLUSDT', top_score: 92 },
  paperValidation: { latest_scan_id: 'scan_1', intents_created: 1 },
  openPositionsAfterCycle: 0,
  durationMs: 8500,
  config: { spot_only: true, max_position_usdt: 10, max_open_positions: 1, futures_allowed: false, margin_allowed: false, leverage_allowed: false, withdrawals_allowed: false }
});
assert.strictEqual(skipped.reason, 'TECHNICAL_VOLUME_NOT_CONFIRMED');
assert.strictEqual(skipped.gates.promotion, 'CONFIDENCE_LOW');
assert.strictEqual(skipped.gates.promotion_blocks_entry, false);
assert.strictEqual(skipped.gates.paper_to_real, 'BLOCK');
assert.strictEqual(skipped.gates.technical_confirmation, 'BLOCK');
assert.strictEqual(skipped.market.assets_analyzed, 200);
assert.strictEqual(skipped.market.candidates_ranked, 200);
assert.strictEqual(skipped.failed_conditions[0].component, 'Technical Confirmation');

const bought = buildSpotCycleDecisionLog({
  reconciliation: { account_consistent: true },
  exits: { ok: true, exit_engine_healthy: true, failures: [] },
  autonomy: { should_halt: false },
  adaptiveGate: { allowed: true, regime: { regime: 'BULL_TREND' } },
  promotionGate: { indicator_only: true, blocks_entry: false, high_confidence: false, state: 'OBSERVE' },
  paperGate: { allowed: true, technical_confirmation: { allowed: true }, candidate: { symbol: 'SOLUSDT', score: 94.2, category: 'MOMENTUM', scan_id: 'scan_1' } },
  entries: { ok: true, positions_opened: 1, selected_symbol: 'SOLUSDT', order_created: true },
  openPositionsAfterCycle: 1,
  durationMs: 9100,
  config: { spot_only: true, max_position_usdt: 10, max_open_positions: 1 }
});
assert.strictEqual(bought.action, 'BUY');
assert.strictEqual(bought.decision, 'EXECUTED');
assert.strictEqual(bought.candidate.symbol, 'SOLUSDT');
assert.strictEqual(bought.gates.promotion_blocks_entry, false);
assert.strictEqual(bought.gates.paper_to_real, 'PASS');
assert.strictEqual(bought.gates.technical_confirmation, 'PASS');

console.log('spotCycleObservability tests passed');