function clamp(value, min = 0, max = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, n));
}

const SIGNAL_RANKING_ENABLED = String(process.env.SIGNAL_RANKING_ENABLED || 'true').toLowerCase() !== 'false';

function resolveWeights() {
  const defaults = {
    confidence: 0.18,
    quantum: 0.1,
    timing: 0.1,
    stability: 0.1,
    context_score: 0.08,
    context_quality: 0.1,
    momentum: 0.08,
    acceleration: 0.06,
    volume_signal: 0.08,
    structural_context_score: 0.08,
    volatility_context_score: 0.08,
    volume_flow_context_score: 0.07,
    liquidity_context_score: 0.07
  };

  if (!process.env.SIGNAL_RANKING_WEIGHTS_JSON) {
    return defaults;
  }

  try {
    const parsed = JSON.parse(process.env.SIGNAL_RANKING_WEIGHTS_JSON);
    const merged = { ...defaults };
    Object.keys(defaults).forEach((key) => {
      const candidate = Number(parsed?.[key]);
      if (Number.isFinite(candidate) && candidate >= 0) {
        merged[key] = candidate;
      }
    });
    return merged;
  } catch (_err) {
    return defaults;
  }
}

const RANKING_WEIGHTS = resolveWeights();

function normalizePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function normalizeContextScore(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 4) return clamp(raw / 4);
  return clamp(raw / 100);
}

function computeFallbackStability(confidenceRaw, quantumRaw, timingRaw) {
  const confidence = normalizePercent(confidenceRaw);
  const quantum = normalizePercent(quantumRaw);
  const timing = normalizePercent(timingRaw);
  const avg = (confidence + quantum + timing) / 3;
  const dispersion =
    (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
  return clamp(avg * (1 - Math.min(dispersion, 0.5)));
}

function normalizeMomentum(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return clamp(raw > 1 ? raw / 1.2 : raw);
}

function normalizeAcceleration(value) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  return clamp(raw > 1 ? raw / 1.5 : raw);
}

function normalizeVolumeSignal(signal) {
  const volumeSpike = Number(signal?.impulse_metrics?.volume_spike ?? signal?.volume_signal ?? NaN);
  if (Number.isFinite(volumeSpike)) {
    return clamp(volumeSpike > 1 ? volumeSpike / 2 : volumeSpike);
  }
  const relativeVolume = Number(signal?.relative_volume ?? signal?.event_context_filter?.metrics?.relative_volume ?? NaN);
  if (Number.isFinite(relativeVolume) && relativeVolume > 0) {
    return clamp(relativeVolume / 2);
  }
  return 0;
}

function normalizeContinuousScore(value, maxNative = 100) {
  const raw = Number(value ?? 0);
  if (!Number.isFinite(raw)) return 0;
  if (raw <= 1) return clamp(raw);
  return clamp(raw / maxNative);
}

function resolveRegime(signal = {}) {
  return (
    signal.regime ||
    signal.market_regime ||
    signal.event_context_filter?.regime ||
    'unknown'
  );
}

function resolveOperable(signal = {}) {
  return Boolean(
    signal.allow_event ??
      signal.is_top_signal ??
      signal.signal_emitted ??
      signal.event_context_filter?.allow_event ??
      false
  );
}

function computeSignalRanking(signal = {}) {
  if (!SIGNAL_RANKING_ENABLED) {
    return {
      signal_ranking_score: null,
      ranking_percentile: null,
      is_ranked_operable: false,
      ranking_components: {},
      ranking_enabled: false
    };
  }

  const confidence = normalizePercent(signal?.confidence_after ?? signal?.confidence ?? signal?.confianza);
  const timing = normalizePercent(signal?.timing_score ?? signal?.timing);
  const quantum = normalizePercent(signal?.quantum_score ?? signal?.quantum);
  const stability = normalizePercent(
    signal?.stability != null ? signal.stability : computeFallbackStability(confidence, quantum, timing)
  );
  const contextScore = normalizeContextScore(signal?.context_score ?? signal?.event_context_filter?.context_score);
  const contextQuality = normalizeContinuousScore(
    signal?.context_quality ?? signal?.event_context_filter?.context_quality,
    100
  );
  const momentum = normalizeMomentum(signal?.momentum ?? signal?.impulse_metrics?.momentum);
  const acceleration = normalizeAcceleration(signal?.acceleration ?? signal?.impulse_metrics?.acceleration);
  const volumeSignal = normalizeVolumeSignal(signal);
  const structuralContextScore = normalizeContinuousScore(
    signal?.structural_context_score ?? signal?.event_context_filter?.structural_context_score
  );
  const volatilityContextScore = normalizeContinuousScore(
    signal?.volatility_context_score ?? signal?.event_context_filter?.volatility_context_score
  );
  const volumeFlowContextScore = normalizeContinuousScore(
    signal?.volume_flow_context_score ?? signal?.event_context_filter?.volume_flow_context_score
  );
  const liquidityContextScore = normalizeContinuousScore(
    signal?.liquidity_context_score ?? signal?.event_context_filter?.liquidity_context_score
  );

  const rawScore =
    RANKING_WEIGHTS.confidence * confidence +
    RANKING_WEIGHTS.quantum * quantum +
    RANKING_WEIGHTS.timing * timing +
    RANKING_WEIGHTS.stability * stability +
    RANKING_WEIGHTS.context_score * contextScore +
    RANKING_WEIGHTS.context_quality * contextQuality +
    RANKING_WEIGHTS.momentum * momentum +
    RANKING_WEIGHTS.acceleration * acceleration +
    RANKING_WEIGHTS.volume_signal * volumeSignal +
    RANKING_WEIGHTS.structural_context_score * structuralContextScore +
    RANKING_WEIGHTS.volatility_context_score * volatilityContextScore +
    RANKING_WEIGHTS.volume_flow_context_score * volumeFlowContextScore +
    RANKING_WEIGHTS.liquidity_context_score * liquidityContextScore;

  return {
    signal_ranking_score: Math.round(clamp(rawScore) * 1000) / 10,
    ranking_percentile: null,
    is_ranked_operable: resolveOperable(signal),
    ranking_enabled: true,
    ranking_regime: resolveRegime(signal),
    ranking_components: {
      confidence,
      quantum,
      context_score: contextScore,
      context_quality: contextQuality,
      timing,
      stability,
      momentum,
      acceleration,
      volume_signal: volumeSignal,
      structural_context_score: structuralContextScore,
      volatility_context_score: volatilityContextScore,
      volume_flow_context_score: volumeFlowContextScore,
      liquidity_context_score: liquidityContextScore
    }
  };
}

function selectTopSignals(signals = [], options = {}) {
  if (!SIGNAL_RANKING_ENABLED) {
    return signals.map((signal) => ({
      ...signal,
      signal_ranking_score: null,
      ranking_percentile: null,
      is_top_signal: false,
      top_signal_flag: false,
      is_top_signal_global: false,
      is_top_signal_symbol: false,
      is_top_signal_regime: false,
      is_ranked_operable: false,
      ranking_enabled: false,
      ranking_position_global: null
    }));
  }

  const topPerSymbol = Math.max(1, Number(options.topPerSymbol || 3));
  const topGlobal = Math.max(1, Number(options.topGlobal || 5));
  const topPerRegime = Math.max(1, Number(options.topPerRegime || 5));

  const enriched = signals.map((signal) => ({
    ...signal,
    ...computeSignalRanking(signal)
  }));

  const sortedGlobal = [...enriched].sort(
    (a, b) =>
      (b.signal_ranking_score || 0) - (a.signal_ranking_score || 0) ||
      String(b.created_at || b.timestamp || '').localeCompare(String(a.created_at || a.timestamp || ''))
  );

  const topGlobalIds = new Set(
    sortedGlobal
      .slice(0, topGlobal)
      .map((signal) => signal.id || signal.prediction_id || `${signal.simbolo || signal.symbol}-${signal.timestamp || signal.created_at}`)
  );

  const symbolBuckets = enriched.reduce((acc, signal) => {
    const symbol = signal.simbolo || signal.symbol || 'UNKNOWN';
    if (!acc[symbol]) acc[symbol] = [];
    acc[symbol].push(signal);
    return acc;
  }, {});

  const topSymbolIds = new Set();
  Object.values(symbolBuckets).forEach((bucket) => {
    bucket
      .sort((a, b) => (b.signal_ranking_score || 0) - (a.signal_ranking_score || 0))
      .slice(0, topPerSymbol)
      .forEach((signal) => {
        topSymbolIds.add(
          signal.id || signal.prediction_id || `${signal.simbolo || signal.symbol}-${signal.timestamp || signal.created_at}`
        );
      });
  });

  const regimeBuckets = enriched.reduce((acc, signal) => {
    const regime = signal.ranking_regime || 'unknown';
    if (!acc[regime]) acc[regime] = [];
    acc[regime].push(signal);
    return acc;
  }, {});

  const topRegimeIds = new Set();
  Object.values(regimeBuckets).forEach((bucket) => {
    bucket
      .sort((a, b) => (b.signal_ranking_score || 0) - (a.signal_ranking_score || 0))
      .slice(0, topPerRegime)
      .forEach((signal) => {
        topRegimeIds.add(
          signal.id || signal.prediction_id || `${signal.simbolo || signal.symbol}-${signal.timestamp || signal.created_at}`
        );
      });
  });

  return sortedGlobal.map((signal, index) => {
    const signalId =
      signal.id || signal.prediction_id || `${signal.simbolo || signal.symbol}-${signal.timestamp || signal.created_at}`;
    const isTopGlobal = topGlobalIds.has(signalId);
    const isTopSymbol = topSymbolIds.has(signalId);
    const isTopRegime = topRegimeIds.has(signalId);
    const rankingPercentile =
      sortedGlobal.length > 1
        ? Math.round((1 - index / (sortedGlobal.length - 1)) * 1000) / 10
        : 100;
    return {
      ...signal,
      ranking_percentile: rankingPercentile,
      is_top_signal: isTopGlobal || isTopSymbol || isTopRegime,
      top_signal_flag: isTopGlobal || isTopSymbol || isTopRegime,
      is_top_signal_global: isTopGlobal,
      is_top_signal_symbol: isTopSymbol,
      is_top_signal_regime: isTopRegime,
      is_ranked_operable: Boolean(signal.is_ranked_operable && rankingPercentile >= 60),
      ranking_enabled: true,
      ranking_position_global: index + 1
    };
  });
}

module.exports = {
  SIGNAL_RANKING_ENABLED,
  RANKING_WEIGHTS,
  computeSignalRanking,
  selectTopSignals
};
