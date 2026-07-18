'use strict';

const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';
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
  return asNumber(
    candidate.opportunityScore ?? candidate.opportunity_score ?? candidate.score ?? candidate.final_score,
    0
  );
}

function candidateVolume(candidate) {
  return asNumber(
    candidate.quoteVolume24h ?? candidate.quote_volume_24h ?? candidate.volume24h,
    0
  );
}

function isRejected(candidate) {
  const status = String(candidate.status || '').toUpperCase();
  return candidate.rejected === true || ['REJECTED', 'DISCARDED', 'BLOCKED'].includes(status);
}

function isValidationPositive(validation) {
  const status = String(validation?.status || validation?.result || '').toUpperCase();
  return validation?.positive === true || validation?.is_positive === true || ['POSITIVE', 'PASSED', 'APPROVED'].includes(status);
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
 * Predicts the same first candidate used by the legacy real executor, then
 * requires current Paper evidence before allowing that executor to run.
 * It creates no order and never changes exposure limits.
 */
async function evaluatePaperToRealEntryGate(db, config = {}) {
  const now = Date.now();
  const maxScanAgeMinutes = Math.max(1, asNumber(config.paper_real_max_scan_age_minutes, 15));
  const minimumScore = Math.max(asNumber(config.min_opportunity_score, 0), asNumber(config.paper_real_min_score, 90));
  const minimumVolume = Math.max(0, asNumber(config.paper_real_min_quote_volume_usdt, 1000000));
  const minimumValidationSamples = Math.max(0, asNumber(config.paper_real_min_validation_samples, 1));
  const reasons = [];

  const [latestScanSnapshot, candidateSnapshot] = await Promise.all([
    db.collection(SCANS).orderBy('created_at', 'desc').limit(1).get(),
    db.collection(CANDIDATES).orderBy('opportunityScore', 'desc').limit(100).get()
  ]);

  if (latestScanSnapshot.empty) reasons.push('NO_PAPER_SCAN');
  if (candidateSnapshot.empty) reasons.push('NO_PAPER_CANDIDATES');

  const latestScan = latestScanSnapshot.empty
    ? null
    : { id: latestScanSnapshot.docs[0].id, ...latestScanSnapshot.docs[0].data() };
  const scanAgeMinutes = latestScan
    ? (now - toMillis(latestScan.created_at)) / 60000
    : null;

  if (latestScan && (!Number.isFinite(scanAgeMinutes) || scanAgeMinutes < 0 || scanAgeMinutes > maxScanAgeMinutes)) {
    reasons.push('PAPER_SCAN_STALE');
  }

  const candidates = candidateSnapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const scoreFiltered = candidates.filter((candidate) =>
    !isRejected(candidate) && candidateScore(candidate) >= asNumber(config.min_opportunity_score, 0)
  );
  const categoryFiltered = Array.isArray(config.allowed_categories) && config.allowed_categories.length
    ? scoreFiltered.filter((candidate) => config.allowed_categories.includes(candidate.category))
    : scoreFiltered;
  const predicted = categoryFiltered[0] || null;

  if (!predicted) reasons.push('NO_EXECUTOR_CANDIDATE');

  const symbol = String(predicted?.symbol || '').toUpperCase();
  const score = candidateScore(predicted || {});
  const volume = candidateVolume(predicted || {});

  if (predicted && latestScan && String(predicted.scan_id || '') !== String(latestScan.id)) {
    reasons.push('EXECUTOR_CANDIDATE_NOT_FROM_LATEST_SCAN');
  }
  if (predicted && score < minimumScore) reasons.push('PAPER_SCORE_BELOW_REAL_THRESHOLD');
  if (predicted && volume < minimumVolume) reasons.push('INSUFFICIENT_24H_QUOTE_VOLUME');

  const sameSymbolInLatestScan = latestScan
    ? candidates.filter((candidate) =>
      String(candidate.scan_id || '') === String(latestScan.id) &&
      String(candidate.symbol || '').toUpperCase() === symbol &&
      !isRejected(candidate)
    )
    : [];
  if (predicted && sameSymbolInLatestScan.length !== 1) reasons.push('DUPLICATE_SYMBOL_IN_LATEST_RANKING');

  const topScoreCount = latestScan
    ? candidates.filter((candidate) =>
      String(candidate.scan_id || '') === String(latestScan.id) &&
      !isRejected(candidate) &&
      Math.abs(candidateScore(candidate) - score) < 0.000001
    ).length
    : 0;
  if (predicted && topScoreCount > 1) reasons.push('AMBIGUOUS_TOP_SCORE');

  let validation = null;
  if (predicted && latestScan) {
    const validationSnapshot = await db.collection(VALIDATIONS)
      .where('scan_id', '==', latestScan.id)
      .get();
    const validationDoc = validationSnapshot.docs.find((doc) =>
      String(doc.data()?.symbol || '').toUpperCase() === symbol
    );
    validation = validationDoc ? { id: validationDoc.id, ...validationDoc.data() } : null;
  }

  if (!validation) reasons.push('PAPER_VALIDATION_MISSING');
  if (validation && !isValidationPositive(validation)) reasons.push('PAPER_VALIDATION_NOT_POSITIVE');

  const validationSamples = asNumber(
    validation?.sample_size ?? validation?.completed_count ?? validation?.observations,
    0
  );
  if (validation && validationSamples < minimumValidationSamples) reasons.push('PAPER_VALIDATION_SAMPLE_TOO_SMALL');

  const decision = {
    created_at: new Date(now).toISOString(),
    allowed: reasons.length === 0,
    reasons,
    candidate: predicted ? {
      id: predicted.id,
      symbol,
      scan_id: predicted.scan_id || null,
      score,
      category: predicted.category || null,
      quote_volume_24h: volume
    } : null,
    validation: validation ? {
      id: validation.id,
      positive: isValidationPositive(validation),
      status: validation.status || validation.result || null,
      sample_size: validationSamples
    } : null,
    latest_scan_id: latestScan?.id || null,
    latest_scan_age_minutes: scanAgeMinutes === null ? null : Number(scanAgeMinutes.toFixed(3)),
    thresholds: {
      minimum_score: minimumScore,
      minimum_quote_volume_usdt: minimumVolume,
      maximum_scan_age_minutes: maxScanAgeMinutes,
      minimum_validation_samples: minimumValidationSamples
    },
    real_mode: true,
    paper_evidence_only: true,
    spot_only: true,
    no_order_created: true,
    version: 'paper_to_real_entry_gate_v1'
  };

  await saveDecision(db, decision);
  return decision;
}

module.exports = {
  evaluatePaperToRealEntryGate,
  candidateScore,
  candidateVolume,
  isValidationPositive
};
