'use strict';

const { evaluateSpotTechnicalConfirmation } = require('./spotTechnicalConfirmation');
const { summarizePositiveValidation } = require('../lib/spotPaperRiskRules');

const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';
const PAPER_RESULTS = 'spot_paper_execution_results';
const DECISIONS = 'real_spot_entry_gate_decisions';

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

async function saveDecision(db, decision) {
  try {
    const id = `paper_real_gate_${Date.now()}`;
    await db.collection(DECISIONS).doc(id).set({ id, ...decision }, { merge: true });
  } catch (error) {
    console.warn('[PAPER_TO_REAL_GATE] Decision log failed:', error.message);
  }
}

/**
 * Evaluates the newest ranked opportunity against previously completed Paper
 * evidence for the same symbol, then performs an independent live technical
 * confirmation. A new scan is no longer required to contain one-hour-old
 * validation results, which was temporally impossible while scans expired in
 * minutes. This gate never creates an order.
 */
async function evaluatePaperToRealEntryGate(db, config = {}) {
  const now = Date.now();
  const maxScanAgeMinutes = Math.max(1, asNumber(config.paper_real_max_scan_age_minutes, 15));
  const minimumScore = Math.max(asNumber(config.min_opportunity_score, 0), asNumber(config.paper_real_min_score, 90));
  const minimumVolume = Math.max(0, asNumber(config.paper_real_min_quote_volume_usdt, 1000000));
  const minimumValidationSamples = Math.max(1, asNumber(config.paper_real_min_validation_samples, 3));
  const minimumPositiveRate = Math.max(0.5, Math.min(1, asNumber(config.paper_real_min_positive_rate, 0.6)));
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
  const predicted = categoryFiltered[0] || null;
  if (!predicted) reasons.push('NO_EXECUTOR_CANDIDATE');

  const symbol = String(predicted?.symbol || '').toUpperCase();
  const score = candidateScore(predicted || {});
  const volume = candidateVolume(predicted || {});
  if (predicted && score < minimumScore) reasons.push('PAPER_SCORE_BELOW_REAL_THRESHOLD');
  if (predicted && volume < minimumVolume) reasons.push('INSUFFICIENT_24H_QUOTE_VOLUME');

  const duplicates = latestScan ? candidates.filter((candidate) => String(candidate.scan_id || '') === String(latestScan.id) && String(candidate.symbol || '').toUpperCase() === symbol && !isRejected(candidate)) : [];
  if (predicted && duplicates.length > 1) reasons.push('DUPLICATE_SYMBOL_IN_LATEST_RANKING');

  const runnerUp = categoryFiltered[1] || null;
  const scoreSeparation = predicted && runnerUp ? score - candidateScore(runnerUp) : null;
  const minimumSeparation = Math.max(0, asNumber(config.paper_real_min_score_separation, 0.5));
  if (predicted && runnerUp && scoreSeparation < minimumSeparation) reasons.push('AMBIGUOUS_TOP_SCORE');

  const validationRows = validationSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const paperRows = paperResultSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const validation = predicted ? validationEvidenceForSymbol(validationRows, paperRows, symbol, latestScan?.id) : null;
  if (predicted && validation.sample_size < minimumValidationSamples) reasons.push('INSUFFICIENT_HISTORICAL_PAPER_EVIDENCE');
  if (predicted && validation.sample_size >= minimumValidationSamples && validation.positive_rate < minimumPositiveRate) reasons.push('HISTORICAL_PAPER_POSITIVE_RATE_TOO_LOW');

  let technical = null;
  const structuralReasons = new Set(['PAPER_SCAN_STALE', 'DUPLICATE_SYMBOL_IN_LATEST_RANKING', 'AMBIGUOUS_TOP_SCORE', 'NO_EXECUTOR_CANDIDATE']);
  if (predicted && !reasons.some((reason) => structuralReasons.has(reason))) {
    technical = await evaluateSpotTechnicalConfirmation(symbol, config);
    if (technical.allowed !== true) reasons.push(...technical.reasons.map((reason) => `TECHNICAL_${reason}`));
  } else if (predicted) {
    reasons.push('TECHNICAL_CONFIRMATION_SKIPPED');
  }

  const decision = {
    created_at: new Date(now).toISOString(),
    allowed: reasons.length === 0,
    reasons: [...new Set(reasons)],
    failed_conditions: [...new Set(reasons)].map((reason) => ({ condition: reason, component: reason.startsWith('TECHNICAL_') ? 'Technical Confirmation' : 'Paper-to-Real' })),
    candidate: predicted ? {
      id: predicted.id,
      symbol,
      scan_id: predicted.scan_id || null,
      score,
      opportunityScore: score,
      score_separation: scoreSeparation,
      category: predicted.category || null,
      quote_volume_24h: volume,
      quoteVolume24h: volume,
      recommendation: predicted.recommendation || null,
      reasons: predicted.reasons || []
    } : null,
    validation,
    technical_confirmation: technical,
    latest_scan_id: latestScan?.id || null,
    latest_scan_age_minutes: scanAgeMinutes === null ? null : Number(scanAgeMinutes.toFixed(3)),
    unique_candidates_in_latest_scan: latestUnique.length,
    thresholds: {
      minimum_score: minimumScore,
      minimum_score_separation: minimumSeparation,
      minimum_quote_volume_usdt: minimumVolume,
      maximum_scan_age_minutes: maxScanAgeMinutes,
      minimum_validation_samples: minimumValidationSamples,
      minimum_positive_rate: minimumPositiveRate,
      minimum_technical_score: asNumber(config.paper_real_min_technical_score, 65),
      minimum_timeframe_confirmations: asNumber(config.paper_real_min_timeframe_confirmations, 2)
    },
    real_mode: true,
    paper_evidence_only: true,
    spot_only: true,
    no_order_created: true,
    version: 'paper_to_real_entry_gate_v3_historical_evidence'
  };

  await saveDecision(db, decision);
  return decision;
}

module.exports = {
  evaluatePaperToRealEntryGate,
  candidateScore,
  candidateVolume,
  uniqueLatestCandidates,
  validationEvidenceForSymbol
};