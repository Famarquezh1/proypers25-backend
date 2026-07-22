'use strict';

const SCANS = 'spot_opportunity_scans';
const CANDIDATES = 'spot_opportunity_candidates';
const VALIDATIONS = 'spot_opportunity_validations';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, number(value)));
}

function round(value, decimals = 2) {
  return Number(number(value).toFixed(decimals));
}

function latestCompletedHorizon(validation = {}) {
  const values = Object.values(validation.horizons || {}).filter((item) => item?.status === 'completed');
  return values.sort((a, b) => number(b.hours) - number(a.hours))[0] || null;
}

function buildDiscoveryCandidate(candidate = {}, validation = null) {
  const opportunity = number(candidate.opportunityScore ?? candidate.opportunity_score ?? candidate.score);
  const risk = number(candidate.riskScore ?? candidate.risk_score);
  const liquidity = number(candidate.liquidityScore ?? candidate.liquidity_score);
  const volume = number(candidate.volumeChangeScore ?? candidate.volume_change_score);
  const breakout = number(candidate.breakoutScore ?? candidate.breakout_score);
  const accumulation = number(candidate.accumulationScore ?? candidate.accumulation_score);
  const impulse = number(candidate.impulseScore ?? candidate.impulse_score);
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons : [];
  const warnings = Array.isArray(candidate.warnings) ? candidate.warnings : [];
  const completed = latestCompletedHorizon(validation || {});
  const validationBonus = completed ? clamp(number(completed.max_favorable_move_pct) * 1.5, -10, 15) : 0;
  const signalBreadth = clamp(reasons.length * 8, 0, 24);
  const conviction = clamp(
    opportunity * 0.5 +
    liquidity * 0.12 +
    volume * 0.1 +
    breakout * 0.08 +
    accumulation * 0.08 +
    impulse * 0.08 +
    signalBreadth -
    risk * 0.24 +
    validationBonus
  );
  const asymmetry = clamp((opportunity * 0.55) + (impulse * 0.15) + (breakout * 0.15) + (accumulation * 0.15) - (risk * 0.35));
  const status = risk >= 75 ? 'REJECTED_RISK' : conviction >= 75 ? 'HIGH_CONVICTION' : conviction >= 60 ? 'WATCH_CLOSELY' : conviction >= 45 ? 'WATCH' : 'IGNORE';

  return {
    symbol: String(candidate.symbol || '').toUpperCase(),
    detected_at: candidate.created_at || null,
    detection_price: number(candidate.price, null),
    quote_volume_24h: number(candidate.quoteVolume24h ?? candidate.quote_volume_24h),
    opportunity_score: round(opportunity),
    conviction_score: round(conviction),
    asymmetry_score: round(asymmetry),
    risk_score: round(risk),
    category: candidate.category || 'WATCHLIST',
    recommendation: candidate.recommendation || null,
    status,
    reasons: reasons.slice(0, 8),
    warnings: warnings.slice(0, 8),
    shadow_only: true,
    validation: completed ? {
      horizon: completed.label || null,
      variation_pct: round(completed.variation_pct),
      max_favorable_move_pct: round(completed.max_favorable_move_pct),
      max_adverse_move_pct: round(completed.max_adverse_move_pct)
    } : null
  };
}

async function getDiscoveryIntelligence(db, options = {}) {
  if (!db) throw new Error('discovery_requires_db');
  const limit = Math.max(5, Math.min(100, number(options.limit, 30)));
  const scanSnapshot = await db.collection(SCANS).orderBy('created_at', 'desc').limit(1).get();
  if (scanSnapshot.empty) {
    return { scan: null, ranking: [], summary: { tracked: 0, actionable: 0, high_conviction: 0 } };
  }

  const scanDoc = scanSnapshot.docs[0];
  const scan = { id: scanDoc.id, ...(scanDoc.data() || {}) };
  const [candidateSnapshot, validationSnapshot] = await Promise.all([
    db.collection(CANDIDATES).where('scan_id', '==', scan.id).get(),
    db.collection(VALIDATIONS).where('scan_id', '==', scan.id).get()
  ]);
  const validations = new Map(validationSnapshot.docs.map((doc) => {
    const value = doc.data() || {};
    return [String(value.symbol || '').toUpperCase(), value];
  }));
  const ranking = candidateSnapshot.docs
    .map((doc) => {
      const candidate = { id: doc.id, ...(doc.data() || {}) };
      return buildDiscoveryCandidate(candidate, validations.get(String(candidate.symbol || '').toUpperCase()) || null);
    })
    .sort((a, b) => b.conviction_score - a.conviction_score || b.asymmetry_score - a.asymmetry_score)
    .map((item, index) => ({ ...item, rank: index + 1 }))
    .slice(0, limit);

  return {
    scan: { id: scan.id, created_at: scan.created_at || null, scanner_version: scan.scanner_version || null },
    mode: 'SHADOW',
    real_orders_enabled: false,
    ranking,
    summary: {
      tracked: ranking.length,
      actionable: ranking.filter((item) => ['HIGH_CONVICTION', 'WATCH_CLOSELY'].includes(item.status)).length,
      high_conviction: ranking.filter((item) => item.status === 'HIGH_CONVICTION').length,
      rejected_risk: ranking.filter((item) => item.status === 'REJECTED_RISK').length,
      top_symbol: ranking[0]?.symbol || null,
      top_conviction: ranking[0]?.conviction_score || null
    }
  };
}

module.exports = { buildDiscoveryCandidate, getDiscoveryIntelligence };
