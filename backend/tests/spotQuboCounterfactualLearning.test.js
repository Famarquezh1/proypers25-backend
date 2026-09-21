'use strict';

const assert = require('assert');
const { classifyMarketRegime } = require('../services/spotMarketRegime');
const {
  parseSignal,
  parsePreapprovalRejection,
  classifyDecision,
  classifyDecisionDetail,
  parseExitIssue,
  matchActualExit,
  exitQuality,
  firstTouchOutcome,
  outcomeMetrics,
  trainAdaptiveWeights,
  trainRegimeWeights,
  summarizeDecisions,
  summarizeRejectionReasons,
  summarizeRegimes
} = require('../scripts/train-spot-qubo-counterfactual-v5');

(function marketRegimeUsesOnlyPriorBars() {
  const start = Date.UTC(2026, 8, 17, 0, 0, 0);
  const bars = [];
  let price = 100;
  for (let i = 0; i < 289; i += 1) {
    price *= 1.00008;
    bars.push([start + i * 300000, 0, 0, 0, price]);
  }
  const result = classifyMarketRegime(bars, bars[bars.length - 1][0]);
  assert(['BULL', 'MIXED', 'RANGE', 'VOLATILE'].includes(result.regime));
  assert(result.r4h > 0);
})();

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


(function parsesPreapprovalRejection() {
  const parsed = parsePreapprovalRejection({
    observed_at: '2026-09-20T20:00:00Z',
    symbol: 'MISSUSDT',
    price: 1.25,
    pct: 4.2,
    qv: 1200000,
    utility: 0.66,
    base: 0.51,
    stable: 0.72,
    v42: 0.91,
    stage: 'PRODUCTION_QUALITY_GATE',
    reasons: ['THIN_LIQUIDITY']
  });
  assert(parsed);
  assert.strictEqual(parsed.sample_source, 'RADAR_PRE_APPROVAL');
  assert.strictEqual(parsed.symbol, 'MISSUSDT');
  assert.strictEqual(parsed.preapproval_reasons[0], 'THIN_LIQUIDITY');
})();

(function decisionsAreSeparated() {
  assert.strictEqual(classifyDecision([{ body: '✅ Validación autónoma local aprobó la oportunidad y ejecutó la compra Spot. orderId: 1.' }]), 'EXECUTED');
  const declined = classifyDecisionDetail([{ body: '🛑 Oportunidad descartada automáticamente por el PC local. No se compró. Motivo: Price advanced 3.4%; anti-chase blocked' }]);
  assert.strictEqual(declined.decision, 'DECLINED');
  assert(/anti-chase/i.test(declined.reason));
  assert.strictEqual(classifyDecision([{ body: '⚠️ problema técnico. No asumir compra.' }]), 'TECHNICAL');
})();

(function actualExitQualityIsMeasured() {
  const exit = parseExitIssue({
    number: 99,
    created_at: '2026-09-18T02:00:00Z',
    body: ['- Símbolo: TESTUSDT', '- Motivo: TRAILING_STOP', '- Entrada aprox.: 1', '- Salida aprox.: 1.025', '- PnL aprox.: 2.500%'].join('\n')
  });
  assert(exit);
  const signal = { symbol: 'TESTUSDT', created_at: '2026-09-18T01:00:00Z' };
  assert.strictEqual(matchActualExit(signal, [exit]).issue_number, 99);
  const quality = exitQuality(exit, { mfe_pct: 4.0 });
  assert.strictEqual(quality.actual_pnl_pct, 2.5);
  assert.strictEqual(quality.capture_ratio, 0.625);
  assert.strictEqual(quality.regret_vs_mfe_pct, 1.5);
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
  rows.forEach((row, i) => {
    row.market_regime = i < 15 ? 'BULL' : 'BEAR';
    row.decision_reason = row.decision === 'DECLINED' ? (i % 4 ? 'anti-chase blocked' : 'liquidity dropped') : 'EXECUTED';
  });
  const trained = trainAdaptiveWeights(rows, { base: 0.55, stable: 0.05, v42: 0.40 });
  assert.strictEqual(trained.samples, 30);
  assert(trained.holdout_samples >= 6);
  const summary = summarizeDecisions(rows);
  assert.strictEqual(summary.executed, 15);
  assert.strictEqual(summary.declined, 15);
  rows[1].sample_source = 'RADAR_PRE_APPROVAL';
  assert.strictEqual(summarizeDecisions(rows).preapproval_declined, 1);
  const reasons = summarizeRejectionReasons(rows);
  assert(reasons.length >= 1);
  const regimes = summarizeRegimes(rows);
  assert.strictEqual(regimes.length, 2);
  const regimeTraining = trainRegimeWeights(rows, { base: 0.55, stable: 0.05, v42: 0.40 });
  assert(regimeTraining && typeof regimeTraining === 'object');
})();

console.log('spot QUBO counterfactual learning tests passed');
