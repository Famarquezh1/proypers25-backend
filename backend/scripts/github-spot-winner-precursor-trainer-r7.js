'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-entry-first.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-winner-precursor-r7-report.json');
const DAY = 86400000;
const HOUR = 3600000;
const STEP = 300000;
const VERSION = 'R7-WINNER-PRECURSOR';
const TRAIN_WINDOWS = [1, 7, 14];
const DEV_START = Date.parse(process.env.DEV_START || '2026-04-01T00:00:00Z');
const DEV_END = Date.parse(process.env.DEV_END || '2026-05-15T00:00:00Z');
const CONFIRM_START = Date.parse(process.env.CONFIRM_START || '2026-05-15T00:00:00Z');
const CONFIRM_END = Date.parse(process.env.CONFIRM_END || '2026-06-01T00:00:00Z');
const MAX_SIGNALS_PER_DAY = 5;
const SYMBOL_COOLDOWN = 6 * HOUR;
const GLOBAL_COOLDOWN = 30 * 60000;
const RIDGE = 0.35;
const Q_GRID = [0.85, 0.90, 0.93, 0.95, 0.97, 0.98, 0.99];
const V42_THRESHOLDS = [
  { i: 0.904010256302157, c: 0.30262335308700017, e: 0.0333071863419859 },
  { i: 0.7912647052581232, c: 0.36672756172128707, e: 0.029510140018270917 },
  { i: 1.6626658194027173, c: 0.43305908219072103, e: 0.019614079751271593 },
];

function loadLib() {
  let src = fs.readFileSync(LIB_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__r7={b,archiveSymbols,targetSymbol,prevCompleteMonth,monthParts,priorMonthLiquidity,mapLimit,loadKlines,contiguous,simulateExit,portfolio,withRecall,safeMetrics};`;
  const c = vm.createContext({ require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout, __dirname, __filename: LIB_PATH });
  vm.runInContext(src, c, { filename: LIB_PATH });
  return c.__r7;
}

const r = loadLib();
const b = r.b;
const { WARM, MIN_QV, POOL_SIZE, FIXED_SIZE, BASE_EXIT, META_FALLBACK, v } = b;

function clamp(x, lo = 0, hi = 1) { return Math.max(lo, Math.min(hi, Number(x) || 0)); }
function avg(xs) { return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0; }
function ret(a, z) { return a > 0 && z > 0 ? z / a - 1 : 0; }
function logSafe(x) { return Math.log(Math.max(0.2, Number(x) || 0.2)); }
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function quantile(xs, q) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y), p = (a.length - 1) * q, i = Math.floor(p), f = p - i;
  return a[i] + (a[Math.min(a.length - 1, i + 1)] - a[i]) * f;
}

function breadthAt(z) {
  return z && z.n ? {
    up15: z.up15 / z.n,
    up60: z.up60 / z.n,
    breakout: z.breakout / z.n,
    ignite: z.ignite / z.n,
    mean60: z.sum60 / z.n,
  } : { up15: .5, up60: .5, breakout: .5, ignite: .5, mean60: 0 };
}

function precursorParts(f) {
  const ignition = 0.9 * logSafe(f.vol15) + 0.65 * logSafe(f.tradeAccel) + 0.65 * f.r15 + 0.35 * f.breakout60;
  const confirm = 1.2 * f.breakout60 + 0.65 * f.rs60 + 0.35 * logSafe(f.vol30) - 0.8 * Math.max(0, f.r24 - 0.10) - 0.5 * Math.max(0, f.r60 - 0.06);
  const extension = 1.15 * f.rs60 + 0.75 * f.rs240 + 0.35 * f.r30 + 0.25 * f.breakout240 - 0.45 * Math.max(0, f.r24 - 0.12);
  return { ignition, confirm, extension };
}

function vector(s) {
  const f = s.f, bd = s.breadth, rw = s.regimeWeights || {}, p = precursorParts(f);
  const accel = f.r15 - 0.25 * f.r60;
  const volSlope = logSafe(f.vol15) - logSafe(f.vol30);
  const chase = Math.max(0, f.r24 - .08) + Math.max(0, f.r60 - .045) + Math.max(0, f.r15 - .025);
  return [
    f.r5, f.r15, f.r30, f.r60, f.r240, f.r24,
    logSafe(f.vol15), logSafe(f.vol30), logSafe(f.tradeAccel),
    f.breakout60, f.breakout240, f.rs60, f.rs240,
    bd.up15 - .5, bd.up60 - .5, bd.breakout - .5, bd.ignite - .5, bd.mean60,
    Number(rw.TREND_UP || 0), Number(rw.VOLATILE || 0), Number(rw.RISK_OFF || 0),
    p.ignition, p.confirm, p.extension, accel, volSlope, chase,
    p.ignition * Math.max(0, f.rs60),
    Math.max(0, f.breakout60) * logSafe(f.vol15),
    Math.max(0, f.rs60) * (bd.up60 - .5),
  ].map(Number);
}

function futureOutcome(s) {
  const rows = s.series, entryI = s.index + 1, entry = rows[entryI]?.o;
  if (!(entry > 0)) return null;
  const horizon = Math.min(rows.length - 1, entryI + 144);
  let max1 = entry, max4 = entry, max12 = entry, minToPeak = entry, runningMin = entry, peakI = entryI;
  let first5 = null, first10 = null, maeBefore5 = null, maeBefore10 = null;
  for (let i = entryI; i <= horizon; i++) {
    runningMin = Math.min(runningMin, rows[i].l);
    if (i <= entryI + 12) max1 = Math.max(max1, rows[i].h);
    if (i <= entryI + 48) max4 = Math.max(max4, rows[i].h);
    if (rows[i].h > max12) { max12 = rows[i].h; peakI = i; minToPeak = runningMin; }
    if (first5 == null && rows[i].h / entry - 1 >= .05) { first5 = i; maeBefore5 = runningMin / entry - 1; }
    if (first10 == null && rows[i].h / entry - 1 >= .10) { first10 = i; maeBefore10 = runningMin / entry - 1; }
  }
  const mfe1 = max1 / entry - 1, mfe4 = max4 / entry - 1, mfe12 = max12 / entry - 1;
  const maeToPeak = minToPeak / entry - 1;
  const winner5 = first5 != null && maeBefore5 > -.03;
  const winner10 = first10 != null && maeBefore10 > -.04;
  const fast4 = mfe4 >= .04 && maeToPeak > -.03;
  const hoursToPeak = Math.max(0, (peakI - entryI) * 5 / 60);
  const y = clamp(
    0.45 * clamp(mfe1, -.08, .12) +
    0.35 * clamp(mfe4, -.10, .18) +
    0.20 * clamp(mfe12, -.12, .25) -
    0.55 * Math.abs(Math.min(0, maeToPeak)) -
    0.0015 * Math.min(12, hoursToPeak) +
    (winner5 ? .025 : 0) + (winner10 ? .04 : 0),
    -.15, .30
  );
  return { mfe1, mfe4, mfe12, maeToPeak, winner5, winner10, fast4, hoursToPeak, y };
}

function solveLinear(A, y) {
  const n = y.length, M = A.map((row, i) => [...row, y[i]]);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let i = col + 1; i < n; i++) if (Math.abs(M[i][col]) > Math.abs(M[pivot][col])) pivot = i;
    if (Math.abs(M[pivot][col]) < 1e-10) return null;
    [M[col], M[pivot]] = [M[pivot], M[col]];
    const d = M[col][col];
    for (let j = col; j <= n; j++) M[col][j] /= d;
    for (let i = 0; i < n; i++) {
      if (i === col) continue;
      const f = M[i][col];
      for (let j = col; j <= n; j++) M[i][j] -= f * M[col][j];
    }
  }
  return M.map(row => row[n]);
}

function fitRidge(rows) {
  if (rows.length < 80) return null;
  const X = rows.map(vector), p = X[0].length, mean = Array(p).fill(0), sd = Array(p).fill(0);
  for (const x of X) for (let j = 0; j < p; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < p; j++) sd[j] += ((x[j] - mean[j]) ** 2) / X.length;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const d = p + 1, A = Array.from({ length: d }, () => Array(d).fill(0)), Y = Array(d).fill(0);
  rows.forEach((s, k) => {
    const x = [1, ...X[k].map((z, j) => (z - mean[j]) / sd[j])], y = s.outcome.y;
    for (let i = 0; i < d; i++) {
      Y[i] += x[i] * y;
      for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j];
    }
  });
  for (let j = 1; j < d; j++) A[j][j] += RIDGE * rows.length;
  const beta = solveLinear(A, Y);
  return beta ? { beta, mean, sd, n: rows.length } : null;
}

function score(model, s) {
  const x = vector(s); let z = model.beta[0];
  for (let j = 0; j < x.length; j++) z += model.beta[j + 1] * ((x[j] - model.mean[j]) / model.sd[j]);
  return z;
}

function v42(s) {
  const p = precursorParts(s.f);
  const pass = V42_THRESHOLDS.filter(th => p.ignition >= th.i && p.confirm >= th.c && p.extension >= th.e).length;
  const norm = clamp((pass / 3) * .6 + clamp(.5 + (p.ignition - .8) / 2) * .18 + clamp(.5 + (p.confirm - .3) / .8) * .14 + clamp(.5 + (p.extension - .03) / .12) * .08);
  return { pass, norm };
}

function signalPolicy(scored, threshold, scoreKey) {
  const groups = new Map();
  for (const s of scored) {
    if (s[scoreKey] < threshold) continue;
    const g = groups.get(s.t) || []; g.push(s); groups.set(s.t, g);
  }
  const candidates = [];
  for (const g of groups.values()) {
    g.sort((a, z) => z[scoreKey] - a[scoreKey]);
    candidates.push(g[0]);
  }
  candidates.sort((a, z) => a.t - z.t || z[scoreKey] - a[scoreKey]);
  const out = [], lastSymbol = new Map(), dayCount = new Map(); let lastGlobal = -Infinity;
  for (const s of candidates) {
    const day = iso(s.t), n = dayCount.get(day) || 0;
    if (n >= MAX_SIGNALS_PER_DAY) continue;
    if (s.t - (lastSymbol.get(s.symbol) || -Infinity) < SYMBOL_COOLDOWN) continue;
    if (s.t - lastGlobal < GLOBAL_COOLDOWN) continue;
    out.push(s); dayCount.set(day, n + 1); lastSymbol.set(s.symbol, s.t); lastGlobal = s.t;
  }
  return out;
}

function predictionMetrics(signals) {
  if (!signals.length) return { signals: 0, winner5Precision: 0, winner10Precision: 0, fast4Precision: 0, avgMfe1: 0, avgMfe4: 0, avgMfe12: 0, avgMaeToPeak: 0, avgHoursToPeak: 0, avgTarget: 0 };
  return {
    signals: signals.length,
    winner5Precision: signals.filter(s => s.outcome.winner5).length / signals.length,
    winner10Precision: signals.filter(s => s.outcome.winner10).length / signals.length,
    fast4Precision: signals.filter(s => s.outcome.fast4).length / signals.length,
    avgMfe1: avg(signals.map(s => s.outcome.mfe1)), avgMfe4: avg(signals.map(s => s.outcome.mfe4)), avgMfe12: avg(signals.map(s => s.outcome.mfe12)),
    avgMaeToPeak: avg(signals.map(s => s.outcome.maeToPeak)), avgHoursToPeak: avg(signals.map(s => s.outcome.hoursToPeak)), avgTarget: avg(signals.map(s => s.outcome.y)),
  };
}

function economicMetrics(signals, all) {
  const m = r.portfolio(signals, all, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  r.withRecall(m, m._trades || [], all);
  return r.safeMetrics(m);
}

function calibrate(train) {
  const cut = Math.floor(train.length * .70), fit = train.slice(0, cut), cal = train.slice(cut);
  const model = fitRidge(fit);
  if (!model || cal.length < 30) return null;
  const scoredCal = cal.map(s => ({ ...s, modelScore: score(model, s) }));
  const scores = scoredCal.map(s => s.modelScore);
  let best = null;
  for (const q of Q_GRID) {
    const th = quantile(scores, q), sig = signalPolicy(scoredCal, th, 'modelScore'), pm = predictionMetrics(sig);
    if (sig.length < 3) continue;
    const objective = pm.winner5Precision * 1.2 + pm.winner10Precision * 1.8 + pm.fast4Precision * .8 + pm.avgTarget * 8 - Math.max(0, -pm.avgMaeToPeak) * 2;
    const row = { q, threshold: th, objective, metrics: pm };
    if (!best || row.objective > best.objective) best = row;
  }
  if (!best) return null;
  const fullModel = fitRidge(train);
  const fullScores = train.map(s => score(fullModel, s));
  return { model: fullModel, q: best.q, threshold: quantile(fullScores, best.q), calibration: best };
}

function evaluateWindow(raw, start, end, trainDays) {
  const trainedSignals = [], baselineSignals = [], audit = [];
  for (let day = start; day < end; day += DAY) {
    const trainTo = day - 12 * HOUR;
    const trainFrom = trainTo - trainDays * DAY;
    const train = raw.filter(s => s.t >= trainFrom && s.t < trainTo);
    const evalRows = raw.filter(s => s.t >= day && s.t < Math.min(end, day + DAY));
    if (train.length < 100 || evalRows.length < 10 || train.filter(s => s.outcome.winner5).length < 5) {
      audit.push({ day: iso(day), trained: false, trainRows: train.length, evalRows: evalRows.length, reason: 'insufficient_training_labels' });
      continue;
    }
    const cfg = calibrate(train);
    if (!cfg) { audit.push({ day: iso(day), trained: false, trainRows: train.length, evalRows: evalRows.length, reason: 'calibration_failed' }); continue; }
    const scored = evalRows.map(s => ({ ...s, modelScore: score(cfg.model, s), v42Score: s.v42.norm, v42Pass: s.v42.pass }));
    const modelSig = signalPolicy(scored, cfg.threshold, 'modelScore');
    const robust = scored.filter(s => s.v42Pass >= 2);
    const baselineTh = robust.length ? -Infinity : Infinity;
    const baseSig = signalPolicy(robust, baselineTh, 'v42Score');
    trainedSignals.push(...modelSig); baselineSignals.push(...baseSig);
    audit.push({ day: iso(day), trained: true, trainRows: train.length, trainWinner5: train.filter(s => s.outcome.winner5).length, evalRows: evalRows.length, q: cfg.q, threshold: cfg.threshold, signals: modelSig.length, v42Signals: baseSig.length, calibration: cfg.calibration.metrics });
  }
  const evalAll = raw.filter(s => s.t >= start && s.t < end);
  return {
    trainDays,
    trained: { prediction: predictionMetrics(trainedSignals), economic: economicMetrics(trainedSignals, evalAll) },
    v42: { prediction: predictionMetrics(baselineSignals), economic: economicMetrics(baselineSignals, evalAll) },
    delta: {
      winner5Precision: predictionMetrics(trainedSignals).winner5Precision - predictionMetrics(baselineSignals).winner5Precision,
      winner10Precision: predictionMetrics(trainedSignals).winner10Precision - predictionMetrics(baselineSignals).winner10Precision,
      avgMfe12: predictionMetrics(trainedSignals).avgMfe12 - predictionMetrics(baselineSignals).avgMfe12,
      netGrowth: economicMetrics(trainedSignals, evalAll).netGrowth - economicMetrics(baselineSignals, evalAll).netGrowth,
      avgNetRet: economicMetrics(trainedSignals, evalAll).avgNetRet - economicMetrics(baselineSignals, evalAll).avgNetRet,
    },
    audit,
  };
}

function passDev(x) {
  const p = x.trained.prediction, e = x.trained.economic, b = x.v42.prediction;
  return p.signals >= 15 && p.winner5Precision >= .25 && p.avgMfe12 > .035 && p.avgMaeToPeak > -.04 && e.netGrowth > 0 && e.avgNetRet > 0 && e.maxDrawdown >= -.08 && (p.winner5Precision >= b.winner5Precision || x.delta.netGrowth > 0);
}

function passConfirm(x) {
  const p = x.trained.prediction, e = x.trained.economic;
  return p.signals >= 8 && p.winner5Precision >= .25 && p.avgMfe12 > .035 && e.netGrowth > 0 && e.avgNetRet > 0 && e.maxDrawdown >= -.08 && x.delta.netGrowth >= 0;
}

async function main() {
  if (![DEV_START, DEV_END, CONFIRM_START, CONFIRM_END].every(Number.isFinite)) throw new Error('Invalid R7 dates');
  if (!(DEV_START < DEV_END && DEV_END <= CONFIRM_START && CONFIRM_START < CONFIRM_END)) throw new Error('R7 periods must be chronological');
  const earliest = DEV_START - 16 * DAY - 12 * HOUR, loadStart = earliest - DAY, loadEnd = CONFIRM_END + DAY;
  const universeMonth = r.prevCompleteMonth(DEV_START);
  console.log(`${VERSION} dev=${iso(DEV_START)}..${iso(DEV_END)} confirm=${iso(CONFIRM_START)}..${iso(CONFIRM_END)} windows=${TRAIN_WINDOWS.join(',')}`);

  const allSymbols = await r.archiveSymbols();
  const targets = allSymbols.filter(s => r.targetSymbol(s).ok);
  const liq = await r.mapLimit(targets, 20, s => r.priorMonthLiquidity(s, universeMonth));
  const ranked = liq.filter(x => x && !x.__error && x.avgDailyQuoteVolume >= MIN_QV).sort((a, z) => z.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  const pool = ranked.slice(0, Number(process.env.HIST_POOL_SIZE || POOL_SIZE || 60)).map(x => x.symbol);
  if (!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');
  if (pool.length < 20) throw new Error('Too few historical symbols');

  const data = new Map();
  const loaded = await r.mapLimit(pool, 8, async symbol => ({ symbol, rows: await r.loadKlines(symbol, loadStart, loadEnd, loadEnd) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  const btc = data.get('BTCUSDT'); if (!btc?.length) throw new Error('BTCUSDT unavailable');
  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();

  for (const [symbol, series] of data) {
    if (symbol === 'BTCUSDT' || series.length < WARM + 146) continue;
    for (let i = WARM; i < series.length - 145; i++) {
      const t = series[i].t;
      if (t < earliest || t >= CONFIRM_END || !r.contiguous(series, i)) continue;
      if ((Math.floor(t / STEP) % 3) !== 0) continue;
      let f; try { f = v.feat(series, i, bm); } catch { continue; }
      if (f.qv < MIN_QV) continue;
      if (f.r24 < -.05 || f.r24 >= .12 || f.r60 < -.03 || f.r60 >= .065 || f.r15 >= .04) continue;
      const precursor = f.vol15 > 1.05 || f.tradeAccel > 1.05 || f.breakout60 > -.004 || f.rs60 > .002;
      if (!precursor) continue;
      const z = breadth.get(t) || { n: 0, up15: 0, up60: 0, breakout: 0, ignite: 0, sum60: 0 };
      z.n++; if (f.r15 > 0) z.up15++; if (f.r60 > 0) z.up60++; if (f.breakout60 > 0) z.breakout++; if (f.vol15 > 1.2) z.ignite++; z.sum60 += f.r60;
      breadth.set(t, z); featureRows.push({ symbol, t, f, series, index: i });
    }
  }

  const raw = [];
  for (const s of featureRows) {
    s.breadth = breadthAt(breadth.get(s.t));
    s.regimeWeights = v.regimeWeights(s.f, s.breadth);
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, z) => z[1] - a[1])[0][0];
    s.outcome = futureOutcome(s); if (!s.outcome) continue;
    s.v42 = v42(s); raw.push(s);
  }
  raw.sort((a, z) => a.t - z.t || a.symbol.localeCompare(z.symbol));

  const development = {};
  for (const d of TRAIN_WINDOWS) {
    const x = evaluateWindow(raw, DEV_START, DEV_END, d); x.pass = passDev(x); development[`${d}d`] = x;
  }
  const eligible = Object.values(development).filter(x => x.pass).sort((a, z) => {
    const az = a.trained.economic.netGrowth * 10 + a.trained.prediction.winner5Precision + a.trained.prediction.winner10Precision * 1.5;
    const bz = z.trained.economic.netGrowth * 10 + z.trained.prediction.winner5Precision + z.trained.prediction.winner10Precision * 1.5;
    return bz - az;
  });
  let confirmation = null;
  if (eligible.length) {
    confirmation = evaluateWindow(raw, CONFIRM_START, CONFIRM_END, eligible[0].trainDays);
    confirmation.pass = passConfirm(confirmation);
  }

  const report = {
    generatedAt: new Date().toISOString(), version: VERSION, researchOnly: true, productionTradingTouched: false,
    objective: 'Train instantaneous ranking directly on future tradable winners (+5%/+10% within 12h) using only pre-entry causal features, with daily walk-forward retraining and fixed signal caps.',
    constraints: { trainingWindows: TRAIN_WINDOWS, maxSignalsPerDay: MAX_SIGNALS_PER_DAY, symbolCooldownHours: SYMBOL_COOLDOWN / HOUR, globalCooldownMinutes: GLOBAL_COOLDOWN / 60000, futureLabelHours: 12, noFutureFeatures: true, productionPromotion: 'NONE' },
    periods: { development: [iso(DEV_START), iso(DEV_END)], chronologicalConfirmation: [iso(CONFIRM_START), iso(CONFIRM_END)], universeMonth: r.monthParts(universeMonth).key },
    universe: { archiveSymbols: allSymbols.length, liquidSymbols: ranked.length, pool: pool.length, loaded: data.size, candidateRows: raw.length, winner5Rows: raw.filter(s => s.outcome.winner5).length, winner10Rows: raw.filter(s => s.outcome.winner10).length },
    development,
    selected: eligible.length ? { trainDays: eligible[0].trainDays } : null,
    confirmation,
    decision: !eligible.length
      ? { label: 'NO_TRAINABLE_WINNER_EDGE', ready: false, reason: 'No 1d/7d/14d walk-forward learner produced positive absolute economics and useful winner precision in development.' }
      : confirmation?.pass
        ? { label: 'WINNER_PRECURSOR_CONFIRMED', ready: false, reason: 'Winner-precursor learner beat the required development and chronological confirmation gates. Keep research-only until production integration is separately guarded.' }
        : { label: 'WINNER_PRECURSOR_NOT_CONFIRMED', ready: false, reason: 'A development configuration emerged but did not survive chronological confirmation. Do not tune on confirmation.' },
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ version: report.version, universe: report.universe, selected: report.selected, development: Object.fromEntries(Object.entries(development).map(([k,x]) => [k,{pass:x.pass,trained:x.trained,v42:x.v42,delta:x.delta}])), confirmation: confirmation ? {pass:confirmation.pass,trained:confirmation.trained,v42:confirmation.v42,delta:confirmation.delta} : null, decision: report.decision }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message || String(e)); process.exit(1); });
