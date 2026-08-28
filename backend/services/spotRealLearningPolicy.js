'use strict';

const LEARNING_VERSION = 'spot_real_learning_policy_v1';
const MIN_OVERALL_SAMPLE = 20;
const MIN_BUCKET_SAMPLE = 6;
const NEGATIVE_EXPECTANCY_USDT = -0.02;
const NEGATIVE_WIN_RATE_PCT = 45;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function scoreBand(score) {
  const value = n(score, 0);
  if (value < 50) return 'SCORE_LT_50';
  if (value < 70) return 'SCORE_50_69';
  if (value < 85) return 'SCORE_70_84';
  return 'SCORE_85_PLUS';
}

function summarizeRows(rows = []) {
  const valid = rows.filter((row) => Number.isFinite(Number(row.net_pnl_usdt)));
  const wins = valid.filter((row) => n(row.net_pnl_usdt) > 0).length;
  const losses = valid.filter((row) => n(row.net_pnl_usdt) < 0).length;
  const pnl = valid.reduce((sum, row) => sum + n(row.net_pnl_usdt), 0);
  const expectancy = valid.length ? pnl / valid.length : 0;
  const winRate = valid.length ? (wins / valid.length) * 100 : 0;
  return {
    sample_size: valid.length,
    wins,
    losses,
    realized_pnl_usdt: Number(pnl.toFixed(8)),
    expectancy_usdt: Number(expectancy.toFixed(8)),
    win_rate_pct: Number(winRate.toFixed(4))
  };
}

function classifyBucket(summary = {}) {
  const enough = n(summary.sample_size) >= MIN_BUCKET_SAMPLE;
  if (!enough) return 'INSUFFICIENT_SAMPLE';
  if (n(summary.expectancy_usdt) <= NEGATIVE_EXPECTANCY_USDT && n(summary.win_rate_pct) < NEGATIVE_WIN_RATE_PCT) {
    return 'NEGATIVE_EXPECTANCY';
  }
  if (n(summary.expectancy_usdt) > 0 && n(summary.win_rate_pct) >= 35) return 'POSITIVE_EXPECTANCY';
  return 'NEUTRAL';
}

function buildLearningProfile(trades = []) {
  const usable = trades.filter((trade) => Number.isFinite(Number(trade.net_pnl_usdt)));
  const overall = summarizeRows(usable);
  const bands = ['SCORE_LT_50', 'SCORE_50_69', 'SCORE_70_84', 'SCORE_85_PLUS'].map((band) => {
    const summary = summarizeRows(usable.filter((trade) => scoreBand(trade.entry_score) === band));
    return { band, ...summary, state: classifyBucket(summary) };
  });
  const reasons = {};
  for (const trade of usable) {
    const reason = String(trade.closing_reason || trade.reason || 'UNKNOWN').toUpperCase();
    if (!reasons[reason]) reasons[reason] = { reason, trades: 0, pnl_usdt: 0 };
    reasons[reason].trades += 1;
    reasons[reason].pnl_usdt += n(trade.net_pnl_usdt);
  }
  const closingReasons = Object.values(reasons)
    .map((row) => ({ ...row, pnl_usdt: Number(row.pnl_usdt.toFixed(8)) }))
    .sort((a, b) => b.trades - a.trades);
  return {
    version: LEARNING_VERSION,
    active: overall.sample_size >= MIN_OVERALL_SAMPLE,
    minimum_overall_sample: MIN_OVERALL_SAMPLE,
    minimum_bucket_sample: MIN_BUCKET_SAMPLE,
    overall,
    score_bands: bands,
    closing_reasons: closingReasons
  };
}

function evaluateLearnedEntry(candidate = {}, profile = {}) {
  const score = n(candidate.opportunityScore ?? candidate.score, 0);
  const band = scoreBand(score);
  const bucket = Array.isArray(profile.score_bands)
    ? profile.score_bands.find((item) => item.band === band)
    : null;
  const active = profile.active === true;
  const blocked = active && bucket?.state === 'NEGATIVE_EXPECTANCY';
  return {
    allowed: !blocked,
    version: LEARNING_VERSION,
    active,
    candidate_score: score,
    score_band: band,
    bucket: bucket || null,
    reason: blocked ? 'LEARNED_SCORE_BAND_NEGATIVE_EXPECTANCY' : null,
    advisory_only_when_positive: true
  };
}

module.exports = {
  LEARNING_VERSION,
  MIN_OVERALL_SAMPLE,
  MIN_BUCKET_SAMPLE,
  NEGATIVE_EXPECTANCY_USDT,
  NEGATIVE_WIN_RATE_PCT,
  scoreBand,
  summarizeRows,
  classifyBucket,
  buildLearningProfile,
  evaluateLearnedEntry
};
