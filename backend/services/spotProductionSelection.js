'use strict';

const DEFAULT_SELECTION_GUARD = Object.freeze({
  minQuoteVolumeUsdt: 750000,
  minRecent15mReturn: -0.025,
  twoWindowMinQuoteVolumeUsdt: 2000000,
  twoWindowMinV42Norm: 0.74,
  twoWindowMinConfirm: 0.50,
  twoWindowMinExtension: 0.04
});

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function evaluateProductionCandidate(candidate, config = {}) {
  const cfg = { ...DEFAULT_SELECTION_GUARD, ...config };
  const qv = finite(candidate?.qv);
  const passWindows = Math.max(0, Math.trunc(finite(candidate?.v42_pass_windows)));
  const v42Norm = finite(candidate?.v42_norm);
  const confirm = finite(candidate?.v42_detail?.confirm, -Infinity);
  const extension = finite(candidate?.v42_detail?.extension, -Infinity);
  const r15 = finite(candidate?.v42_detail?.r15, -Infinity);
  const reasons = [];

  if (qv < cfg.minQuoteVolumeUsdt) reasons.push('THIN_LIQUIDITY');
  if (passWindows < 2) reasons.push('V42_ROBUSTNESS');
  // Do not commit capital into a candidate whose short-term move has already
  // reversed sharply. Discovery stays broad; this is only a production gate.
  if (r15 < cfg.minRecent15mReturn) reasons.push('RECENT_REVERSAL');

  // A 2/3 candidate can still be an early winner, but it must compensate for
  // the missing trained window with materially better liquidity and continuation.
  if (passWindows === 2) {
    if (qv < cfg.twoWindowMinQuoteVolumeUsdt) reasons.push('TWO_WINDOW_LIQUIDITY');
    if (v42Norm < cfg.twoWindowMinV42Norm) reasons.push('TWO_WINDOW_SCORE');
    if (confirm < cfg.twoWindowMinConfirm) reasons.push('TWO_WINDOW_CONFIRM');
    if (extension < cfg.twoWindowMinExtension) reasons.push('TWO_WINDOW_EXTENSION');
  }

  return {
    ok: reasons.length === 0,
    reasons,
    metrics: {
      quote_volume: qv,
      pass_windows: passWindows,
      v42_norm: v42Norm,
      confirm,
      extension,
      r15
    }
  };
}

function summarizeSelectionRejections(rows) {
  const counts = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    for (const reason of row?.selection_gate?.reasons || []) counts[reason] = (counts[reason] || 0) + 1;
  }
  return counts;
}

module.exports = {
  DEFAULT_SELECTION_GUARD,
  evaluateProductionCandidate,
  summarizeSelectionRejections
};
