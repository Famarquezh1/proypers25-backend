const db = require('../firebase-admin-config');
const { run: runSignalIntelligenceAudit } = require('../scripts/audit-signal-intelligence');
const { run: runSuppressedValidationAudit } = require('../scripts/validate-suppressed-signals');
const { run: runExecutionVsModelAudit } = require('../scripts/execution-vs-model-audit');

const SNAPSHOT_COLLECTION = 'analytics_snapshots';
const SNAPSHOT_DOC_ID = 'statistical_learning_v1';
const SNAPSHOT_MEM_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.STATISTICAL_LEARNING_MEM_TTL_MS || 10 * 60 * 1000)
);
const STATISTICAL_LEARNING_ENABLED =
  String(process.env.STATISTICAL_LEARNING_ENABLED || 'true').toLowerCase() !== 'false';
const DEFAULT_DAYS = Math.max(1, Math.min(365, Number(process.env.SIGNAL_INTEL_AUDIT_DAYS || 30)));
const DEFAULT_MAX_DOCS = Math.max(1000, Math.min(300000, Number(process.env.STATISTICAL_LEARNING_MAX_DOCS || 25000)));
const WALKFORWARD_TRAIN_SIZE = Math.max(100, Number(process.env.STAT_LEARNING_WF_TRAIN_SIZE || 500));
const WALKFORWARD_VALIDATION_SIZE = Math.max(25, Number(process.env.STAT_LEARNING_WF_VALIDATION_SIZE || 100));
const WALKFORWARD_STEP = Math.max(25, Number(process.env.STAT_LEARNING_WF_STEP || 100));
const ROLLING_EXPECTANCY_WINDOW = Math.max(50, Number(process.env.STAT_LEARNING_ROLLING_WINDOW || 200));
const ROLLING_EXPECTANCY_STEP = Math.max(10, Number(process.env.STAT_LEARNING_ROLLING_STEP || 50));
const SURVIVORSHIP_RECENT_WINDOW = Math.max(10, Number(process.env.STAT_LEARNING_SYMBOL_RECENT_WINDOW || 30));
const SURVIVORSHIP_PRIOR_WINDOW = Math.max(10, Number(process.env.STAT_LEARNING_SYMBOL_PRIOR_WINDOW || 30));
const MATRIX_MIN_SAMPLES = Math.max(2, Number(process.env.STAT_LEARNING_MATRIX_MIN_SAMPLES || 3));

let snapshotCache = {
  fetchedAt: 0,
  payload: null,
  inFlight: null
};

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value?.toDate === 'function') {
    const out = value.toDate();
    return out instanceof Date && Number.isFinite(out.getTime()) ? out : null;
  }
  const out = new Date(value);
  return Number.isFinite(out.getTime()) ? out : null;
}

function normalizeOutcome(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'UNKNOWN';
  if (value.includes('WIN') || value.includes('VALID')) return 'WIN';
  if (value.includes('LOSS') || value.includes('FAIL') || value.includes('PERD')) return 'LOSS';
  if (value.includes('BREAKEVEN')) return 'BREAKEVEN';
  if (value.includes('SUPP')) return 'SUPPRESSED';
  if (value.includes('PEND')) return 'PENDING';
  return value;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function mean(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function variance(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (filtered.length < 2) return 0;
  const avg = mean(filtered);
  return filtered.reduce((sum, value) => sum + (value - avg) ** 2, 0) / filtered.length;
}

function percentile(values, p) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const idx = (p / 100) * (filtered.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return filtered[lo];
  const weight = idx - lo;
  return filtered[lo] * (1 - weight) + filtered[hi] * weight;
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

function normalizeDirection(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['up', 'buy', 'long', 'alza'].includes(value)) return 'up';
  if (['down', 'sell', 'short', 'baja'].includes(value)) return 'down';
  return 'neutral';
}

function normalizeSystemSymbol(symbol) {
  if (!symbol) return 'UNKNOWN';
  const upper = String(symbol).toUpperCase().replace('/', '-').replace(/\s+/g, '');
  if (upper.endsWith('-USD')) return upper;
  if (upper.endsWith('USDT')) return `${upper.slice(0, -4)}-USD`;
  if (upper.endsWith('-USDT')) return `${upper.slice(0, -5)}-USD`;
  return upper;
}

function buildBucket(value, boundaries = [20, 40, 60, 80]) {
  if (!Number.isFinite(value)) return 'unknown';
  if (value < boundaries[0]) return `0-${boundaries[0]}`;
  if (value < boundaries[1]) return `${boundaries[0]}-${boundaries[1]}`;
  if (value < boundaries[2]) return `${boundaries[1]}-${boundaries[2]}`;
  if (value < boundaries[3]) return `${boundaries[2]}-${boundaries[3]}`;
  return `${boundaries[3]}-100`;
}

function calcExpectancyFromReturns(values) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) {
    return {
      total: 0,
      win_rate: null,
      avg_win: null,
      avg_loss: null,
      expectancy: null
    };
  }
  const wins = filtered.filter((value) => value > 0);
  const losses = filtered.filter((value) => value < 0).map((value) => Math.abs(value));
  const winRate = wins.length / filtered.length;
  const avgWin = mean(wins);
  const avgLoss = mean(losses);
  return {
    total: filtered.length,
    win_rate: winRate,
    avg_win: avgWin,
    avg_loss: avgLoss,
    expectancy: winRate * (avgWin || 0) - (1 - winRate) * (avgLoss || 0)
  };
}

function sortByExpectancyAndTotal(items = []) {
  return [...items].sort((a, b) => {
    const delta = toNum(b.expectancy, -Infinity) - toNum(a.expectancy, -Infinity);
    if (delta !== 0) return delta;
    return Number(b.total || 0) - Number(a.total || 0);
  });
}

function extractCounterfactualExpectedReturn(row) {
  const result = normalizeOutcome(row?.result);
  const mfe = toNum(row?.mfe);
  const mae = toNum(row?.mae);
  if (result === 'WIN') return Number.isFinite(mfe) ? mfe : null;
  if (result === 'LOSS') return Number.isFinite(mae) ? -Math.abs(mae) : null;
  return null;
}

function linearRegressionSlope(values) {
  const points = values
    .map((value, index) => ({ x: index, y: Number(value) }))
    .filter((point) => Number.isFinite(point.y));
  if (points.length < 2) return 0;
  const avgX = mean(points.map((point) => point.x));
  const avgY = mean(points.map((point) => point.y));
  const numerator = points.reduce((sum, point) => sum + ((point.x - avgX) * (point.y - avgY)), 0);
  const denominator = points.reduce((sum, point) => sum + ((point.x - avgX) ** 2), 0);
  return denominator > 0 ? numerator / denominator : 0;
}

function computeRankProxy(row) {
  const storedPercentile = toNum(row?.ranking_percentile);
  if (Number.isFinite(storedPercentile)) return clamp(storedPercentile, 0, 100);
  const storedScore = toNum(row?.signal_ranking_score);
  if (Number.isFinite(storedScore)) return clamp(storedScore, 0, 100);

  const confidence = clamp((toNum(row?.confidence, 0) || 0) * 100, 0, 100);
  const quantum = clamp((toNum(row?.quantum_score, 0) || 0) * 100, 0, 100);
  const timing = clamp((toNum(row?.timing_score, 0) || 0) * 100, 0, 100);
  const contextQuality =
    clamp(
      toNum(row?.context_quality, null) ??
        Math.min(100, Math.max(0, (toNum(row?.context_score, 0) || 0) * 25)),
      0,
      100
    );

  return (
    (confidence * 0.35) +
    (quantum * 0.2) +
    (timing * 0.2) +
    (contextQuality * 0.25)
  );
}

function classifyExtendedRegime(source = {}, row = {}) {
  const metrics = source?.event_context_filter?.metrics || source?.event_context_filter?.details || {};
  const compressionDuration =
    toNum(source?.compression_duration) ??
    toNum(source?.event_context_filter?.compression_duration) ??
    toNum(metrics?.compression_duration) ??
    0;
  const volRatio =
    toNum(source?.volatility_expansion_ratio) ??
    toNum(source?.event_context_filter?.volatility_expansion_ratio) ??
    toNum(metrics?.volatility_expansion_ratio) ??
    0;
  const relativeVolume =
    toNum(source?.relative_volume) ??
    toNum(source?.event_context_filter?.relative_volume) ??
    toNum(metrics?.relative_volume) ??
    0;
  const expansionImpulse =
    toNum(source?.event_context_filter?.expansion_impulse) ??
    toNum(metrics?.expansion_impulse) ??
    0;
  const structuralAcceptance =
    toNum(source?.event_context_filter?.structural_break_acceptance) ??
    toNum(metrics?.structural_break_acceptance) ??
    0;
  const wickImbalance =
    toNum(source?.event_context_filter?.wick_imbalance) ??
    toNum(metrics?.wick_imbalance) ??
    0;
  const fakeBreakoutPenalty =
    toNum(source?.event_context_filter?.fake_breakout_penalty) ??
    toNum(metrics?.fake_breakout_penalty) ??
    0;
  const liquidityTrapRisk =
    toNum(source?.event_context_filter?.liquidity_trap_risk) ??
    toNum(metrics?.liquidity_trap_risk) ??
    0;
  const directionalReturn = Math.abs(toNum(row?.directional_return_pct, 0) || 0);
  const rangeBreak =
    Boolean(source?.range_break_detected) ||
    Boolean(source?.event_context_filter?.range_break_detected) ||
    Boolean(metrics?.rangeBreak?.detected);

  if (compressionDuration >= 3 || (volRatio > 0 && volRatio <= 0.85 && relativeVolume <= 1.05)) {
    return 'compression';
  }
  if (liquidityTrapRisk >= 0.6 || fakeBreakoutPenalty >= 0.6 || wickImbalance >= 0.55) {
    return 'exhaustion';
  }
  if (rangeBreak || structuralAcceptance >= 0.6 || expansionImpulse >= 1.25) {
    return 'breakout';
  }
  if (volRatio >= 1.2 || relativeVolume >= 1.4 || expansionImpulse >= 1) {
    return 'expansion';
  }
  if (directionalReturn >= 0.8) {
    return 'trend';
  }
  return 'range';
}

async function loadPredictionRows(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  let snap;
  try {
    snap = await db.collection('velas_predicciones').orderBy('created_at', 'desc').limit(maxDocs).get();
  } catch (err) {
    snap = await db.collection('velas_predicciones').limit(maxDocs).get();
  }

  const rows = snap.docs
    .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
    .filter((row) => {
      const timestamp = toDate(row?.created_at || row?.timestamp);
      return timestamp && timestamp.getTime() >= cutoffMs;
    })
    .map((row) => {
      const createdAt = toDate(row?.created_at || row?.timestamp);
      const direction = normalizeDirection(row?.direction);
      const actualChange = toNum(row?.verification?.actual_change);
      const directionalReturn =
        Number.isFinite(actualChange) && direction !== 'neutral'
          ? direction === 'up'
            ? actualChange
            : -actualChange
          : null;
      const confidence = toNum(row?.confianza ?? row?.confidence);
      const contextQuality =
        toNum(row?.context_quality ?? row?.event_context_filter?.context_quality);
      const contextScore = toNum(row?.context_score);

      return {
        id: row.id,
        created_at: createdAt ? createdAt.toISOString() : null,
        created_at_ms: createdAt ? createdAt.getTime() : null,
        symbol: normalizeSystemSymbol(row?.simbolo || row?.symbol || row?.simbolo_normalizado),
        direction,
        signal_emitted: row?.signal_emitted === true,
        suppression_reason: row?.suppression_reason || null,
        outcome: normalizeOutcome(
          row?.verification_outcome ||
            row?.verification?.verification_outcome ||
            row?.verification?.outcome_label ||
            row?.status
        ),
        directional_return_pct: directionalReturn,
        confidence,
        quantum_score: toNum(row?.quantum_score),
        timing_score: toNum(row?.timing_score),
        context_quality: contextQuality,
        context_score: contextScore,
        regime: classifyExtendedRegime(row, { directional_return_pct: directionalReturn }),
        source_data: row
      };
    });

  const scored = rows.map((row) => ({
    ...row,
    ranking_value: computeRankProxy(row)
  }));

  const sortedScores = [...scored]
    .map((row) => row.ranking_value)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);

  return scored.map((row) => {
    let percentileValue = null;
    if (Number.isFinite(row.ranking_value) && sortedScores.length) {
      const lessOrEqual = sortedScores.filter((value) => value <= row.ranking_value).length;
      percentileValue = (lessOrEqual / sortedScores.length) * 100;
    }
    return {
      ...row,
      ranking_percentile: percentileValue,
      rank_bucket: buildBucket(percentileValue)
    };
  });
}

function summarizeGroupedExpectancy(items = [], keyFn) {
  return sortByExpectancyAndTotal(
    Array.from(
      items.reduce((acc, item) => {
        const key = keyFn(item);
        if (!acc.has(key)) acc.set(key, []);
        acc.get(key).push(item);
        return acc;
      }, new Map()).entries()
    ).map(([key, rows]) => {
      const expectancy = calcExpectancyFromReturns(rows.map((row) => row.directional_return_pct));
      return {
        key,
        total: rows.length,
        win_rate: expectancy.win_rate,
        expectancy: expectancy.expectancy
      };
    })
  );
}

function buildCounterfactualLearning(suppressedReport = {}) {
  const rows = Array.isArray(suppressedReport?.per_signal) ? suppressedReport.per_signal : [];
  const totalSuppressed = Number(suppressedReport?.suppressed_summary?.total_suppressed || rows.length || 0);
  const classified = rows.filter((row) => normalizeOutcome(row?.result) === 'WIN' || normalizeOutcome(row?.result) === 'LOSS');
  const expectedReturns = classified
    .map(extractCounterfactualExpectedReturn)
    .filter((value) => Number.isFinite(value));
  const wins = classified.filter((row) => normalizeOutcome(row?.result) === 'WIN');
  const losses = classified.filter((row) => normalizeOutcome(row?.result) === 'LOSS');
  const expectancy = calcExpectancyFromReturns(expectedReturns);
  const missedAlpha = wins
    .map(extractCounterfactualExpectedReturn)
    .filter((value) => Number.isFinite(value) && value > 0)
    .reduce((sum, value) => sum + value, 0);

  return {
    total_suppressed: totalSuppressed,
    classified_suppressed: classified.length,
    counterfactual_win_rate: expectancy.win_rate,
    counterfactual_expectancy: expectancy.expectancy,
    missed_alpha: missedAlpha,
    false_negative_rate: totalSuppressed > 0 ? wins.length / totalSuppressed : null,
    wins: wins.length,
    losses: losses.length,
    loss_share: totalSuppressed > 0 ? losses.length / totalSuppressed : null,
    note: 'Observe-only. Usa retornos contrafactuales de señales suprimidas auditadas.'
  };
}

function buildExpectancyStability(emittedVerifiedRows = []) {
  const weekly = Array.from(
    emittedVerifiedRows.reduce((acc, row) => {
      const key = isoWeekKey(new Date(row.created_at_ms));
      if (!acc.has(key)) acc.set(key, []);
      acc.get(key).push(row);
      return acc;
    }, new Map()).entries()
  )
    .map(([isoWeek, rows]) => {
      const expectancy = calcExpectancyFromReturns(rows.map((row) => row.directional_return_pct));
      return {
        iso_week: isoWeek,
        total: rows.length,
        win_rate: expectancy.win_rate,
        expectancy: expectancy.expectancy
      };
    })
    .sort((a, b) => a.iso_week.localeCompare(b.iso_week));

  const weeklyExpectancies = weekly.map((item) => item.expectancy).filter((value) => Number.isFinite(value));
  const expVariance = variance(weeklyExpectancies);
  const expMeanAbs = Math.abs(mean(weeklyExpectancies) || 0);
  const normalizedDispersion = expMeanAbs > 0 ? Math.sqrt(expVariance) / (expMeanAbs + 0.001) : Math.sqrt(expVariance);
  const stabilityScore = clamp(100 * (1 / (1 + normalizedDispersion)), 0, 100);

  const bySymbol = summarizeGroupedExpectancy(emittedVerifiedRows, (row) => row.symbol)
    .map((item) => ({ ...item, symbol: item.key }))
    .filter((item) => item.total >= 5)
    .slice(0, 16);
  const byRegime = summarizeGroupedExpectancy(emittedVerifiedRows, (row) => row.regime)
    .map((item) => ({ ...item, regime: item.key }));
  const byRankBucket = summarizeGroupedExpectancy(emittedVerifiedRows, (row) => row.rank_bucket)
    .map((item) => ({ ...item, rank_bucket: item.key }));
  const byContextBucket = summarizeGroupedExpectancy(
    emittedVerifiedRows.map((row) => ({
      ...row,
      context_bucket: buildBucket(toNum(row.context_quality, row.context_score != null ? row.context_score * 25 : NaN))
    })),
    (row) => row.context_bucket
  ).map((item) => ({ ...item, context_bucket: item.key }));

  return {
    expectancy_stability_score: stabilityScore,
    expectancy_variance: expVariance,
    weekly_windows: weekly,
    expectancy_by_symbol: bySymbol,
    expectancy_by_regime: byRegime,
    expectancy_by_rank_bucket: byRankBucket,
    expectancy_by_context_bucket: byContextBucket
  };
}

function buildWalkforwardValidation(emittedVerifiedRows = []) {
  const rows = [...emittedVerifiedRows].sort((a, b) => a.created_at_ms - b.created_at_ms);
  const windows = [];

  for (
    let start = WALKFORWARD_TRAIN_SIZE;
    start + WALKFORWARD_VALIDATION_SIZE <= rows.length;
    start += WALKFORWARD_STEP
  ) {
    const training = rows.slice(start - WALKFORWARD_TRAIN_SIZE, start);
    const validation = rows.slice(start, start + WALKFORWARD_VALIDATION_SIZE);
    const trainExpectancy = calcExpectancyFromReturns(training.map((row) => row.directional_return_pct));
    const validationExpectancy = calcExpectancyFromReturns(validation.map((row) => row.directional_return_pct));
    windows.push({
      index: windows.length + 1,
      training_window_size: training.length,
      validation_window_size: validation.length,
      training_expectancy: trainExpectancy.expectancy,
      validation_expectancy: validationExpectancy.expectancy,
      validation_win_rate: validationExpectancy.win_rate,
      edge_decay: toNum(trainExpectancy.expectancy, 0) - toNum(validationExpectancy.expectancy, 0),
      validation_from: validation[0]?.created_at || null,
      validation_to: validation[validation.length - 1]?.created_at || null
    });
  }

  return {
    windows,
    walkforward_expectancy: mean(windows.map((window) => window.validation_expectancy)),
    walkforward_win_rate: mean(windows.map((window) => window.validation_win_rate)),
    walkforward_edge_decay: mean(windows.map((window) => window.edge_decay)),
    windows_evaluated: windows.length,
    training_window: WALKFORWARD_TRAIN_SIZE,
    validation_window: WALKFORWARD_VALIDATION_SIZE,
    step: WALKFORWARD_STEP
  };
}

function buildRegimeLearning(rows = []) {
  const entries = summarizeGroupedExpectancy(rows, (row) => row.regime)
    .map((item) => {
      const subset = rows.filter((row) => row.regime === item.key);
      return {
        regime: item.key,
        total: item.total,
        win_rate: item.win_rate,
        expectancy: item.expectancy,
        signal_density: rows.length ? item.total / rows.length : null
      };
    });
  return {
    regimes: entries,
    best_regime: sortByExpectancyAndTotal(entries)[0] || null
  };
}

function buildAlphaDecay(emittedVerifiedRows = []) {
  const rows = [...emittedVerifiedRows].sort((a, b) => a.created_at_ms - b.created_at_ms);
  const rolling = [];
  for (let start = 0; start + ROLLING_EXPECTANCY_WINDOW <= rows.length; start += ROLLING_EXPECTANCY_STEP) {
    const slice = rows.slice(start, start + ROLLING_EXPECTANCY_WINDOW);
    const expectancy = calcExpectancyFromReturns(slice.map((row) => row.directional_return_pct));
    rolling.push({
      index: rolling.length + 1,
      total: slice.length,
      from: slice[0]?.created_at || null,
      to: slice[slice.length - 1]?.created_at || null,
      expectancy: expectancy.expectancy,
      win_rate: expectancy.win_rate
    });
  }

  const expectancySeries = rolling.map((item) => item.expectancy);
  const slope = linearRegressionSlope(expectancySeries);
  const delta =
    rolling.length >= 2
      ? toNum(rolling[rolling.length - 1]?.expectancy, 0) - toNum(rolling[0]?.expectancy, 0)
      : 0;
  const trend = slope < -0.01 ? 'decaying' : slope > 0.01 ? 'improving' : 'stable';

  return {
    alpha_decay_rate: slope,
    expectancy_trend: trend,
    rolling_expectancy_delta: delta,
    rolling_windows: rolling
  };
}

function buildConfidenceCalibration(emittedVerifiedRows = []) {
  const buckets = [
    { key: '90-95', min: 0.9, max: 0.95 },
    { key: '95-97', min: 0.95, max: 0.97 },
    { key: '97-99', min: 0.97, max: 0.99 },
    { key: '99+', min: 0.99, max: 1.01 }
  ];

  return {
    confidence_bucket_accuracy: buckets.map((bucket) => {
      const subset = emittedVerifiedRows.filter((row) => {
        const confidence = toNum(row.confidence);
        if (!Number.isFinite(confidence)) return false;
        return confidence >= bucket.min && confidence < bucket.max;
      });
      const expectancy = calcExpectancyFromReturns(subset.map((row) => row.directional_return_pct));
      return {
        bucket: bucket.key,
        total: subset.length,
        real_winrate_per_confidence_bucket: expectancy.win_rate,
        expectancy: expectancy.expectancy
      };
    })
  };
}

function buildSymbolSurvivorship(emittedVerifiedRows = []) {
  const grouped = emittedVerifiedRows.reduce((acc, row) => {
    if (!acc.has(row.symbol)) acc.set(row.symbol, []);
    acc.get(row.symbol).push(row);
    return acc;
  }, new Map());

  return {
    symbols: sortByExpectancyAndTotal(
      Array.from(grouped.entries()).map(([symbol, rows]) => {
        const ordered = [...rows].sort((a, b) => b.created_at_ms - a.created_at_ms);
        const recent = ordered.slice(0, SURVIVORSHIP_RECENT_WINDOW);
        const prior = ordered.slice(SURVIVORSHIP_RECENT_WINDOW, SURVIVORSHIP_RECENT_WINDOW + SURVIVORSHIP_PRIOR_WINDOW);
        const recentExpectancy = calcExpectancyFromReturns(recent.map((row) => row.directional_return_pct));
        const priorExpectancy = calcExpectancyFromReturns(prior.map((row) => row.directional_return_pct));
        return {
          symbol,
          total: rows.length,
          symbol_expectancy_trend:
            toNum(recentExpectancy.expectancy, 0) - toNum(priorExpectancy.expectancy, 0),
          symbol_edge_decay:
            toNum(priorExpectancy.expectancy, 0) - toNum(recentExpectancy.expectancy, 0),
          symbol_signal_density: rows.length,
          recent_expectancy: recentExpectancy.expectancy,
          prior_expectancy: priorExpectancy.expectancy,
          symbol_degraded: recent.length >= SURVIVORSHIP_RECENT_WINDOW && toNum(recentExpectancy.expectancy, 0) < 0
        };
      })
    )
  };
}

function buildExpectancyStabilityMatrix(emittedVerifiedRows = []) {
  const grouped = emittedVerifiedRows.reduce((acc, row) => {
    const key = `${row.symbol}__${row.regime}__${row.rank_bucket}`;
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(row);
    return acc;
  }, new Map());

  const cells = Array.from(grouped.entries())
    .map(([key, rows]) => {
      const [symbol, regime, rankBucket] = key.split('__');
      const expectancy = calcExpectancyFromReturns(rows.map((row) => row.directional_return_pct));
      return {
        symbol,
        regime,
        rank_bucket: rankBucket,
        total: rows.length,
        expectancy: expectancy.expectancy,
        win_rate: expectancy.win_rate
      };
    })
    .filter((cell) => cell.total >= MATRIX_MIN_SAMPLES)
    .sort((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      return toNum(b.expectancy, -Infinity) - toNum(a.expectancy, -Infinity);
    })
    .slice(0, 30);

  return { cells };
}

async function buildAnalyticsInputs(options = {}) {
  const days = Math.max(1, Math.min(365, Number(options.days || DEFAULT_DAYS)));
  const maxDocs = Math.max(1000, Math.min(300000, Number(options.maxDocs || DEFAULT_MAX_DOCS)));
  const dashboardPayload = options.dashboardPayload || null;

  if (dashboardPayload) {
    return {
      days,
      maxDocs,
      intelligenceReport: dashboardPayload?.intelligence?.report || {},
      suppressedReport: dashboardPayload?.suppressed?.report || {},
      executionReport: dashboardPayload?.execution?.report || {},
      predictionRows: await loadPredictionRows(days, maxDocs)
    };
  }

  const [intelligenceReport, suppressedReport, executionReport, predictionRows] = await Promise.all([
    runSignalIntelligenceAudit({ days, maxDocs, writeFiles: false }),
    runSuppressedValidationAudit({
      days,
      maxDocs: Math.max(250, Math.min(300000, Number(process.env.AUDIT_MAX_DOCS || 250))),
      concurrency: Math.max(1, Math.min(20, Number(process.env.AUDIT_CONCURRENCY || 6))),
      writeFiles: false
    }),
    runExecutionVsModelAudit({
      days,
      maxDocs: Math.max(250, Math.min(300000, Number(process.env.AUDIT_MAX_DOCS || 250))),
      concurrency: Math.max(1, Math.min(20, Number(process.env.AUDIT_CONCURRENCY || 6))),
      matchWindowMinutes: Math.max(1, Math.min(30, Number(process.env.EXEC_MATCH_WINDOW_MINUTES || 5))),
      writeFiles: false
    }),
    loadPredictionRows(days, maxDocs)
  ]);

  return {
    days,
    maxDocs,
    intelligenceReport,
    suppressedReport,
    executionReport,
    predictionRows
  };
}

async function persistSection(collectionName, sectionName, payload) {
  await db.collection(collectionName).doc('current').set({
    generated_at: payload.generated_at,
    section: sectionName,
    data: payload[sectionName]
  }, { merge: true });
}

async function persistSnapshot(payload) {
  await db.collection(SNAPSHOT_COLLECTION).doc(SNAPSHOT_DOC_ID).set(payload, { merge: true });
  await Promise.all([
    persistSection('signal_learning_metrics', 'walkforward_validation', payload),
    persistSection('expectancy_stability', 'expectancy_stability', payload),
    persistSection('counterfactual_metrics', 'counterfactual_learning', payload),
    persistSection('regime_learning', 'regime_learning', payload),
    persistSection('alpha_decay', 'alpha_decay', payload),
    persistSection('confidence_calibration', 'confidence_calibration', payload)
  ]);
}

async function loadPersistedSnapshot() {
  const doc = await db.collection(SNAPSHOT_COLLECTION).doc(SNAPSHOT_DOC_ID).get();
  if (!doc.exists) return null;
  const payload = doc.data() || null;
  if (!payload) return null;
  snapshotCache = {
    fetchedAt: Date.now(),
    payload,
    inFlight: null
  };
  return payload;
}

async function refreshStatisticalLearningSnapshot(options = {}) {
  if (!STATISTICAL_LEARNING_ENABLED) {
    return {
      generated_at: new Date().toISOString(),
      enabled: false,
      reason: 'STATISTICAL_LEARNING_ENABLED=false'
    };
  }

  const inputs = await buildAnalyticsInputs(options);
  const emittedVerifiedRows = inputs.predictionRows.filter(
    (row) => row.signal_emitted && (row.outcome === 'WIN' || row.outcome === 'LOSS')
  );
  const allVerifiedRows = inputs.predictionRows.filter((row) => row.outcome === 'WIN' || row.outcome === 'LOSS');

  const counterfactualLearning = buildCounterfactualLearning(inputs.suppressedReport);
  const expectancyStability = buildExpectancyStability(emittedVerifiedRows);
  const walkforwardValidation = buildWalkforwardValidation(emittedVerifiedRows);
  const regimeLearning = buildRegimeLearning(allVerifiedRows);
  const alphaDecay = buildAlphaDecay(emittedVerifiedRows);
  const confidenceCalibration = buildConfidenceCalibration(emittedVerifiedRows);
  const symbolSurvivorship = buildSymbolSurvivorship(emittedVerifiedRows);
  const expectancyStabilityMatrix = buildExpectancyStabilityMatrix(emittedVerifiedRows);

  const generatedAt = new Date().toISOString();
  const payload = {
    generated_at: generatedAt,
    enabled: true,
    config: {
      days: inputs.days,
      max_docs: inputs.maxDocs,
      walkforward_training_window: WALKFORWARD_TRAIN_SIZE,
      walkforward_validation_window: WALKFORWARD_VALIDATION_SIZE,
      walkforward_step: WALKFORWARD_STEP,
      rolling_expectancy_window: ROLLING_EXPECTANCY_WINDOW,
      rolling_expectancy_step: ROLLING_EXPECTANCY_STEP
    },
    counterfactual_learning: counterfactualLearning,
    expectancy_stability: expectancyStability,
    walkforward_validation: walkforwardValidation,
    regime_learning: regimeLearning,
    alpha_decay: alphaDecay,
    confidence_calibration: confidenceCalibration,
    symbol_survivorship: symbolSurvivorship,
    expectancy_stability_matrix: expectancyStabilityMatrix
  };

  await persistSnapshot(payload);
  snapshotCache = {
    fetchedAt: Date.now(),
    payload,
    inFlight: null
  };
  return payload;
}

async function getStatisticalLearningSnapshot(options = {}) {
  const refresh = Boolean(options.refresh);
  const now = Date.now();
  const memFresh = snapshotCache.payload && now - snapshotCache.fetchedAt < SNAPSHOT_MEM_TTL_MS;

  if (!refresh && memFresh) {
    return {
      payload: snapshotCache.payload,
      cached: true,
      source: 'memory'
    };
  }

  if (!refresh) {
    const persisted = await loadPersistedSnapshot();
    if (persisted) {
      return {
        payload: persisted,
        cached: true,
        source: 'firestore'
      };
    }

    return {
      payload: {
        generated_at: null,
        enabled: STATISTICAL_LEARNING_ENABLED,
        pending: true,
        reason: 'snapshot_not_generated_yet'
      },
      cached: false,
      source: 'missing'
    };
  }

  if (!snapshotCache.inFlight) {
    snapshotCache.inFlight = refreshStatisticalLearningSnapshot(options).finally(() => {
      snapshotCache.inFlight = null;
    });
  }

  const payload = await snapshotCache.inFlight;
  return {
    payload,
    cached: false,
    source: 'recomputed'
  };
}

module.exports = {
  STATISTICAL_LEARNING_ENABLED,
  refreshStatisticalLearningSnapshot,
  getStatisticalLearningSnapshot
};
