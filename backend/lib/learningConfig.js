const db = require('../firebase-admin-config');

const CACHE_TTL_MS = 3 * 60 * 1000;
const cache = new Map();
const inFlightLoads = new Map();

const fallbackScopes = [
  (symbol, mode, timeframe) => [symbol, mode, timeframe],
  (symbol, mode) => [symbol, mode, 'any'],
  () => ['GLOBAL', 'timeframe', 'any']
];

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);

const normalizeKey = (symbol, mode, timeframe) => `${symbol}|${mode}|${timeframe}`;

async function queryScopeConfig(symbol, mode, timeframe, scopeTuple) {
  const [s, m, t] = scopeTuple;
  try {
    const snapshot = await db
      .collection('velas_learning_config')
      .where('scope.symbol', '==', s)
      .where('scope.mode', '==', m)
      .where('scope.timeframe', '==', t)
      .orderBy('version', 'desc')
      .limit(1)
      .get();
    if (!snapshot.empty) {
      const doc = snapshot.docs[0];
      return {
        id: doc.id,
        version: doc.data().version,
        scope: doc.data().scope,
        metrics: doc.data().metrics
      };
    }
  } catch (err) {
    console.warn('learningConfig load failed', {
      symbol,
      mode,
      timeframe,
      scope: scopeTuple,
      message: err.message
    });
  }
  return null;
}

const loadConfig = async (symbol, mode, timeframe) => {
  const key = normalizeKey(symbol, mode, timeframe);
  const cached = cache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) {
    return cached.config;
  }

  if (inFlightLoads.has(key)) {
    return inFlightLoads.get(key);
  }

  const loadPromise = (async () => {
    const scopes = fallbackScopes.map((fallback) => fallback(symbol, mode, timeframe));
    const matches = await Promise.all(
      scopes.map((scopeTuple) => queryScopeConfig(symbol, mode, timeframe, scopeTuple))
    );
    const config = matches.find(Boolean) || null;
    cache.set(key, { fetchedAt: Date.now(), config });
    return config;
  })().finally(() => {
    inFlightLoads.delete(key);
  });

  inFlightLoads.set(key, loadPromise);
  return loadPromise;
};

const deriveAdjustments = (metrics) => {
  if (!metrics) return null;
  const winDiff = (metrics.win_rate ?? 0) - 50;
  const confidenceAdj = clamp(winDiff / 100, -0.15, 0.05);
  const quantumAdj = clamp(((metrics.avg_quantum_score ?? 0) - 0.5) * 0.2, -0.15, 0.05);
  const timingAdj = clamp(((metrics.avg_timing_score ?? 0) - 0.5) * 0.15, -0.15, 0.05);
  return {
    confidenceAdj,
    quantumAdj,
    timingAdj
  };
};

const buildAdjData = (adj) => ({
  confidence_factor: adj.confidenceAdj,
  quantum_modifier: adj.quantumAdj,
  timing_modifier: adj.timingAdj
});

const preloadLearningConfig = (symbol, mode, timeframe) => loadConfig(symbol, mode, timeframe);

const applyLearningAdjustments = async (symbol, mode, timeframe, scores, options = {}) => {
  const config = options.preloadedConfig !== undefined
    ? options.preloadedConfig
    : await loadConfig(symbol, mode, timeframe);
  if (!config || !config.metrics) {
    return {
      ...scores,
      learning: null
    };
  }
  const adjustments = deriveAdjustments(config.metrics);
  if (!adjustments) {
    return {
      ...scores,
      learning: null
    };
  }
  const calibrated = {
    confidence: clamp(scores.confidence + adjustments.confidenceAdj, 0.05, 0.99),
    quantumScore: clamp(scores.quantumScore + adjustments.quantumAdj, 0.05, 0.99),
    timingScore: clamp(scores.timingScore + adjustments.timingAdj, 0, 1)
  };
  return {
    ...calibrated,
    learning: {
      version: config.version,
      scope: config.scope,
      adjustments: buildAdjData(adjustments)
    }
  };
};

module.exports = {
  applyLearningAdjustments,
  preloadLearningConfig
};
