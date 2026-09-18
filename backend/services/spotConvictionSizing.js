'use strict';

const NORMAL_POSITION_USDT = 15;
const HIGH_CONVICTION_POSITION_USDT = 30;
const EXCEPTIONAL_CONVICTION_POSITION_USDT = 40;
const LEVERAGED_POSITION_USDT = 5;
const MIN_CASH_RESERVE_USDT = 40;
const CASH_RESERVE_PCT = 0.20;

function n(value, fallback = NaN) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function safeRatio(value, baseline) {
  const a = n(value);
  const b = n(baseline);
  return Number.isFinite(a) && Number.isFinite(b) && b > 0 ? a / b : 0;
}

function classifyConviction(input = {}) {
  const lane = String(input.lane || 'CORE').toUpperCase();

  if (lane === 'V10_HUNTER') {
    const scoreEdge = safeRatio(input.microflowScore, input.microflowCut);
    const marginEdge = safeRatio(input.microflowMargin, input.microflowMarginCut);
    const winRate = n(input.calibrationWinRate, 0);

    if (scoreEdge >= 1.45 && marginEdge >= 1.75 && winRate >= 0.60) {
      return { tier: 'EXCEPTIONAL', cap_usdt: EXCEPTIONAL_CONVICTION_POSITION_USDT, score_edge: scoreEdge, margin_edge: marginEdge };
    }
    if (scoreEdge >= 1.20 && marginEdge >= 1.20 && winRate >= 0.58) {
      return { tier: 'HIGH', cap_usdt: HIGH_CONVICTION_POSITION_USDT, score_edge: scoreEdge, margin_edge: marginEdge };
    }
    return { tier: 'NORMAL', cap_usdt: NORMAL_POSITION_USDT, score_edge: scoreEdge, margin_edge: marginEdge };
  }

  const score = n(input.v61Score);
  const passCount = Math.max(0, Math.floor(n(input.v42PassCount, 0)));
  const norm = n(input.v42Norm, 0);

  if (passCount >= 3 && norm >= 0.985 && Number.isFinite(score) && score >= 1.05) {
    return { tier: 'EXCEPTIONAL', cap_usdt: EXCEPTIONAL_CONVICTION_POSITION_USDT };
  }
  if (passCount >= 3 && norm >= 0.94 && Number.isFinite(score) && score >= 0.80) {
    return { tier: 'HIGH', cap_usdt: HIGH_CONVICTION_POSITION_USDT };
  }
  return { tier: 'NORMAL', cap_usdt: NORMAL_POSITION_USDT };
}

function tierFractionFloor(tier) {
  if (tier === 'EXCEPTIONAL') return 0.20;
  if (tier === 'HIGH') return 0.15;
  return 0;
}

function floorCents(value) {
  return Math.floor(Math.max(0, Number(value) || 0) * 100) / 100;
}

function resolveConvictionPosition(input = {}) {
  const classification = classifyConviction(input);
  const usdtFree = Math.max(0, n(input.usdtFree, 0));
  const baseFraction = Math.max(0, n(input.baseFraction, 0));
  const isLeveraged = input.isLeveraged === true;

  const reserveUsdt = Math.max(MIN_CASH_RESERVE_USDT, usdtFree * CASH_RESERVE_PCT);
  const spendableUsdt = Math.max(0, usdtFree - reserveUsdt);
  const effectiveFraction = Math.max(baseFraction, tierFractionFloor(classification.tier));
  const fractionTargetUsdt = usdtFree * effectiveFraction;
  const capUsdt = isLeveraged ? LEVERAGED_POSITION_USDT : classification.cap_usdt;
  const quoteOrderQty = floorCents(Math.min(capUsdt, spendableUsdt, fractionTargetUsdt));

  return {
    ...classification,
    tier: isLeveraged ? 'LEVERAGED' : classification.tier,
    cap_usdt: capUsdt,
    reserve_usdt: floorCents(reserveUsdt),
    spendable_usdt: floorCents(spendableUsdt),
    effective_fraction: effectiveFraction,
    quote_order_qty: quoteOrderQty
  };
}

module.exports = {
  NORMAL_POSITION_USDT,
  HIGH_CONVICTION_POSITION_USDT,
  EXCEPTIONAL_CONVICTION_POSITION_USDT,
  LEVERAGED_POSITION_USDT,
  MIN_CASH_RESERVE_USDT,
  CASH_RESERVE_PCT,
  classifyConviction,
  resolveConvictionPosition
};
