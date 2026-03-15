const db = require('../firebase-admin-config');
const { run: runSignalIntelligenceAudit } = require('../scripts/audit-signal-intelligence');
const { run: runSuppressedValidationAudit } = require('../scripts/validate-suppressed-signals');
const { run: runExecutionVsModelAudit } = require('../scripts/execution-vs-model-audit');
const {
  SIGNAL_RANKING_ENABLED,
  RANKING_WEIGHTS,
  selectTopSignals
} = require('./signal_ranking_engine');
const {
  getAdaptiveSystemProfiles
} = require('./adaptive_calibration_engine');

const SNAPSHOT_COLLECTION = 'analytics_snapshots';
const SNAPSHOT_DOC_ID = 'signal_intelligence_dashboard_v1';
const SNAPSHOT_MEM_TTL_MS = Math.max(
  60 * 1000,
  Number(process.env.SIGNAL_INTEL_DASHBOARD_MEM_TTL_MS || 5 * 60 * 1000)
);

let snapshotCache = {
  fetchedAt: 0,
  payload: null,
  inFlight: null
};

function signalIdentifier(signal = {}) {
  return (
    signal.id ||
    signal.prediction_id ||
    `${signal.simbolo || signal.symbol || 'UNKNOWN'}-${signal.timestamp || signal.created_at || Date.now()}`
  );
}

async function loadRecentRankableSignals(limit = 160) {
  const snapshot = await db.collection('velas_predicciones').orderBy('timestamp', 'desc').limit(limit).get();
  return snapshot.docs
    .map((doc) => ({ id: doc.id, ...doc.data() }))
    .filter((signal) => signal?.signal_emitted === true);
}

function decorateSignalsWithRanking(signals = [], options = {}) {
  return selectTopSignals(signals, options).map((signal) => ({
    ...signal,
    signal_id: signalIdentifier(signal)
  }));
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
  const bestContextBucket =
    [...contextBuckets].sort(
      (a, b) =>
        Number(b?.expectancy || -Infinity) - Number(a?.expectancy || -Infinity) ||
        Number(b?.win_rate || 0) - Number(a?.win_rate || 0)
    )[0] || null;
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

function buildSnapshotDocRef() {
  return db.collection(SNAPSHOT_COLLECTION).doc(SNAPSHOT_DOC_ID);
}

async function persistSnapshot(payload) {
  await buildSnapshotDocRef().set(payload, { merge: true });
}

async function loadPersistedSnapshot() {
  const doc = await buildSnapshotDocRef().get();
  if (!doc.exists) return null;
  const data = doc.data() || null;
  if (!data) return null;
  snapshotCache = {
    fetchedAt: Date.now(),
    payload: data,
    inFlight: null
  };
  return data;
}

async function refreshSignalIntelligenceDashboardSnapshot(options = {}) {
  const intelligenceDays = Math.max(
    1,
    Math.min(365, Number(options.days || process.env.SIGNAL_INTEL_AUDIT_DAYS || 30))
  );
  const intelligenceMaxDocs = Math.max(
    1000,
    Math.min(300000, Number(options.maxDocs || process.env.SIGNAL_INTEL_AUDIT_MAX_DOCS || 25000))
  );
  const suppressedMaxDocs = Math.max(
    50,
    Math.min(300000, Number(options.suppressedMaxDocs || process.env.AUDIT_MAX_DOCS || 250))
  );
  const executionMaxDocs = Math.max(
    50,
    Math.min(300000, Number(options.executionMaxDocs || process.env.AUDIT_MAX_DOCS || 250))
  );
  const concurrency = Math.max(
    1,
    Math.min(20, Number(options.concurrency || process.env.AUDIT_CONCURRENCY || 6))
  );
  const matchWindowMinutes = Math.max(
    1,
    Math.min(30, Number(options.matchWindowMinutes || process.env.EXEC_MATCH_WINDOW_MINUTES || 5))
  );

  const [intelligenceBase, suppressedReport, executionReport] = await Promise.all([
    runSignalIntelligenceAudit({
      days: intelligenceDays,
      maxDocs: intelligenceMaxDocs,
      writeFiles: false
    }),
    runSuppressedValidationAudit({
      days: intelligenceDays,
      maxDocs: suppressedMaxDocs,
      concurrency,
      writeFiles: false
    }),
    runExecutionVsModelAudit({
      days: intelligenceDays,
      maxDocs: executionMaxDocs,
      concurrency,
      matchWindowMinutes,
      writeFiles: false
    })
  ]);

  const intelligenceReport = await buildSignalIntelligenceComposite(intelligenceBase);
  const fetchedAt = new Date().toISOString();
  const payload = {
    generated_at: fetchedAt,
    config: {
      intelligence_days: intelligenceDays,
      intelligence_max_docs: intelligenceMaxDocs,
      suppressed_max_docs: suppressedMaxDocs,
      execution_max_docs: executionMaxDocs,
      concurrency,
      match_window_minutes: matchWindowMinutes
    },
    intelligence: {
      fetched_at: fetchedAt,
      report: intelligenceReport
    },
    suppressed: {
      fetched_at: fetchedAt,
      report: suppressedReport
    },
    execution: {
      fetched_at: fetchedAt,
      report: executionReport
    }
  };

  await persistSnapshot(payload);
  snapshotCache = {
    fetchedAt: Date.now(),
    payload,
    inFlight: null
  };
  return payload;
}

async function getSignalIntelligenceDashboardSnapshot(options = {}) {
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
  }

  if (!snapshotCache.inFlight) {
    snapshotCache.inFlight = refreshSignalIntelligenceDashboardSnapshot(options).finally(() => {
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
  getSignalIntelligenceDashboardSnapshot,
  refreshSignalIntelligenceDashboardSnapshot
};
