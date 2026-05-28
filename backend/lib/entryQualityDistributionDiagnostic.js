function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const hours = Math.max(0.1, Number(options.hours || 6));
  const since = sinceExplicit || new Date(until.getTime() - (hours * 60 * 60 * 1000));
  return { since, until };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function percentile(sortedValues = [], pct = 50) {
  if (!sortedValues.length) return null;
  if (sortedValues.length === 1) return sortedValues[0];
  const clamped = Math.max(0, Math.min(100, Number(pct || 0)));
  const index = (clamped / 100) * (sortedValues.length - 1);
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sortedValues[lower];
  const weight = index - lower;
  return sortedValues[lower] + ((sortedValues[upper] - sortedValues[lower]) * weight);
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function getCategoryTotals(row = {}) {
  const components = row?.execution_guard?.entryQualityComponents || {};
  const penalties = Array.isArray(row?.execution_guard?.entryQualityPenalties)
    ? row.execution_guard.entryQualityPenalties
    : [];

  const freshness = toNumber(components.freshness, 0);
  const priceDeviation = toNumber(components.price_deviation, 0);
  const velocity = toNumber(components.velocity_alignment, 0);
  const acceleration = toNumber(components.acceleration_alignment, 0);
  const imbalance = toNumber(components.imbalance_strength, 0);
  const lifecycle = toNumber(components.lifecycle_state, 0);

  let staleSnapshotPenalty = 0;
  let weakSnapshotPenalty = 0;
  let slippagePenalty = 0;

  for (const penalty of penalties) {
    const type = String(penalty?.type || '').toLowerCase();
    const points = toNumber(penalty?.points, 0) || 0;
    if (type === 'stale_snapshot') staleSnapshotPenalty += points;
    else if (type === 'weak_snapshot') weakSnapshotPenalty += points;
    else if (type === 'slippage_penalty') slippagePenalty += points;
  }

  return {
    penalty_direction:
      ((100 - velocity) * 0.2) +
      ((100 - imbalance) * 0.18),
    penalty_impulse:
      ((100 - acceleration) * 0.14),
    penalty_volatility:
      ((100 - priceDeviation) * 0.24),
    penalty_context:
      ((100 - freshness) * 0.14) +
      ((100 - lifecycle) * 0.1) +
      staleSnapshotPenalty +
      weakSnapshotPenalty,
    penalty_slippage:
      slippagePenalty
  };
}

function buildDiagnosis({ distribution, avgScore, p50Score, p75Score, avgExplicitPenalty, avgBaseScore }) {
  const total = distribution.high_count + distribution.medium_count + distribution.low_count;
  const lowShare = total > 0 ? distribution.low_count / total : 0;
  const mediumShare = total > 0 ? distribution.medium_count / total : 0;

  if (total === 0) return 'mixed';
  if ((p75Score ?? -1) < 40 && lowShare >= 0.7) return 'scores_shifted_low';
  if ((avgBaseScore ?? 0) >= 40 && (p50Score ?? 0) < 40 && (avgExplicitPenalty ?? 0) >= 5) {
    return 'penalties_too_aggressive';
  }
  if ((avgScore ?? 0) >= 34 && (avgScore ?? 0) <= 45 && mediumShare >= 0.25) {
    return 'threshold_issue';
  }
  return 'mixed';
}

async function getEntryQualityDistributionDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const scores = [];
  const penaltyTotals = {
    penalty_direction: 0,
    penalty_impulse: 0,
    penalty_volatility: 0,
    penalty_context: 0,
    penalty_slippage: 0
  };
  const explicitPenaltySums = [];
  const baseScores = [];

  let highCount = 0;
  let mediumCount = 0;
  let lowCount = 0;

  for (const row of intents) {
    const guard = row?.execution_guard || {};
    const score = toNumber(
      row.entry_quality_score ??
      guard.entryQualityScore ??
      row.entry_execution_snapshot?.entry_quality_score,
      null
    );
    if (score === null) continue;

    scores.push(score);
    if (score >= 70) highCount += 1;
    else if (score >= 40) mediumCount += 1;
    else lowCount += 1;

    const categories = getCategoryTotals(row);
    penaltyTotals.penalty_direction += categories.penalty_direction;
    penaltyTotals.penalty_impulse += categories.penalty_impulse;
    penaltyTotals.penalty_volatility += categories.penalty_volatility;
    penaltyTotals.penalty_context += categories.penalty_context;
    penaltyTotals.penalty_slippage += categories.penalty_slippage;

    const components = guard.entryQualityComponents || {};
    const baseScore =
      (toNumber(components.price_deviation, 0) * 0.24) +
      (toNumber(components.velocity_alignment, 0) * 0.2) +
      (toNumber(components.acceleration_alignment, 0) * 0.14) +
      (toNumber(components.imbalance_strength, 0) * 0.18) +
      (toNumber(components.freshness, 0) * 0.14) +
      (toNumber(components.lifecycle_state, 0) * 0.1);
    baseScores.push(baseScore);

    const explicitPenaltySum = (guard.entryQualityPenalties || []).reduce((sum, penalty) => {
      return sum + (toNumber(penalty?.points, 0) || 0);
    }, 0);
    explicitPenaltySums.push(explicitPenaltySum);
  }

  const sortedScores = [...scores].sort((a, b) => a - b);
  const totalScoredIntents = sortedScores.length;
  const topPenalties = Object.entries(penaltyTotals)
    .map(([key, totalPoints]) => ({
      type: key,
      avg_points: totalScoredIntents > 0 ? round(totalPoints / totalScoredIntents) : 0,
      total_points: round(totalPoints)
    }))
    .sort((a, b) => b.total_points - a.total_points);

  const distribution = {
    high_count: highCount,
    medium_count: mediumCount,
    low_count: lowCount
  };
  const avgScore = round(average(scores));
  const p25Score = round(percentile(sortedScores, 25));
  const p50Score = round(percentile(sortedScores, 50));
  const p75Score = round(percentile(sortedScores, 75));
  const avgExplicitPenalty = round(average(explicitPenaltySums));
  const avgBaseScore = round(average(baseScores));

  return {
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2)
    },
    total_intents: totalScoredIntents,
    distribution,
    avg_score: avgScore,
    p25_score: p25Score,
    p50_score: p50Score,
    p75_score: p75Score,
    top_penalties: topPenalties,
    diagnosis: buildDiagnosis({
      distribution,
      avgScore,
      p50Score,
      p75Score,
      avgExplicitPenalty,
      avgBaseScore
    }),
    support: {
      avg_base_score_before_explicit_penalties: avgBaseScore,
      avg_explicit_penalty_points: avgExplicitPenalty
    }
  };
}

module.exports = {
  getEntryQualityDistributionDiagnostic
};
