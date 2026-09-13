'use strict';

// Live V10 HUNTER. It retrains the already validated 15m microflow model from
// public Binance history, calibrates only on information available before the
// decision, and emits at most one current candidate. It never places orders.
const fs = require('fs');
const vm = require('vm');
const path = require('path');

const v10Path = path.join(__dirname, 'github-spot-microflow-trainer-v10.js');
let source = fs.readFileSync(v10Path, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '\n');
source += ';globalThis.__v10live={v,TRAIN_DAYS,NAMES,klines,flowFeatures,future,simulate,crossSection,train,choose};';
const context = vm.createContext({
  require, console, process, fetch, URLSearchParams, AbortController,
  setTimeout, clearTimeout, Date, Math, Map, Set, Array, Number, String, JSON,
  __dirname: path.dirname(v10Path), __filename: v10Path
});
vm.runInContext(source, context, { filename: 'v10-live-base.js' });
const m = context.__v10live;

function findIndexAt(rows, target) {
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    if (rows[i].t === target) return i;
    if (rows[i].t < target) break;
  }
  return -1;
}

function normalizeLive(rows) {
  if (rows.length < 8) return [];
  const d = m.NAMES.length;
  const mu = Array(d).fill(0);
  const sd = Array(d).fill(1);
  for (let j = 0; j < d; j += 1) {
    mu[j] = m.v.avg(rows.map((r) => r.z[j]));
    const s = m.v.std(rows.map((r) => r.z[j]));
    sd[j] = s > 1e-9 ? s : 1;
  }
  return rows.map((r) => ({
    ...r,
    cz: r.z.map((x, j) => m.v.clamp((x - mu[j]) / sd[j], -5, 5))
  }));
}

async function main() {
  const step = m.v.STEP_MS;
  const day = m.v.DAY_MS;
  const cadence = 3 * step; // validated V10 cadence = 15m
  const targetT = Math.floor((Date.now() - step) / cadence) * cadence;
  const fitStart = targetT - 7 * day;
  const fitEnd = targetT - 2 * day - 3 * 60 * 60 * 1000;
  const calStart = targetT - 2 * day;
  const calEnd = targetT - 3 * 60 * 60 * 1000;
  const dataStart = fitStart - m.v.WARM * step;
  const dataEnd = targetT + step;

  const symbols = await m.v.universe();
  const loaded = await m.v.mapLimit(symbols, 8, async (symbol) => ({
    symbol,
    rows: await m.klines(symbol, dataStart, dataEnd)
  }));
  const data = new Map();
  for (const item of loaded) if (item && !item.__error && item.rows?.length) data.set(item.symbol, item.rows);
  const btc = data.get('BTCUSDT');
  if (!btc?.length) throw new Error('V10_HUNTER BTC context unavailable');
  const bm = m.v.btcMap(btc);

  const raw = [];
  for (const [symbol, rows] of data) {
    if (symbol === 'BTCUSDT' || rows.length < m.v.WARM + 40) continue;
    for (let i = m.v.WARM; i < rows.length - 38; i += 3) {
      const f = m.v.feature(rows, i, bm);
      if (!m.v.candidate(f)) continue;
      const fu = m.future(rows, i);
      const exec = m.simulate(rows, i);
      if (!fu || !exec) continue;
      raw.push({ symbol, t: rows[i].t, z: [...m.v.vector(f), ...m.flowFeatures(rows, i)], future: fu, exec });
    }
  }
  const historical = m.crossSection(raw);
  const fit = historical.filter((r) => r.t >= fitStart && r.t < fitEnd);
  const cal = historical.filter((r) => r.t >= calStart && r.t < calEnd);
  if (fit.length < 800 || cal.length < 300) {
    console.log(JSON.stringify({ ok: true, notify: false, lane: 'V10_HUNTER', reason: 'insufficient causal training/calibration samples', fit: fit.length, calibration: cal.length }));
    return;
  }

  const model = m.train(fit);
  const policy = m.choose(cal, model);
  if (!policy) {
    console.log(JSON.stringify({ ok: true, notify: false, lane: 'V10_HUNTER', reason: 'calibration has no positive microflow edge', target: new Date(targetT).toISOString() }));
    return;
  }

  const live = [];
  for (const [symbol, rows] of data) {
    if (symbol === 'BTCUSDT') continue;
    const i = findIndexAt(rows, targetT);
    if (i < m.v.WARM) continue;
    const f = m.v.feature(rows, i, bm);
    if (!m.v.candidate(f)) continue;
    live.push({
      symbol,
      t: targetT,
      price: rows[i].c,
      pct: f.r24 * 100,
      quoteVolume: f.qv24,
      z: [...m.v.vector(f), ...m.flowFeatures(rows, i)]
    });
  }
  const scored = normalizeLive(live)
    .map((r) => ({ ...r, score: model.predict(r.cz) }))
    .sort((a, b) => b.score - a.score);
  if (scored.length < 2) {
    console.log(JSON.stringify({ ok: true, notify: false, lane: 'V10_HUNTER', reason: 'insufficient live cross-section', liveCandidates: scored.length }));
    return;
  }

  const top = scored[0];
  const margin = top.score - scored[1].score;
  const passes = top.score >= policy.scoreCut && margin >= policy.marginCut;
  if (!passes) {
    console.log(JSON.stringify({ ok: true, notify: false, lane: 'V10_HUNTER', reason: 'live leader below calibrated microflow confidence', symbol: top.symbol, score: top.score, margin, scoreCut: policy.scoreCut, marginCut: policy.marginCut }));
    return;
  }
  if (!(top.pct >= 1 && top.pct < 18)) {
    console.log(JSON.stringify({ ok: true, notify: false, lane: 'V10_HUNTER', reason: 'live microflow leader outside execution momentum band', symbol: top.symbol, pct: top.pct }));
    return;
  }

  console.log(JSON.stringify({
    ok: true,
    notify: true,
    lane: 'V10_HUNTER',
    mode: 'V10_TAKER_FLOW_15M_SELF_TRAINED',
    source: 'BINANCE_VISION',
    target: new Date(targetT).toISOString(),
    symbol: top.symbol,
    pct: Number(top.pct.toFixed(6)),
    price: top.price,
    quote_volume: top.quoteVolume,
    microflow_score: top.score,
    microflow_margin: margin,
    score_cut: policy.scoreCut,
    margin_cut: Number.isFinite(policy.marginCut) ? policy.marginCut : null,
    calibration: policy.metrics,
    trained_samples: fit.length,
    calibration_samples: cal.length,
    live_candidates: scored.length,
    exit_policy: { take_profit: 0.03, hard_stop: 0.012, timeout_minutes: 180 },
    maximum_real_order_usdt: 10,
    production_core_bypass: false
  }));
}

main().catch((error) => {
  console.error(error.stack || error.message || String(error));
  process.exit(1);
});
