'use strict';

const assert = require('assert');
const {
  CURRENT_CORE_POLICY,
  parseSignal,
  classifyDecision,
  parseExit,
  dedupeExits,
  simulatePolicy,
  policyGrid,
  metrics,
  chronologicalSplit,
  trainPolicy,
  evaluateHoldout
} = require('../scripts/train-spot-exit-policy-v2');

(function parsesCoreSignal() {
  const row = parseSignal({
    number: 1,
    created_at: '2026-09-10T00:00:00Z',
    title: '[SPOT SIGNAL] TESTUSDT +8.2%',
    body: ['- Símbolo: TESTUSDT', '- Precio: 1.25'].join('\n')
  });
  assert(row);
  assert.strictEqual(row.lane, 'CORE');
  assert.strictEqual(row.symbol, 'TESTUSDT');
})();

(function parsesV10Signal() {
  const row = parseSignal({
    number: 2,
    created_at: '2026-09-10T00:00:00Z',
    title: '[SPOT SIGNAL] TESTUSDT +8.2%',
    body: ['- Símbolo: TESTUSDT', '- Precio: 1.25', '- Lane: V10_HUNTER'].join('\n')
  });
  assert(row);
  assert.strictEqual(row.lane, 'V10_HUNTER');
})();

(function decisionsAreDetected() {
  assert.strictEqual(classifyDecision([{ body: 'ejecutó la compra Spot. orderId: 123' }]).decision, 'EXECUTED');
  assert.strictEqual(classifyDecision([{ body: 'Oportunidad descartada automáticamente. No se compró.' }]).decision, 'DECLINED');
})();

(function exitsDeduplicate() {
  const a = parseExit({
    number: 10,
    created_at: '2026-09-11T00:00:00Z',
    title: '[SPOT EXIT] TESTUSDT STOP',
    body: ['- Símbolo: TESTUSDT', '- Motivo: STOP_LOSS', '- Entrada aprox.: 1', '- Salida aprox.: 0.95', '- PnL aprox.: -5%', '- orderId=55'].join('\n')
  });
  assert(a);
  assert.strictEqual(dedupeExits([a, { ...a, issue_number: 11 }]).length, 1);
})();

(function simulatorStopsConservatively() {
  const bars = [
    [0, 1, 1.03, 0.94, 1.01],
    [300000, 1.01, 1.02, 1, 1.01]
  ];
  const result = simulatePolicy(bars, 1, CURRENT_CORE_POLICY, 0);
  assert(result);
  assert.strictEqual(result.reason, 'HARD_STOP');
  assert(Math.abs(result.return_pct + 0.05) < 1e-9);
})();

(function simulatorCanTakeProfit() {
  const policy = { ...CURRENT_CORE_POLICY, hard_stop_pct: 0.03, take_profit_pct: 0.04 };
  const bars = [
    [0, 1, 1.041, 0.995, 1.03]
  ];
  const result = simulatePolicy(bars, 1, policy, 0);
  assert.strictEqual(result.reason, 'TAKE_PROFIT');
  assert(Math.abs(result.return_pct - 0.04) < 1e-9);
})();

(function policyGridIsBounded() {
  const grid = policyGrid();
  assert(grid.length > 200);
  assert(grid.length < 3000);
  for (const p of grid) {
    assert(p.hard_stop_pct > 0 && p.hard_stop_pct <= 0.05);
    assert(p.trailing_distance_pct < p.trailing_trigger_pct + 0.015);
  }
})();

(function chronologicalTrainingAndHoldoutWork() {
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    const good = i % 2 === 0;
    const bars = [];
    let price = 1;
    for (let k = 0; k < 144; k += 1) {
      price *= good ? 1.00035 : 0.9999;
      bars.push([
        Date.UTC(2026, 8, 10, 0, i) + k * 300000,
        price,
        good ? Math.max(price, 1.045) : price * 1.002,
        good ? price * 0.998 : Math.min(price, 0.965),
        price
      ]);
    }
    rows.push({
      created_at: new Date(Date.UTC(2026, 8, 10, 0, i)).toISOString(),
      entry_price: 1,
      bars
    });
  }
  const split = chronologicalSplit(rows);
  assert(split.train.length > 0 && split.validation.length > 0 && split.holdout.length > 0);
  assert(Date.parse(split.train.at(-1).created_at) < Date.parse(split.holdout[0].created_at));
  const trained = trainPolicy(split.train, split.validation);
  assert(trained.selected.policy);
  const evalResult = evaluateHoldout(split.holdout, trained.selected.policy);
  assert.strictEqual(evalResult.holdout_samples, undefined); // top-level metrics contain samples
  assert(Number.isFinite(evalResult.candidate.mean_return_pct));
})();

(function metricsAreSane() {
  const rows = [{
    entry_price: 1,
    bars: [[0, 1, 1.05, 0.99, 1.04]]
  }];
  const m = metrics(rows, { ...CURRENT_CORE_POLICY, take_profit_pct: 0.04 });
  assert.strictEqual(m.samples, 1);
  assert(m.mean_return_pct > 3);
})();

console.log('spot exit policy historical training tests passed');
