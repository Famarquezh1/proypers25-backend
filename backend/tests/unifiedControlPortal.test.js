'use strict';

const assert = require('assert');
const { buildStrategyMetrics, determineLeader, evaluateProductionGate } = require('../services/unifiedControlPortal');

const core = buildStrategyMetrics('CORE', {
  cash_usdt: 80,
  equity_usdt: 110,
  realized_pnl_usdt: 10,
  max_drawdown_pct: -4
}, [{ remaining_notional_usdt: 30, risk_score: 35 }], [
  { realized_pnl_usdt: 8, close_reason: 'TAKE_PROFIT_1', opened_at: '2026-01-01T00:00:00Z', closed_at: '2026-01-01T01:00:00Z' },
  { realized_pnl_usdt: -2, close_reason: 'STOP_LOSS', opened_at: '2026-01-02T00:00:00Z', closed_at: '2026-01-02T02:00:00Z' }
], [{ action: 'OBSERVE', risk_score: 45, created_at: '2026-01-02T03:00:00Z' }]);

assert.strictEqual(core.win_rate_pct, 50);
assert.strictEqual(core.profit_factor, 4);
assert.strictEqual(core.expectancy_usdt, 3);
assert.strictEqual(core.tp_count, 1);
assert.strictEqual(core.sl_count, 1);
assert.strictEqual(core.capital_used_usdt, 30);
assert.strictEqual(core.real_orders_enabled, false);

const gem = buildStrategyMetrics('GEM_HUNTER', { cash_usdt: 50, equity_usdt: 50, max_drawdown_pct: 0 }, [], [], []);
assert.strictEqual(gem.data_state, 'EMPTY');
assert.strictEqual(determineLeader(core, gem).strategy, 'CORE');

const blocked = evaluateProductionGate({
  core,
  gem,
  discovery: { exists: true },
  realCycle: { binance_ok: true },
  learningHealthy: true,
  dataQuality: false,
  health: { ok: true },
  firestoreOk: true
});
assert.strictEqual(blocked.status, 'BLOCKED');
assert.strictEqual(blocked.enables_real_trading, false);
assert.ok(blocked.checks.some((check) => check.name === 'GEM Hunter' && check.status === 'BLOCKED'));

const readyStrategy = { ...core, operations_count: 30, expectancy_usdt: 1, profit_factor: 1.5, drawdown_pct: 5, data_state: 'AVAILABLE', real_orders_enabled: false };
const ready = evaluateProductionGate({
  core: readyStrategy,
  gem: readyStrategy,
  discovery: { exists: true },
  realCycle: { binance_ok: true },
  learningHealthy: true,
  dataQuality: true,
  health: { ok: true },
  firestoreOk: true
});
assert.strictEqual(ready.status, 'READY FOR PRODUCTION');
assert.strictEqual(ready.informational_only, true);

console.log('unifiedControlPortal tests passed');
