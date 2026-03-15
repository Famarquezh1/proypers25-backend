const db = require('../firebase-admin-config');

const PROFILE_COLLECTION = 'execution_profiles';
const RANKING_PROFILE_COLLECTION = 'ranking_profiles';
const CONTEXT_PROFILE_COLLECTION = 'context_profiles';
const LEARNING_SNAPSHOT_COLLECTION = 'learning_snapshots';
const PROFILE_DOC_ID = process.env.ADAPTIVE_PROFILE_DOC_ID || 'default';
const CALIBRATION_VERSION = process.env.CALIBRATION_VERSION || 'v2';
const ADAPTIVE_CALIBRATION_ENABLED =
  String(process.env.ADAPTIVE_CALIBRATION_ENABLED || 'true').toLowerCase() !== 'false';
const RECALIBRATION_INTERVAL_MS = Math.max(
  60 * 60 * 1000,
  Number(process.env.ADAPTIVE_RECALIBRATION_INTERVAL_MS || 24 * 60 * 60 * 1000)
);
const RECALIBRATION_SIGNAL_DELTA = Math.max(
  100,
  Number(process.env.ADAPTIVE_RECALIBRATION_SIGNAL_DELTA || 500)
);

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function clampRelative(candidate, baseline, maxDeltaRatio) {
  if (!Number.isFinite(candidate)) return null;
  if (!Number.isFinite(baseline) || baseline <= 0) return candidate;
  return clamp(candidate, baseline * (1 - maxDeltaRatio), baseline * (1 + maxDeltaRatio));
}

function round(value, decimals = 3) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

function mean(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function safeBucketKey(value) {
  return String(value || 'unknown').replace(/[^\w\-]+/g, '_');
}

function normalizeRate(value) {
  const n = toNum(value, null);
  if (n == null) return null;
  return n > 1 ? n / 100 : n;
}

function computeEdgeQualityScore(report = {}) {
  const winRate = normalizeRate(report?.win_rates?.win_rate_emitidas) ?? 0;
  const expectancy = toNum(report?.states?.emitidas?.expectancy?.expectancy, 0);
  const mfeP75 = toNum(report?.states?.emitidas?.mfe_mae?.mfe?.p75, 0);
  const filterDelta = toNum(report?.event_context_filter_impact?.delta_expectancy, 0);
  const strongContextWinRate = normalizeRate(
    (report?.context_quality_buckets || []).find((bucket) => String(bucket?.bucket) === '80-100')?.win_rate
  ) ?? 0;

  const expectancyRatio = mfeP75 > 0 ? clamp(expectancy / mfeP75, 0, 1) : clamp(expectancy / 1.5, 0, 1);
  const filterContribution = clamp((filterDelta + 0.5) / 1.5, 0, 1);
  const score =
    100 *
    (0.42 * winRate + 0.28 * expectancyRatio + 0.15 * strongContextWinRate + 0.15 * filterContribution);

  return round(clamp(score, 0, 100), 1);
}

function deriveRankingProfile(report = {}, existingProfile = null) {
  const rankedSignals = Array.isArray(report?.ranked_signals) ? report.ranked_signals : [];
  const topSignals = rankedSignals.filter((signal) => signal?.top_signal_flag);
  const topRankValues = topSignals
    .map((signal) => toNum(signal?.signal_ranking_score, null))
    .filter((value) => value != null);
  const allRankValues = rankedSignals
    .map((signal) => toNum(signal?.signal_ranking_score, null))
    .filter((value) => value != null);

  const strongContextBucket = Array.isArray(report?.context_quality_buckets)
    ? report.context_quality_buckets.find((bucket) => String(bucket?.bucket) === '80-100')
    : null;

  return {
    profile_id: PROFILE_DOC_ID,
    calibration_version: CALIBRATION_VERSION,
    ranking_weights: report?.ranking_summary?.weights || existingProfile?.ranking_weights || null,
    min_context_quality_recommended: round(
      toNum(strongContextBucket?.total, 0) > 0
        ? Math.max(55, toNum(strongContextBucket?.bucket?.split('-')?.[0], 80))
        : toNum(existingProfile?.min_context_quality_recommended, 60),
      1
    ),
    min_signal_ranking_score_recommended: round(
      topRankValues.length
        ? Math.max(60, mean(topRankValues) - 5)
        : allRankValues.length
          ? Math.max(55, mean(allRankValues))
          : toNum(existingProfile?.min_signal_ranking_score_recommended, 60),
      1
    ),
    top_global_count: Number(report?.ranking_summary?.top_global_count || 0),
    top_symbol_count: Number(report?.ranking_summary?.top_symbol_count || 0),
    updated_at: new Date().toISOString()
  };
}

function deriveContextProfile(report = {}, existingProfile = null) {
  const buckets = Array.isArray(report?.context_quality_buckets) ? report.context_quality_buckets : [];
  const bestBucket = [...buckets]
    .filter((bucket) => Number.isFinite(toNum(bucket?.win_rate, null)))
    .sort((a, b) => (toNum(b?.expectancy, -Infinity) - toNum(a?.expectancy, -Infinity)) || (toNum(b?.win_rate, 0) - toNum(a?.win_rate, 0)))[0];
  const regimePerformance = report?.regime_performance || {};

  const regimeSuitability = Object.entries(regimePerformance).map(([regime, data]) => ({
    regime,
    win_rate: normalizeRate(data?.win_rate),
    expectancy: toNum(data?.expectancy?.expectancy, null),
    total: Number(data?.total || 0)
  }));

  return {
    profile_id: PROFILE_DOC_ID,
    calibration_version: CALIBRATION_VERSION,
    best_context_bucket: bestBucket?.bucket || existingProfile?.best_context_bucket || 'unknown',
    best_context_bucket_win_rate: normalizeRate(bestBucket?.win_rate),
    best_context_bucket_expectancy: toNum(bestBucket?.expectancy, null),
    context_bucket_quality: buckets.reduce((acc, bucket) => {
      acc[safeBucketKey(bucket?.bucket)] = {
        total: Number(bucket?.total || 0),
        win_rate: normalizeRate(bucket?.win_rate),
        expectancy: toNum(bucket?.expectancy, null)
      };
      return acc;
    }, {}),
    regime_suitability: regimeSuitability,
    updated_at: new Date().toISOString()
  };
}

function deriveCandidateProfile(report = {}, existingProfile = null) {
  const emitted = report?.states?.emitidas || {};
  const mfeP75 = toNum(emitted?.mfe_mae?.mfe?.p75, null);
  const mfeP90 = toNum(emitted?.mfe_mae?.mfe?.p90, null);
  const maeP75 = toNum(emitted?.mfe_mae?.mae?.p75, null);
  const maeP90 = toNum(emitted?.mfe_mae?.mae?.p90, null);

  const lead03P75 = toNum(report?.lead_time?.threshold_03?.p75, null);
  const lead05P50 = toNum(report?.lead_time?.threshold_05?.p50, null);

  let adaptiveTp = null;
  if (mfeP75 != null && mfeP75 > 0) adaptiveTp = mfeP75 * 0.9;
  else if (mfeP90 != null && mfeP90 > 0) adaptiveTp = mfeP90 * 0.75;
  else adaptiveTp = toNum(existingProfile?.adaptive_tp, 0.8);

  let adaptiveSl = null;
  if (maeP75 != null && maeP75 > 0) adaptiveSl = maeP75 * 1.05;
  else if (maeP90 != null && maeP90 > 0) adaptiveSl = maeP90 * 0.9;
  else if (adaptiveTp != null && adaptiveTp > 0) adaptiveSl = adaptiveTp / 1.67;
  else adaptiveSl = toNum(existingProfile?.adaptive_sl, 0.45);

  let adaptiveHorizon = null;
  if (lead03P75 != null && lead03P75 > 0) adaptiveHorizon = Math.round(lead03P75 * 1.1);
  else if (lead05P50 != null && lead05P50 > 0) adaptiveHorizon = Math.round(lead05P50 * 0.9);
  else adaptiveHorizon = Math.round(toNum(existingProfile?.adaptive_horizon, 300));

  adaptiveTp = clampRelative(adaptiveTp, toNum(existingProfile?.adaptive_tp, null), 0.2);
  adaptiveSl = clampRelative(adaptiveSl, toNum(existingProfile?.adaptive_sl, null), 0.2);
  adaptiveHorizon = clampRelative(adaptiveHorizon, toNum(existingProfile?.adaptive_horizon, null), 0.3);

  adaptiveTp = round(Math.max(adaptiveTp || 0.1, 0.1), 3);
  adaptiveSl = round(Math.max(adaptiveSl || 0.05, 0.05), 3);
  adaptiveHorizon = Math.max(Math.round(adaptiveHorizon || 60), 30);

  return {
    adaptive_tp: adaptiveTp,
    adaptive_sl: adaptiveSl,
    adaptive_horizon: adaptiveHorizon,
    adaptive_horizon_seconds: adaptiveHorizon
  };
}

function resolveLearningStatus(report = {}, edgeQualityScore = 0) {
  const totalSignals = Number(report?.totals?.total_signals || 0);
  if (totalSignals < 30) return 'warming_up';
  if (totalSignals < 100) return 'learning';
  if (edgeQualityScore >= 75) return 'stable';
  if (edgeQualityScore >= 55) return 'monitoring';
  return 'recalibrating';
}

function needsRecalibration(existingProfile = null, report = {}, options = {}) {
  if (options.force) return true;
  if (!existingProfile) return true;

  const lastTime = new Date(existingProfile.last_calibration_time || existingProfile.updated_at || 0).getTime();
  const now = Date.now();
  if (!Number.isFinite(lastTime) || now - lastTime >= RECALIBRATION_INTERVAL_MS) {
    return true;
  }

  const sourceSignals = Number(existingProfile.source_signal_count || 0);
  const currentSignals = Number(report?.totals?.total_signals || 0);
  return currentSignals - sourceSignals >= RECALIBRATION_SIGNAL_DELTA;
}

async function loadExistingProfile(docId = PROFILE_DOC_ID) {
  const snap = await db.collection(PROFILE_COLLECTION).doc(docId).get();
  if (!snap.exists) return null;
  return { id: snap.id, ...snap.data() };
}

async function persistProfile(profile, docId = PROFILE_DOC_ID) {
  await db.collection(PROFILE_COLLECTION).doc(docId).set(profile, { merge: true });
  return profile;
}

async function persistAuxiliaryProfiles({ executionProfile, rankingProfile, contextProfile, snapshot }, docId = PROFILE_DOC_ID) {
  const batch = db.batch();
  batch.set(db.collection(PROFILE_COLLECTION).doc(docId), executionProfile, { merge: true });
  batch.set(db.collection(RANKING_PROFILE_COLLECTION).doc(docId), rankingProfile, { merge: true });
  batch.set(db.collection(CONTEXT_PROFILE_COLLECTION).doc(docId), contextProfile, { merge: true });
  if (snapshot) {
    batch.set(db.collection(LEARNING_SNAPSHOT_COLLECTION).doc(snapshot.snapshot_id), snapshot, { merge: true });
  }
  await batch.commit();
}

async function loadAuxiliaryProfiles(docId = PROFILE_DOC_ID) {
  const [executionSnap, rankingSnap, contextSnap] = await Promise.all([
    db.collection(PROFILE_COLLECTION).doc(docId).get(),
    db.collection(RANKING_PROFILE_COLLECTION).doc(docId).get(),
    db.collection(CONTEXT_PROFILE_COLLECTION).doc(docId).get()
  ]);
  return {
    execution: executionSnap.exists ? { id: executionSnap.id, ...executionSnap.data() } : null,
    ranking: rankingSnap.exists ? { id: rankingSnap.id, ...rankingSnap.data() } : null,
    context: contextSnap.exists ? { id: contextSnap.id, ...contextSnap.data() } : null
  };
}

async function getAdaptiveExecutionProfile(report = {}, options = {}) {
  if (!ADAPTIVE_CALIBRATION_ENABLED) {
    return {
      profile_id: options.docId || PROFILE_DOC_ID,
      learning_status: 'disabled',
      calibration_version: CALIBRATION_VERSION,
      recalibrated: false,
      adaptive_tp: null,
      adaptive_sl: null,
      adaptive_horizon: null,
      adaptive_horizon_seconds: null,
      edge_quality_score: null
    };
  }

  const existingProfile = await loadExistingProfile(options.docId || PROFILE_DOC_ID);
  const edgeQualityScore = computeEdgeQualityScore(report);
  const learningStatus = resolveLearningStatus(report, edgeQualityScore);
  const totalSignals = Number(report?.totals?.total_signals || 0);
  const shouldRecalibrate = needsRecalibration(existingProfile, report, options);

  if (!shouldRecalibrate && existingProfile) {
    return {
      ...existingProfile,
      edge_quality_score: toNum(existingProfile.edge_quality_score, edgeQualityScore),
      learning_status: existingProfile.learning_status || learningStatus,
      recalibrated: false
    };
  }

  const candidate = deriveCandidateProfile(report, existingProfile);
  const timestamp = new Date().toISOString();
  const profile = {
    profile_id: options.docId || PROFILE_DOC_ID,
    adaptive_tp: candidate.adaptive_tp,
    adaptive_sl: candidate.adaptive_sl,
    adaptive_horizon: candidate.adaptive_horizon,
    adaptive_horizon_seconds: candidate.adaptive_horizon_seconds,
    learning_status: learningStatus,
    edge_quality_score: edgeQualityScore,
    last_calibration_time: timestamp,
    updated_at: timestamp,
    source_signal_count: totalSignals,
    source_window_days: Number(report?.window_days || 0),
    calibration_reason: existingProfile ? 'refresh' : 'bootstrap',
    safety_limits: {
      tp_delta_limit: 0.2,
      sl_delta_limit: 0.2,
      horizon_delta_limit: 0.3
    },
    source_metrics: {
      win_rate_emitidas: normalizeRate(report?.win_rates?.win_rate_emitidas),
      expectancy_emitidas: toNum(report?.states?.emitidas?.expectancy?.expectancy, null),
      mfe_p75: toNum(report?.states?.emitidas?.mfe_mae?.mfe?.p75, null),
      mfe_p90: toNum(report?.states?.emitidas?.mfe_mae?.mfe?.p90, null),
      mae_p75: toNum(report?.states?.emitidas?.mfe_mae?.mae?.p75, null),
      mae_p90: toNum(report?.states?.emitidas?.mfe_mae?.mae?.p90, null),
      lead_time_p75: toNum(report?.lead_time?.threshold_03?.p75, null)
    }
  };

  if (options.persist !== false) {
    await persistProfile(profile, options.docId || PROFILE_DOC_ID);
  }

  return {
    ...profile,
    recalibrated: true
  };
}

async function getAdaptiveSystemProfiles(report = {}, options = {}) {
  if (!ADAPTIVE_CALIBRATION_ENABLED) {
    return {
      enabled: false,
      execution_profile: await getAdaptiveExecutionProfile(report, { ...options, persist: false }),
      ranking_profile: null,
      context_profile: null
    };
  }

  const existing = await loadAuxiliaryProfiles(options.docId || PROFILE_DOC_ID);
  const executionProfile = await getAdaptiveExecutionProfile(report, options);
  const rankingProfile = {
    ...deriveRankingProfile(report, existing.ranking),
    learning_status: executionProfile.learning_status,
    last_calibration_time: executionProfile.last_calibration_time
  };
  const contextProfile = {
    ...deriveContextProfile(report, existing.context),
    learning_status: executionProfile.learning_status,
    last_calibration_time: executionProfile.last_calibration_time
  };

  if (options.persist !== false) {
    await persistAuxiliaryProfiles({
      executionProfile,
      rankingProfile,
      contextProfile,
      snapshot: {
        snapshot_id: `${options.docId || PROFILE_DOC_ID}_${Date.now()}`,
        profile_id: options.docId || PROFILE_DOC_ID,
        calibration_version: CALIBRATION_VERSION,
        created_at: new Date().toISOString(),
        learning_status: executionProfile.learning_status,
        edge_quality_score: executionProfile.edge_quality_score,
        execution_profile: executionProfile,
        ranking_profile: rankingProfile,
        context_profile: contextProfile
      }
    }, options.docId || PROFILE_DOC_ID);
  }

  return {
    enabled: true,
    calibration_version: CALIBRATION_VERSION,
    execution_profile: executionProfile,
    ranking_profile: rankingProfile,
    context_profile: contextProfile
  };
}

module.exports = {
  ADAPTIVE_CALIBRATION_ENABLED,
  computeEdgeQualityScore,
  deriveContextProfile,
  deriveCandidateProfile,
  deriveRankingProfile,
  loadAdaptiveExecutionProfile: loadExistingProfile,
  getAdaptiveExecutionProfile,
  getAdaptiveSystemProfiles
};
