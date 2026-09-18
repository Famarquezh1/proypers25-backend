'use strict';

const assert = require('assert');
const PRODUCTION = require('../config/spot-exit-policy-v2.json');
const {
  CURRENT_CORE_POLICY,
  CURRENT_V61_POLICY,
  parseSignal,
  classifyDecision,
  parseExit,
  dedupeExits,
  oneToOneExitMatch,
  legacyStop,
  v61Features,
  maybeTightenV61,
  simulateStack,
  v61Grid,
  metrics,
  chronologicalSplit,
  trainV61Policy,
  evaluateHoldout
} = require('../scripts/train-spot-exit-policy-v2');

(function holdoutPassedPolicyIsProduction() {
  assert.strictEqual(PRODUCTION.mode, 'PRODUCTION');
  assert.strictEqual(PRODUCTION.v61.mfe, 0.018);
  assert.strictEqual(PRODUCTION.v61.r15, 0);
  assert.strictEqual(PRODUCTION.v61.confirm, 0.015);
  assert(PRODUCTION.training_reference.holdout_after.mean_return_pct > PRODUCTION.training_reference.holdout_before.mean_return_pct);
  assert(PRODUCTION.training_reference.holdout_after.profit_factor > PRODUCTION.training_reference.holdout_before.profit_factor);
})();

(function parsesCoreSignal() {
  const row = parseSignal({
    number: 1,
    created_at: '2026-09-10T00:00:00Z',
    title: '[SPOT SIGNAL] TESTUSDT +8.2%',
    body: ['- Símbolo: TESTUSDT', '- Precio: 1.25'].join('\n')
  });
  assert(row);
  assert.strictEqual(row.lane, 'CORE');
})();

(function decisionKeepsExecutionTime() {
  const result = classifyDecision([
    { created_at: '2026-09-10T00:01:00Z', body: 'ejecutó la compra Spot. orderId: 123' }
  ]);
  assert.strictEqual(result.decision, 'EXECUTED');
  assert.strictEqual(result.order_id, '123');
  assert.strictEqual(result.execution_at, '2026-09-10T00:01:00Z');
})();

(function exitsDeduplicateAndMatchOneToOne() {
  const exits = dedupeExits([
    { symbol: 'AAAUSDT', order_id: '1', created_at: '2026-09-10T02:00:00Z', pnl_pct: 2 },
    { symbol: 'AAAUSDT', order_id: '1', created_at: '2026-09-10T02:01:00Z', pnl_pct: 2 },
    { symbol: 'AAAUSDT', order_id: '2', created_at: '2026-09-10T05:00:00Z', pnl_pct: -1 }
  ]);
  assert.strictEqual(exits.length, 2);
  const signals = [
    { issue_number: 1, symbol: 'AAAUSDT', execution_at: '2026-09-10T01:00:00Z' },
    { issue_number: 2, symbol: 'AAAUSDT', execution_at: '2026-09-10T04:00:00Z' }
  ];
  const matches = oneToOneExitMatch(signals, exits);
  assert.strictEqual(matches.get(1).order_id, '1');
  assert.strictEqual(matches.get(2).order_id, '2');
})();

(function legacyStopBehaves() {
  const hard = legacyStop(100, 101, CURRENT_CORE_POLICY);
  assert.strictEqual(hard.reason, 'HARD_STOP');
  const be = legacyStop(100, 106, CURRENT_CORE_POLICY);
  assert.strictEqual(be.reason, 'BREAK_EVEN');
  const trail = legacyStop(100, 110, CURRENT_CORE_POLICY);
  assert.strictEqual(trail.reason, 'TRAILING');
})();

function syntheticBars(start, count, drift = 0.0002) {
  const rows = [];
  let price = 100;
  for (let i = 0; i < count; i += 1) {
    const open = price;
    price *= 1 + drift;
    const high = price * 1.002;
    const low = price * 0.998;
    rows.push([start + i * 300000, open, high, low, price, 0, start + (i + 1) * 300000 - 1, 1000000, 100]);
  }
  return rows;
}

(function v61FeaturesUseHistoricalContext() {
  const start = Date.UTC(2026, 8, 10);
  const bars = syntheticBars(start, 400, 0.0001);
  const btc = syntheticBars(start, 400, 0.00005);
  const f = v61Features(bars, 350, btc);
  assert(f);
  assert(Number.isFinite(f.confirm));
  assert(Number.isFinite(f.rs60));
})();

(function v61CanTightenOnlyWhenConditionsPass() {
  const start = Date.UTC(2026, 8, 10);
  const bars = syntheticBars(start, 400, 0);
  const btc = syntheticBars(start, 400, 0);
  // Force prior rise then fading close on last context bar.
  for (let i = 300; i < 350; i += 1) {
    bars[i][2] = 103;
    bars[i][4] = 103;
  }
  bars[350][2] = 103;
  bars[350][4] = 101.5;
  const tightened = maybeTightenV61({
    bars,
    index: 350,
    btcBars: btc,
    entryPrice: 100,
    high: 103,
    currentStop: 95,
    policy: { ...CURRENT_V61_POLICY, r15: 1, confirm: 10, healthyPnl: 10 }
  });
  assert(tightened >= 95);
})();

(function stackSimulationProducesFiniteResult() {
  const start = Date.UTC(2026, 8, 10);
  const context = syntheticBars(start, 600, 0.00005);
  const btc = syntheticBars(start, 600, 0.00003);
  const executionAt = new Date(start + 300 * 300000).toISOString();
  const row = {
    created_at: executionAt,
    execution_at: executionAt,
    entry_price: context[300][4],
    bars: context,
    btc_bars: btc
  };
  const result = simulateStack(row, CURRENT_CORE_POLICY, CURRENT_V61_POLICY, 0);
  assert(result);
  assert(Number.isFinite(result.return_pct));
})();

(function v61GridIsBounded() {
  const grid = v61Grid();
  assert(grid.length > 100);
  assert(grid.length < 1000);
  assert(grid.every((p) => p.enabled === true));
})();

(function chronologicalTrainingWorks() {
  const start = Date.UTC(2026, 8, 10);
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    const executionMs = start + i * 3600000;
    const bars = syntheticBars(executionMs - 24 * 3600000, 577, i % 2 === 0 ? 0.0002 : -0.00005);
    const btc = syntheticBars(executionMs - 24 * 3600000, 577, 0.00002);
    rows.push({
      created_at: new Date(executionMs).toISOString(),
      execution_at: new Date(executionMs).toISOString(),
      entry_price: bars[288][4],
      bars,
      btc_bars: btc
    });
  }
  const split = chronologicalSplit(rows);
  assert(split.train.length > split.validation.length);
  assert(split.holdout.length > 0);
  const trained = trainV61Policy(split.train, split.validation);
  assert(trained.selected.policy);
  const evaluation = evaluateHoldout(split.holdout, trained.selected.policy);
  assert(Number.isFinite(evaluation.candidate.mean_return_pct));
})();

(function metricsAreSane() {
  const start = Date.UTC(2026, 8, 10);
  const bars = syntheticBars(start, 577, 0.0001);
  const btc = syntheticBars(start, 577, 0.00005);
  const executionAt = new Date(start + 288 * 300000).toISOString();
  const m = metrics([{
    created_at: executionAt,
    execution_at: executionAt,
    entry_price: bars[288][4],
    bars,
    btc_bars: btc
  }], CURRENT_CORE_POLICY, CURRENT_V61_POLICY);
  assert.strictEqual(m.samples, 1);
  assert(Number.isFinite(m.mean_return_pct));
})();

(function parseExitStillWorks() {
  const exit = parseExit({
    number: 5,
    created_at: '2026-09-11T00:00:00Z',
    title: '[SPOT EXIT] TESTUSDT STOP',
    body: ['- Símbolo: TESTUSDT','- Motivo: STOP_LOSS','- Entrada aprox.: 1','- Salida aprox.: 0.95','- PnL aprox.: -5%','- orderId=99'].join('\n')
  });
  assert(exit);
  assert.strictEqual(exit.order_id, '99');
})();

console.log('spot exit stack historical training tests passed');
