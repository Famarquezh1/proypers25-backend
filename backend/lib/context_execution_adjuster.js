/**
 * Execution tuning layer (optional/reversible).
 * Applies TP/SL adjustments after model decision, without touching scoring engines.
 */

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function roundForPrice(value, entryPrice) {
  const entry = toNumber(entryPrice) || 0;
  if (!Number.isFinite(value)) return value;
  let decimals = 2;
  if (entry > 0 && entry < 1) decimals = 6;
  else if (entry > 0 && entry < 100) decimals = 4;
  return Number(Number(value).toFixed(decimals));
}

function getTpMultiplier(contextScore) {
  if (contextScore === 2) return 0.8;
  if (contextScore === 3) return 1.0;
  if (contextScore === 4) return 1.3;
  return 1.0;
}

function adjustExecutionTargets(signal, contextMetrics) {
  const entryPrice = toNumber(signal?.entry_price);
  const baseTp = toNumber(signal?.base_tp);
  const baseSl = toNumber(signal?.base_sl);
  const direction = signal?.direction;

  const contextScore = Number(contextMetrics?.context_score || 0);
  const volatilityExpansionRatio = Number(contextMetrics?.volatility_expansion_ratio || 0);
  const relativeVolume = Number(contextMetrics?.relative_volume || 0);
  const volumeAcceleration = Number(contextMetrics?.volume_acceleration || 0);

  // Return passthrough if the plan is incomplete or direction is neutral.
  if (
    !entryPrice ||
    !baseTp ||
    !baseSl ||
    (direction !== 'up' && direction !== 'down')
  ) {
    return {
      base_tp: baseTp,
      adjusted_tp: baseTp,
      base_sl: baseSl,
      adjusted_sl: baseSl,
      tp_multiplier: 1,
      context_score: contextScore,
      volatility_expansion_ratio: volatilityExpansionRatio,
      relative_volume: relativeVolume,
      volume_acceleration: volumeAcceleration,
      applied: false,
      reason: 'invalid_trade_plan'
    };
  }

  let tpMultiplier = getTpMultiplier(contextScore);
  if (volatilityExpansionRatio > 1.4) {
    tpMultiplier *= 1.2;
  }

  // TP adjustment is applied over the TP distance from entry, not over absolute price.
  const tpDistance = Math.abs(baseTp - entryPrice);
  const adjustedTpDistance = tpDistance * tpMultiplier;
  const adjustedTpRaw =
    direction === 'up'
      ? entryPrice + adjustedTpDistance
      : entryPrice - adjustedTpDistance;

  // Tighten SL only on very strong context.
  let adjustedSlRaw = baseSl;
  if (contextScore === 4 && relativeVolume > 2.0) {
    const slDistance = Math.abs(entryPrice - baseSl);
    const tightenedDistance = slDistance * 0.9;
    adjustedSlRaw =
      direction === 'up'
        ? entryPrice - tightenedDistance
        : entryPrice + tightenedDistance;
  }

  return {
    base_tp: roundForPrice(baseTp, entryPrice),
    adjusted_tp: roundForPrice(adjustedTpRaw, entryPrice),
    base_sl: roundForPrice(baseSl, entryPrice),
    adjusted_sl: roundForPrice(adjustedSlRaw, entryPrice),
    tp_multiplier: Number(tpMultiplier.toFixed(4)),
    context_score: contextScore,
    volatility_expansion_ratio: Number(volatilityExpansionRatio.toFixed(4)),
    relative_volume: Number(relativeVolume.toFixed(4)),
    volume_acceleration: Number(volumeAcceleration.toFixed(4)),
    applied: true
  };
}

module.exports = {
  adjustExecutionTargets
};

