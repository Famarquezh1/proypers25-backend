const { normalizeToBinance } = require('../utils/symbolNormalizer');

const ENTRY_QUALITY_DEFICIT_MULTIPLIERS = {
  direction: 0.7,
  context: 0.7,
  impulse: 0.8,
  volatility: 1
};

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

function toFinite(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function softenComponentScore(score, multiplier) {
  const normalizedScore = clamp(Number(score), 0, 100);
  const normalizedMultiplier = clamp(Number(multiplier), 0, 1);
  return 100 - ((100 - normalizedScore) * normalizedMultiplier);
}

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function normalizeDirection(side) {
  return String(side || 'BUY').toUpperCase() === 'SELL' ? -1 : 1;
}

function resolveExecutionGuardConfig(botConfig = {}) {
  const raw = botConfig?.execution_guard || {};
  const legacyMinEntryQualityRaw = Number(
    raw.min_entry_quality_score ?? process.env.EXECUTION_GUARD_MIN_ENTRY_QUALITY_SCORE ?? 0.7
  );
  const normalizedLegacyHighQuality =
    legacyMinEntryQualityRaw <= 1 ? legacyMinEntryQualityRaw * 100 : legacyMinEntryQualityRaw;
  const highQualityScore = clamp(
    Number(
      raw.high_quality_score ??
        process.env.EXECUTION_GUARD_HIGH_QUALITY_SCORE ??
        normalizedLegacyHighQuality
    ),
    45,
    95
  );
  const mediumQualityScore = clamp(
    Number(raw.medium_quality_score ?? process.env.EXECUTION_GUARD_MEDIUM_QUALITY_SCORE ?? 38),
    20,
    highQualityScore - 5
  );
  return {
    enabled: raw.enabled !== false,
    signal_expiration_ms: Math.max(
      15000,
      Number(raw.signal_expiration_ms ?? process.env.EXECUTION_GUARD_SIGNAL_EXPIRATION_MS ?? 45000)
    ),
    snapshot_wait_ms: Math.max(
      0,
      Number(raw.snapshot_wait_ms ?? process.env.EXECUTION_GUARD_SNAPSHOT_WAIT_MS ?? 2500)
    ),
    snapshot_poll_interval_ms: Math.max(
      100,
      Number(raw.snapshot_poll_interval_ms ?? process.env.EXECUTION_GUARD_SNAPSHOT_POLL_INTERVAL_MS ?? 200)
    ),
    max_snapshot_staleness_ms: Math.max(
      1000,
      Number(raw.max_snapshot_staleness_ms ?? process.env.EXECUTION_GUARD_MAX_SNAPSHOT_STALENESS_MS ?? 8000)
    ),
    min_entry_quality_score: Number((highQualityScore / 100).toFixed(2)),
    high_quality_score: highQualityScore,
    medium_quality_score: mediumQualityScore,
    max_price_deviation_pct: Math.max(
      0.02,
      Number(raw.max_price_deviation_pct ?? process.env.EXECUTION_GUARD_MAX_PRICE_DEVIATION_PCT ?? 0.75)
    ),
    hard_price_deviation_pct: Math.max(
      0.05,
      Number(
        raw.hard_price_deviation_pct ??
          process.env.EXECUTION_GUARD_HARD_PRICE_DEVIATION_PCT ??
          1.4
      )
    ),
    max_estimated_slippage_pct: Math.max(
      0.02,
      Number(
        raw.max_estimated_slippage_pct ??
          process.env.EXECUTION_GUARD_MAX_ESTIMATED_SLIPPAGE_PCT ??
          0.45
      )
    ),
    hard_estimated_slippage_pct: Math.max(
      0.05,
      Number(
        raw.hard_estimated_slippage_pct ??
          process.env.EXECUTION_GUARD_HARD_ESTIMATED_SLIPPAGE_PCT ??
          0.85
      )
    ),
    max_spread_bps: Math.max(
      0.1,
      Number(raw.max_spread_bps ?? process.env.EXECUTION_GUARD_MAX_SPREAD_BPS ?? 8)
    ),
    min_recent_trades_window: Math.max(
      0,
      Math.floor(Number(raw.min_recent_trades_window ?? process.env.EXECUTION_GUARD_MIN_RECENT_TRADES_WINDOW ?? 1))
    ),
    good_velocity_bps_per_sec: Math.max(
      0.5,
      Number(raw.good_velocity_bps_per_sec ?? process.env.EXECUTION_GUARD_GOOD_VELOCITY_BPS_PER_SEC ?? 5)
    ),
    adverse_velocity_bps_per_sec: -Math.max(
      0.5,
      Number(raw.adverse_velocity_bps_per_sec ?? process.env.EXECUTION_GUARD_ADVERSE_VELOCITY_BPS_PER_SEC ?? 7)
    ),
    good_acceleration_bps_per_sec2: Math.max(
      0.1,
      Number(
        raw.good_acceleration_bps_per_sec2 ??
          process.env.EXECUTION_GUARD_GOOD_ACCELERATION_BPS_PER_SEC2 ??
          1.2
      )
    ),
    adverse_acceleration_bps_per_sec2: -Math.max(
      0.1,
      Number(
        raw.adverse_acceleration_bps_per_sec2 ??
          process.env.EXECUTION_GUARD_ADVERSE_ACCELERATION_BPS_PER_SEC2 ??
          2.4
      )
    ),
    positive_imbalance: clamp(
      Number(raw.positive_imbalance ?? process.env.EXECUTION_GUARD_POSITIVE_IMBALANCE ?? 0.12),
      0.01,
      1
    ),
    adverse_imbalance: -clamp(
      Number(raw.adverse_imbalance ?? process.env.EXECUTION_GUARD_ADVERSE_IMBALANCE ?? 0.22),
      0.01,
      1
    ),
    stall_velocity_ceiling_bps_per_sec: Math.max(
      0.1,
      Number(
        raw.stall_velocity_ceiling_bps_per_sec ??
          process.env.EXECUTION_GUARD_STALL_VELOCITY_CEILING_BPS_PER_SEC ??
          0.9
      )
    ),
    deterioration_negative_signals_threshold: Math.max(
      3,
      Math.floor(
        Number(
          raw.deterioration_negative_signals_threshold ??
            process.env.EXECUTION_GUARD_DETERIORATION_NEGATIVE_SIGNALS_THRESHOLD ??
            4
        )
      )
    ),
    invalidation_negative_signals_threshold: Math.max(
      4,
      Math.floor(
        Number(
          raw.invalidation_negative_signals_threshold ??
            process.env.EXECUTION_GUARD_INVALIDATION_NEGATIVE_SIGNALS_THRESHOLD ??
            5
        )
      )
    ),
    stale_snapshot_penalty_points: Math.max(
      0,
      Number(
        raw.stale_snapshot_penalty_points ??
          process.env.EXECUTION_GUARD_STALE_SNAPSHOT_PENALTY_POINTS ??
          10
      )
    ),
    weak_snapshot_penalty_points: Math.max(
      0,
      Number(
        raw.weak_snapshot_penalty_points ??
          process.env.EXECUTION_GUARD_WEAK_SNAPSHOT_PENALTY_POINTS ??
          5
      )
    ),
    medium_high_quality_score: clamp(
      Number(
        raw.medium_high_quality_score ??
          process.env.EXECUTION_GUARD_MEDIUM_HIGH_QUALITY_SCORE ??
          55
      ),
      mediumQualityScore,
      highQualityScore
    ),
    high_quality_size_factor: clamp(
      Number(
        raw.high_quality_size_factor ??
          process.env.EXECUTION_GUARD_HIGH_QUALITY_SIZE_FACTOR ??
          1
      ),
      0.2,
      1
    ),
    medium_high_quality_size_factor: clamp(
      Number(
        raw.medium_high_quality_size_factor ??
          process.env.EXECUTION_GUARD_MEDIUM_HIGH_QUALITY_SIZE_FACTOR ??
          0.7
      ),
      0.2,
      1
    ),
    medium_low_quality_size_factor: clamp(
      Number(
        raw.medium_low_quality_size_factor ??
          process.env.EXECUTION_GUARD_MEDIUM_LOW_QUALITY_SIZE_FACTOR ??
          0.4
      ),
      0.2,
      1
    )
  };
}

function resolveSignalTimestamp(signal = {}) {
  return (
    parseDateLike(signal?.signal_at) ||
    parseDateLike(signal?.signal_emitted_at) ||
    parseDateLike(signal?.emitted_at) ||
    parseDateLike(signal?.created_at) ||
    parseDateLike(signal?.timestamp) ||
    parseDateLike(signal?.ahora) ||
    parseDateLike(signal?.entry_time)
  );
}

function resolveSnapshotTimestamp(snapshot = {}) {
  return (
    parseDateLike(snapshot?.last_trade_ts) ||
    parseDateLike(snapshot?.last_update_ts) ||
    parseDateLike(snapshot?.published_at) ||
    parseDateLike(snapshot?.updated_at)
  );
}

function resolveSignalPrice(signal = {}, fallbackPrice = null) {
  const candidates = [
    signal?.spot_price,
    signal?.precio_actual,
    signal?.trade_plan?.entry_price,
    signal?.entry_price,
    fallbackPrice
  ];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function resolveExecutionReferencePrice(side, snapshot = {}, fallbackPrice = null) {
  const upperSide = String(side || 'BUY').toUpperCase();
  const candidates =
    upperSide === 'SELL'
      ? [snapshot?.bid, snapshot?.last_price, snapshot?.ask, fallbackPrice]
      : [snapshot?.ask, snapshot?.last_price, snapshot?.bid, fallbackPrice];
  for (const candidate of candidates) {
    const n = Number(candidate);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function pctDiff(base, other) {
  const a = Number(base);
  const b = Number(other);
  if (!Number.isFinite(a) || a <= 0 || !Number.isFinite(b) || b <= 0) return null;
  return Math.abs(((b - a) / a) * 100);
}

function directionalValue(value, side) {
  const n = toFinite(value, 0);
  return n * normalizeDirection(side);
}

function buildSnapshotSummary(symbol, side, snapshot = {}, fallbackPrice = null) {
  const executionReferencePrice = resolveExecutionReferencePrice(side, snapshot, fallbackPrice);
  const snapshotTs = resolveSnapshotTimestamp(snapshot);
  const snapshotPresent =
    Boolean(snapshotTs) ||
    Number.isFinite(Number(snapshot?.bid)) ||
    Number.isFinite(Number(snapshot?.ask)) ||
    Number.isFinite(Number(snapshot?.last_price)) ||
    Number.isFinite(Number(snapshot?.price_velocity_bps_per_sec)) ||
    Number.isFinite(Number(snapshot?.trade_flow_imbalance));
  return {
    symbol: normalizeToBinance(symbol),
    snapshot_present: snapshotPresent,
    last_price: toFinite(snapshot?.last_price, fallbackPrice),
    bid: toFinite(snapshot?.bid, null),
    ask: toFinite(snapshot?.ask, null),
    spread_bps: toFinite(snapshot?.spread_bps, null),
    recent_trades_window: Math.max(0, Math.floor(Number(snapshot?.recent_trades_window || 0))),
    velocity: toFinite(snapshot?.price_velocity_bps_per_sec, null),
    acceleration: toFinite(snapshot?.price_acceleration_bps_per_sec2, null),
    imbalance: toFinite(snapshot?.trade_flow_imbalance, null),
    micro_high: toFinite(snapshot?.micro_high, null),
    micro_low: toFinite(snapshot?.micro_low, null),
    snapshot_at: snapshotTs ? snapshotTs.toISOString() : null,
    execution_reference_price: executionReferencePrice,
    price_history_points: Math.max(0, Math.floor(Number(snapshot?.price_history_points || 0))),
    velocity_history_points: Math.max(0, Math.floor(Number(snapshot?.velocity_history_points || 0)))
  };
}

function inferEntryLifecycleState({
  signalAgeMs,
  snapshotFresh,
  snapshotSummary,
  directionalVelocity,
  directionalAcceleration,
  directionalImbalance,
  strongStall,
  negativeSignals,
  config
}) {
  const recentTradesWindow = Math.max(0, Number(snapshotSummary?.recent_trades_window || 0));
  const ageMs = Math.max(0, Number(signalAgeMs || 0));
  const expansionDetected =
    directionalVelocity >= config.good_velocity_bps_per_sec * 0.6 &&
    directionalImbalance >= config.positive_imbalance * 0.5 &&
    recentTradesWindow >= config.min_recent_trades_window;
  const structuralMomentumLoss =
    directionalVelocity <= config.adverse_velocity_bps_per_sec &&
    directionalAcceleration <= config.adverse_acceleration_bps_per_sec2 &&
    directionalImbalance <= config.adverse_imbalance;

  if (
    negativeSignals >= config.deterioration_negative_signals_threshold &&
    (strongStall || structuralMomentumLoss)
  ) {
    return 'deterioration';
  }
  if (expansionDetected) {
    return 'expansion';
  }
  if (
    ageMs <= config.signal_expiration_ms * 0.35 &&
    snapshotFresh &&
    recentTradesWindow <= config.min_recent_trades_window + 1 &&
    directionalAcceleration >= config.adverse_acceleration_bps_per_sec2 * 0.25
  ) {
    return 'incubation';
  }
  return 'evaluation';
}

function computeEntryQuality({
  signalAgeMs,
  priceDeviationPct,
  directionalVelocity,
  directionalAcceleration,
  directionalImbalance,
  entryLifecycleState,
  snapshotFresh,
  recentTradesWindow,
  estimatedSlippagePct,
  config
}) {
  const freshnessScore = clamp(1 - signalAgeMs / Math.max(config.signal_expiration_ms, 1), 0, 1) * 100;
  const deviationScore = clamp(
    1 - Number(priceDeviationPct ?? config.max_price_deviation_pct * 1.5) /
      Math.max(config.max_price_deviation_pct, 0.001),
    0,
    1
  ) * 100;
  const velocityScore = clamp(
    (directionalVelocity - config.adverse_velocity_bps_per_sec) /
      Math.max(config.good_velocity_bps_per_sec - config.adverse_velocity_bps_per_sec, 0.001),
    0,
    1
  ) * 100;
  const accelerationScore = clamp(
    (directionalAcceleration - config.adverse_acceleration_bps_per_sec2) /
      Math.max(config.good_acceleration_bps_per_sec2 - config.adverse_acceleration_bps_per_sec2, 0.001),
    0,
    1
  ) * 100;
  const imbalanceScore = clamp(
    (directionalImbalance - config.adverse_imbalance) /
      Math.max(config.positive_imbalance - config.adverse_imbalance, 0.001),
    0,
    1
  ) * 100;
  const lifecycleScore = {
    incubation: 58,
    evaluation: 70,
    expansion: 92,
    deterioration: 12
  }[entryLifecycleState] ?? 55;
  const adjustedDeviationScore = softenComponentScore(
    deviationScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.volatility
  );
  const adjustedVelocityScore = softenComponentScore(
    velocityScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.direction
  );
  const adjustedAccelerationScore = softenComponentScore(
    accelerationScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.impulse
  );
  const adjustedImbalanceScore = softenComponentScore(
    imbalanceScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.direction
  );
  const adjustedFreshnessScore = softenComponentScore(
    freshnessScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.context
  );
  const adjustedLifecycleScore = softenComponentScore(
    lifecycleScore,
    ENTRY_QUALITY_DEFICIT_MULTIPLIERS.context
  );

  let score =
    adjustedDeviationScore * 0.24 +
    adjustedVelocityScore * 0.2 +
    adjustedAccelerationScore * 0.14 +
    adjustedImbalanceScore * 0.18 +
    adjustedFreshnessScore * 0.14 +
    adjustedLifecycleScore * 0.1;

  const penalties = [];
  if (!snapshotFresh) {
    const penalty = Number(
      (config.stale_snapshot_penalty_points * ENTRY_QUALITY_DEFICIT_MULTIPLIERS.context).toFixed(2)
    );
    score -= penalty;
    penalties.push({ type: 'stale_snapshot', points: penalty });
  }
  if (recentTradesWindow <= 0) {
    const penalty = Number(
      (config.weak_snapshot_penalty_points * ENTRY_QUALITY_DEFICIT_MULTIPLIERS.context).toFixed(2)
    );
    score -= penalty;
    penalties.push({ type: 'weak_snapshot', points: penalty });
  }
  if (Number.isFinite(estimatedSlippagePct) && estimatedSlippagePct > config.max_estimated_slippage_pct) {
    const penalty = Math.min(
      config.stale_snapshot_penalty_points,
      (estimatedSlippagePct - config.max_estimated_slippage_pct) * 10
    );
    score -= penalty;
    penalties.push({ type: 'slippage_penalty', points: Number(penalty.toFixed(2)) });
  }
  score = clamp(score, 0, 100);

  return {
    entryQualityScore: Number(score.toFixed(2)),
    qualityComponents: {
      freshness: Number(freshnessScore.toFixed(2)),
      price_deviation: Number(deviationScore.toFixed(2)),
      velocity_alignment: Number(velocityScore.toFixed(2)),
      acceleration_alignment: Number(accelerationScore.toFixed(2)),
      imbalance_strength: Number(imbalanceScore.toFixed(2)),
      lifecycle_state: Number(lifecycleScore.toFixed(2))
    },
    penalties
  };
}

function determineQualityZone(score, config) {
  if (score >= config.high_quality_score) return 'high';
  if (score >= config.medium_quality_score) return 'medium';
  return 'low';
}

function determineDecisionReason({
  blocked,
  reason,
  qualityZone,
  invalidationDetected,
  structuralDeterioration,
  signalExpired,
  signalTimestampMissing
}) {
  if (blocked) return reason;
  if (signalTimestampMissing) return 'signal_timestamp_missing';
  if (invalidationDetected) return 'execution_guard_invalidation';
  if (structuralDeterioration) return 'execution_guard_deterioration';
  if (qualityZone === 'high') return 'entry_quality_high';
  if (qualityZone === 'medium') return signalExpired ? 'entry_quality_medium_late' : 'entry_quality_medium';
  return reason || 'entry_quality_low';
}

function evaluateExecutionGuard(symbol, signal = {}, microstructure = null, options = {}) {
  const config = resolveExecutionGuardConfig(options.botConfig);
  const normalizedSymbol = normalizeToBinance(symbol || signal?.symbol || signal?.simbolo);
  const side = String(options.side || signal?.side || signal?.direction || 'BUY').toUpperCase();
  const nowMs = Number(options.nowMs || Date.now());
  const signalTime = resolveSignalTimestamp(signal);
  const signalAgeMs = signalTime ? Math.max(0, nowMs - signalTime.getTime()) : null;
  const signalTimestampMissing = !signalTime;
  const signalExpired = signalAgeMs != null && signalAgeMs > config.signal_expiration_ms;
  const expectedEntryPrice = Number(signal?.trade_plan?.entry_price || signal?.entry_price || 0) || null;
  const snapshotSummary = buildSnapshotSummary(
    normalizedSymbol,
    side,
    microstructure || {},
    expectedEntryPrice
  );
  const signalPrice = resolveSignalPrice(signal, snapshotSummary.execution_reference_price);
  const snapshotTs = resolveSnapshotTimestamp(microstructure || {});
  const snapshotAgeMs = snapshotTs ? Math.max(0, nowMs - snapshotTs.getTime()) : null;
  const snapshotFresh = snapshotAgeMs != null && snapshotAgeMs <= config.max_snapshot_staleness_ms;
  const snapshotAvailable = Boolean(snapshotSummary.execution_reference_price);
  const recentTradesWindow = Math.max(0, Number(snapshotSummary.recent_trades_window || 0));
  const spreadBps = toFinite(snapshotSummary?.spread_bps, null);
  const priceDeviationPct = pctDiff(expectedEntryPrice || signalPrice || 0, snapshotSummary.execution_reference_price);
  const estimatedSlippagePct = pctDiff(signalPrice, snapshotSummary.execution_reference_price);
  const directionalVelocity = directionalValue(snapshotSummary?.velocity, side);
  const directionalAcceleration = directionalValue(snapshotSummary?.acceleration, side);
  const directionalImbalance = directionalValue(snapshotSummary?.imbalance, side);

  const priceDeviationSoft =
    Number.isFinite(priceDeviationPct) && priceDeviationPct > config.max_price_deviation_pct;
  const priceDeviationHard =
    Number.isFinite(priceDeviationPct) && priceDeviationPct > config.hard_price_deviation_pct;
  const slippageSoft =
    Number.isFinite(estimatedSlippagePct) && estimatedSlippagePct > config.max_estimated_slippage_pct;
  const slippageHard =
    Number.isFinite(estimatedSlippagePct) && estimatedSlippagePct > config.hard_estimated_slippage_pct;
  const adverseVelocity = directionalVelocity <= config.adverse_velocity_bps_per_sec;
  const adverseAcceleration = directionalAcceleration <= config.adverse_acceleration_bps_per_sec2;
  const adverseImbalance = directionalImbalance <= config.adverse_imbalance;
  const wideSpread = Number.isFinite(spreadBps) && spreadBps > config.max_spread_bps;
  const weakTrades = recentTradesWindow < config.min_recent_trades_window;
  const strongStall =
    weakTrades &&
    Math.abs(Number(snapshotSummary.velocity || 0)) <= config.stall_velocity_ceiling_bps_per_sec &&
    Math.abs(directionalImbalance) <= Math.abs(config.positive_imbalance);

  const negativeSignals = [
    adverseVelocity,
    adverseAcceleration,
    adverseImbalance,
    strongStall,
    wideSpread,
    weakTrades,
    !snapshotFresh,
    priceDeviationSoft,
    slippageSoft
  ].filter(Boolean).length;
  const positiveSignals = [
    directionalVelocity >= config.good_velocity_bps_per_sec * 0.6,
    directionalAcceleration >= config.good_acceleration_bps_per_sec2 * 0.35,
    directionalImbalance >= config.positive_imbalance * 0.5,
    recentTradesWindow >= Math.max(config.min_recent_trades_window, 1)
  ].filter(Boolean).length;

  const entryLifecycleState = inferEntryLifecycleState({
    signalAgeMs: Math.max(0, Number(signalAgeMs || 0)),
    snapshotFresh,
    snapshotSummary,
    directionalVelocity,
    directionalAcceleration,
    directionalImbalance,
    strongStall,
    negativeSignals,
    config
  });
  const structuralDeterioration =
    entryLifecycleState === 'deterioration' &&
    negativeSignals >= config.deterioration_negative_signals_threshold &&
    positiveSignals <= 1;
  const invalidationDetected =
    priceDeviationHard ||
    slippageHard ||
    (
      negativeSignals >= config.invalidation_negative_signals_threshold &&
      adverseVelocity &&
      adverseImbalance
    );

  const entryQuality = computeEntryQuality({
    signalAgeMs: Math.max(0, Number(signalAgeMs || config.signal_expiration_ms * 2)),
    priceDeviationPct,
    directionalVelocity,
    directionalAcceleration,
    directionalImbalance,
    entryLifecycleState,
    snapshotFresh,
    recentTradesWindow,
    estimatedSlippagePct,
    config
  });
  const qualityZone = determineQualityZone(entryQuality.entryQualityScore, config);
  const qualityOk = qualityZone !== 'low';
  const momentumAligned = !structuralDeterioration && !invalidationDetected;

  let blocked = false;
  let reason = null;
  if (!config.enabled) {
    blocked = false;
  } else if (signalTimestampMissing) {
    blocked = true;
    reason = 'signal_timestamp_missing';
  } else if (invalidationDetected) {
    blocked = true;
    reason = 'execution_guard_invalidation';
  } else if (structuralDeterioration) {
    blocked = true;
    reason = 'execution_guard_deterioration';
  } else if (!qualityOk) {
    blocked = true;
    reason = 'entry_quality_low';
  }

  const decisionReason = determineDecisionReason({
    blocked,
    reason,
    qualityZone,
    invalidationDetected,
    structuralDeterioration,
    signalExpired,
    signalTimestampMissing
  });

  return {
    enabled: config.enabled,
    blocked,
    reason,
    decision: blocked ? 'blocked' : 'executed',
    decisionReason,
    signalExpired,
    signalTimestampMissing,
    signalTimestamp: signalTime ? signalTime.toISOString() : null,
    signalAgeMs,
    signalExpirationMs: config.signal_expiration_ms,
    snapshotAvailable,
    snapshotFresh,
    snapshotAgeMs,
    momentumAligned,
    deteriorationDetected: structuralDeterioration,
    invalidationDetected,
    strongStall,
    negativeSignals,
    positiveSignals,
    qualityZone,
    entryLifecycleState,
    entryQualityScore: entryQuality.entryQualityScore,
    qualityThreshold: config.high_quality_score,
    qualityThresholds: {
      high: config.high_quality_score,
      medium: config.medium_quality_score
    },
    priceDeviationPct: Number.isFinite(priceDeviationPct) ? Number(priceDeviationPct.toFixed(4)) : null,
    estimatedSlippagePct: Number.isFinite(estimatedSlippagePct) ? Number(estimatedSlippagePct.toFixed(4)) : null,
    signalPrice,
    executionReferencePrice: snapshotSummary.execution_reference_price,
    entryQualityComponents: entryQuality.qualityComponents,
    entryQualityPenalties: entryQuality.penalties,
    microstructure: snapshotSummary,
    conditions: {
      quality_zone: qualityZone,
      snapshot_available: snapshotAvailable,
      snapshot_fresh: snapshotFresh,
      strong_stall: strongStall,
      invalidation_detected: invalidationDetected,
      deterioration_detected: structuralDeterioration,
      momentum_aligned: momentumAligned
    }
  };
}

module.exports = {
  resolveExecutionGuardConfig,
  resolveSignalTimestamp,
  resolveSnapshotTimestamp,
  resolveSignalPrice,
  resolveExecutionReferencePrice,
  buildSnapshotSummary,
  evaluateExecutionGuard
};
