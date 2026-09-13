'use strict';

const ENTRY_FIRST_VERSION = 'spot_entry_first_priority_v1';

function clamp(value, min = 0, max = 100) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function firstNumber(candidate, keys, fallback = null) {
  for (const key of keys) {
    const value = Number(candidate?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return fallback;
}

function normalizeScore(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return clamp(n <= 1 && n >= 0 ? n * 100 : n);
}

function freshnessScore(candidate = {}) {
  const move24 = firstNumber(candidate, ['priceChange24h', 'price_change_24h'], 0);
  const move7d = firstNumber(candidate, ['priceChange7d', 'price_change_7d'], 0);

  let intraday;
  if (move24 < -4) intraday = 5;
  else if (move24 < 0) intraday = 25 + ((move24 + 4) / 4) * 20;
  else if (move24 <= 12) intraday = 45 + (move24 / 12) * 55;
  else if (move24 <= 18) intraday = 100 - ((move24 - 12) / 6) * 45;
  else intraday = Math.max(0, 55 - (move24 - 18) * 4.5);

  let weekly;
  if (move7d < -10) weekly = 10;
  else if (move7d < 0) weekly = 35 + ((move7d + 10) / 10) * 15;
  else if (move7d <= 30) weekly = 50 + (move7d / 30) * 50;
  else weekly = Math.max(20, 100 - (move7d - 30) * 1.5);

  return clamp(intraday * 0.72 + weekly * 0.28);
}

function componentCoverage(candidate = {}) {
  const groups = [
    ['opportunityScore', 'opportunity_score', 'score', 'final_score'],
    ['impulseScore', 'impulse_score'],
    ['breakoutScore', 'breakout_score'],
    ['accumulationScore', 'accumulation_score'],
    ['liquidityScore', 'liquidity_score'],
    ['volumeChangeScore', 'volume_change_score'],
    ['riskScore', 'risk_score'],
    ['priceChange24h', 'price_change_24h']
  ];
  const present = groups.filter((keys) => firstNumber(candidate, keys, null) !== null).length;
  return present / groups.length;
}

function computeEntryFirstPriority(candidate = {}, config = {}) {
  const enabled = config.entry_first_enabled !== false;
  const opportunity = normalizeScore(firstNumber(candidate, ['opportunityScore', 'opportunity_score', 'score', 'final_score'], 0));
  const impulse = normalizeScore(firstNumber(candidate, ['impulseScore', 'impulse_score'], 0));
  const breakout = normalizeScore(firstNumber(candidate, ['breakoutScore', 'breakout_score'], 0));
  const accumulation = normalizeScore(firstNumber(candidate, ['accumulationScore', 'accumulation_score'], 0));
  const liquidity = normalizeScore(firstNumber(candidate, ['liquidityScore', 'liquidity_score'], 0));
  const volume = normalizeScore(firstNumber(candidate, ['volumeChangeScore', 'volume_change_score'], 0));
  const risk = normalizeScore(firstNumber(candidate, ['riskScore', 'risk_score'], 0));
  const freshness = freshnessScore(candidate);
  const earlyMomentum = normalizeScore(firstNumber(candidate, ['earlyMomentumScore', 'early_momentum_score'], 0));
  const coverage = componentCoverage(candidate);

  // Production transfer of the V7.2 ENTRY-first principle: rank the broad causal
  // candidate set before lane selection. This is intentionally a soft prioritizer,
  // not an admission gate. Existing Paper, technical and safety gates remain final.
  const positive =
    opportunity * 0.18 +
    impulse * 0.18 +
    breakout * 0.14 +
    accumulation * 0.12 +
    liquidity * 0.14 +
    volume * 0.10 +
    freshness * 0.09 +
    earlyMomentum * 0.05;
  const riskPenalty = risk * 0.20;
  const trajectory = clamp(positive - riskPenalty);

  // If feature coverage is sparse, fall back toward the already-proven production
  // opportunity score instead of inventing confidence from missing fields.
  const coverageWeight = clamp(coverage, 0, 1);
  const priority = clamp(coverageWeight * trajectory + (1 - coverageWeight) * opportunity);

  return {
    enabled,
    version: ENTRY_FIRST_VERSION,
    entry_first_score: Number(priority.toFixed(3)),
    feature_coverage: Number(coverage.toFixed(3)),
    components: {
      opportunity,
      impulse,
      breakout,
      accumulation,
      liquidity,
      volume,
      freshness: Number(freshness.toFixed(3)),
      early_momentum: earlyMomentum,
      risk,
      risk_penalty: Number(riskPenalty.toFixed(3))
    }
  };
}

function prioritizeEntryFirstCandidates(candidates = [], config = {}) {
  const enabled = config.entry_first_enabled !== false;
  const enriched = candidates.map((candidate) => {
    const result = computeEntryFirstPriority(candidate, config);
    return {
      ...candidate,
      entry_first_score: result.entry_first_score,
      entry_first_feature_coverage: result.feature_coverage,
      entry_first_components: result.components,
      entry_first_version: result.version
    };
  });

  if (!enabled) {
    return {
      enabled: false,
      version: ENTRY_FIRST_VERSION,
      candidates: enriched.map((candidate, index) => ({ ...candidate, entry_first_rank: index + 1 }))
    };
  }

  const sorted = [...enriched].sort((left, right) => {
    const entryDelta = Number(right.entry_first_score || 0) - Number(left.entry_first_score || 0);
    if (Math.abs(entryDelta) > 0.000001) return entryDelta;
    const opportunityDelta = Number(right.opportunityScore || right.opportunity_score || 0) - Number(left.opportunityScore || left.opportunity_score || 0);
    if (Math.abs(opportunityDelta) > 0.000001) return opportunityDelta;
    return Number(right.quoteVolume24h || right.quote_volume_24h || 0) - Number(left.quoteVolume24h || left.quote_volume_24h || 0);
  });

  return {
    enabled: true,
    version: ENTRY_FIRST_VERSION,
    candidates: sorted.map((candidate, index) => ({ ...candidate, entry_first_rank: index + 1 }))
  };
}

function prioritizeLane(candidates = [], entryFirstEnabled = true) {
  if (!entryFirstEnabled) return candidates;
  return [...candidates].sort((left, right) => {
    const scoreDelta = Number(right.entry_first_score || 0) - Number(left.entry_first_score || 0);
    if (Math.abs(scoreDelta) > 0.000001) return scoreDelta;
    return Number(right.opportunityScore || right.opportunity_score || 0) - Number(left.opportunityScore || left.opportunity_score || 0);
  });
}

module.exports = {
  ENTRY_FIRST_VERSION,
  computeEntryFirstPriority,
  prioritizeEntryFirstCandidates,
  prioritizeLane,
  freshnessScore
};
