'use strict';

const assert = require('assert');
const {
  parseHistoricalSignal,
  dedupeExits,
  pctBucket,
  liquidityBucket,
  historyCellKey,
  trainHistoryPrior,
  historyEdge,
  trainHistoricalModel,
  evaluateHistoricalModel,
  chronologicalSplit,
  summarizeExitHistory
} = require('../scripts/train-spot-qubo-full-history-v5');

(function parsesPreQuboSignal() {
  const row = parseHistoricalSignal({
    number: 23,
    created_at: '2026-09-10T15:19:51Z',
    title: '[SPOT SIGNAL] KDAUSDT +17.647%',
    body: [
      '- Símbolo: KDAUSDT',
      '- Cambio 24h: +17.647%',
      '- Precio: 0.00600000',
      '- Volumen quote 24h: 343775.05241600 USD/USDT aprox.'
    ].join('\n')
  });
  assert(row);
  assert.strictEqual(row.symbol, 'KDAUSDT');
  assert.strictEqual(row.feature_complete, false);
  assert(row.base >= 0 && row.base <= 1);
})();

(function parsesModernSignal() {
  const row = parseHistoricalSignal({
    number: 991,
    created_at: '2026-09-18T20:20:21Z',
    title: '[SPOT SIGNAL] SOXLBUSDT +8.087%',
    body: [
      '- Símbolo: SOXLBUSDT',
      '- Cambio 24h: +8.087%',
      '- Precio: 123.76',
      '- Volumen quote 24h: 3157733.71087 USD/USDT aprox.',
      '- Utility: 0.707728',
      '- QUBO: LOCAL_QUBO_BQM_EXACT_PRODUCTION_V5',
      '- QUBO contexto: regime=RANGE | effective_weights={"base":0.55,"stable":0.05,"v42":0.4}',
      '- QUBO features: base=0.67613 | stable=0.778237226104429 | v42=0.742363',
      '- V4.2 robustez: 2/3 ventanas | score: 0.742363'
    ].join('\n')
  });
  assert(row);
  assert.strictEqual(row.feature_complete, true);
  assert.strictEqual(row.market_regime_recorded, 'RANGE');
  assert.strictEqual(row.stable, 0.778237226104429);
})();

(function exitDedupUsesOrderId() {
  const exits = dedupeExits([
    { symbol: 'AAAUSDT', order_id: '1', pnl_pct: 2, created_at: '2026-09-11T00:00:00Z' },
    { symbol: 'AAAUSDT', order_id: '1', pnl_pct: 2, created_at: '2026-09-11T00:01:00Z' },
    { symbol: 'AAAUSDT', order_id: '2', pnl_pct: -1, created_at: '2026-09-11T01:00:00Z' }
  ]);
  assert.strictEqual(exits.length, 2);
})();

(function historyBucketsAreStable() {
  assert.strictEqual(pctBucket(3.9), 'P01_04');
  assert.strictEqual(pctBucket(8), 'P07_10');
  assert.strictEqual(liquidityBucket(900000), 'L0_1M');
  assert.strictEqual(liquidityBucket(25000000), 'L20M_PLUS');
  assert.strictEqual(historyCellKey({ market_regime: 'RANGE', pct: 8, qv: 25000000 }), 'RANGE|P07_10|L20M_PLUS');
})();

(function historyPriorShrinksAndScores() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({
      market_regime: i < 15 ? 'BULL' : 'BEAR',
      pct: i < 15 ? 8 : 11,
      qv: i < 15 ? 10000000 : 2000000,
      target_pct: i < 15 ? 3 + i * 0.01 : -1 - i * 0.01
    });
  }
  const prior = trainHistoryPrior(rows);
  const bullEdge = historyEdge({ market_regime: 'BULL', pct: 8, qv: 10000000 }, prior);
  const bearEdge = historyEdge({ market_regime: 'BEAR', pct: 11, qv: 2000000 }, prior);
  assert(bullEdge > bearEdge);
  assert(bullEdge <= 1 && bearEdge >= -1);
})();

(function chronologicalEvaluationIsOutOfSample() {
  const rows = [];
  for (let i = 0; i < 120; i += 1) {
    const bull = i % 2 === 0;
    const base = (i % 20) / 20;
    rows.push({
      created_at: new Date(Date.UTC(2026, 8, 10, 0, i)).toISOString(),
      feature_complete: true,
      base,
      stable: 1 - base,
      v42: 0.5 + base * 0.2,
      market_regime: bull ? 'BULL' : 'RANGE',
      pct: bull ? 7.5 : 11.5,
      qv: bull ? 10000000 : 1500000,
      target_pct: bull ? 2 + base : -0.5 + base,
      first_touch_3pct_vs_5pct: bull ? 'WIN' : 'NONE',
      exit_quality: bull ? { actual_pnl_pct: 1.5 + base } : null
    });
  }
  const { train, holdout } = chronologicalSplit(rows);
  assert(train.length > holdout.length);
  assert(Date.parse(train[train.length - 1].created_at) < Date.parse(holdout[0].created_at));
  const model = trainHistoricalModel(train, { base: 0.55, stable: 0.05, v42: 0.40 });
  const evaluation = evaluateHistoricalModel(holdout, model, { base: 0.55, stable: 0.05, v42: 0.40 });
  assert.strictEqual(evaluation.holdout_samples, holdout.length);
  assert(Number.isFinite(evaluation.candidate_spearman));
})();

(function exitSummaryIsDedupedInputSummary() {
  const summary = summarizeExitHistory([
    { reason: 'STOP', pnl_pct: 2 },
    { reason: 'STOP', pnl_pct: -1 },
    { reason: 'TP', pnl_pct: 3 }
  ]);
  assert.strictEqual(summary.unique_exit_orders, 3);
  assert.strictEqual(summary.positive, 2);
  assert.strictEqual(summary.negative, 1);
})();

console.log('spot QUBO full-history backfill tests passed');
