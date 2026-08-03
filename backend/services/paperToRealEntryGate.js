'use strict';

const { evaluateSpotTechnicalConfirmation } = require('./spotTechnicalConfirmation');
const { summarizePositiveValidation } = require('../lib/spotPaperRiskRules');

const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';
const PAPER_RESULTS = 'spot_paper_execution_results';
const DECISIONS = 'real_spot_entry_gate_decisions';

const TACTICAL_CATEGORIES = new Set(['MOMENTUM', 'BREAKOUT', 'VOLUME_SPIKE', 'ACCUMULATION']);
const TACTICAL_BLOCKING_WARNINGS = new Set(['parabolic_24h_move', 'extreme_volatility', 'high_risk_profile']);

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function candidateScore(candidate) {
  return asNumber(candidate.opportunityScore ?? candidate.opportunity_score ?? candidate.score ?? candidate.final_score, 0);
}

function candidateVolume(candidate) {
  return asNumber(candidate.quoteVolume24h ?? candidate.quote_volume_24h ?? candidate.volume24h, 0);
}

function candidateMetric(candidate, ...keys) {
  for (const key of keys) {
    if (candidate?.[key] !== undefined && candidate?.[key] !== null) return asNumber(candidate[key], 0);
  }
  return 0;
}

function isRejected(candidate) {
  const status = String(candidate.status || '').toUpperCase();
  return candidate.rejected === true || ['REJECTED', 'DISCARDED', 'BLOCKED'].includes(status);
}

function uniqueLatestCandidates(candidates, latestScanId) {
  const bySymbol = new Map();
  for (const candidate of candidates) {
    if (String(candidate.scan_id || '') !== String(latestScanId || '')) continue;
    const symbol = String(candidate.symbol || '').toUpperCase();
    if (!symbol || isRejected(candidate)) continue;
    const current = bySymbol.get(symbol);
    if (!current || candidateScore(candidate) > candidateScore(current)) bySymbol.set(symbol, candidate);
  }
  return [...bySymbol.values()].sort((left, right) => {
    const scoreDifference = candidateScore(right) - candidateScore(left);
    if (Math.abs(scoreDifference) > 0.000001) return scoreDifference;
    return candidateVolume(right) - candidateVolume(left);
  });
}

function validationEvidenceForSymbol(validationRows, paperRows, symbol, currentScanId) {
  const normalized = String(symbol || '').toUpperCase();
  const historicalValidations = validationRows
    .filter((row) => String(row.symbol || '').toUpperCase() === normalized)
    .filter((row) => String(row.scan_id || '') !== String(currentScanId || ''))
    .map((row) => ({ row, summary: summarizePositiveValidation(row) }))
    .filter(({ summary }) => summary.completed_count > 0);

  const positiveHistorical = historicalValidations.filter(({ summary }) => summary.positive === true);
  const completedHorizons = historicalValidations.reduce((sum, item) => sum + item.summary.completed_count, 0);
  const positiveHorizons = historicalValidations.reduce((sum, item) => sum + item.summary.positive_completed_count, 0);
  const paperTrades = paperRows.filter((row) => String(row.symbol || '').toUpperCase() === normalized);
  const positivePaperTrades = paperTrades.filter((row) => asNumber(row.estimated_net_pnl_pct ?? row.net_pnl_pct, 0) > 0);
  const totalEvidence = completedHorizons + paperTrades.length;
  const positiveEvidence = positiveHorizons + positivePaperTrades.length;

  return {
    historical_validation_documents: historicalValidations.length,
    positive_validation_documents: positiveHistorical.length,
    completed_horizons: completedHorizons,
    positive_horizons: positiveHorizons,
    paper_trades: paperTrades.length,
    positive_paper_trades: positivePaperTrades.length,
    sample_size: totalEvidence,
    positive_rate: totalEvidence > 0 ? positiveEvidence / totalEvidence : 0,
    latest_positive_validation_id: positiveHistorical[0]?.row?.id || null,
    latest_positive_validation_scan_id: positiveHistorical[0]?.row?.scan_id || null,
    source: 'historical_symbol_evidence'
  };
}

function tacticalThresholds(config = {}) {
  return {
    enabled: config.tactical_momentum_enabled !== false,
    minimum_score: Math.max(asNumber(config.min_opportunity_score, 0), asNumber(config.tactical_momentum_min_score, 70)),
    minimum_quote_volume_usdt: Math.max(100000, asNumber(config.tactical_momentum_min_quote_volume_usdt, 500000)),
    minimum_price_change_24h: Math.max(0, asNumber(config.tactical_momentum_min_price_change_24h, 2.5)),
    maximum_price_change_24h: Math.max(5, asNumber(config.tactical_momentum_max_price_change_24h, 18)),
    minimum_impulse_score: Math.max(0, asNumber(config.tactical_momentum_min_impulse_score, 60)),
    minimum_liquidity_score: Math.max(0, asNumber(config.tactical_momentum_min_liquidity_score, 50)),
    maximum_risk_score: Math.min(70, Math.max(0, asNumber(config.tactical_momentum_max_risk_score, 55))),
    minimum_existing_evidence_positive_rate: Math.max(0.25, Math.min(1, asNumber(config.tactical_momentum_min_existing_positive_rate, 0.4))),
    minimum_technical_score: Math.max(65, asNumber(config.tactical_momentum_min_technical_score, 70)),
    minimum_timeframe_confirmations: Math.max(2, asNumber(config.tactical_momentum_min_timeframe_confirmations, 2))
  };
}

function evaluateTacticalMomentumCandidate(candidate, evidence = null, config = {}) {
  const thresholds = tacticalThresholds(config);
  const reasons = [];
  const score = candidateScore(candidate || {});
  const volume = candidateVolume(candidate || {});
  const priceChange24h = candidateMetric(candidate, 'priceChange24h', 'price_change_24h');
  const impulseScore = candidateMetric(candidate, 'impulseScore', 'impulse_score');
  const liquidityScore = candidateMetric(candidate, 'liquidityScore', 'liquidity_score');
  const riskScore = candidateMetric(candidate, 'riskScore', 'risk_score');
  const category = String(candidate?.category || '').toUpperCase();
  const warnings = Array.isArray(candidate?.warnings) ? candidate.warnings : [];

  if (!thresholds.enabled) reasons.push('TACTICAL_MOMENTUM_DISABLED');
  if (!TACTICAL_CATEGORIES.has(category)) reasons.push('TACTICAL_CATEGORY_NOT_ALLOWED');
  if (score < thresholds.minimum_score) reasons.push('TACTICAL_SCORE_BELOW_THRESHOLD');
  if (volume < thresholds.minimum_quote_volume_usdt) reasons.push('TACTICAL_LIQUIDITY_VOLUME_TOO_LOW');
  if (priceChange24h < thresholds.minimum_price_change_24h) reasons.push('TACTICAL_MOVE_NOT_STARTED');
  if (priceChange24h > thresholds.maximum_price_change_24h) reasons.push('TACTICAL_MOVE_ALREADY_EXTENDED');
  if (impulseScore < thresholds.minimum_impulse_score) reasons.push('TACTICAL_IMPULSE_TOO_WEAK');
  if (liquidityScore < thresholds.minimum_liquidity_score) reasons.push('TACTICAL_LIQUIDITY_SCORE_TOO_LOW');
  if (riskScore > thresholds.maximum_risk_score) reasons.push('TACTICAL_RISK_TOO_HIGH');
  if (warnings.some((warning) => TACTICAL_BLOCKING_WARNINGS.has(String(warning)))) reasons.push('TACTICAL_BLOCKING_WARNING');
  if (evidence && evidence.sample_size >= 2 && evidence.positive_rate < thresholds.minimum_existing_evidence_positive_rate) {
    reasons.push('TACTICAL_EXISTING_EVIDENCE_NEGATIVE');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    metrics: {
      score,
      quote_volume_24h: volume,
      price_change_24h: priceChange24h,
      impulse_score: impulseScore,
      liquidity_score: liquidityScore,
      risk_score: riskScore,
      category,
      warnings
    },
    thresholds
  };
}

function evaluateStandardCandidate(candidate, evidence, config = {}, runnerUp = null) {
  const minimumScore = Math.max(asNumber(config.min_opportunity_score, 0), asNumber(config.paper_real_min_score, 90));
  const minimumVolume = Math.max(0, asNumber(config.paper_real_min_quote_volume_usdt, 1000000));
  const minimumValidationSamples = Math.max(1, asNumber(config.paper_real_min_validation_samples, 3));
  const minimumPositiveRate = Math.max(0.5, Math.min(1, asNumber(config.paper_real_min_positive_rate, 0.6)));
  const minimumSeparation = Math.max(0, asNumber(config.paper_real_min_score_separation, 0.5));
  const score = candidateScore(candidate || {});
  const volume = candidateVolume(candidate || {});
  const scoreSeparation = candidate && runnerUp ? score - candidateScore(runnerUp) : null;
  const reasons = [];

  if (score < minimumScore) reasons.push('PAPER_SCORE_BELOW_REAL_THRESHOLD');
  if (volume < minimumVolume) reasons.push('INSUFFICIENT_24H_QUOTE_VOLUME');
  if (runnerUp && scoreSeparation < minimumSeparation) reasons.push('AMBIGUOUS_TOP_SCORE');
  if (!evidence || evidence.sample_size < minimumValidationSamples) reasons.push('INSUFFICIENT_HISTORICAL_PAPER_EVIDENCE');
  if (evidence && evidence.sample_size >= minimumValidationSamples && evidence.positive_rate < minimumPositiveRate) {
    reasons.push('HISTORICAL_PAPER_POSITIVE_RATE_TOO_LOW');
  }

  return {
    allowed: reasons.length === 0,
    reasons,
    score_separation: scoreSeparation,
    thresholds: {
      minimum_score: minimumScore,
      minimum_score_separation: minimumSeparation,
      minimum_quote_volume_usdt: minimumVolume,
      minimum_validation_samples: minimumValidationSamples,
      minimum_positive_rate: minimumPositiveRate,
      minimum_technical_score: asNumber(config.paper_real_min_technical_score, 65),
      minimum_timeframe_confirmations: asNumber(config.paper_real_min_timeframe_confirmations, 2)
    }
  };
}

function buildCandidateAudit(candidates, validationRows, paperRows, currentScanId, config = {}) {
  return candidates.slice(0, 20).map((candidate, index) => {
    const symbol = String(candidate.symbol || '').toUpperCase();
    const evidence = validationEvidenceForSymbol(validationRows, paperRows, symbol, currentScanId);
    const standard = evaluateStandardCandidate(candidate, evidence, config, candidates[index + 1] || null);
    const tactical = evaluateTacticalMomentumCandidate(candidate, evidence, config);
    return {
      symbol,
      rank: index + 1,
      score: candidateScore(candidate),
      quote_volume_24h: candidateVolume(candidate),
      price_change_24h: candidateMetric(candidate, 'priceChange24h', 'price_change_24h'),
      impulse_score: candidateMetric(candidate, 'impulseScore', 'impulse_score'),
      liquidity_score: candidateMetric(candidate, 'liquidityScore', 'liquidity_score'),
      risk_score: candidateMetric(candidate, 'riskScore', 'risk_score'),
      category: candidate.category || null,
      standard_allowed: standard.allowed,
      standard_reasons: standard.reasons,
      tactical_allowed: tactical.allowed,
      tactical_reasons: tactical.reasons,
      historical_sample_size: evidence.sample_size,
      historical_positive_rate: evidence.positive_rate
    };
  });
}

async function saveDecision(db, decision) {
  try {
    const id = `paper_real_gate_${Date.now()}`;
    await db.collection(DECISIONS).doc(id).set({ id, ...decision }, { merge: true });
  } catch (error) {
    console.warn('[PAPER_TO_REAL_GATE] Decision log failed:', error.message);
  }
}

/**
 * Dual-lane entry gate:
 * - STANDARD requires accumulated historical Paper evidence.
 * - TACTICAL_MOMENTUM permits one controlled 10 USDT entry when a fresh move is
 *   liquid, not parabolic, low-risk and independently confirmed on Binance.
 * Neither lane can bypass reconciliation, exit health, autonomy or config gates.
 */
async function evaluatePaperToRealEntryGate(db, config = {}) {
  const now = Date.now();
  const maxScanAgeMinutes = Math.max(1, asNumber(config.paper_real_max_scan_age_minutes, 15));
  const reasons = [];

  const [latestScanSnapshot, candidateSnapshot, validationSnapshot, paperResultSnapshot] = await Promise.all([
    db.collection(SCANS).orderBy('created_at', 'desc').limit(1).get(),
    db.collection(CANDIDATES).orderBy('opportunityScore', 'desc').limit(250).get(),
    db.collection(VALIDATIONS).orderBy('observed_at', 'desc').limit(500).get(),
    db.collection(PAPER_RESULTS).orderBy('closed_at', 'desc').limit(300).get()
  ]);

  if (latestScanSnapshot.empty) reasons.push('NO_PAPER_SCAN');
  if (candidateSnapshot.empty) reasons.push('NO_PAPER_CANDIDATES');

  const latestScan = latestScanSnapshot.empty ? null : { id: latestScanSnapshot.docs[0].id, ...latestScanSnapshot.docs[0].data() };
  const scanAgeMinutes = latestScan ? (now - toMillis(latestScan.created_at)) / 60000 : null;
  if (latestScan && (!Number.isFinite(scanAgeMinutes) || scanAgeMinutes < 0 || scanAgeMinutes > maxScanAgeMinutes)) reasons.push('PAPER_SCAN_STALE');

  const candidates = candidateSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const latestUnique = uniqueLatestCandidates(candidates, latestScan?.id);
  const scoreFiltered = latestUnique.filter((candidate) => candidateScore(candidate) >= asNumber(config.min_opportunity_score, 0));
  const categoryFiltered = Array.isArray(config.allowed_categories) && config.allowed_categories.length
    ? scoreFiltered.filter((candidate) => config.allowed_categories.includes(candidate.category))
    : scoreFiltered;

  const validationRows = validationSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const paperRows = paperResultSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const candidateAudit = buildCandidateAudit(categoryFiltered, validationRows, paperRows, latestScan?.id, config);

  let predicted = null;
  let entryMode = null;
  let laneEvaluation = null;
  let validation = null;

  for (let index = 0; index < categoryFiltered.length; index += 1) {
    const candidate = categoryFiltered[index];
    const evidence = validationEvidenceForSymbol(validationRows, paperRows, candidate.symbol, latestScan?.id);
    const standard = evaluateStandardCandidate(candidate, evidence, config, categoryFiltered[index + 1] || null);
    if (standard.allowed) {
      predicted = candidate;
      entryMode = 'STANDARD_PAPER_TO_REAL';
      laneEvaluation = standard;
      validation = evidence;
      break;
    }
  }

  if (!predicted) {
    for (const candidate of categoryFiltered) {
      const evidence = validationEvidenceForSymbol(validationRows, paperRows, candidate.symbol, latestScan?.id);
      const tactical = evaluateTacticalMomentumCandidate(candidate, evidence, config);
      if (tactical.allowed) {
        predicted = candidate;
        entryMode = 'TACTICAL_MOMENTUM';
        laneEvaluation = tactical;
        validation = evidence;
        break;
      }
    }
  }

  if (!predicted) reasons.push('NO_STANDARD_OR_TACTICAL_CANDIDATE');

  const symbol = String(predicted?.symbol || '').toUpperCase();
  const duplicates = latestScan && predicted
    ? candidates.filter((candidate) => String(candidate.scan_id || '') === String(latestScan.id) && String(candidate.symbol || '').toUpperCase() === symbol && !isRejected(candidate))
    : [];
  if (predicted && duplicates.length > 1) reasons.push('DUPLICATE_SYMBOL_IN_LATEST_RANKING');

  let technical = null;
  const structuralReasons = new Set(['PAPER_SCAN_STALE', 'DUPLICATE_SYMBOL_IN_LATEST_RANKING', 'NO_STANDARD_OR_TACTICAL_CANDIDATE']);
  if (predicted && !reasons.some((reason) => structuralReasons.has(reason))) {
    const technicalConfig = entryMode === 'TACTICAL_MOMENTUM'
      ? {
          ...config,
          paper_real_min_technical_score: laneEvaluation.thresholds.minimum_technical_score,
          paper_real_min_timeframe_confirmations: laneEvaluation.thresholds.minimum_timeframe_confirmations
        }
      : config;
    technical = await evaluateSpotTechnicalConfirmation(symbol, technicalConfig);
    if (technical.allowed !== true) reasons.push(...technical.reasons.map((reason) => `TECHNICAL_${reason}`));
  } else if (predicted) {
    reasons.push('TECHNICAL_CONFIRMATION_SKIPPED');
  }

  const score = candidateScore(predicted || {});
  const volume = candidateVolume(predicted || {});
  const decision = {
    created_at: new Date(now).toISOString(),
    allowed: reasons.length === 0,
    entry_mode: entryMode,
    tactical_entry: entryMode === 'TACTICAL_MOMENTUM',
    reasons: [...new Set(reasons)],
    failed_conditions: [...new Set(reasons)].map((reason) => ({ condition: reason, component: reason.startsWith('TECHNICAL_') ? 'Technical Confirmation' : 'Paper-to-Real' })),
    candidate: predicted ? {
      id: predicted.id,
      symbol,
      scan_id: predicted.scan_id || null,
      score,
      opportunityScore: score,
      score_separation: laneEvaluation?.score_separation ?? null,
      category: predicted.category || null,
      quote_volume_24h: volume,
      quoteVolume24h: volume,
      priceChange24h: candidateMetric(predicted, 'priceChange24h', 'price_change_24h'),
      impulseScore: candidateMetric(predicted, 'impulseScore', 'impulse_score'),
      liquidityScore: candidateMetric(predicted, 'liquidityScore', 'liquidity_score'),
      riskScore: candidateMetric(predicted, 'riskScore', 'risk_score'),
      warnings: predicted.warnings || [],
      recommendation: predicted.recommendation || null,
      reasons: predicted.reasons || [],
      entry_mode: entryMode
    } : null,
    validation,
    technical_confirmation: technical,
    latest_scan_id: latestScan?.id || null,
    latest_scan_age_minutes: scanAgeMinutes === null ? null : Number(scanAgeMinutes.toFixed(3)),
    unique_candidates_in_latest_scan: latestUnique.length,
    candidate_pool_audit: candidateAudit,
    thresholds: {
      maximum_scan_age_minutes: maxScanAgeMinutes,
      standard: evaluateStandardCandidate({}, null, config).thresholds,
      tactical_momentum: tacticalThresholds(config)
    },
    real_mode: true,
    paper_evidence_only: entryMode !== 'TACTICAL_MOMENTUM',
    spot_only: true,
    maximum_real_order_usdt: 10,
    no_order_created: true,
    version: 'paper_to_real_entry_gate_v4_tactical_momentum'
  };

  await saveDecision(db, decision);
  return decision;
}

module.exports = {
  evaluatePaperToRealEntryGate,
  candidateScore,
  candidateVolume,
  uniqueLatestCandidates,
  validationEvidenceForSymbol,
  tacticalThresholds,
  evaluateTacticalMomentumCandidate,
  evaluateStandardCandidate,
  buildCandidateAudit
};
