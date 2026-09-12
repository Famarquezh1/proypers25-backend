'use strict';

const fs = require('fs');
const path = require('path');

const BASE = 'https://data-api.binance.vision';
const STEP_MS = 5 * 60 * 1000;
const LOOKBACK_DAYS = Math.max(7, Math.min(30, Number(process.env.TRAIN_LOOKBACK_DAYS || 30)));
const MAX_SYMBOLS = Math.max(20, Math.min(100, Number(process.env.TRAIN_MAX_SYMBOLS || 60)));
const MIN_HIST_QV = Math.max(100000, Number(process.env.MIN_HIST_QUOTE_VOL_24H || 200000));
const WINNER_TARGET = Math.max(0.05, Number(process.env.TRAIN_WINNER_TARGET || 0.10));
const FWD_BARS = 288; // 24 h
const WARMUP = 288; // 24 h
const PURGE_MS = 24 * 60 * 60 * 1000;
const SIGNAL_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const LEGACY_LIMIT = 24;
const DIVERSE_LIMIT = 100;
const CONSENSUS_CANDIDATES = [2, 3, 4];

function avg(values) { return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0; }
function std(values) { const m = avg(values); return values.length ? Math.sqrt(avg(values.map(v => (v - m) ** 2))) : 0; }
function ret(a, b) { return a > 0 ? b / a - 1 : 0; }
function clamp(v, min = 0, max = 1) { return Math.max(min, Math.min(max, Number(v) || 0)); }
function percentile(values, p) { if (!values.length) return 0; const a = [...values].sort((x, y) => x - y); return a[Math.max(0, Math.min(a.length - 1, Math.floor((a.length - 1) * p)))]; }
function qsum(rows, i, n) { let s = 0; for (let k = Math.max(0, i - n + 1); k <= i; k += 1) s += rows[k].q; return s; }

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25000);
  try {
    const response = await fetch(url, { signal: controller.signal, headers: { 'user-agent': 'proypers25-early-probe-v5' } });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function universe() {
  const rows = await fetchJson(`${BASE}/api/v3/ticker/24hr`);
  return rows
    .filter(r => String(r.symbol || '').endsWith('USDT'))
    .filter(r => !/(UP|DOWN|BULL|BEAR)USDT$/.test(String(r.symbol)))
    .filter(r => Number(r.quoteVolume || 0) >= MIN_HIST_QV)
    .sort((a, b) => Number(b.quoteVolume || 0) - Number(a.quoteVolume || 0))
    .slice(0, MAX_SYMBOLS)
    .map(r => String(r.symbol));
}

async function klines(symbol) {
  const start = Date.now() - LOOKBACK_DAYS * 86400000;
  let cursor = start;
  const out = [];
  for (let page = 0; page < 40 && cursor < Date.now(); page += 1) {
    const q = new URLSearchParams({ symbol, interval: '5m', startTime: String(cursor), limit: '1000' });
    const rows = await fetchJson(`${BASE}/api/v3/klines?${q}`);
    if (!Array.isArray(rows) || !rows.length) break;
    for (const r of rows) out.push({ t: +r[0], o: +r[1], h: +r[2], l: +r[3], c: +r[4], q: +r[7], n: +r[8] });
    const next = +rows.at(-1)[0] + STEP_MS;
    if (next <= cursor) break;
    cursor = next;
    if (rows.length < 1000) break;
  }
  return out;
}

function btcMap(rows) {
  const map = new Map();
  for (let i = WARMUP; i < rows.length; i += 1) {
    const rr = [];
    for (let j = i - 11; j <= i; j += 1) rr.push(ret(rows[j - 1].c, rows[j].c));
    map.set(rows[i].t, { r60: ret(rows[i - 12].c, rows[i].c), r240: ret(rows[i - 48].c, rows[i].c), vol: std(rr) });
  }
  return map;
}

function features(rows, i, btc) {
  const c = rows[i].c;
  const b = btc.get(rows[i].t) || {};
  const r5 = ret(rows[i - 1].c, c);
  const r15 = ret(rows[i - 3].c, c);
  const r30 = ret(rows[i - 6].c, c);
  const r60 = ret(rows[i - 12].c, c);
  const r240 = ret(rows[i - 48].c, c);
  const r24h = ret(rows[i - 288].c, c);
  const baseline = avg(rows.slice(i - 72, i - 12).map(x => x.q)) * 12;
  const prior60 = Math.max(...rows.slice(i - 12, i).map(x => x.h));
  const prior240 = Math.max(...rows.slice(i - 48, i).map(x => x.h));
  const rr1 = []; for (let j = i - 11; j <= i; j += 1) rr1.push(ret(rows[j - 1].c, rows[j].c));
  const rr4 = []; for (let j = i - 47; j <= i - 12; j += 1) rr4.push(ret(rows[j - 1].c, rows[j].c));
  return {
    r5, r15, r30, r60, r240, r24h,
    qv24h: qsum(rows, i, 288),
    vol15: baseline > 0 ? qsum(rows, i, 3) / (baseline / 4) : 1,
    vol30: baseline > 0 ? qsum(rows, i, 6) / (baseline / 2) : 1,
    tradeAccel: rows[i].n / Math.max(1, avg(rows.slice(i - 12, i).map(x => x.n))),
    breakout60: prior60 > 0 ? c / prior60 - 1 : 0,
    breakout240: prior240 > 0 ? c / prior240 - 1 : 0,
    compression: std(rr4) > 0 ? std(rr1) / std(rr4) : 1,
    rsBtc60: r60 - (b.r60 || 0),
    rsBtc240: r240 - (b.r240 || 0)
  };
}

const agents = {
  EARLY_MOMENTUM: f => 1.3*f.r15 + 1.15*f.r30 + .65*f.r60 + .35*Math.log(Math.max(.2,f.vol15)) - .8*Math.max(0,f.r24h-.12),
  VOLUME_IGNITION: f => .75*Math.log(Math.max(.2,f.vol15)) + .55*Math.log(Math.max(.2,f.tradeAccel)) + .55*f.r15 + .35*f.breakout60,
  FRESH_BREAKOUT: f => 1.7*f.breakout60 + .9*f.r15 + .45*f.r30 + .35*Math.log(Math.max(.2,f.vol15)) - .9*Math.max(0,f.r24h-.10) - .7*Math.max(0,f.r60-.06),
  RELATIVE_STRENGTH_BTC: f => 1.35*f.rsBtc60 + .9*f.rsBtc240 + .35*f.r30 + .2*Math.log(Math.max(.2,f.vol15)) - .5*Math.max(0,f.r24h-.12),
  SQUEEZE_BREAKOUT: f => 1.25*f.breakout60 + .65*f.breakout240 + .65*Math.log(Math.max(.2,f.vol30)) - .55*Math.max(0,f.compression-1) + .25*f.rsBtc60,
  PRE_EXPLOSION: f => 1.05*f.r15 + .8*f.r30 + .6*f.breakout60 + .45*Math.log(Math.max(.2,f.vol15)) + .45*f.rsBtc60 - .75*Math.max(0,f.r24h-.10) - .45*Math.max(0,f.r60-.06),
  EXHAUSTION_AVOID: f => .7*f.r30 + .5*f.breakout60 + .35*Math.log(Math.max(.2,f.vol15)) - 1.2*Math.max(0,f.r24h-.10)
};

function futureOutcome(rows, i) {
  if (i + 1 >= rows.length) return null;
  const entry = rows[i + 1].o;
  let maxGain = 0;
  let hit10 = null;
  let hit20 = null;
  for (let k = i + 1; k < rows.length && k <= i + FWD_BARS; k += 1) {
    const gain = rows[k].h / entry - 1;
    maxGain = Math.max(maxGain, gain);
    if (hit10 === null && gain >= .10) hit10 = (k - (i + 1)) * 5;
    if (hit20 === null && gain >= .20) hit20 = (k - (i + 1)) * 5;
  }
  return { maxGain, hit10, hit20, winner: maxGain >= WINNER_TARGET };
}

function baseUtility(sample) {
  const pct = sample.f.r24h * 100;
  const momentum = clamp(pct / 12);
  const liquidity = clamp((Math.log10(Math.max(MIN_HIST_QV, sample.f.qv24h)) - Math.log10(MIN_HIST_QV)) / (Math.log10(150000000) - Math.log10(MIN_HIST_QV)));
  const freshness = pct <= 8 ? 1 : clamp(1 - ((pct - 8) / 10));
  const chasePenalty = pct > 12 ? clamp((pct - 12) / 6) : 0;
  return momentum*.45 + liquidity*.30 + freshness*.25 - chasePenalty*.15;
}

function laneScore(sample, lane) {
  const pct = sample.f.r24h * 100;
  const liquidity = clamp((Math.log10(Math.max(MIN_HIST_QV, sample.f.qv24h)) - Math.log10(MIN_HIST_QV)) / (Math.log10(150000000) - Math.log10(MIN_HIST_QV)));
  if (lane === 'fresh') return clamp(1 - Math.abs(pct - 2) / 4)*.45 + clamp(Math.log(Math.max(.2,sample.f.vol15))/2 + .5)*.25 + clamp(sample.f.breakout60*25 + .5)*.20 + liquidity*.10;
  if (lane === 'volume') return clamp(Math.log(Math.max(.2,sample.f.vol15))/2 + .5)*.55 + clamp(Math.log(Math.max(.2,sample.f.tradeAccel))/2 + .5)*.25 + liquidity*.20;
  if (lane === 'breakout') return clamp(sample.f.breakout60*30 + .5)*.55 + clamp(sample.f.rsBtc60*20 + .5)*.25 + liquidity*.20;
  if (lane === 'surge') return clamp(1 - Math.abs(pct - 9) / 8)*.45 + clamp(sample.f.r60*10 + .5)*.25 + clamp(Math.log(Math.max(.2,sample.f.vol15))/2 + .5)*.20 + liquidity*.10;
  return baseUtility(sample);
}

function eligible(samples) {
  return samples.filter(s => s.f.qv24h >= MIN_HIST_QV && s.f.r24h >= .001 && s.f.r24h < .18 && s.f.r60 < .10 && s.f.r15 < .06);
}

function selectLegacy(samples) {
  return eligible(samples).sort((a,b) => baseUtility(b) - baseUtility(a)).slice(0, LEGACY_LIMIT);
}

function selectDiversified(samples) {
  const e = eligible(samples);
  const lanes = {
    fresh: [...e].sort((a,b) => laneScore(b,'fresh') - laneScore(a,'fresh')),
    surge: [...e].sort((a,b) => laneScore(b,'surge') - laneScore(a,'surge')),
    volume: [...e].sort((a,b) => laneScore(b,'volume') - laneScore(a,'volume')),
    breakout: [...e].sort((a,b) => laneScore(b,'breakout') - laneScore(a,'breakout')),
    base: [...e].sort((a,b) => baseUtility(b) - baseUtility(a))
  };
  const out = [], seen = new Set();
  const add = (pool, quota) => { let n = 0; for (const s of pool) { if (out.length >= DIVERSE_LIMIT || n >= quota) break; if (seen.has(s.symbol)) continue; seen.add(s.symbol); out.push(s); n += 1; } };
  add(lanes.fresh, 30); add(lanes.surge, 20); add(lanes.volume, 20); add(lanes.breakout, 20); add(lanes.base, 10); add(lanes.base, DIVERSE_LIMIT - out.length);
  return out;
}

function buildThresholds(train) {
  const thresholds = {};
  for (const [name, fn] of Object.entries(agents)) thresholds[name] = percentile(train.map(s => fn(s.f)), .92);
  return thresholds;
}

function consensus(sample, thresholds) {
  const passed = [];
  for (const [name, fn] of Object.entries(agents)) if (fn(sample.f) >= thresholds[name]) passed.push(name);
  return passed;
}

function dedupeSignals(signals) {
  const out = [], until = new Map();
  for (const s of [...signals].sort((a,b) => a.t - b.t)) {
    if (s.t < (until.get(s.symbol) || 0)) continue;
    out.push(s); until.set(s.symbol, s.t + SIGNAL_COOLDOWN_MS);
  }
  return out;
}

function metrics(signals, allWinnerSamples) {
  const deduped = dedupeSignals(signals);
  const winners = deduped.filter(s => s.o.winner);
  const avgPct = avg(deduped.map(s => s.f.r24h * 100));
  const winnerPct = avg(winners.map(s => s.f.r24h * 100));
  const precision = deduped.length ? winners.length / deduped.length : 0;
  const candidateWinnerKeys = new Set(allWinnerSamples.map(s => `${s.symbol}:${Math.floor(s.t / SIGNAL_COOLDOWN_MS)}`));
  const detectedWinnerKeys = new Set(winners.map(s => `${s.symbol}:${Math.floor(s.t / SIGNAL_COOLDOWN_MS)}`));
  const recall = candidateWinnerKeys.size ? detectedWinnerKeys.size / candidateWinnerKeys.size : 0;
  return {
    signals: deduped.length,
    winners: winners.length,
    precision,
    recall,
    avgDetection24hPct: avgPct,
    avgWinnerDetection24hPct: winnerPct,
    medianMinutesTo10: percentile(winners.filter(s => s.o.hit10 !== null).map(s => s.o.hit10), .5),
    medianMinutesTo20: percentile(winners.filter(s => s.o.hit20 !== null).map(s => s.o.hit20), .5),
    avgFutureMaxGain: avg(deduped.map(s => s.o.maxGain))
  };
}

function evaluatePolicy(byTime, selector, thresholds, consensusMin) {
  const signals = [];
  for (const samples of byTime.values()) {
    for (const s of selector(samples)) {
      const passed = consensus(s, thresholds);
      if (passed.length >= consensusMin) signals.push({ ...s, agentsPassed: passed });
    }
  }
  return signals;
}

async function main() {
  const symbols = await universe();
  if (!symbols.includes('BTCUSDT')) symbols.unshift('BTCUSDT');
  console.log(`EARLY_PROBE_V5 lookback=${LOOKBACK_DAYS}d maxSymbols=${MAX_SYMBOLS} winnerTarget=${WINNER_TARGET}`);
  const data = new Map();
  for (const symbol of symbols) {
    try { const rows = await klines(symbol); data.set(symbol, rows); console.log(`LOADED ${symbol} ${rows.length}`); }
    catch (error) { console.log(`SKIP ${symbol} ${error.message}`); }
  }
  const btc = btcMap(data.get('BTCUSDT') || []);
  const samples = [];
  for (const [symbol, rows] of data) {
    if (symbol === 'BTCUSDT') continue;
    for (let i = WARMUP; i < rows.length - FWD_BARS - 1; i += 1) {
      const f = features(rows, i, btc);
      if (f.qv24h < MIN_HIST_QV) continue;
      const o = futureOutcome(rows, i);
      if (o) samples.push({ symbol, t: rows[i].t, price: rows[i].c, f, o });
    }
  }
  samples.sort((a,b) => a.t - b.t);
  if (samples.length < 1000) throw new Error(`insufficient samples ${samples.length}`);

  const t0 = samples[0].t, t1 = samples.at(-1).t, span = t1 - t0;
  const c1 = t0 + span*.60, c2 = t0 + span*.80;
  const train = samples.filter(s => s.t < c1 - PURGE_MS);
  const validation = samples.filter(s => s.t > c1 + PURGE_MS && s.t < c2 - PURGE_MS);
  const test = samples.filter(s => s.t > c2 + PURGE_MS);
  const thresholds = buildThresholds(train);

  function group(list) { const m = new Map(); for (const s of list) { const a = m.get(s.t) || []; a.push(s); m.set(s.t, a); } return m; }
  const validationByTime = group(validation), testByTime = group(test);
  let bestConsensus = 2, bestScore = -Infinity, validationComparison = null;
  for (const c of CONSENSUS_CANDIDATES) {
    const oldSignals = evaluatePolicy(validationByTime, selectLegacy, thresholds, c);
    const newSignals = evaluatePolicy(validationByTime, selectDiversified, thresholds, c);
    const winnerSamples = validation.filter(s => s.o.winner);
    const oldM = metrics(oldSignals, winnerSamples), newM = metrics(newSignals, winnerSamples);
    const score = (newM.recall-oldM.recall)*2 + (newM.precision-oldM.precision) + Math.max(0,(oldM.avgWinnerDetection24hPct-newM.avgWinnerDetection24hPct)/10);
    if (score > bestScore) { bestScore = score; bestConsensus = c; validationComparison = { legacy24: oldM, diversified100: newM }; }
  }

  const testWinners = test.filter(s => s.o.winner);
  const legacySignals = evaluatePolicy(testByTime, selectLegacy, thresholds, bestConsensus);
  const diverseSignals = evaluatePolicy(testByTime, selectDiversified, thresholds, bestConsensus);
  const legacy = metrics(legacySignals, testWinners), diversified = metrics(diverseSignals, testWinners);
  const verdict = diversified.recall > legacy.recall && diversified.avgWinnerDetection24hPct <= legacy.avgWinnerDetection24hPct;

  const report = {
    generatedAt: new Date().toISOString(),
    version: 'V5_EARLY_PROBE_RESEARCH',
    researchOnly: true,
    productionTradingTouched: false,
    lookbackDays: LOOKBACK_DAYS,
    hardLookbackCapDays: 30,
    interval: '5m',
    sampleEveryBars: 1,
    symbolsLoaded: data.size,
    samples: { total: samples.length, train: train.length, validation: validation.length, test: test.length },
    winnerTarget: WINNER_TARGET,
    agents: Object.keys(agents),
    agentThresholds: thresholds,
    consensusMin: bestConsensus,
    validation: validationComparison,
    test: { legacy24: legacy, diversified100: diversified },
    delta: {
      recall: diversified.recall - legacy.recall,
      precision: diversified.precision - legacy.precision,
      winnerDetection24hPct: diversified.avgWinnerDetection24hPct - legacy.avgWinnerDetection24hPct,
      medianMinutesTo10: diversified.medianMinutesTo10 - legacy.medianMinutesTo10,
      avgFutureMaxGain: diversified.avgFutureMaxGain - legacy.avgFutureMaxGain
    },
    researchGate: {
      pass: verdict,
      reason: verdict ? 'Diversified probe detected more historical winners without detecting them later on average.' : 'HOLD: diversified probe did not clearly improve both winner recall and detection timing.'
    }
  };

  const dir = path.join(__dirname, '..', 'training-output'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'spot-early-probe-v5-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

main().catch(error => { console.error(error.stack || error.message || String(error)); process.exit(1); });
