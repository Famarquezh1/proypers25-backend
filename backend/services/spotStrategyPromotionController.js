'use strict';

const CHAMPION = 'spot_quant_champions/current';
const ADAPTIVE = 'real_spot_config/adaptive_strategy';
const PROMOTION = 'real_spot_config/strategy_promotion';
const RESULTS = 'real_spot_execution_results';
const VALIDATIONS = 'spot_opportunity_validations';
const RUNS = 'spot_strategy_promotion_runs';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function normalizedSymbol(value) {
  return String(value || '').toUpperCase();
}

function positiveValidation(row) {
  const status = String(row?.status || row?.result || '').toUpperCase();
  return row?.positive === true || row?.is_positive === true || ['POSITIVE', 'PASSED', 'APPROVED'].includes(status);
}

function summarizeReal(rows = [], symbol) {
  const filtered = rows.filter((row) => !symbol || normalizedSymbol(row.symbol) === normalizedSymbol(symbol));
  const returns = filtered.map((row) => n(row.net_pnl_pct) / 100).filter(Number.isFinite);
  const pnl = filtered.map((row) => n(row.net_pnl_usdt)).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  return {
    trades: returns.length,
    expectancy: mean(returns),
    win_rate: returns.length ? wins.length / returns.length : 0,
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    net_pnl_usdt: pnl.reduce((sum, value) => sum + value, 0)
  };
}

function summarizePaper(rows = [], symbol) {
  const filtered = rows.filter((row) => normalizedSymbol(row.symbol) === normalizedSymbol(symbol));
  const positive = filtered.filter(positiveValidation);
  const sampleSize = filtered.reduce((sum, row) => sum + Math.max(1, n(row.sample_size ?? row.completed_count ?? row.observations, 1)), 0);
  return {
    validations: filtered.length,
    positive_validations: positive.length,
    positive_rate: filtered.length ? positive.length / filtered.length : 0,
    sample_size: sampleSize
  };
}

function assessPromotion({ champion, adaptive, paper, real, config = {} }) {
  const reasons = [];
  const symbol = normalizedSymbol(champion?.symbol);
  const validation = champion?.champion?.walk?.validation;
  const test = champion?.champion?.walk?.test;
  const calibration = champion?.champion?.calibration;
  const minPaperValidations = Math.max(3, n(config.strategy_promotion_min_paper_validations, 3));
  const minPaperSamples = Math.max(10, n(config.strategy_promotion_min_paper_samples, 20));
  const minRealTrades = Math.max(3, n(config.strategy_promotion_min_real_trades, 5));
  const maxPaperRealExpectancyGap = Math.max(0.0025, n(config.strategy_promotion_max_expectancy_gap, 0.02));

  if (!symbol) reasons.push('NO_QUANT_CHAMPION');
  if (champion?.promotion_eligible !== true) reasons.push('QUANT_CHAMPION_NOT_ELIGIBLE');
  if (!validation || validation.expectancy <= 0 || validation.profitFactor < 1.15) reasons.push('VALIDATION_OUT_OF_SAMPLE_WEAK');
  if (!test || test.expectancy <= 0 || test.profitFactor < 1.15 || test.maxDrawdown > 0.12) reasons.push('TEST_OUT_OF_SAMPLE_WEAK');
  if (calibration && calibration.samples >= 20 && calibration.calibrated !== true) reasons.push('PROBABILITY_CALIBRATION_WEAK');
  if (paper.validations < minPaperValidations) reasons.push('INSUFFICIENT_PAPER_VALIDATIONS');
  if (paper.sample_size < minPaperSamples) reasons.push('INSUFFICIENT_PAPER_SAMPLE');
  if (paper.positive_rate < 0.6) reasons.push('PAPER_POSITIVE_RATE_TOO_LOW');
  if (adaptive?.entry_allowed === false || adaptive?.state === 'DEGRADED') reasons.push('ADAPTIVE_STRATEGY_DEGRADED');

  const paperExpectancy = n(test?.expectancy);
  const realExpectancy = n(real.expectancy);
  const divergence = real.trades > 0 ? Math.abs(paperExpectancy - realExpectancy) : null;
  if (real.trades >= minRealTrades) {
    if (real.expectancy <= 0) reasons.push('REAL_EXPECTANCY_NON_POSITIVE');
    if (real.profit_factor < 1.05) reasons.push('REAL_PROFIT_FACTOR_DEGRADED');
    if (divergence !== null && divergence > maxPaperRealExpectancyGap) reasons.push('PAPER_REAL_DIVERGENCE_TOO_HIGH');
  }

  const evidenceReady = reasons.length === 0;
  return {
    symbol: symbol || null,
    state: evidenceReady ? 'PROMOTED_LIMITED' : 'OBSERVE',
    entry_allowed: evidenceReady,
    reasons,
    champion_run_id: champion?.research_run_id || null,
    paper,
    real,
    divergence: {
      expectancy_gap: divergence,
      paper_expectancy: paperExpectancy,
      real_expectancy: realExpectancy,
      enough_real_sample: real.trades >= minRealTrades
    },
    limits: {
      real_max_position_usdt: 10,
      real_max_open_positions: 1,
      min_paper_validations: minPaperValidations,
      min_paper_samples: minPaperSamples,
      min_real_trades: minRealTrades,
      max_expectancy_gap: maxPaperRealExpectancyGap
    },
    no_order_created: true,
    requires_paper_gate: true,
    requires_technical_confirmation: true
  };
}

async function evaluateStrategyPromotion(db, config = {}) {
  const [championSnap, adaptiveSnap, validationSnap, resultSnap] = await Promise.all([
    db.doc(CHAMPION).get(),
    db.doc(ADAPTIVE).get(),
    db.collection(VALIDATIONS).orderBy('created_at', 'desc').limit(300).get(),
    db.collection(RESULTS).orderBy('closed_at', 'desc').limit(200).get()
  ]);
  const champion = championSnap.exists ? championSnap.data() : null;
  const adaptive = adaptiveSnap.exists ? adaptiveSnap.data() : null;
  const symbol = normalizedSymbol(champion?.symbol);
  const paperRows = validationSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const realRows = resultSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const decision = assessPromotion({
    champion,
    adaptive,
    paper: summarizePaper(paperRows, symbol),
    real: summarizeReal(realRows, symbol),
    config
  });
  const now = new Date().toISOString();
  const run = {
    id: `promotion_${Date.now()}`,
    created_at: now,
    ...decision,
    spot_only: true,
    futures_allowed: false,
    margin_allowed: false,
    leverage_allowed: false,
    withdrawals_allowed: false,
    version: 'spot_strategy_promotion_v1'
  };
  await db.collection(RUNS).doc(run.id).set(run);
  await db.doc(PROMOTION).set({ ...run, updated_at: now, source_run_id: run.id }, { merge: true });
  return run;
}

async function getStrategyPromotionGate(db) {
  const snap = await db.doc(PROMOTION).get();
  if (!snap.exists) return { allowed: false, state: 'NOT_INITIALIZED', reasons: ['STRATEGY_PROMOTION_NOT_INITIALIZED'] };
  const data = snap.data();
  return {
    allowed: data.entry_allowed === true,
    state: data.state || 'UNKNOWN',
    symbol: data.symbol || null,
    reasons: data.reasons || [],
    paper: data.paper || null,
    real: data.real || null,
    divergence: data.divergence || null,
    updated_at: data.updated_at || data.created_at || null
  };
}

module.exports = {
  positiveValidation,
  summarizeReal,
  summarizePaper,
  assessPromotion,
  evaluateStrategyPromotion,
  getStrategyPromotionGate
};