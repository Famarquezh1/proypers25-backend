'use strict';

const axios = require('axios');

const RESULTS = 'real_spot_execution_results';
const RUNS = 'spot_adaptive_strategy_runs';
const CONTROL = 'real_spot_config/adaptive_strategy';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mean(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function stdev(values) {
  if (values.length < 2) return 0;
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function computePerformanceMetrics(rows = []) {
  const returns = rows.map((row) => n(row.net_pnl_pct) / 100).filter(Number.isFinite);
  const wins = returns.filter((value) => value > 0);
  const losses = returns.filter((value) => value <= 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  let equity = 1;
  let peak = 1;
  let maxDrawdown = 0;
  for (const value of returns) {
    equity *= 1 + value;
    peak = Math.max(peak, equity);
    maxDrawdown = Math.max(maxDrawdown, peak > 0 ? (peak - equity) / peak : 0);
  }
  const downside = returns.filter((value) => value < 0);
  const volatility = stdev(returns);
  const downsideDeviation = stdev(downside);
  return {
    trades: returns.length,
    win_rate: returns.length ? wins.length / returns.length : 0,
    expectancy: mean(returns),
    profit_factor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0,
    max_drawdown: maxDrawdown,
    net_return: equity - 1,
    sharpe_like: volatility > 0 ? mean(returns) / volatility : 0,
    sortino_like: downsideDeviation > 0 ? mean(returns) / downsideDeviation : 0
  };
}

function classifyRegime(candles = []) {
  if (candles.length < 50) return { regime: 'UNKNOWN', confidence: 0 };
  const closes = candles.map((row) => n(row.close));
  const recent = closes.slice(-20);
  const prior = closes.slice(-40, -20);
  const recentMean = mean(recent);
  const priorMean = mean(prior);
  const trend = priorMean > 0 ? (recentMean / priorMean) - 1 : 0;
  const returns = recent.slice(1).map((value, index) => (value / recent[index]) - 1);
  const volatility = stdev(returns);
  let regime = 'SIDEWAYS_LOW_VOL';
  if (volatility >= 0.018) regime = trend >= 0 ? 'BULL_HIGH_VOL' : 'BEAR_HIGH_VOL';
  else if (trend >= 0.025) regime = 'BULL_TREND';
  else if (trend <= -0.025) regime = 'BEAR_TREND';
  else if (volatility >= 0.009) regime = 'SIDEWAYS_HIGH_VOL';
  return {
    regime,
    trend_20_vs_20: trend,
    volatility_20: volatility,
    confidence: Math.min(1, Math.abs(trend) * 12 + volatility * 15)
  };
}

function decideStrategyState(metrics, regime) {
  if (metrics.trades < 10) {
    return { state: 'OBSERVE', entry_allowed: true, reasons: ['INSUFFICIENT_REAL_SAMPLE'] };
  }
  const reasons = [];
  if (metrics.expectancy <= 0) reasons.push('NON_POSITIVE_EXPECTANCY');
  if (metrics.profit_factor < 1.05) reasons.push('PROFIT_FACTOR_DEGRADED');
  if (metrics.max_drawdown > 0.12) reasons.push('DRAWDOWN_TOO_HIGH');
  if (regime.regime.startsWith('BEAR') && metrics.win_rate < 0.45) reasons.push('BEAR_REGIME_WEAKNESS');
  const degraded = reasons.length > 0;
  return {
    state: degraded ? 'DEGRADED' : 'ACTIVE',
    entry_allowed: !degraded,
    reasons
  };
}

async function fetchMarketRegime() {
  const response = await axios.get('https://api.binance.com/api/v3/klines', {
    params: { symbol: 'BTCUSDT', interval: '1h', limit: 120 },
    timeout: 12000
  });
  const candles = (response.data || []).map((row) => ({ close: n(row[4]) }));
  return classifyRegime(candles);
}

async function runAdaptiveSpotStrategyController(db) {
  const snapshot = await db.collection(RESULTS).orderBy('closed_at', 'desc').limit(100).get();
  const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const metrics = computePerformanceMetrics(rows);
  const regime = await fetchMarketRegime();
  const decision = decideStrategyState(metrics, regime);
  const now = new Date().toISOString();
  const run = {
    id: `adaptive_${Date.now()}`,
    created_at: now,
    spot_only: true,
    no_order_created: true,
    metrics,
    regime,
    decision,
    version: 'adaptive_spot_strategy_v1'
  };
  await db.collection(RUNS).doc(run.id).set(run);
  await db.doc(CONTROL).set({
    updated_at: now,
    ...decision,
    metrics,
    regime,
    source_run_id: run.id,
    real_entry_approval: false,
    requires_paper_gate: true,
    limits_unchanged: true
  }, { merge: true });
  return run;
}

async function getAdaptiveEntryGate(db) {
  const snap = await db.doc(CONTROL).get();
  if (!snap.exists) return { allowed: true, state: 'NOT_INITIALIZED', reasons: ['ADAPTIVE_GATE_NOT_INITIALIZED'] };
  const data = snap.data();
  return {
    allowed: data.entry_allowed !== false,
    state: data.state || 'UNKNOWN',
    reasons: data.reasons || [],
    metrics: data.metrics || null,
    regime: data.regime || null
  };
}

module.exports = {
  computePerformanceMetrics,
  classifyRegime,
  decideStrategyState,
  runAdaptiveSpotStrategyController,
  getAdaptiveEntryGate
};
