function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toFinite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pnlPctFor(side, entryPrice, currentPrice) {
  const entry = Number(entryPrice || 0);
  const price = Number(currentPrice || 0);
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(price) || price <= 0) return 0;
  if (String(side || '').toUpperCase() === 'SELL') {
    return ((entry - price) / entry) * 100;
  }
  return ((price - entry) / entry) * 100;
}

function determineFavorablePrice(side, currentPrice, microHigh, microLow, existingPeak) {
  if (String(side || '').toUpperCase() === 'SELL') {
    const candidates = [existingPeak, microLow, currentPrice].map(Number).filter(Number.isFinite);
    return candidates.length ? Math.min(...candidates) : Number(currentPrice || 0);
  }
  const candidates = [existingPeak, microHigh, currentPrice].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.max(...candidates) : Number(currentPrice || 0);
}

function determineAdversePrice(side, currentPrice, microHigh, microLow, existingTrough) {
  if (String(side || '').toUpperCase() === 'SELL') {
    const candidates = [existingTrough, microHigh, currentPrice].map(Number).filter(Number.isFinite);
    return candidates.length ? Math.max(...candidates) : Number(currentPrice || 0);
  }
  const candidates = [existingTrough, microLow, currentPrice].map(Number).filter(Number.isFinite);
  return candidates.length ? Math.min(...candidates) : Number(currentPrice || 0);
}

function normalizeMode(value, fallback = 'off') {
  const raw = String(value || fallback).toLowerCase();
  if (raw === 'observe') return 'observe';
  if (raw === 'enforce') return 'enforce';
  if (raw === 'true') return 'observe';
  return 'off';
}

function resolveLifecycleConfig(botConfig = {}) {
  const lifecycle = botConfig?.impulse_lifecycle || {};
  const incubationMs = Math.max(60000, Number(lifecycle.incubation_ms || 90000));
  const evaluationMs = Math.max(15000, Number(lifecycle.evaluation_ms || 45000));
  return {
    enabled: normalizeMode(lifecycle.mode || lifecycle.enabled, 'off') !== 'off',
    mode: normalizeMode(lifecycle.mode || lifecycle.enabled, 'off'),
    incubation_ms: incubationMs,
    evaluation_ms: evaluationMs,
    no_ignition_ms: Math.max(
      incubationMs + evaluationMs,
      Number(lifecycle.no_ignition_ms || incubationMs + evaluationMs)
    ),
    no_ignition_min_negative_signals: Math.max(
      2,
      Number(lifecycle.no_ignition_min_negative_signals || 3)
    ),
    no_ignition_velocity_ceiling_bps_per_sec: Math.max(
      0.5,
      Number(lifecycle.no_ignition_velocity_ceiling_bps_per_sec || 2)
    ),
    no_ignition_required_stall_ratio: clamp(
      Number(lifecycle.no_ignition_required_stall_ratio || 0.75),
      0.3,
      1.5
    ),
    no_ignition_imbalance_ceiling: Number(lifecycle.no_ignition_imbalance_ceiling || 0.05),
    stall_ms: Math.max(5000, Number(lifecycle.stall_ms || 25000)),
    decay_threshold: clamp(Number(lifecycle.decay_threshold || 0.62), 0.1, 0.95),
    ignition_expansion_pct: Math.max(0.01, Number(lifecycle.ignition_expansion_pct || 0.05)),
    expansion_min_pnl_pct: Math.max(
      0.02,
      Number(lifecycle.expansion_min_pnl_pct || Math.max(Number(lifecycle.ignition_expansion_pct || 0.05), 0.08))
    ),
    expansion_min_new_extremes: Math.max(1, Number(lifecycle.expansion_min_new_extremes || 2)),
    expansion_hold_ms: Math.max(30000, Number(lifecycle.expansion_hold_ms || 60000)),
    evaluation_positive_velocity_bps_per_sec: Number(
      lifecycle.evaluation_positive_velocity_bps_per_sec || 4
    ),
    evaluation_negative_velocity_bps_per_sec: Number(
      lifecycle.evaluation_negative_velocity_bps_per_sec || -4
    ),
    evaluation_positive_imbalance: Number(lifecycle.evaluation_positive_imbalance || 0.12),
    evaluation_negative_imbalance: Number(lifecycle.evaluation_negative_imbalance || -0.12),
    evaluation_positive_signal_threshold: Math.max(
      1,
      Number(lifecycle.evaluation_positive_signal_threshold || 2)
    ),
    stall_velocity_bps_per_sec: Number(lifecycle.stall_velocity_bps_per_sec || 6),
    severe_pullback_pct: Math.max(0.02, Number(lifecycle.severe_pullback_pct || 0.18)),
    deterioration_pullback_pct: Math.max(
      0.03,
      Number(lifecycle.deterioration_pullback_pct || 0.12)
    ),
    deterioration_negative_signal_threshold: Math.max(
      2,
      Number(lifecycle.deterioration_negative_signal_threshold || 3)
    )
  };
}

function appendTimelineEntry(previousTimeline = [], nextEntry) {
  const list = Array.isArray(previousTimeline) ? previousTimeline.slice(-15) : [];
  const latest = list[list.length - 1];
  if (latest && latest.state === nextEntry.state && latest.reason === nextEntry.reason) {
    return list;
  }
  list.push(nextEntry);
  return list.slice(-16);
}

function summarizeMicrostructure(snapshot = {}) {
  return {
    velocity: toFinite(snapshot?.price_velocity_bps_per_sec, 0),
    acceleration: toFinite(snapshot?.price_acceleration_bps_per_sec2, 0),
    imbalance: Number.isFinite(Number(snapshot?.trade_flow_imbalance))
      ? Number(snapshot.trade_flow_imbalance)
      : 0,
    spread_bps: Number.isFinite(Number(snapshot?.spread_bps))
      ? Number(snapshot.spread_bps)
      : null
  };
}

function buildSignalScores({
  lifecycleConfig,
  currentPnlPct,
  maxPnlPct,
  newPositiveExtreme,
  stallDurationMs,
  pullbackFromPeakPct,
  velocity,
  acceleration,
  imbalance,
  structuralImprovement
}) {
  let positiveSignals = 0;
  let negativeSignals = 0;

  if (currentPnlPct > 0) positiveSignals += 1;
  if (maxPnlPct >= lifecycleConfig.ignition_expansion_pct) positiveSignals += 1;
  if (newPositiveExtreme) positiveSignals += 1;
  if (velocity >= lifecycleConfig.evaluation_positive_velocity_bps_per_sec) positiveSignals += 1;
  if (acceleration > 0) positiveSignals += 1;
  if (imbalance >= lifecycleConfig.evaluation_positive_imbalance) positiveSignals += 1;
  if (structuralImprovement) positiveSignals += 1;

  if (!structuralImprovement) negativeSignals += 1;
  if (Math.abs(velocity) <= lifecycleConfig.stall_velocity_bps_per_sec) negativeSignals += 1;
  if (velocity <= lifecycleConfig.evaluation_negative_velocity_bps_per_sec) negativeSignals += 1;
  if (acceleration < 0) negativeSignals += 1;
  if (imbalance <= lifecycleConfig.evaluation_negative_imbalance) negativeSignals += 1;
  if (stallDurationMs >= lifecycleConfig.stall_ms * 0.5) negativeSignals += 1;
  if (pullbackFromPeakPct >= lifecycleConfig.deterioration_pullback_pct * 0.5) negativeSignals += 1;

  return {
    positiveSignals,
    negativeSignals
  };
}

function resolveLegacyState(impulseState, impulseReason, currentPnlPct) {
  if (impulseState === 'expansion') return 'alive';
  if (impulseState === 'deterioration') {
    if (
      ['no_ignition_accumulated', 'stall_confirmed', 'impulse_dead_after_decay'].includes(String(impulseReason || '')) ||
      currentPnlPct <= 0
    ) {
      return 'dead';
    }
    return 'decaying';
  }
  return 'ignition';
}

function updateImpulseLifecycle(position = {}, marketSnapshot = null, options = {}) {
  const lifecycleConfig = resolveLifecycleConfig(options.botConfig);
  const now = Number(options.now || Date.now());
  const openedAt = parseDateLike(position.opened_at);
  const openedAtMs = openedAt ? openedAt.getTime() : now;
  const elapsedMs = Math.max(0, now - openedAtMs);
  const previous = position.impulse_lifecycle || {};
  const side = String(position.side || 'BUY').toUpperCase();
  const entryPrice = Number(position.entry_price || 0);
  const currentPrice = Number(
    options.markPrice || marketSnapshot?.last_price || marketSnapshot?.bid || marketSnapshot?.ask || position.mark_price || entryPrice
  );
  const currentPnlPct = pnlPctFor(side, entryPrice, currentPrice);

  const favorablePriceSeen = determineFavorablePrice(
    side,
    currentPrice,
    marketSnapshot?.micro_high,
    marketSnapshot?.micro_low,
    previous.peak_price_seen
  );
  const adversePriceSeen = determineAdversePrice(
    side,
    currentPrice,
    marketSnapshot?.micro_high,
    marketSnapshot?.micro_low,
    previous.trough_price_seen
  );

  const previousMaxPnl = Number.isFinite(Number(previous.max_pnl_pct))
    ? Number(previous.max_pnl_pct)
    : currentPnlPct;
  const previousMinPnl = Number.isFinite(Number(previous.min_pnl_pct))
    ? Number(previous.min_pnl_pct)
    : currentPnlPct;

  const maxPnlPct = Math.max(previousMaxPnl, pnlPctFor(side, entryPrice, favorablePriceSeen), currentPnlPct);
  const minPnlPct = Math.min(previousMinPnl, pnlPctFor(side, entryPrice, adversePriceSeen), currentPnlPct);
  const newPositiveExtreme = maxPnlPct > previousMaxPnl + 0.005 && maxPnlPct > 0;
  const newExtremeCount = Number(previous.new_extreme_count || 0) + (newPositiveExtreme ? 1 : 0);
  const latestNewExtremeAt = newPositiveExtreme
    ? new Date(now).toISOString()
    : (previous.latest_new_extreme_at || null);

  const timeToFirstExpansionMs =
    previous.time_to_first_expansion_ms != null
      ? Number(previous.time_to_first_expansion_ms)
      : maxPnlPct >= lifecycleConfig.ignition_expansion_pct
        ? elapsedMs
        : null;

  const earlyMfePct =
    elapsedMs <= lifecycleConfig.no_ignition_ms
      ? Math.max(Number(previous.early_mfe_pct || 0), Math.max(maxPnlPct, 0))
      : Number(previous.early_mfe_pct || Math.max(maxPnlPct, 0));
  const earlyMaePct =
    elapsedMs <= lifecycleConfig.no_ignition_ms
      ? Math.min(Number(previous.early_mae_pct || 0), Math.min(minPnlPct, 0))
      : Number(previous.early_mae_pct || Math.min(minPnlPct, 0));

  const lastUpdatedAtMs = Number(previous.lifecycle_last_updated_at_ms || openedAtMs || now);
  const stallDurationMs = newPositiveExtreme
    ? 0
    : Math.max(0, Number(previous.stall_duration_ms || 0) + Math.max(0, now - lastUpdatedAtMs));

  const { velocity, acceleration, imbalance, spread_bps: spreadBps } = summarizeMicrostructure(marketSnapshot);
  const pullbackFromPeakPct = Math.max(0, maxPnlPct - currentPnlPct);
  const structuralImprovement =
    timeToFirstExpansionMs != null ||
    maxPnlPct >= lifecycleConfig.ignition_expansion_pct ||
    newExtremeCount >= lifecycleConfig.expansion_min_new_extremes;

  const { positiveSignals, negativeSignals } = buildSignalScores({
    lifecycleConfig,
    currentPnlPct,
    maxPnlPct,
    newPositiveExtreme,
    stallDurationMs,
    pullbackFromPeakPct,
    velocity,
    acceleration,
    imbalance,
    structuralImprovement
  });

  const decayScore = clamp(
    (pullbackFromPeakPct / Math.max(lifecycleConfig.severe_pullback_pct, 0.01)) * 0.35 +
      (stallDurationMs / Math.max(lifecycleConfig.stall_ms, 1000)) * 0.25 +
      (negativeSignals / 6) * 0.25 +
      (velocity < 0 ? Math.min(Math.abs(velocity) / 25, 1) * 0.1 : 0) +
      (acceleration < 0 ? Math.min(Math.abs(acceleration) / 15, 1) * 0.05 : 0),
    0,
    1
  );

  const expansionConfirmed =
    structuralImprovement &&
    (maxPnlPct >= lifecycleConfig.expansion_min_pnl_pct ||
      newExtremeCount >= lifecycleConfig.expansion_min_new_extremes ||
      positiveSignals >= lifecycleConfig.evaluation_positive_signal_threshold);

  const msSinceFirstExpansion =
    timeToFirstExpansionMs != null
      ? Math.max(0, elapsedMs - Number(timeToFirstExpansionMs))
      : null;
  const expansionGuardActive = Boolean(
    expansionConfirmed &&
      (
        msSinceFirstExpansion == null ||
        msSinceFirstExpansion <= lifecycleConfig.expansion_hold_ms ||
        newPositiveExtreme ||
        positiveSignals >= negativeSignals
      )
  );
  const noIgnitionAccumulated =
    !expansionConfirmed &&
    elapsedMs >= lifecycleConfig.no_ignition_ms &&
    negativeSignals >= lifecycleConfig.no_ignition_min_negative_signals &&
    positiveSignals <= 1 &&
    !structuralImprovement &&
    newExtremeCount < 1 &&
    Math.abs(velocity) <= lifecycleConfig.no_ignition_velocity_ceiling_bps_per_sec &&
    imbalance <= lifecycleConfig.no_ignition_imbalance_ceiling &&
    stallDurationMs >= lifecycleConfig.stall_ms * lifecycleConfig.no_ignition_required_stall_ratio;
  const strongDeterioration =
    (expansionConfirmed && pullbackFromPeakPct >= lifecycleConfig.deterioration_pullback_pct) ||
    decayScore >= lifecycleConfig.decay_threshold ||
    (stallDurationMs >= lifecycleConfig.stall_ms &&
      negativeSignals >= lifecycleConfig.deterioration_negative_signal_threshold);

  let impulseState = 'evaluation';
  let impulseStateReason = 'structured_evaluation';

  if (elapsedMs < lifecycleConfig.incubation_ms) {
    impulseState = 'incubation';
    impulseStateReason = 'minimum_observation_window';
  } else if (expansionConfirmed && expansionGuardActive) {
    impulseState = 'expansion';
    impulseStateReason = newPositiveExtreme ? 'new_extreme_continuity' : 'expansion_confirmed';
  } else if (strongDeterioration) {
    impulseState = 'deterioration';
    if (
      stallDurationMs >= lifecycleConfig.stall_ms &&
      negativeSignals >= lifecycleConfig.deterioration_negative_signal_threshold
    ) {
      impulseStateReason = 'stall_confirmed';
    } else if (currentPnlPct <= 0 && pullbackFromPeakPct >= lifecycleConfig.severe_pullback_pct) {
      impulseStateReason = 'impulse_dead_after_decay';
    } else {
      impulseStateReason = 'strong_deterioration';
    }
  } else if (noIgnitionAccumulated) {
    impulseState = 'evaluation';
    impulseStateReason = 'no_ignition_accumulated';
  } else if (expansionConfirmed) {
    impulseState = 'evaluation';
    impulseStateReason = 'post_expansion_reassessment';
  }

  const legacyState = resolveLegacyState(impulseState, impulseStateReason, currentPnlPct);
  const timeline = appendTimelineEntry(previous.impulse_state_timeline, {
    state: impulseState,
    reason: impulseStateReason,
    at: new Date(now).toISOString(),
    pnl_pct: Number(currentPnlPct.toFixed(4)),
    price: Number(currentPrice.toFixed(8))
  });

  return {
    ...previous,
    enabled: lifecycleConfig.enabled,
    mode: lifecycleConfig.mode,
    impulse_state: impulseState,
    impulse_state_reason: impulseStateReason,
    impulse_state_legacy: legacyState,
    lifecycle_phase: impulseState,
    incubation_completed: elapsedMs >= lifecycleConfig.incubation_ms,
    evaluation_elapsed_ms: Math.max(0, elapsedMs - lifecycleConfig.incubation_ms),
    time_to_first_expansion_ms: timeToFirstExpansionMs,
    ms_since_first_expansion: msSinceFirstExpansion,
    expansion_confirmed: expansionConfirmed,
    expansion_guard_active: expansionGuardActive,
    structural_improvement: structuralImprovement,
    positive_signal_count: positiveSignals,
    negative_signal_count: negativeSignals,
    no_ignition_eligible: noIgnitionAccumulated,
    early_mfe_pct: Number(earlyMfePct.toFixed(4)),
    early_mae_pct: Number(earlyMaePct.toFixed(4)),
    max_pnl_pct: Number(maxPnlPct.toFixed(4)),
    min_pnl_pct: Number(minPnlPct.toFixed(4)),
    peak_price_seen: Number(favorablePriceSeen.toFixed(8)),
    trough_price_seen: Number(adversePriceSeen.toFixed(8)),
    pullback_from_peak_pct: Number(pullbackFromPeakPct.toFixed(4)),
    stall_duration_ms: Math.round(stallDurationMs),
    momentum_decay_score: Number(decayScore.toFixed(4)),
    new_extreme_count: newExtremeCount,
    new_positive_extreme: newPositiveExtreme,
    latest_new_extreme_at: latestNewExtremeAt,
    last_micro_price: Number(currentPrice.toFixed(8)),
    lifecycle_last_updated_at: new Date(now).toISOString(),
    lifecycle_last_updated_at_ms: now,
    observation_snapshot: marketSnapshot
      ? {
          spread_bps: spreadBps,
          trade_flow_imbalance: Number.isFinite(imbalance) ? Number(imbalance.toFixed(4)) : null,
          price_velocity_bps_per_sec: Number.isFinite(velocity) ? Number(velocity.toFixed(4)) : null,
          price_acceleration_bps_per_sec2: Number.isFinite(acceleration) ? Number(acceleration.toFixed(4)) : null
        }
      : null,
    impulse_state_timeline: timeline
  };
}

module.exports = {
  pnlPctFor,
  resolveLifecycleConfig,
  updateImpulseLifecycle
};
