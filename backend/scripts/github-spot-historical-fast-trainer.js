'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const INTERVAL = '15m';
const INTERVAL_MS = 15 * 60 * 1000;
const LOOKBACK_DAYS = Number(process.env.TRAIN_LOOKBACK_DAYS || 30);
const MAX_SYMBOLS = Number(process.env.TRAIN_MAX_SYMBOLS || 24);
const FORWARD_BARS = 24; // 6 hours
const WARMUP_BARS = 96; // 24 hours
const FEE_ROUNDTRIP_PCT = 0.002;
const TARGET_PCT = 0.04;
const STOP_PCT = -0.03;

function clamp(v, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, Number(v) || 0)); }
function pct(a, b) { return b > 0 ? (a / b) - 1 : 0; }
function avg(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0; }
function std(xs) { const m = avg(xs); return xs.length ? Math.sqrt(avg(xs.map((x) => (x - m) ** 2))) : 0; }
function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const res = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'proypers25-fast-trainer/1.0' } });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
    return res.json();
  } finally { clearTimeout(timer); }
}

async function universe() {
  const rows = await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows
    .filter((r) => String(r.symbol).endsWith('USDT'))
    .filter((r) => !/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter((r) => Number(r.quoteVolume) >= 2_000_000)
    .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
    .slice(0, MAX_SYMBOLS)
    .map((r) => String(r.symbol));
}

async function klines(symbol) {
  const start = Date.now() - LOOKBACK_DAYS * 86400000;
  let cursor = start;
  const out = [];
  for (let page = 0; page < 12 && cursor < Date.now(); page += 1) {
    const q = new URLSearchParams({ symbol, interval: INTERVAL, startTime: String(cursor), limit: '1000' });
    const rows = await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({
      t: Number(r[0]), o: Number(r[1]), h: Number(r[2]), l: Number(r[3]), c: Number(r[4]), v: Number(r[5]), q: Number(r[7])
    });
    const next = Number(rows[rows.length - 1][0]) + INTERVAL_MS;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
  }
  return out;
}

function features(rows, i) {
  const c = rows[i].c;
  const r1h = pct(c, rows[i - 4].c);
  const r4h = pct(c, rows[i - 16].c);
  const r24h = pct(c, rows[i - 96].c);
  const recentVol = avg(rows.slice(i - 3, i + 1).map((x) => x.q));
  const baseVol = avg(rows.slice(i - 31, i - 3).map((x) => x.q));
  const volAccel = baseVol > 0 ? recentVol / baseVol : 1;
  const highs = rows.slice(i - 16, i).map((x) => x.h);
  const priorHigh = Math.max(...highs);
  const breakout = priorHigh > 0 ? c / priorHigh - 1 : 0;
  const returns = rows.slice(i - 15, i + 1).map((x, j, a) => j ? pct(x.c, a[j - 1].c) : 0).slice(1);
  const volatility = std(returns);
  const candleRange = rows[i].l > 0 ? (rows[i].h / rows[i].l) - 1 : 0;
  return { r1h, r4h, r24h, volAccel, breakout, volatility, candleRange };
}

const agents = {
  EARLY_MOMENTUM: (f) => 1.8 * f.r1h + 1.1 * f.r4h + 0.25 * Math.log(Math.max(0.2, f.volAccel)),
  VOLUME_ACCEL: (f) => 0.8 * f.r1h + 0.65 * Math.log(Math.max(0.2, f.volAccel)) - 4 * f.volatility,
  BREAKOUT: (f) => 2.2 * f.breakout + 0.9 * f.r4h + 0.2 * Math.log(Math.max(0.2, f.volAccel)),
  FRESHNESS: (f) => 1.2 * f.r1h + 0.7 * f.r4h - 0.9 * Math.max(0, f.r24h - 0.12),
  TREND: (f) => 0.6 * f.r1h + 1.0 * f.r4h + 0.45 * f.r24h,
  RISK_ADJUSTED: (f) => 1.1 * f.r1h + 0.8 * f.r4h - 7 * f.volatility - 2 * f.candleRange,
  SURGE_FILTER: (f) => 1.4 * f.r1h + 0.45 * Math.log(Math.max(0.2, f.volAccel)) - 1.4 * Math.max(0, f.r24h - 0.18),
  CONSENSUS: (f) => 0.9 * f.r1h + 0.8 * f.r4h + 0.3 * f.breakout + 0.25 * Math.log(Math.max(0.2, f.volAccel)) - 4 * f.volatility
};

function outcome(rows, i) {
  const entry = rows[i].c;
  let maxGain = -Infinity;
  let minGain = Infinity;
  let first = 'NONE';
  for (let j = i + 1; j <= Math.min(rows.length - 1, i + FORWARD_BARS); j += 1) {
    const up = rows[j].h / entry - 1;
    const dn = rows[j].l / entry - 1;
    maxGain = Math.max(maxGain, up);
    minGain = Math.min(minGain, dn);
    if (first === 'NONE') {
      if (dn <= STOP_PCT) first = 'STOP';
      else if (up >= TARGET_PCT) first = 'TARGET';
    }
  }
  const terminal = rows[Math.min(rows.length - 1, i + FORWARD_BARS)].c / entry - 1;
  const realized = first === 'TARGET' ? TARGET_PCT : first === 'STOP' ? STOP_PCT : terminal;
  return { win: first === 'TARGET', first, maxGain, minGain, net: realized - FEE_ROUNDTRIP_PCT };
}

function metrics(items) {
  if (!items.length) return { n: 0, win_rate: 0, avg_net: 0, profit_factor: 0, score: -999 };
  const wins = items.filter((x) => x.o.net > 0);
  const grossWin = wins.reduce((s, x) => s + x.o.net, 0);
  const grossLoss = Math.abs(items.filter((x) => x.o.net < 0).reduce((s, x) => s + x.o.net, 0));
  const winRate = wins.length / items.length;
  const avgNet = avg(items.map((x) => x.o.net));
  const pf = grossLoss > 0 ? grossWin / grossLoss : grossWin > 0 ? 99 : 0;
  return { n: items.length, win_rate: winRate, avg_net: avgNet, profit_factor: pf, score: avgNet * Math.sqrt(items.length) + 0.015 * (winRate - 0.5) };
}

function chooseThreshold(train) {
  const sorted = [...train].sort((a, b) => b.s - a.s);
  const candidates = [0.03, 0.05, 0.08, 0.12, 0.18].map((fraction) => {
    const n = Math.max(12, Math.floor(sorted.length * fraction));
    const selected = sorted.slice(0, n);
    return { threshold: selected[selected.length - 1]?.s ?? Infinity, m: metrics(selected) };
  });
  candidates.sort((a, b) => b.m.score - a.m.score);
  return candidates[0];
}

async function main() {
  const symbols = await universe();
  console.log(`FAST_TRAINER universe=${symbols.length} lookback_days=${LOOKBACK_DAYS} interval=${INTERVAL}`);
  const samples = [];
  for (const symbol of symbols) {
    try {
      const rows = await klines(symbol);
      for (let i = WARMUP_BARS; i < rows.length - FORWARD_BARS; i += 4) { // hourly decision points
        const f = features(rows, i);
        // Historical replay gate: only information available at i is used.
        if (f.r24h < 0.005 || f.r24h >= 0.18) continue;
        const o = outcome(rows, i);
        samples.push({ symbol, t: rows[i].t, f, o });
      }
      console.log(`LOADED ${symbol} bars=${rows.length}`);
    } catch (e) { console.log(`SKIP ${symbol} ${e.message}`); }
  }
  samples.sort((a, b) => a.t - b.t);
  if (samples.length < 200) throw new Error(`Insufficient historical samples: ${samples.length}`);

  const trainEnd = Math.floor(samples.length * 0.60);
  const validationEnd = Math.floor(samples.length * 0.80);
  const trainBase = samples.slice(0, trainEnd);
  const validationBase = samples.slice(trainEnd, validationEnd);
  const testBase = samples.slice(validationEnd);
  const results = [];

  for (const [name, fn] of Object.entries(agents)) {
    const score = (x) => ({ ...x, s: fn(x.f) });
    const train = trainBase.map(score);
    const validation = validationBase.map(score);
    const test = testBase.map(score);
    const chosen = chooseThreshold(train);
    const valSelected = validation.filter((x) => x.s >= chosen.threshold);
    const testSelected = test.filter((x) => x.s >= chosen.threshold);
    results.push({ agent: name, threshold: chosen.threshold, train: chosen.m, validation: metrics(valSelected), test: metrics(testSelected) });
  }

  results.sort((a, b) => (b.validation.score + b.test.score) - (a.validation.score + a.test.score));
  const viable = results.filter((r) => r.validation.n >= 12 && r.test.n >= 12 && r.validation.avg_net > 0 && r.test.avg_net > 0);
  const champions = viable.slice(0, 3).map((r) => ({ agent: r.agent, threshold: r.threshold }));
  const report = {
    generated_at: new Date().toISOString(),
    mode: 'HISTORICAL_WALK_FORWARD_NO_FUTURE_LEAKAGE',
    source: 'BINANCE_VISION',
    interval: INTERVAL,
    lookback_days: LOOKBACK_DAYS,
    symbols,
    samples: samples.length,
    split: { train: trainBase.length, validation: validationBase.length, test: testBase.length },
    target: { target_pct: TARGET_PCT, stop_pct: STOP_PCT, forward_hours: FORWARD_BARS * 0.25, fee_roundtrip_pct: FEE_ROUNDTRIP_PCT },
    champions,
    results
  };
  const dir = path.resolve(process.cwd(), 'training-output');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spot-fast-training-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(dir, 'spot-fast-champions.json'), JSON.stringify({ generated_at: report.generated_at, champions }, null, 2));
  console.log(JSON.stringify({ ok: true, samples: report.samples, champions, best: results[0] }, null, 2));
}

main().catch((e) => { console.error(e.stack || e.message || String(e)); process.exit(1); });
