'use strict';

const V42_THRESHOLDS = [
  { days: 30, i: 0.904010256302157, c: 0.30262335308700017, e: 0.0333071863419859 },
  { days: 45, i: 0.7912647052581232, c: 0.36672756172128707, e: 0.029510140018270917 },
  { days: 60, i: 1.6626658194027173, c: 0.43305908219072103, e: 0.019614079751271593 }
];

const ENTRY_COOLDOWN_MS = 7 * 60 * 1000;
const BURST_WINDOW_MS = 30 * 60 * 1000;
const EXTENDED_24H_PCT = 12;
const EXTENDED_CONTINUATION_MAX_24H_PCT = 18;
const HIGH_CORRELATION = 0.88;
const HIGH_QUALITY_NORM = 0.94;
const ELITE_QUALITY_NORM = 0.97;
const EARLY_CONFIRM_MIN_24H_PCT = 1.5;
const EARLY_CONFIRM_MAX_24H_PCT = 8;
const EARLY_CONFIRM_MIN_NORM = 0.82;
const EARLY_CONFIRM_MIN_IGNITION = 1.0;
const EARLY_CONFIRM_MIN_CONFIRM = 0.28;
const EARLY_CONFIRM_MIN_EXTENSION = 0.015;
const EARLY_CONFIRM_MAX_R15 = 0.04;
const EARLY_CONFIRM_MAX_R60 = 0.08;

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function avg(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function ret(a, b) {
  return a > 0 ? (b / a) - 1 : 0;
}

function qsum(rows, i, n) {
  let sum = 0;
  for (let k = Math.max(0, i - n + 1); k <= i; k += 1) sum += Number(rows[k]?.q || 0);
  return sum;
}

function v42QualityFromBars(symbolBars, btcBars) {
  const i = symbolBars.length - 2;
  const bi = btcBars.length - 2;
  if (i < 288 || bi < 48) return { valid: false, freshEnough: false, passCount: 0, norm: 0 };

  const c = Number(symbolBars[i].c || 0);
  const r15 = ret(Number(symbolBars[i - 3].c || 0), c);
  const r30 = ret(Number(symbolBars[i - 6].c || 0), c);
  const r60 = ret(Number(symbolBars[i - 12].c || 0), c);
  const r240 = ret(Number(symbolBars[i - 48].c || 0), c);
  const r24 = ret(Number(symbolBars[i - 288].c || 0), c);
  const base = avg(symbolBars.slice(i - 72, i - 12).map((x) => Number(x.q || 0))) * 12;
  const ph60 = Math.max(...symbolBars.slice(i - 12, i).map((x) => Number(x.h || 0)));
  const ph240 = Math.max(...symbolBars.slice(i - 48, i).map((x) => Number(x.h || 0)));
  const vol15 = base > 0 ? qsum(symbolBars, i, 3) / (base / 4) : 1;
  const vol30 = base > 0 ? qsum(symbolBars, i, 6) / (base / 2) : 1;
  const tradeAccel = Number(symbolBars[i].n || 0) / Math.max(1, avg(symbolBars.slice(i - 12, i).map((x) => Number(x.n || 0))));
  const breakout60 = ph60 > 0 ? c / ph60 - 1 : 0;
  const breakout240 = ph240 > 0 ? c / ph240 - 1 : 0;
  const btcR60 = ret(Number(btcBars[bi - 12].c || 0), Number(btcBars[bi].c || 0));
  const btcR240 = ret(Number(btcBars[bi - 48].c || 0), Number(btcBars[bi].c || 0));
  const rs60 = r60 - btcR60;
  const rs240 = r240 - btcR240;

  const ignition = 0.9 * Math.log(Math.max(0.2, vol15)) + 0.65 * Math.log(Math.max(0.2, tradeAccel)) + 0.65 * r15 + 0.35 * breakout60;
  const confirm = 1.2 * breakout60 + 0.65 * rs60 + 0.35 * Math.log(Math.max(0.2, vol30)) - 0.8 * Math.max(0, r24 - 0.10) - 0.5 * Math.max(0, r60 - 0.06);
  const extension = 1.15 * rs60 + 0.75 * rs240 + 0.35 * r30 + 0.25 * breakout240 - 0.45 * Math.max(0, r24 - 0.12);
  const freshEnough = r24 < 0.18 && r60 < 0.10 && r15 < 0.06;
  const passCount = freshEnough
    ? V42_THRESHOLDS.filter((th) => ignition >= th.i && confirm >= th.c && extension >= th.e).length
    : 0;
  const mid = V42_THRESHOLDS[1];
  const ignitionMargin = clamp(0.5 + (ignition - mid.i) / 2.0);
  const confirmMargin = clamp(0.5 + (confirm - mid.c) / 0.8);
  const extensionMargin = clamp(0.5 + (extension - mid.e) / 0.12);
  const norm = freshEnough
    ? clamp((passCount / 3) * 0.55 + ignitionMargin * 0.20 + confirmMargin * 0.15 + extensionMargin * 0.10)
    : 0;

  return {
    valid: true,
    freshEnough,
    passCount,
    norm,
    detail: { ignition, confirm, extension, r15, r60, r24 }
  };
}

function closedReturns(bars, periods = 24) {
  const lastClosed = bars.length - 2;
  if (lastClosed < 2) return [];
  const start = Math.max(1, lastClosed - Math.max(2, periods) + 1);
  const values = [];
  for (let i = start; i <= lastClosed; i += 1) {
    const previous = Number(bars[i - 1]?.c || 0);
    const current = Number(bars[i]?.c || 0);
    if (previous > 0 && current > 0) values.push(ret(previous, current));
  }
  return values;
}

function pearson(a, b) {
  const size = Math.min(a.length, b.length);
  if (size < 6) return NaN;
  const aa = a.slice(-size);
  const bb = b.slice(-size);
  const meanA = avg(aa);
  const meanB = avg(bb);
  let numerator = 0;
  let sumA = 0;
  let sumB = 0;
  for (let i = 0; i < size; i += 1) {
    const da = aa[i] - meanA;
    const db = bb[i] - meanB;
    numerator += da * db;
    sumA += da * da;
    sumB += db * db;
  }
  const denominator = Math.sqrt(sumA * sumB);
  return denominator > 0 ? numerator / denominator : NaN;
}

function returnCorrelationFromBars(candidateBars, peerBars, periods = 24) {
  return pearson(closedReturns(candidateBars, periods), closedReturns(peerBars, periods));
}

function evaluateSpotEntryBurstGate({
  lane = 'CORE',
  symbol = '',
  currentPct = 0,
  now = Date.now(),
  managedPositions = [],
  v42Quality = {},
  peerCorrelations = []
} = {}) {
  const target = String(symbol || '').toUpperCase();
  const positions = (Array.isArray(managedPositions) ? managedPositions : [])
    .map((position) => ({
      symbol: String(position?.symbol || '').toUpperCase(),
      openedAt: Number(position?.openedAt || 0)
    }))
    .filter((position) => position.symbol);

  if (positions.some((position) => position.symbol === target)) {
    return { allow: false, reason: 'same managed Spot position is already open', code: 'SAME_SYMBOL_OPEN' };
  }

  if (String(lane || 'CORE').toUpperCase() !== 'CORE') {
    return { allow: true, reason: 'non-CORE lane unchanged', code: 'NON_CORE_UNCHANGED' };
  }

  const passCount = Number(v42Quality?.passCount || 0);
  const norm = Number(v42Quality?.norm || 0);
  const highQuality = passCount === 3 && norm >= HIGH_QUALITY_NORM;
  const eliteQuality = passCount === 3 && norm >= ELITE_QUALITY_NORM;
  const recent = positions.filter((position) => position.openedAt > 0 && now >= position.openedAt && now - position.openedAt <= ENTRY_COOLDOWN_MS);
  const burst = positions.filter((position) => position.openedAt > 0 && now >= position.openedAt && now - position.openedAt <= BURST_WINDOW_MS);
  const finiteCorrelations = (Array.isArray(peerCorrelations) ? peerCorrelations : [])
    .map((item) => Number(item?.correlation))
    .filter(Number.isFinite);
  const maxCorrelation = finiteCorrelations.length ? Math.max(...finiteCorrelations) : null;

  if (recent.length > 0 && !eliteQuality) {
    return { allow: false, reason: `entry cooldown active (${recent.length} managed position opened in last 7m)`, code: 'ENTRY_COOLDOWN', diagnostics: { passCount, norm, maxCorrelation } };
  }
  if (burst.length >= 3 && !eliteQuality) {
    return { allow: false, reason: `entry burst saturated (${burst.length} managed positions opened in last 30m)`, code: 'BURST_SATURATED', diagnostics: { passCount, norm, maxCorrelation } };
  }
  if (burst.length >= 2 && !highQuality) {
    return { allow: false, reason: `entry burst requires 3/3 V4.2 quality (${burst.length} recent managed positions)`, code: 'BURST_QUALITY', diagnostics: { passCount, norm, maxCorrelation } };
  }
  if (Number(currentPct) >= EXTENDED_24H_PCT) {
    const detail = v42Quality?.detail || {};
    const extendedContinuation =
      Number(currentPct) < EXTENDED_CONTINUATION_MAX_24H_PCT &&
      highQuality &&
      Number(detail.r15) > 0 &&
      Number(detail.r15) <= 0.04 &&
      Number(detail.r60) > 0 &&
      Number(detail.r60) <= 0.08 &&
      Number(detail.confirm) >= 0.45 &&
      Number(detail.extension) >= 0.03;
    if (extendedContinuation) {
      return {
        allow: true,
        reason: 'extended high-conviction continuation admitted at reduced size',
        code: 'EXTENDED_CONTINUATION_ADMITTED',
        diagnostics: { passCount, norm, maxCorrelation, currentPct: Number(currentPct), r15: Number(detail.r15), r60: Number(detail.r60), confirm: Number(detail.confirm), extension: Number(detail.extension) }
      };
    }
    return { allow: false, reason: `CORE entry blocked at ${Number(currentPct).toFixed(2)}% 24h extension (standard limit ${EXTENDED_24H_PCT}%, continuation ceiling ${EXTENDED_CONTINUATION_MAX_24H_PCT}%)`, code: 'EXTENDED_ENTRY', diagnostics: { passCount, norm, maxCorrelation } };
  }
  if (maxCorrelation !== null && maxCorrelation >= HIGH_CORRELATION && !eliteQuality) {
    return { allow: false, reason: `correlated entry blocked (max 2h correlation ${maxCorrelation.toFixed(3)})`, code: 'CORRELATED_ENTRY', diagnostics: { passCount, norm, maxCorrelation } };
  }

  if (!highQuality) {
    const detail = v42Quality?.detail || {};
    const earlyConfirmation =
      passCount === 2 &&
      v42Quality?.freshEnough === true &&
      norm >= EARLY_CONFIRM_MIN_NORM &&
      Number(currentPct) >= EARLY_CONFIRM_MIN_24H_PCT &&
      Number(currentPct) < EARLY_CONFIRM_MAX_24H_PCT &&
      Number(detail.ignition) >= EARLY_CONFIRM_MIN_IGNITION &&
      Number(detail.confirm) >= EARLY_CONFIRM_MIN_CONFIRM &&
      Number(detail.extension) >= EARLY_CONFIRM_MIN_EXTENSION &&
      Number(detail.r15) > 0 &&
      Number(detail.r15) <= EARLY_CONFIRM_MAX_R15 &&
      Number(detail.r60) > 0 &&
      Number(detail.r60) <= EARLY_CONFIRM_MAX_R60;

    if (earlyConfirmation) {
      return {
        allow: true,
        reason: 'early CORE confirmation admitted at reduced initial size',
        code: 'EARLY_CONFIRMATION_ADMITTED',
        diagnostics: {
          passCount,
          norm,
          recentEntries7m: recent.length,
          recentEntries30m: burst.length,
          maxCorrelation,
          ignition: Number(detail.ignition),
          confirm: Number(detail.confirm),
          extension: Number(detail.extension),
          r15: Number(detail.r15),
          r60: Number(detail.r60),
          currentPct: Number(currentPct)
        }
      };
    }

    return {
      allow: false,
      reason: `CORE real entry requires 3/3 V4.2 quality and norm >= ${HIGH_QUALITY_NORM}, or strict early-confirmation criteria`,
      code: 'CORE_QUALITY_REQUIRED',
      diagnostics: { passCount, norm, recentEntries7m: recent.length, recentEntries30m: burst.length, maxCorrelation }
    };
  }

  return {
    allow: true,
    reason: 'high-conviction entry admitted',
    code: 'HIGH_CONVICTION_ADMITTED',
    diagnostics: { passCount, norm, recentEntries7m: recent.length, recentEntries30m: burst.length, maxCorrelation }
  };
}

module.exports = {
  ENTRY_COOLDOWN_MS,
  BURST_WINDOW_MS,
  EXTENDED_24H_PCT,
  EXTENDED_CONTINUATION_MAX_24H_PCT,
  HIGH_CORRELATION,
  HIGH_QUALITY_NORM,
  ELITE_QUALITY_NORM,
  EARLY_CONFIRM_MIN_24H_PCT,
  EARLY_CONFIRM_MAX_24H_PCT,
  EARLY_CONFIRM_MIN_NORM,
  EARLY_CONFIRM_MIN_IGNITION,
  EARLY_CONFIRM_MIN_CONFIRM,
  EARLY_CONFIRM_MIN_EXTENSION,
  EARLY_CONFIRM_MAX_R15,
  EARLY_CONFIRM_MAX_R60,
  v42QualityFromBars,
  returnCorrelationFromBars,
  evaluateSpotEntryBurstGate
};
