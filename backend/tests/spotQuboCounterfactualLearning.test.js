'use strict';

const assert = require('assert');
const {
  parseSignal,
  classifyDecision,
  firstTouchOutcome,
  outcomeMetrics,
  trainAdaptiveWeights,
  summarizeDecisions
} = require('../scripts/train-spot-qubo-counterfactual-v5');

(function parsesLegacyCoreSignal() {
  const issue = {
    number: 1,
    created_at: '2026-09-17T00:00:00Z',
    body: [
      'Proypers25 detectó una oportunidad Spot en producción con V4.2 y QUBO.',
      '- Símbolo: TESTUSDT',
      '- Cambio 24h: +8.5%',
      '- Precio: 1.0',
      '- Volumen quote 24h: 5000000 USD/USDT aprox.',
      '- Utility: 0.82',
      '- QUBO: LOCAL_QUBO_EXACT_PRODUCTION_V42',
      '- V4.2 robustez: 3/3 ventanas | score: 0.95'
    ].join('\n')
  };
  const parsed = parseSignal(issue);
  assert(parsed);
  assert.strictEqual(parsed.symbol, 'TESTUSDT');
  assert(parsed.base >= 0 && parsed.base <= 1);
  assert(parsed.stable >= 0 && parsed.stable <= 1);
})();

(function parsesDirectFeatures() {
  const issue = {
    number: 2,
    created_at: '2026-09-17T00:00:00Z',
    body: [
      'V4.2 QUBO',
      '- Símbolo: ABCUSDT',
      '- Cambio 24h: +7%',
      '- Precio: 2',
      '- Volumen quote 24h: 9000000',
      '- Utility: 0.8',
      '- QUBO: LOCAL_QUBO_BQM_EXACT_PRODUCTION_V5',
      '- QUBO features: base=0.72 | stable=0.61 | v42=0.92',
      '- V4.2 robustez: 3/3 ventanas | score: 0.92'
    ].join('\n')
  };
  const parsed = parseSignal(issue);
  assert.strictEqual(parsed.base, 0.72);
  assert.strictEqual(parsed.stable, 0.61);
})();

(function decisionsAreSeparated() {
  assert.strictEqual(classifyDecision([{ body: '✅ Validación autónoma local aprobó la oportunidad y ejecutó la compra Spot. orderId: 1.' }]), 'EXECUTED');
  assert.strictEqual(classifyDecision([{ body: '🛑 Oportunidad descartada automáticamente por el PC local. No se compró.' }]), 'DECLINED');
  assert.strictEqual(classifyDecision([{ body: '⚠️ problema técnico. No asumir compra.' }]), 'TECHNICAL');
})();

(function outcomeIsConservative() {
  const entry = 100;
  const sameCandle = [[0,0,104,94,101]];
  assert.strictEqual(firstTouchOutcome(sameCandle, entry), 'LOSS');
  const winBars = [[0,0,103.5,99,103]];
  assert.strictEqual(firstTouchOutcome(winBars, entry), 'WIN');
  const metrics = outcomeMetrics(winBars, entry);
  assert(metrics.mfe_pct > 3);
  assert(metrics.target_pct > 0);
})();

(function adaptiveTrainingUsesDeclinedAndExecutedRows() {
  const rows = [];
  for (let i = 0; i < 30; i += 1) {
    rows.push({
      created_at: new Date(Date.UTC(2026, 8, 1, i)).toISOString(),
      decision: i % 2 ? 'DECLINED' : 'EXECUTED',
      base: i / 30,
      stable: 1 - i / 30,
      v42: 0.5,
      target_pct: i / 10,
      first_touch_3pct_vs_5pct: i % 3 ? 'WIN' : 'LOSS'
    });
  }
  const trained = trainAdaptiveWeights(rows, { base: 0.55, stable: 0.05, v42: 0.40 });
  assert.strictEqual(trained.samples, 30);
  assert(trained.holdout_samples >= 6);
  const summary = summarizeDecisions(rows);
  assert.strictEqual(summary.executed, 15);
  assert.strictEqual(summary.declined, 15);
})();

console.log('spot QUBO counterfactual learning tests passed');
