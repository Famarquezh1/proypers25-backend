'use strict';

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 100) {
  return Math.min(max, Math.max(min, asNumber(value, min)));
}

const SOFT_TECHNICAL_REASONS = new Set([
  'TECHNICAL_SCORE_BELOW_THRESHOLD',
  'TECHNICAL_TECHNICAL_SCORE_BELOW_THRESHOLD',
  'TECHNICAL_MOVE_OVEREXTENDED',
  'TECHNICAL_VOLUME_NOT_CONFIRMED',
  'TECHNICAL_INSUFFICIENT_TIMEFRAME_CONFIRMATION'
]);

function softTechnicalReason(reason) {
  return SOFT_TECHNICAL_REASONS.has(String(reason || ''));
}

function hasReason(reasons, ...codes) {
  return codes.some((code) => reasons.includes(code));
}

function evaluateQuantEntryDecision({ paperGate = {}, adaptiveGate = {}, config = {} } = {}) {
  const candidate = paperGate.candidate || {};
  const technical = paperGate.technical_confirmation || {};
  const selectionLane = String(paperGate.selection_lane || candidate.selection_lane || '').toUpperCase();
  const fastLane = selectionLane === 'EARLY_MOMENTUM' || selectionLane === 'TACTICAL_MOMENTUM';
  const paperReasons = Array.isArray(paperGate.reasons) ? paperGate.reasons : [];
  const hardPaperReasons = paperReasons.filter((reason) => !softTechnicalReason(reason));
  const adaptiveReasons = Array.isArray(adaptiveGate.reasons) ? adaptiveGate.reasons : [];
  const adaptiveCompatible = adaptiveGate.allowed !== false || (
    adaptiveGate.state === 'DEGRADED'
    && adaptiveReasons.length === 1
    && adaptiveReasons[0] === 'DRAWDOWN_TOO_HIGH'
  );

  const momentum = clamp(Math.max(
    asNumber(candidate.earlyMomentumScore ?? candidate.early_momentum_score, 0),
    asNumber(candidate.impulseScore ?? candidate.impulse_score, 0)
  ));
  const technicalScore = clamp(technical.score);
  const liquidity = clamp(candidate.liquidityScore ?? candidate.liquidity_score);
  const volume = clamp(candidate.earlyMomentum?.volume_score ?? candidate.early_momentum?.volume_score ?? 0);
  const structure = clamp(candidate.earlyMomentum?.structure_score ?? candidate.early_momentum?.structure_score ?? 0);
  const opportunity = clamp(candidate.score ?? candidate.opportunityScore ?? candidate.opportunity_score);
  const risk = clamp(candidate.riskScore ?? candidate.risk_score);

  let penalty = risk * 0.20;
  if (hasReason(paperReasons, 'TECHNICAL_MOVE_OVEREXTENDED')) penalty += 5;
  if (hasReason(paperReasons, 'TECHNICAL_VOLUME_NOT_CONFIRMED')) penalty += 3;
  if (hasReason(paperReasons, 'TECHNICAL_INSUFFICIENT_TIMEFRAME_CONFIRMATION')) penalty += 4;
  if (hasReason(paperReasons, 'TECHNICAL_SCORE_BELOW_THRESHOLD', 'TECHNICAL_TECHNICAL_SCORE_BELOW_THRESHOLD')) penalty += 3;
  if (adaptiveReasons.includes('DRAWDOWN_TOO_HIGH')) penalty += 3;

  const score = clamp(
    (momentum * 0.30) +
    (technicalScore * 0.20) +
    (liquidity * 0.15) +
    (volume * 0.15) +
    (structure * 0.10) +
    (opportunity * 0.10) - penalty
  );

  const historicalPositiveRate = paperGate.validation?.sample_size > 0
    ? clamp(asNumber(paperGate.validation.positive_rate, 0.5) * 100) / 100
    : clamp(score / 100, 0.45, 0.75);
  const modeledWinProbability = Math.min(0.85, Math.max(0.35, (historicalPositiveRate * 0.55) + ((score / 100) * 0.45)));
  const rewardPct = Math.max(0.25, asNumber(config.quant_entry_reward_pct ?? config.take_profit_pct, 2.5));
  const lossPct = Math.max(0.25, asNumber(config.quant_entry_loss_pct ?? config.stop_loss_pct, 1.5));
  const roundTripCostPct = Math.max(0, asNumber(config.quant_entry_round_trip_cost_pct, 0.25));
  const expectedValuePct = (modeledWinProbability * rewardPct) - ((1 - modeledWinProbability) * lossPct) - roundTripCostPct;
  const minimumScore = Math.max(70, asNumber(config.quant_entry_min_score, 72));
  const minimumEvPct = Math.max(0, asNumber(config.quant_entry_min_ev_pct, 0.20));

  const allowed = fastLane
    && adaptiveCompatible
    && hardPaperReasons.length === 0
    && score >= minimumScore
    && expectedValuePct >= minimumEvPct;

  return {
    allowed,
    policy: 'quantitative_fast_lane_v1',
    score: Number(score.toFixed(2)),
    minimum_score: minimumScore,
    modeled_win_probability: Number(modeledWinProbability.toFixed(4)),
    expected_value_pct: Number(expectedValuePct.toFixed(4)),
    minimum_expected_value_pct: minimumEvPct,
    reward_pct: rewardPct,
    loss_pct: lossPct,
    round_trip_cost_pct: roundTripCostPct,
    adaptive_compatible: adaptiveCompatible,
    components: {
      momentum,
      technical: technicalScore,
      liquidity,
      volume,
      structure,
      opportunity,
      risk_penalty: Number(penalty.toFixed(2))
    },
    soft_technical_reasons: paperReasons.filter(softTechnicalReason),
    hard_reasons: hardPaperReasons,
    adaptive_reasons: adaptiveReasons,
    selection_lane: selectionLane || null
  };
}

module.exports = {
  evaluateQuantEntryDecision,
  softTechnicalReason
};
