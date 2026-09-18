'use strict';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function ret(a, b) {
  return a > 0 ? b / a - 1 : 0;
}

function std(values = []) {
  if (!values.length) return 0;
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance = values.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / values.length;
  return Math.sqrt(variance);
}

function classifyMarketRegime(bars = [], endMs = Infinity) {
  const eligible = bars
    .filter((row) => Array.isArray(row) ? n(row[0]) <= endMs : n(row.t ?? row.time) <= endMs)
    .slice(-289);
  if (eligible.length < 49) {
    return { regime: 'UNKNOWN', r1h: 0, r4h: 0, r24h: 0, vol4h: 0 };
  }

  const close = (row) => Array.isArray(row) ? n(row[4]) : n(row.c ?? row.close);
  const current = close(eligible[eligible.length - 1]);
  const r1h = eligible.length >= 13 ? ret(close(eligible[eligible.length - 13]), current) : 0;
  const r4h = eligible.length >= 49 ? ret(close(eligible[eligible.length - 49]), current) : 0;
  const r24h = eligible.length >= 289 ? ret(close(eligible[eligible.length - 289]), current) : r4h;

  const recent = eligible.slice(-49);
  const returns = [];
  for (let i = 1; i < recent.length; i += 1) returns.push(ret(close(recent[i - 1]), close(recent[i])));
  const vol4h = std(returns) * Math.sqrt(48);

  let regime = 'MIXED';
  if (vol4h >= 0.045) regime = 'VOLATILE';
  else if (r4h >= 0.012 && r24h >= -0.005) regime = 'BULL';
  else if (r4h <= -0.012 && r24h <= 0.005) regime = 'BEAR';
  else if (Math.abs(r4h) <= 0.007 && Math.abs(r1h) <= 0.004) regime = 'RANGE';

  return { regime, r1h, r4h, r24h, vol4h };
}

module.exports = { classifyMarketRegime };
