'use strict';

const axios = require('axios');

const BINANCE_BASE = 'https://api.binance.com';
const DEFAULT_PROBE_LIMIT = 60;
const DEFAULT_CONCURRENCY = 8;
const BLOCKING_WARNINGS = new Set(['parabolic_24h_move', 'extreme_volatility', 'high_risk_profile']);

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  const numeric = asNumber(value, min);
  return Math.min(max, Math.max(min, numeric));
}

function average(values = []) {
  const finite = values.map(Number).filter(Number.isFinite);
  if (!finite.length) return 0;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function pctChange(current, previous) {
  const now = Number(current);
  const before = Number(previous);
  if (!(now > 0) || !(before > 0)) return 0;
  return ((now - before) / before) * 100;
}

function parseKlines(rows = []) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    openTime: Number(row[0]),
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4]),
    volume: Number(row[5]),
    closeTime: Number(row[6]),
    quoteVolume: Number(row[7])
  })).filter((row) => row.close > 0 && row.high > 0 && row.low > 0 && Number.isFinite(row.quoteVolume));
}

function earlyMomentumThresholds(config = {}) {
  return {
    enabled: config.early_momentum_enabled !== false,
    minimum_score: Math.max(55, asNumber(config.early_momentum_min_score, 65)),
    minimum_quote_volume_usdt: Math.max(100000, asNumber(config.early_momentum_min_quote_volume_usdt, 500000)),
    minimum_price_change_24h: Math.max(0, asNumber(config.early_momentum_min_price_change_24h, 0.5)),
    maximum_price_change_24h: Math.max(5, asNumber(config.early_momentum_max_price_change_24h, 18)),
    minimum_change_5m_pct: Math.max(0, asNumber(config.early_momentum_min_change_5m_pct, 0.1)),
    minimum_change_15m_pct: Math.max(0, asNumber(config.early_momentum_min_change_15m_pct, 0.5)),
    minimum_change_1h_pct: Math.max(0, asNumber(config.early_momentum_min_change_1h_pct, 1.0)),
    minimum_relative_volume: Math.max(1, asNumber(config.early_momentum_min_relative_volume, 1.15)),
    minimum_intraday_confirmations: Math.max(2, Math.min(3, asNumber(config.early_momentum_min_intraday_confirmations, 2))),
    maximum_risk_score: Math.min(70, Math.max(0, asNumber(config.early_momentum_max_risk_score, 55))),
    minimum_existing_evidence_positive_rate: Math.max(0.25, Math.min(1, asNumber(config.early_momentum_min_existing_positive_rate, 0.4))),
    minimum_technical_score: Math.max(55, asNumber(config.early_momentum_min_technical_score, 60)),
    minimum_timeframe_confirmations: Math.max(2, asNumber(config.early_momentum_min_timeframe_confirmations, 2))
  };
}

function probeThresholds(config = {}) {
  return {
    minimum_quote_volume_usdt: Math.max(100000, asNumber(config.early_momentum_probe_min_quote_volume_usdt, 300000)),
    minimum_price_change_24h: asNumber(config.early_momentum_probe_min_price_change_24h, 0.25),
    maximum_price_change_24h: Math.max(5, asNumber(config.early_momentum_probe_max_price_change_24h, 18)),
    maximum_risk_score: Math.min(75, Math.max(0, asNumber(config.early_momentum_probe_max_risk_score, 65))),
    limit: Math.max(10, Math.min(60, asNumber(config.early_momentum_probe_limit, DEFAULT_PROBE_LIMIT)))
  };
}

function seedScore(candidate = {}) {
  const priceChange24h = asNumber(candidate.priceChange24h ?? candidate.price_change_24h, 0);
  const liquidity = asNumber(candidate.liquidityScore ?? candidate.liquidity_score, 0);
  const impulse = asNumber(candidate.impulseScore ?? candidate.impulse_score, 0);
  const volumeChange = asNumber(candidate.volumeChangeScore ?? candidate.volume_change_score, 0);
  const sweetSpot = clamp(100 - (Math.abs(priceChange24h - 6) * 10), 0, 100);
  return (sweetSpot * 0.4) + (liquidity * 0.25) + (impulse * 0.2) + (volumeChange * 0.15);
}

function diverseProbeScore(candidate = {}, lane = 'fresh') {
  const priceChange24h = asNumber(candidate.priceChange24h ?? candidate.price_change_24h, 0);
  const liquidity = asNumber(candidate.liquidityScore ?? candidate.liquidity_score, 0);
  const impulse = asNumber(candidate.impulseScore ?? candidate.impulse_score, 0);
  const volumeChange = asNumber(candidate.volumeChangeScore ?? candidate.volume_change_score, 0);
  const breakout = asNumber(candidate.breakoutScore ?? candidate.breakout_score, 0);

  if (lane === 'volume') return (volumeChange * 0.55) + (liquidity * 0.3) + (impulse * 0.15);
  if (lane === 'breakout') return (breakout * 0.6) + (volumeChange * 0.2) + (liquidity * 0.2);

  // Give genuinely fresh moves a dedicated path into the expensive 5m probe.
  // This prevents a crowded set of already-visible ~6% daily movers from
  // consuming every probe slot before a 1-3% move has time to accelerate.
  const freshSweetSpot = clamp(100 - (Math.abs(priceChange24h - 2) * 18), 0, 100);
  return (freshSweetSpot * 0.35) + (volumeChange * 0.3) + (liquidity * 0.25) + (impulse * 0.1);
}

function selectProbeCandidates(candidates = [], config = {}) {
  const thresholds = probeThresholds(config);
  const eligible = candidates
    .filter((candidate) => {
      const priceChange24h = asNumber(candidate.priceChange24h ?? candidate.price_change_24h, 0);
      const volume = asNumber(candidate.quoteVolume24h ?? candidate.quote_volume_24h, 0);
      const risk = asNumber(candidate.riskScore ?? candidate.risk_score, 0);
      const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
      return priceChange24h >= thresholds.minimum_price_change_24h &&
        priceChange24h <= thresholds.maximum_price_change_24h &&
        volume >= thresholds.minimum_quote_volume_usdt &&
        risk <= thresholds.maximum_risk_score &&
        !warnings.some((warning) => BLOCKING_WARNINGS.has(String(warning)));
    })
    .map((candidate) => ({ ...candidate, earlyMomentumSeedScore: Number(seedScore(candidate).toFixed(2)) }));

  const bySeed = [...eligible].sort((left, right) => right.earlyMomentumSeedScore - left.earlyMomentumSeedScore);
  const byVolume = [...eligible].sort((left, right) => diverseProbeScore(right, 'volume') - diverseProbeScore(left, 'volume'));
  const byBreakout = [...eligible].sort((left, right) => diverseProbeScore(right, 'breakout') - diverseProbeScore(left, 'breakout'));
  const byFresh = [...eligible].sort((left, right) => diverseProbeScore(right, 'fresh') - diverseProbeScore(left, 'fresh'));

  const primaryQuota = Math.max(4, Math.floor(thresholds.limit * 0.4));
  const secondaryQuota = Math.max(2, Math.floor((thresholds.limit - primaryQuota) / 3));
  const selected = [];
  const seen = new Set();

  function addFrom(pool, quota) {
    let added = 0;
    for (const candidate of pool) {
      if (selected.length >= thresholds.limit || added >= quota) break;
      const symbol = String(candidate.symbol || '').toUpperCase();
      if (!symbol || seen.has(symbol)) continue;
      seen.add(symbol);
      selected.push(candidate);
      added += 1;
    }
  }

  addFrom(bySeed, primaryQuota);
  addFrom(byFresh, secondaryQuota);
  addFrom(byVolume, secondaryQuota);
  addFrom(byBreakout, thresholds.limit - selected.length);
  addFrom(bySeed, thresholds.limit - selected.length);

  return selected.slice(0, thresholds.limit);
}

function analyzeEarlyMomentumCandles(inputRows = []) {
  const parsed = inputRows.length && Array.isArray(inputRows[0]) ? parseKlines(inputRows) : inputRows;
  // Binance includes the currently-forming candle. Use only closed 5m candles so
  // a transient wick cannot trigger a real-money entry.
  const candles = parsed.length > 1 ? parsed.slice(0, -1) : parsed;
  if (candles.length < 16) {
    return { valid: false, reason: 'INSUFFICIENT_INTRADAY_CANDLES', score: 0, confirmations: 0 };
  }

  const last = candles[candles.length - 1];
  const change5m = pctChange(last.close, candles[candles.length - 2].close);
  const change15m = pctChange(last.close, candles[candles.length - 4].close);
  const change1h = pctChange(last.close, candles[candles.length - 13].close);

  const recentVolume = average(candles.slice(-3).map((candle) => candle.quoteVolume));
  const baselineVolume = average(candles.slice(-15, -3).map((candle) => candle.quoteVolume));
  const relativeVolume = baselineVolume > 0 ? recentVolume / baselineVolume : 0;

  const velocity5m = change5m;
  const velocity15mPer5 = change15m / 3;
  const velocity1hPer5 = change1h / 12;
  const accelerating = velocity5m >= Math.max(0.03, velocity15mPer5 * 0.8) &&
    velocity15mPer5 >= Math.max(0.02, velocity1hPer5 * 0.8);

  const confirmationFlags = [change5m >= 0.1, change15m >= 0.5, change1h >= 1.0];
  const confirmations = confirmationFlags.filter(Boolean).length;
  const priceScore = clamp((change5m * 50) + (change15m * 18) + (change1h * 7), 0, 100);
  const volumeScore = clamp((relativeVolume - 1) * 45, 0, 100);
  const structureScore = clamp((confirmations * 22) + (accelerating ? 34 : 0), 0, 100);
  const score = clamp((priceScore * 0.5) + (volumeScore * 0.25) + (structureScore * 0.25), 0, 100);

  return {
    valid: true,
    score: Number(score.toFixed(2)),
    change_5m_pct: Number(change5m.toFixed(4)),
    change_15m_pct: Number(change15m.toFixed(4)),
    change_1h_pct: Number(change1h.toFixed(4)),
    relative_volume_15m: Number(relativeVolume.toFixed(3)),
    price_score: Number(priceScore.toFixed(2)),
    volume_score: Number(volumeScore.toFixed(2)),
    structure_score: Number(structureScore.toFixed(2)),
    confirmations,
    accelerating,
    last_closed_candle_at: new Date(last.closeTime).toISOString(),
    source: 'binance_5m_closed_klines'
  };
}

function evaluateEarlyMomentumCandidate(candidate = {}, evidence = null, config = {}) {
  const thresholds = earlyMomentumThresholds(config);
  const metrics = candidate.earlyMomentum || candidate.early_momentum || {};
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
  const reasons = [];
  const priceChange24h = asNumber(candidate.priceChange24h ?? candidate.price_change_24h, 0);
  const volume = asNumber(candidate.quoteVolume24h ?? candidate.quote_volume_24h, 0);
  const risk = asNumber(candidate.riskScore ?? candidate.risk_score, 0);

  if (!thresholds.enabled) reasons.push('EARLY_MOMENTUM_DISABLED');
  if (metrics.valid !== true) reasons.push('EARLY_INTRADAY_DATA_INVALID');
  if (asNumber(metrics.score, 0) < thresholds.minimum_score) reasons.push('EARLY_SCORE_BELOW_THRESHOLD');
  if (volume < thresholds.minimum_quote_volume_usdt) reasons.push('EARLY_LIQUIDITY_VOLUME_TOO_LOW');
  if (priceChange24h < thresholds.minimum_price_change_24h) reasons.push('EARLY_MOVE_NOT_STARTED');
  if (priceChange24h > thresholds.maximum_price_change_24h) reasons.push('EARLY_MOVE_ALREADY_EXTENDED');
  if (asNumber(metrics.change_5m_pct, 0) < thresholds.minimum_change_5m_pct) reasons.push('EARLY_5M_NOT_ACCELERATING');
  if (asNumber(metrics.change_15m_pct, 0) < thresholds.minimum_change_15m_pct) reasons.push('EARLY_15M_TOO_WEAK');
  if (asNumber(metrics.change_1h_pct, 0) < thresholds.minimum_change_1h_pct) reasons.push('EARLY_1H_TOO_WEAK');
  if (asNumber(metrics.relative_volume_15m, 0) < thresholds.minimum_relative_volume) reasons.push('EARLY_VOLUME_NOT_EXPANDING');
  if (asNumber(metrics.confirmations, 0) < thresholds.minimum_intraday_confirmations) reasons.push('EARLY_INTRADAY_CONFIRMATIONS_TOO_LOW');
  if (metrics.accelerating !== true && asNumber(metrics.relative_volume_15m, 0) < 1.8) reasons.push('EARLY_ACCELERATION_NOT_CONFIRMED');
  if (risk > thresholds.maximum_risk_score) reasons.push('EARLY_RISK_TOO_HIGH');
  if (warnings.some((warning) => BLOCKING_WARNINGS.has(String(warning)))) reasons.push('EARLY_BLOCKING_WARNING');
  if (evidence && evidence.sample_size >= 3 && evidence.positive_rate < thresholds.minimum_existing_evidence_positive_rate) {
    reasons.push('EARLY_EXISTING_EVIDENCE_NEGATIVE');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      ...metrics,
      quote_volume_24h: volume,
      price_change_24h: priceChange24h,
      risk_score: risk
    },
    thresholds
  };
}

async function fetchFiveMinuteKlines(symbol, dependencies = {}) {
  if (dependencies.fetchKlines) return dependencies.fetchKlines(symbol);
  const response = await axios.get(`${BINANCE_BASE}/api/v3/klines`, {
    params: { symbol, interval: '5m', limit: 32 },
    timeout: 10000
  });
  return response.data;
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await mapper(items[index]);
      } catch (error) {
        results[index] = { error: error.message || String(error), candidate: items[index] };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length || 1) }, () => worker()));
  return results;
}

async function enrichEarlyMomentumCandidates(candidates = [], config = {}, dependencies = {}) {
  const thresholds = earlyMomentumThresholds(config);
  if (!thresholds.enabled) {
    return {
      candidates,
      probed_count: 0,
      eligible_count: 0,
      eligible_symbols: [],
      errors: [],
      version: 'early_momentum_radar_v1'
    };
  }

  const seeds = selectProbeCandidates(candidates, config);
  const concurrency = Math.max(1, Math.min(12, asNumber(config.early_momentum_probe_concurrency, DEFAULT_CONCURRENCY)));
  const results = await mapWithConcurrency(seeds, concurrency, async (candidate) => {
    const rows = await fetchFiveMinuteKlines(String(candidate.symbol || '').toUpperCase(), dependencies);
    return { candidate, metrics: analyzeEarlyMomentumCandles(rows) };
  });

  const bySymbol = new Map(candidates.map((candidate) => [String(candidate.symbol || '').toUpperCase(), { ...candidate }]));
  const errors = [];
  const eligibleSymbols = [];

  for (const result of results) {
    if (!result || result.error || !result.candidate) {
      if (result?.error) errors.push({ symbol: result.candidate?.symbol || null, error: result.error });
      continue;
    }
    const symbol = String(result.candidate.symbol || '').toUpperCase();
    const enriched = {
      ...bySymbol.get(symbol),
      earlyMomentumSeedScore: result.candidate.earlyMomentumSeedScore,
      earlyMomentumScore: asNumber(result.metrics?.score, 0),
      earlyMomentum: result.metrics,
      early_momentum_probed: true
    };
    const evaluation = evaluateEarlyMomentumCandidate(enriched, null, config);
    enriched.early_momentum_prequalified = evaluation.allowed;
    enriched.early_momentum_reasons = evaluation.reasons;
    if (evaluation.allowed) {
      eligibleSymbols.push(symbol);
      enriched.reasons = [...new Set([...(enriched.reasons || []), 'intraday_acceleration_5m_15m_1h', 'early_volume_expansion'])];
    }
    bySymbol.set(symbol, enriched);
  }

  return {
    candidates: candidates.map((candidate) => bySymbol.get(String(candidate.symbol || '').toUpperCase()) || candidate),
    probed_count: seeds.length,
    eligible_count: eligibleSymbols.length,
    eligible_symbols: eligibleSymbols,
    errors: errors.slice(0, 10),
    version: 'early_momentum_radar_v1'
  };
}

module.exports = {
  analyzeEarlyMomentumCandles,
  diverseProbeScore,
  earlyMomentumThresholds,
  evaluateEarlyMomentumCandidate,
  enrichEarlyMomentumCandidates,
  parseKlines,
  pctChange,
  probeThresholds,
  seedScore,
  selectProbeCandidates
};
