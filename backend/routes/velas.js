const express = require('express');
const router = express.Router();
const entrenarVelas = require('../scripts/entrenamientoVelas');
const prediccionVelas = require('../scripts/prediccionVelas');
const verificarPrediccionVelas = require('../scripts/verificacionVelas');
const { run: runSignalIntelligenceAudit } = require('../scripts/audit-signal-intelligence');
const { run: runSuppressedValidationAudit } = require('../scripts/validate-suppressed-signals');
const { run: runExecutionVsModelAudit } = require('../scripts/execution-vs-model-audit');
const {
  SIGNAL_RANKING_ENABLED,
  RANKING_WEIGHTS,
  computeSignalRanking,
  selectTopSignals
} = require('../lib/signal_ranking_engine');
const {
  ADAPTIVE_CALIBRATION_ENABLED,
  getAdaptiveSystemProfiles
} = require('../lib/adaptive_calibration_engine');
const {
  getSignalIntelligenceDashboardSnapshot
} = require('../lib/signalIntelligenceDashboard');
const {
  STATISTICAL_LEARNING_ENABLED,
  getStatisticalLearningSnapshot
} = require('../lib/statisticalLearningEngine');
const {
  EXECUTION_DISCIPLINE_ENABLED,
  getExecutionDisciplineSummary
} = require('../lib/execution_discipline_engine');
const { fetchBinanceSpot } = require('../services/dataSources/binance');
const { executeSignalTrade, getMarkPrice, toBinanceSymbol } = require('../lib/binanceFuturesExecutor');
const db = require('../firebase-admin-config');
const FieldValue = require('firebase-admin').firestore.FieldValue;

const SIMBOLOS_VELAS = [
  'BTC-USD',
  'ETH-USD',
  'DOGE-USD',
  'HBAR-USD',
  'SOL-USD',
  'ADA-USD',
  'XRP-USD',
  'BNB-USD',
  'AVAX-USD',
  'LINK-USD',
  'MATIC-USD',
  'DOT-USD',
  'LTC-USD',
  'BCH-USD',
  'TRX-USD',
  'SHIB-USD',
  'TON-USD',
  'NEAR-USD',
  'ATOM-USD',
  'ICP-USD',
  'XLM-USD',
  'OP-USD',
  'ARB-USD',
  'INJ-USD',
  'APT-USD'
];
const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h'];

const handleError = (res, err, message = 'Error interno') => {
  console.error(message, err);
  res.status(500).json({ error: message });
};

const CRON_SECRET = process.env.CRON_SECRET || '';
const SIGNAL_INTEL_CACHE_TTL_MS = Math.max(60 * 1000, Number(process.env.SIGNAL_INTEL_CACHE_TTL_MS || 10 * 60 * 1000));
let signalIntelCache = {
  fetchedAt: 0,
  payload: null,
  inFlight: null
};
const SUPPRESSED_VALIDATION_CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.SUPPRESSED_VALIDATION_CACHE_TTL_MS || 10 * 60 * 1000)
);
let suppressedValidationCache = {
  fetchedAt: 0,
  payload: null,
  inFlight: null
};
const EXECUTION_AUDIT_CACHE_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.EXECUTION_AUDIT_CACHE_TTL_MS || 10 * 60 * 1000)
);
let executionAuditCache = {
  fetchedAt: 0,
  payload: null,
  inFlight: null
};
const SUPPRESSED_VALIDATION_ENABLED =
  String(process.env.SUPPRESSED_VALIDATION_ENABLED || 'true').toLowerCase() !== 'false';
const EXECUTION_INTELLIGENCE_ENABLED =
  String(process.env.EXECUTION_INTELLIGENCE_ENABLED || 'true').toLowerCase() !== 'false';

function signalIdentifier(signal = {}) {
  return (
    signal.id ||
    signal.prediction_id ||
    `${signal.simbolo || signal.symbol || 'UNKNOWN'}-${signal.timestamp || signal.created_at || Date.now()}`
  );
}

function decorateSignalsWithRanking(signals = [], options = {}) {
  return selectTopSignals(signals, options).map((signal) => ({
    ...signal,
    signal_id: signalIdentifier(signal)
  }));
}

async function loadRecentRankableSignals(limit = 160) {
  const snapshot = await db.collection('velas_predicciones').orderBy('timestamp', 'desc').limit(limit).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((signal) => signal?.signal_emitted === true);
}

function summarizeRankedSignals(signals = []) {
  return signals.slice(0, 12).map((signal) => ({
    id: signal.id || null,
    simbolo: signal.simbolo || signal.symbol || 'UNKNOWN',
    timestamp: signal.timestamp || signal.created_at || null,
    direction: signal.direction || 'neutral',
    timeframe: signal.timeframe || 'unknown',
    confidence: signal.confianza ?? signal.confidence ?? null,
    context_score: signal.context_score ?? null,
    context_quality: signal.context_quality ?? signal.event_context_filter?.context_quality ?? null,
    signal_ranking_score: signal.signal_ranking_score ?? null,
    ranking_percentile: signal.ranking_percentile ?? null,
    top_signal_flag: Boolean(signal.top_signal_flag),
    is_top_signal: Boolean(signal.is_top_signal),
    is_top_signal_global: Boolean(signal.is_top_signal_global),
    is_top_signal_symbol: Boolean(signal.is_top_signal_symbol),
    is_top_signal_regime: Boolean(signal.is_top_signal_regime),
    is_ranked_operable: Boolean(signal.is_ranked_operable),
    ranking_regime: signal.ranking_regime || 'unknown',
    ranking_position_global: signal.ranking_position_global ?? null
  }));
}

function summarizeRankingSignals(rankedSignals = []) {
  const globalTop = rankedSignals.filter((signal) => signal.is_top_signal_global).length;
  const symbolTop = rankedSignals.filter((signal) => signal.is_top_signal_symbol).length;
  const regimeTop = rankedSignals.filter((signal) => signal.is_top_signal_regime).length;
  const operable = rankedSignals.filter((signal) => signal.is_ranked_operable).length;
  const percentiles = rankedSignals
    .map((signal) => Number(signal.ranking_percentile))
    .filter((value) => Number.isFinite(value));
  const avgPercentile = percentiles.length
    ? percentiles.reduce((sum, value) => sum + value, 0) / percentiles.length
    : null;

  const byRegime = rankedSignals.reduce((acc, signal) => {
    const regime = signal.ranking_regime || 'unknown';
    if (!acc[regime]) {
      acc[regime] = { total: 0, operable: 0, avg_score: 0 };
    }
    acc[regime].total += 1;
    acc[regime].avg_score += Number(signal.signal_ranking_score || 0);
    if (signal.is_ranked_operable) acc[regime].operable += 1;
    return acc;
  }, {});

  return {
    enabled: SIGNAL_RANKING_ENABLED,
    weights: RANKING_WEIGHTS,
    top_global_count: globalTop,
    top_symbol_count: symbolTop,
    top_regime_count: regimeTop,
    operable_count: operable,
    avg_ranking_percentile: avgPercentile,
    regime_summary: Object.entries(byRegime).map(([regime, data]) => ({
      regime,
      total: data.total,
      operable: data.operable,
      avg_score: data.total ? Math.round((data.avg_score / data.total) * 10) / 10 : null
    }))
  };
}

function summarizeContextIntelligence(report = {}) {
  const contextBuckets = Array.isArray(report?.context_quality_buckets) ? report.context_quality_buckets : [];
  const scoreBuckets = Array.isArray(report?.context_score_buckets) ? report.context_score_buckets : [];
  const bestContextBucket = [...contextBuckets]
    .sort((a, b) => (Number(b?.expectancy || -Infinity) - Number(a?.expectancy || -Infinity)) || (Number(b?.win_rate || 0) - Number(a?.win_rate || 0)))[0] || null;
  const regimePerformance = Object.entries(report?.regime_performance || {}).map(([regime, stats]) => ({
    regime,
    total: Number(stats?.total || 0),
    win_rate: Number(stats?.win_rate ?? 0),
    expectancy: Number(stats?.expectancy?.expectancy ?? 0)
  }));

  return {
    enabled: String(process.env.EVENT_CONTEXT_FILTER_ENABLED || 'false').toLowerCase() === 'true',
    mode: process.env.EVENT_CONTEXT_FILTER_MODE || 'observe',
    best_context_bucket: bestContextBucket
      ? {
          bucket: String(bestContextBucket.bucket || 'unknown'),
          total: Number(bestContextBucket.total || 0),
          win_rate: Number(bestContextBucket.win_rate ?? 0),
          expectancy: Number(bestContextBucket.expectancy ?? 0)
        }
      : null,
    context_quality_buckets: contextBuckets,
    context_score_buckets: scoreBuckets,
    regime_performance: regimePerformance
  };
}

async function buildSignalIntelligenceComposite(report) {
  const recentSignals = await loadRecentRankableSignals(160);
  const rankedSignals = decorateSignalsWithRanking(recentSignals, {
    topPerSymbol: 3,
    topGlobal: 5,
    topPerRegime: 5
  });
  const rankingSummary = summarizeRankingSignals(rankedSignals);
  const adaptiveProfiles = await getAdaptiveSystemProfiles(
    {
      ...report,
      ranked_signals: summarizeRankedSignals(rankedSignals),
      ranking_summary: rankingSummary
    },
    { persist: true }
  );
  return {
    ...report,
    ranked_signals: summarizeRankedSignals(rankedSignals),
    ranking_summary: rankingSummary,
    adaptive_calibration: adaptiveProfiles.execution_profile,
    adaptive_profiles: adaptiveProfiles,
    context_intelligence_summary: summarizeContextIntelligence(report)
  };
}

function requireCronSecret(req, res) {
  if (!CRON_SECRET) {
    res.status(500).json({ error: 'CRON_SECRET no configurado en backend.' });
    return false;
  }
  const incoming = req.get('x-cron-secret') || '';
  if (incoming !== CRON_SECRET) {
    res.status(401).json({ error: 'No autorizado. x-cron-secret inválido.' });
    return false;
  }
  return true;
}

router.get('/disponibles', (_req, res) => {
  res.json({
    symbols: SIMBOLOS_VELAS,
    timeframes: TIMEFRAMES
  });
});

router.get('/audit-signal-intelligence', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const days = Math.max(1, Math.min(365, Number(req.query.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30)));
    const maxDocs = Math.max(1000, Math.min(300000, Number(req.query.maxDocs || process.env.SIGNAL_INTEL_AUDIT_MAX_DOCS || 25000)));
    const now = Date.now();
    const isFresh = signalIntelCache.payload && now - signalIntelCache.fetchedAt < SIGNAL_INTEL_CACHE_TTL_MS;

    if (!refresh && isFresh) {
      return res.json({
        ok: true,
        cached: true,
        fetched_at: new Date(signalIntelCache.fetchedAt).toISOString(),
        report: signalIntelCache.payload
      });
    }

    if (!signalIntelCache.inFlight) {
      signalIntelCache.inFlight = runSignalIntelligenceAudit({
        days,
        maxDocs,
        writeFiles: false
      })
        .then(async (report) => {
          const enrichedReport = await buildSignalIntelligenceComposite(report);
          signalIntelCache.payload = enrichedReport;
          signalIntelCache.fetchedAt = Date.now();
          return enrichedReport;
        })
        .finally(() => {
          signalIntelCache.inFlight = null;
        });
    }

    const report = await signalIntelCache.inFlight;
    return res.json({
      ok: true,
      cached: false,
      fetched_at: new Date(signalIntelCache.fetchedAt).toISOString(),
      report
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'signal_intelligence_audit_failed'
    });
  }
});

router.get('/signal-intelligence-dashboard', async (req, res) => {
  try {
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const days = Math.max(1, Math.min(365, Number(req.query.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30)));
    const maxDocs = Math.max(1000, Math.min(300000, Number(req.query.maxDocs || process.env.SIGNAL_INTEL_AUDIT_MAX_DOCS || 25000)));
    const snapshot = await getSignalIntelligenceDashboardSnapshot({
      refresh,
      days,
      maxDocs,
      suppressedMaxDocs: Math.max(50, Math.min(300000, Number(req.query.suppressedMaxDocs || process.env.AUDIT_MAX_DOCS || 250))),
      executionMaxDocs: Math.max(50, Math.min(300000, Number(req.query.executionMaxDocs || process.env.AUDIT_MAX_DOCS || 250))),
      concurrency: Math.max(1, Math.min(20, Number(req.query.concurrency || process.env.AUDIT_CONCURRENCY || 6))),
      matchWindowMinutes: Math.max(
        1,
        Math.min(30, Number(req.query.matchWindowMinutes || process.env.EXEC_MATCH_WINDOW_MINUTES || 5))
      )
    });

    return res.json({
      ok: true,
      cached: snapshot.cached,
      source: snapshot.source,
      fetched_at: snapshot.payload?.generated_at || new Date().toISOString(),
      snapshot: snapshot.payload
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'signal_intelligence_dashboard_failed'
    });
  }
});

async function respondLearningSection(req, res, sectionName) {
  try {
    if (!STATISTICAL_LEARNING_ENABLED) {
      return res.json({
        ok: true,
        disabled: true,
        report: { enabled: false, reason: 'STATISTICAL_LEARNING_ENABLED=false' }
      });
    }

    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const days = Math.max(1, Math.min(365, Number(req.query.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30)));
    const maxDocs = Math.max(
      1000,
      Math.min(300000, Number(req.query.maxDocs || process.env.STATISTICAL_LEARNING_MAX_DOCS || 25000))
    );
    const snapshot = await getStatisticalLearningSnapshot({ refresh, days, maxDocs });

    return res.json({
      ok: true,
      cached: snapshot.cached,
      source: snapshot.source,
      fetched_at: snapshot.payload?.generated_at || new Date().toISOString(),
      report: sectionName ? snapshot.payload?.[sectionName] || {} : snapshot.payload
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'statistical_learning_failed'
    });
  }
}

router.get('/counterfactual-learning', async (req, res) => respondLearningSection(req, res, 'counterfactual_learning'));
router.get('/expectancy-stability', async (req, res) => respondLearningSection(req, res, 'expectancy_stability'));
router.get('/regime-learning', async (req, res) => respondLearningSection(req, res, 'regime_learning'));
router.get('/alpha-decay', async (req, res) => respondLearningSection(req, res, 'alpha_decay'));
router.get('/confidence-calibration', async (req, res) => respondLearningSection(req, res, 'confidence_calibration'));

router.get('/execution-discipline-summary', async (_req, res) => {
  try {
    if (!EXECUTION_DISCIPLINE_ENABLED) {
      return res.json({
        ok: true,
        disabled: true,
        report: { enabled: false, reason: 'EXECUTION_DISCIPLINE_ENABLED=false' }
      });
    }
    const report = await getExecutionDisciplineSummary(db);
    return res.json({
      ok: true,
      report
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'execution_discipline_summary_failed'
    });
  }
});

router.get('/audit-suppressed-validation', async (req, res) => {
  try {
    if (!SUPPRESSED_VALIDATION_ENABLED) {
      return res.json({
        ok: true,
        disabled: true,
        report: { enabled: false, reason: 'SUPPRESSED_VALIDATION_ENABLED=false' }
      });
    }
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const days = Math.max(1, Math.min(365, Number(req.query.days || process.env.AUDIT_DAYS || 30)));
    const maxDocs = Math.max(50, Math.min(300000, Number(req.query.maxDocs || process.env.AUDIT_MAX_DOCS || 200)));
    const concurrency = Math.max(
      1,
      Math.min(20, Number(req.query.concurrency || process.env.AUDIT_CONCURRENCY || 6))
    );
    const now = Date.now();
    const isFresh =
      suppressedValidationCache.payload &&
      now - suppressedValidationCache.fetchedAt < SUPPRESSED_VALIDATION_CACHE_TTL_MS;

    if (!refresh && isFresh) {
      return res.json({
        ok: true,
        cached: true,
        fetched_at: new Date(suppressedValidationCache.fetchedAt).toISOString(),
        report: suppressedValidationCache.payload
      });
    }

    if (!suppressedValidationCache.inFlight) {
      suppressedValidationCache.inFlight = runSuppressedValidationAudit({
        days,
        maxDocs,
        concurrency,
        writeFiles: false
      })
        .then((report) => {
          suppressedValidationCache.payload = report;
          suppressedValidationCache.fetchedAt = Date.now();
          return report;
        })
        .finally(() => {
          suppressedValidationCache.inFlight = null;
        });
    }

    const report = await suppressedValidationCache.inFlight;
    return res.json({
      ok: true,
      cached: false,
      fetched_at: new Date(suppressedValidationCache.fetchedAt).toISOString(),
      report
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'suppressed_validation_audit_failed'
    });
  }
});

router.get('/audit-execution-vs-model', async (req, res) => {
  try {
    if (!EXECUTION_INTELLIGENCE_ENABLED) {
      return res.json({
        ok: true,
        disabled: true,
        report: { enabled: false, reason: 'EXECUTION_INTELLIGENCE_ENABLED=false' }
      });
    }
    const refresh = String(req.query.refresh || '').toLowerCase() === 'true';
    const days = Math.max(1, Math.min(365, Number(req.query.days || process.env.AUDIT_DAYS || 30)));
    const maxDocs = Math.max(50, Math.min(300000, Number(req.query.maxDocs || process.env.AUDIT_MAX_DOCS || 250)));
    const concurrency = Math.max(
      1,
      Math.min(20, Number(req.query.concurrency || process.env.AUDIT_CONCURRENCY || 6))
    );
    const matchWindowMinutes = Math.max(
      1,
      Math.min(30, Number(req.query.matchWindowMinutes || process.env.EXEC_MATCH_WINDOW_MINUTES || 5))
    );
    const now = Date.now();
    const isFresh =
      executionAuditCache.payload &&
      now - executionAuditCache.fetchedAt < EXECUTION_AUDIT_CACHE_TTL_MS;

    if (!refresh && isFresh) {
      return res.json({
        ok: true,
        cached: true,
        fetched_at: new Date(executionAuditCache.fetchedAt).toISOString(),
        report: executionAuditCache.payload
      });
    }

    if (!executionAuditCache.inFlight) {
      executionAuditCache.inFlight = runExecutionVsModelAudit({
        days,
        maxDocs,
        concurrency,
        matchWindowMinutes,
        writeFiles: false
      })
        .then((report) => {
          executionAuditCache.payload = report;
          executionAuditCache.fetchedAt = Date.now();
          return report;
        })
        .finally(() => {
          executionAuditCache.inFlight = null;
        });
    }

    const report = await executionAuditCache.inFlight;
    return res.json({
      ok: true,
      cached: false,
      fetched_at: new Date(executionAuditCache.fetchedAt).toISOString(),
      report
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'execution_vs_model_audit_failed'
    });
  }
});

router.get('/ranking-summary', async (req, res) => {
  try {
    const limit = Math.max(20, Math.min(300, Number(req.query.limit || 160)));
    const recentSignals = await loadRecentRankableSignals(limit);
    const rankedSignals = decorateSignalsWithRanking(recentSignals, {
      topPerSymbol: 3,
      topGlobal: 5,
      topPerRegime: 5
    });
    res.json({
      ok: true,
      summary: summarizeRankingSignals(rankedSignals),
      ranked_signals: summarizeRankedSignals(rankedSignals)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'ranking_summary_failed'
    });
  }
});

router.get('/adaptive-profiles', async (req, res) => {
  try {
    const report = await runSignalIntelligenceAudit({
      days: Math.max(1, Math.min(365, Number(req.query.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30))),
      maxDocs: Math.max(1000, Math.min(300000, Number(req.query.maxDocs || process.env.SIGNAL_INTEL_AUDIT_MAX_DOCS || 25000))),
      writeFiles: false
    });
    const enriched = await buildSignalIntelligenceComposite(report);
    res.json({
      ok: true,
      profiles: enriched.adaptive_profiles
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'adaptive_profiles_failed'
    });
  }
});

router.get('/context-intelligence-summary', async (req, res) => {
  try {
    const report = await runSignalIntelligenceAudit({
      days: Math.max(1, Math.min(365, Number(req.query.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30))),
      maxDocs: Math.max(1000, Math.min(300000, Number(req.query.maxDocs || process.env.SIGNAL_INTEL_AUDIT_MAX_DOCS || 25000))),
      writeFiles: false
    });
    res.json({
      ok: true,
      summary: summarizeContextIntelligence(report)
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err?.message || 'context_intelligence_summary_failed'
    });
  }
});

router.post('/entrenar/:symbol', async (req, res) => {
  const { symbol } = req.params;
  if (!symbol) {
    return res.status(400).json({ error: 'Debe indicar un símbolo para entrenar.' });
  }

  try {
    await entrenarVelas(symbol);
    res.json({ message: `Entrenamiento iniciado para ${symbol}` });
  } catch (err) {
    handleError(res, err, `Error al entrenar ${symbol}`);
  }
});

router.post('/entrenar-multiple', async (_req, res) => {
  try {
    const sessionRef = await db.collection('velas_entrenamientos').add({
      type: 'entrenamiento-multiple',
      symbols: SIMBOLOS_VELAS,
      created_at: new Date().toISOString(),
      status: 'en-cola',
      total_symbols: SIMBOLOS_VELAS.length,
      completed_count: 0,
      estimated_duration_minutes: 1
    });

    for (const symbol of SIMBOLOS_VELAS) {
      try {
        const registered = await entrenarVelas(symbol);
        const detailRef = sessionRef.collection('detalle');
        await detailRef.add({
          simbolo: symbol,
          status: 'entrenado',
          registrado_id: registered.id,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error('Error entrenando símbolo', symbol, err.message);
        const detailRef = sessionRef.collection('detalle');
        await detailRef.add({
          simbolo: symbol,
          status: 'error',
          timestamp: new Date().toISOString(),
          error: err.message
        });
      }

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(sessionRef);
        const completed = (snap.get('completed_count') || 0) + 1;
        tx.update(sessionRef, {
          completed_count: completed,
          status: completed >= SIMBOLOS_VELAS.length ? 'completado' : 'en-progreso'
        });
      });
    }

    res.json({ message: 'Entrenamiento masivo iniciado', sessionId: sessionRef.id });
  } catch (err) {
    handleError(res, err, 'Error al entrenar múltiples símbolos');
  }
});

router.get('/historial/entrenamientos', async (_req, res) => {
  try {
    const snapshot = await db.collection('velas_entrenamientos')
      .orderBy('created_at', 'desc')
      .limit(20)
      .get();

    res.json(snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() })));
  } catch (err) {
    handleError(res, err, 'Error al obtener historial de entrenamientos');
  }
});

router.get('/entrenamientos/pendientes', async (_req, res) => {
  try {
    const doc = await db.collection('entrenamientos_pendientes')
      .orderBy('createdAt', 'desc')
      .limit(1)
      .get();

    if (doc.empty) {
      return res.json(null);
    }

    const snapshot = doc.docs[0];
    const data = snapshot.data();
    res.json({
      id: snapshot.id,
      ...data
    });
  } catch (err) {
    handleError(res, err, 'Error al obtener entrenamiento pendiente');
  }
});

router.post('/prediccion', async (req, res) => {
  const { symbol, timeframe = '5m', monto = 1000, execution_mode } = req.body;
  if (!symbol) {
    return res.status(400).json({ error: 'El campo symbol es obligatorio.' });
  }

    try {
      const prediction = await prediccionVelas({ symbol, timeframe, monto, execution_mode });
    res.json({
      ...prediction,
      ...computeSignalRanking(prediction)
    });
  } catch (err) {
    handleError(res, err, 'Error al generar predicción de velas');
  }
});

// Test manual controlado para validar conexión/permiso real con Binance Futures sin esperar HC.
// Requiere x-cron-secret y ejecuta 1 intento con payload sintético.
router.post('/binance/test-order', async (req, res) => {
  if (!requireCronSecret(req, res)) return;

  const {
    symbol = 'ETH-USD',
    direction = 'up',
    source_profile = 'manual_prealert'
  } = req.body || {};

  if (direction !== 'up' && direction !== 'down') {
    return res.status(400).json({ error: 'direction debe ser up o down.' });
  }

  try {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    let spotPrice = 0;
    try {
      const fetchedSpot = await fetchBinanceSpot(normalizedSymbol);
      spotPrice = Number(fetchedSpot?.price || 0);
    } catch (_) {
      spotPrice = 0;
    }
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      const futuresSymbol = toBinanceSymbol(normalizedSymbol);
      if (futuresSymbol) {
        spotPrice = Number(await getMarkPrice(futuresSymbol));
      }
    }
    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
      return res.status(400).json({ error: 'No se pudo obtener spot válido para test.' });
    }

    const deltaPct = 0.6;
    const rr = 1.67;
    const riskPct = Number((deltaPct / rr).toFixed(4));
    const tpPrice = direction === 'up'
      ? Number((spotPrice * (1 + deltaPct / 100)).toFixed(8))
      : Number((spotPrice * (1 - deltaPct / 100)).toFixed(8));
    const slPrice = direction === 'up'
      ? Number((spotPrice * (1 - riskPct / 100)).toFixed(8))
      : Number((spotPrice * (1 + riskPct / 100)).toFixed(8));

    const testSignal = {
      id: `manual-test-${Date.now()}`,
      prediction_id: `manual-test-${Date.now()}`,
      symbol: normalizedSymbol,
      direction,
      confidence: 0.99,
      quantum_score: 0.99,
      timing_score: 0.99,
      context_score: 4,
      expected_move_percent: deltaPct,
      spot_price: spotPrice,
      trade_plan: {
        entry_price: spotPrice,
        stop_loss: slPrice,
        take_profit: tpPrice,
        target_exit_price: tpPrice,
        risk_reward_ratio: rr
      },
      estimated_window: {
        start: new Date().toISOString(),
        end: new Date(Date.now() + 60 * 1000).toISOString()
      },
      timestamp: new Date().toISOString()
    };

    const result = await executeSignalTrade(db, testSignal, {
      source: 'manual_test',
      source_profile
    });

    return res.status(200).json({
      ok: true,
      mode: 'binance_test_order',
      symbol: normalizedSymbol,
      source_profile,
      result
    });
  } catch (err) {
    console.error('[BINANCE_TEST_ORDER] error', err?.message || err);
    return res.status(500).json({
      ok: false,
      error: err?.message || 'binance_test_order_failed'
    });
  }
});

router.get('/predicciones', async (req, res) => {
  try {
    let queryRef = db.collection('velas_predicciones').orderBy('timestamp', 'desc').limit(50);
    if (req.query.symbol) {
      queryRef = queryRef.where('simbolo', '==', req.query.symbol);
    }
    const snapshot = await queryRef.get();
    const signals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(decorateSignalsWithRanking(signals, { topPerSymbol: 3, topGlobal: 5 }));
  } catch (err) {
    handleError(res, err, 'Error al obtener predicciones');
  }
});

router.get('/historial', async (req, res) => {
  try {
    const rawLimit = Number(req.query.limit);
    const symbol = (req.query.symbol || '').toString().toUpperCase();
    const status = (req.query.status || '').toString();
    const from = req.query.from ? req.query.from.toString() : null;
    const to = req.query.to ? req.query.to.toString() : null;
    const startAfter = req.query.startAfter ? req.query.startAfter.toString() : null;

    let queryRef = db.collection('velas_predicciones').orderBy('timestamp', 'desc');

    if (symbol) {
      queryRef = queryRef.where('simbolo', '==', symbol);
    }
    if (status) {
      queryRef = queryRef.where('status', '==', status);
    }
    if (from) {
      queryRef = queryRef.where('timestamp', '>=', from);
    }
    if (to) {
      queryRef = queryRef.where('timestamp', '<=', to);
    }
    if (startAfter) {
      queryRef = queryRef.startAfter(startAfter);
    }
    if (Number.isFinite(rawLimit) && rawLimit > 0) {
      queryRef = queryRef.limit(rawLimit);
    }

    const snapshot = await queryRef.get();
    const signals = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json(decorateSignalsWithRanking(signals, { topPerSymbol: 3, topGlobal: 5 }));
  } catch (err) {
    handleError(res, err, 'Error al obtener historial de velas');
  }
});

router.post('/verificar/:id', async (req, res) => {
  const { id } = req.params;
  if (!id) {
    return res.status(400).json({ error: 'Se requiere el ID de la predicción.' });
  }

  try {
    const result = await verificarPrediccionVelas(id);
    res.json(result);
  } catch (err) {
    handleError(res, err, 'Error al verificar predicción');
  }
});

module.exports = router;
