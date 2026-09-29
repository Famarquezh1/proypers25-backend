'use strict';

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function evaluateSpotMetaDecision({
  lane = 'CORE',
  localGuard = {},
  v61Score = 0,
  v42PassCount = 0,
  v42Norm = 0,
  signalPct = 0,
  currentPct = 0,
  exposureUsdt = 0,
  equityUsdt = 0
} = {}) {
  const m = localGuard.metrics || {};
  const reasons = [];
  const warnings = [];

  const continuationPass = m.continuationPass === true;
  const continuationScore = finite(m.continuationScore, -1);
  const manipulationRisk = clamp(finite(m.manipulationRisk, 1));
  const endReturn = finite(m.endReturnPct, -1);
  const peakToEnd = finite(m.peakToEndPct, -1);
  const spread = Math.max(0, finite(m.lastSpreadPct, 1));
  const score61 = finite(v61Score, 0);
  const quality42 = clamp(finite(v42Norm, 0));
  const pass42 = Math.max(0, Math.round(finite(v42PassCount, 0)));
  const advancePct = finite(currentPct) - finite(signalPct);
  const deployment = equityUsdt > 0 ? Math.max(0, finite(exposureUsdt) / finite(equityUsdt)) : 0;

  if (localGuard.allow === false) reasons.push('LOCAL_GUARD_BLOCK');
  if (!continuationPass) reasons.push('NO_CONTINUATION');
  if (manipulationRisk >= 0.65) reasons.push('MANIPULATION_RISK_HIGH');
  if (spread >= 0.004) reasons.push('SPREAD_TOO_WIDE');
  if (peakToEnd <= -0.008) reasons.push('PEAK_REJECTION');

  if (continuationScore < 0.15) warnings.push('CONTINUATION_MARGIN_THIN');
  if (endReturn <= 0) warnings.push('MICRO_PATH_NOT_ADVANCING');
  if (peakToEnd <= -0.003) warnings.push('MICRO_PULLBACK');
  if (manipulationRisk >= 0.40) warnings.push('MANIPULATION_RISK_ELEVATED');
  if (advancePct >= 2) warnings.push('POST_SIGNAL_EXTENSION');
  if (deployment >= 0.45) warnings.push('PORTFOLIO_ALREADY_DEPLOYED');

  let evidence = 0;
  evidence += clamp((continuationScore + 0.10) / 0.50) * 0.34;
  evidence += clamp((endReturn + 0.004) / 0.014) * 0.16;
  evidence += clamp((peakToEnd + 0.008) / 0.012) * 0.10;
  evidence += (1 - manipulationRisk) * 0.14;
  evidence += (1 - clamp(spread / 0.004)) * 0.08;
  evidence += quality42 * 0.10;
  evidence += clamp((score61 + 0.25) / 1.25) * 0.08;

  const hardReject = reasons.length > 0;
  let decision = 'WAIT';
  if (hardReject) decision = 'REJECT';
  else if (evidence >= 0.68 && warnings.length <= 1) decision = 'BUY';

  const confidence = clamp(
    decision === 'REJECT'
      ? 0.72 + Math.min(0.23, reasons.length * 0.06)
      : decision === 'BUY'
        ? 0.55 + Math.max(0, evidence - 0.68)
        : 0.52 + Math.min(0.25, warnings.length * 0.05)
  );

  return {
    version: 'SPOT_META_DECISION_SHADOW_V1',
    mode: 'SHADOW_ONLY',
    lane: String(lane || 'CORE').toUpperCase(),
    decision,
    confidence,
    evidence_score: evidence,
    reasons,
    warnings,
    features: {
      continuation_pass: continuationPass,
      continuation_score: continuationScore,
      manipulation_risk: manipulationRisk,
      end_return_pct: endReturn,
      peak_to_end_pct: peakToEnd,
      spread_pct: spread,
      v61_score: score61,
      v42_pass_count: pass42,
      v42_norm: quality42,
      post_signal_advance_pct_points: advancePct,
      deployed_equity_fraction: deployment
    }
  };
}

module.exports = { evaluateSpotMetaDecision };
