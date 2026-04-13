const DEFAULTS = {
  early_followthrough_ratio: 0.3,
  early_followthrough_min_progress: 0.2,
  trailing_trigger_min: 0.4,
  trailing_trigger_max: 0.6,
  micro_pullback_pct: 0.004,
  momentum_loss_streak: 3
};

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function resolveHorizonSeconds(signal) {
  const minutes = Number(signal?.timeframe_minutes || signal?.timeframeMinutes || 0);
  if (Number.isFinite(minutes) && minutes > 0) {
    return Math.max(60, minutes * 60);
  }
  return 300;
}

function resolveEntryPrice(signal = {}) {
  const tradePlan = signal.trade_plan || signal.tradePlan || {};
  return Number(tradePlan.entry_price ?? signal.entry_price ?? signal.spot_price ?? 0) || null;
}

function resolveTargetPrice(signal = {}) {
  const tradePlan = signal.trade_plan || signal.tradePlan || {};
  return Number(
    tradePlan.take_profit ??
      tradePlan.target_exit_price ??
      tradePlan.tp_price ??
      signal.tp_price ??
      0
  ) || null;
}

function resolveCurrentPrice(snapshot = {}) {
  return Number(snapshot.last_price ?? snapshot.price ?? snapshot.mark_price ?? 0) || null;
}

function resolveVolatilityPct(snapshot = {}) {
  const raw = snapshot.volatility_pct ?? snapshot.recent_volatility_pct ?? snapshot.price_volatility_pct ?? null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

function computeTrailingBufferPct(progress, volatilityPct) {
  const base = Number.isFinite(volatilityPct) ? Math.max(0.002, Math.min(volatilityPct / 2, 0.012)) : 0.004;
  if (!Number.isFinite(progress)) return base;
  if (progress >= 0.55) return Math.max(0.002, base * 0.8);
  if (progress >= 0.45) return base;
  return Math.min(0.015, base * 1.2);
}

function computeProgressToTarget(entry, target, current) {
  if (!entry || !target || !current) return null;
  const total = Math.abs(target - entry);
  if (total <= 0) return null;
  const progress = Math.abs(current - entry) / total;
  return clamp(progress, 0, 2);
}

function computeMomentumLoss(snapshot = {}, history = []) {
  const velocity = Number(snapshot.price_velocity_bps_per_sec ?? snapshot.velocity ?? 0);
  const acceleration = Number(snapshot.price_acceleration_bps_per_sec2 ?? snapshot.acceleration ?? 0);
  let negativeStreak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (Number(history[i]) < 0) negativeStreak += 1;
    else break;
  }
  return {
    velocity,
    acceleration,
    negativeStreak
  };
}

function evaluateExitIntelligence(signal = {}, snapshot = {}, context = {}) {
  const now = context.now || new Date();
  const createdAt = new Date(signal.created_at || signal.timestamp || signal.generated_at || now);
  const horizonSeconds = resolveHorizonSeconds(signal);
  const elapsedSeconds = Math.max(0, (now.getTime() - createdAt.getTime()) / 1000);
  const entryPrice = resolveEntryPrice(signal);
  const targetPrice = resolveTargetPrice(signal);
  const currentPrice = resolveCurrentPrice(snapshot);
  const volatilityPct = resolveVolatilityPct(snapshot);
  const progress = computeProgressToTarget(entryPrice, targetPrice, currentPrice);

  const followThroughGate = horizonSeconds * DEFAULTS.early_followthrough_ratio;
  const earlyFollowThrough =
    elapsedSeconds >= followThroughGate && progress != null && progress < DEFAULTS.early_followthrough_min_progress;

  const velocityHistory = Array.isArray(snapshot.velocity_history || snapshot.velocity_history_points)
    ? snapshot.velocity_history
    : [];
  const momentum = computeMomentumLoss(snapshot, velocityHistory);
  const microPullback =
    Number(snapshot.pullback_from_peak_pct ?? snapshot.pullback_pct ?? 0) || 0;

  if (earlyFollowThrough) {
    return {
      exit_signal: true,
      exit_reason: 'no_followthrough',
      urgency: 'high',
      urgency_level: 'high',
      suggested_action: 'full_exit',
      meta: {
        elapsed_seconds: Math.round(elapsedSeconds),
        progress_to_target: progress
      }
    };
  }

  if (
    momentum.negativeStreak >= DEFAULTS.momentum_loss_streak &&
    microPullback >= DEFAULTS.micro_pullback_pct
  ) {
    return {
      exit_signal: true,
      exit_reason: 'momentum_loss',
      urgency: 'high',
      urgency_level: 'high',
      suggested_action: 'partial_exit',
      meta: {
        negative_streak: momentum.negativeStreak,
        pullback_pct: microPullback
      }
    };
  }

  if (progress != null && progress >= DEFAULTS.trailing_trigger_min && progress <= DEFAULTS.trailing_trigger_max) {
    const bufferPct = computeTrailingBufferPct(progress, volatilityPct);
    const trailingStop = currentPrice ? currentPrice * (1 - bufferPct) : null;
    return {
      exit_signal: true,
      exit_reason: 'trailing_dynamic',
      urgency: 'low',
      urgency_level: 'low',
      suggested_action: 'hold',
      meta: {
        progress_to_target: progress,
        trailing_buffer_pct: Number(bufferPct.toFixed(4)),
        trailing_stop: trailingStop ? Number(trailingStop.toFixed(6)) : null
      }
    };
  }

  if (elapsedSeconds >= horizonSeconds) {
    return {
      exit_signal: true,
      exit_reason: 'time_expired',
      urgency: 'high',
      urgency_level: 'high',
      suggested_action: 'full_exit',
      meta: {
        elapsed_seconds: Math.round(elapsedSeconds),
        horizon_seconds: horizonSeconds
      }
    };
  }

  return {
    exit_signal: false,
    exit_reason: 'hold',
    urgency: 'low',
    urgency_level: 'low',
    suggested_action: 'hold',
    meta: {
      elapsed_seconds: Math.round(elapsedSeconds),
      progress_to_target: progress
    }
  };
}

module.exports = {
  evaluateExitIntelligence,
  evaluateExit: evaluateExitIntelligence
};
