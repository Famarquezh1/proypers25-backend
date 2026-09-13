'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R8_PATH = path.join(__dirname, 'github-spot-winner-capture-trainer-r8.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-winner-profit-meta-report.json');
const DAY = 86400000;
const HOUR = 3600000;
const VERSION = 'WINNER-PROFIT-META-14D';
const ENTRY_TRAIN_DAYS = 14;
const META_TRAIN_DAYS = 14;
const DEV_START = Date.parse('2026-04-15T00:00:00Z');
const DEV_END = Date.parse('2026-05-15T00:00:00Z');
const CONFIRM_START = DEV_END;
const CONFIRM_END = Date.parse('2026-06-01T00:00:00Z');
const RIDGE = 0.45;
const THRESHOLD_Q = [0.45, 0.55, 0.65, 0.75, 0.85, 0.90];

function loadR8() {
  let src = fs.readFileSync(R8_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__pm={r,q,b,buildRaw,generateSignals,metrics};`;
  const c = vm.createContext({ require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout, __dirname, __filename: R8_PATH });
  vm.runInContext(src, c, { filename: R8_PATH });
  return c.__pm;
}

const lib = loadR8();
const { r, q, b } = lib;
const { BASE_EXIT, FIXED_SIZE } = b;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, Number(x) || 0)); }
function avg(xs) { return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0; }
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function logSafe(x) { return Math.log(Math.max(0.2, Number(x) || 0.2)); }
function quantile(xs, q0) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y), p = (a.length - 1) * q0, i = Math.floor(p), f = p - i;
  return a[i] + (a[Math.min(a.length - 1, i + 1)] - a[i]) * f;
}

function metaVector(s) {
  const f = s.f || {}, bd = s.breadth || {}, rw = s.regimeWeights || {}, v42 = s.v42 || {};
  const chase = Math.max(0, Number(f.r24 || 0) - .08) + Math.max(0, Number(f.r60 || 0) - .045) + Math.max(0, Number(f.r15 || 0) - .025);
  return [
    Number(s.modelScore || 0),
    Number(v42.norm || 0), Number(v42.pass || 0) / 3,
    Number(f.r15 || 0), Number(f.r60 || 0), Number(f.r24 || 0),
    logSafe(f.vol15), logSafe(f.vol30), logSafe(f.tradeAccel),
    Number(f.breakout60 || 0), Number(f.rs60 || 0), Number(f.rs240 || 0),
    Number(bd.up15 ?? .5) - .5, Number(bd.up60 ?? .5) - .5,
    Number(bd.breakout ?? .5) - .5, Number(bd.ignite ?? .5) - .5, Number(bd.mean60 || 0),
    Number(rw.TREND_UP || 0) - Number(rw.RISK_OFF || 0), Number(rw.VOLATILE || 0),
    chase,
    Number(s.modelScore || 0) * Math.max(0, Number(f.rs60 || 0)),
    Number(s.modelScore || 0) * (Number(bd.up60 ?? .5) - .5),
  ].map(x => Number.isFinite(Number(x)) ? Number(x) : 0);
}

function baseOutcome(s) {
  const o = r.simulateExit(s, BASE_EXIT);
  return o && Number.isFinite(o.net) ? o : null;
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
  if (rows.length < 35) return null;
  const X = rows.map(x => metaVector(x.s)), p = X[0].length;
  const mean = Array(p).fill(0), sd = Array(p).fill(0);
  for (const x of X) for (let j = 0; j < p; j++) mean[j] += x[j] / X.length;
  for (const x of X) for (let j = 0; j < p; j++) sd[j] += ((x[j] - mean[j]) ** 2) / X.length;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const d = p + 1, A = Array.from({ length: d }, () => Array(d).fill(0)), Y = Array(d).fill(0);
  rows.forEach((row, k) => {
    const x = [1, ...X[k].map((z, j) => (z - mean[j]) / sd[j])];
    const y = clamp(row.y, -.08, .12);
    for (let i = 0; i < d; i++) {
      Y[i] += x[i] * y;
      for (let j = 0; j < d; j++) A[i][j] += x[i] * x[j];
    }
  });
  for (let j = 1; j < d; j++) A[j][j] += RIDGE * rows.length;
  const beta = solveLinear(A, Y);
  return beta ? { beta, mean, sd, n: rows.length } : null;
}

function predict(model, s) {
  const x = metaVector(s); let z = model.beta[0];
  for (let j = 0; j < x.length; j++) z += model.beta[j + 1] * ((x[j] - model.mean[j]) / model.sd[j]);
  return Number.isFinite(z) ? z : -Infinity;
}

function compoundGrowth(rows) {
  let equity = 1;
  for (const x of rows) equity *= 1 + FIXED_SIZE * x.y;
  return equity - 1;
}

function chooseDailyMeta(trainRows) {
  if (trainRows.length < 45) return { enabled: false, reason: 'insufficient_closed_signals' };
  const cut = Math.max(30, Math.floor(trainRows.length * .68));
  const fit = trainRows.slice(0, cut), cal = trainRows.slice(cut);
  if (cal.length < 10) return { enabled: false, reason: 'insufficient_calibration_signals' };
  const model = fitRidge(fit);
  if (!model) return { enabled: false, reason: 'meta_model_unavailable' };
  const calScored = cal.map(x => ({ ...x, pred: predict(model, x.s) })).filter(x => Number.isFinite(x.pred));
  let best = null;
  for (const q0 of THRESHOLD_Q) {
    const th = quantile(calScored.map(x => x.pred), q0);
    const kept = calScored.filter(x => x.pred >= th);
    if (kept.length < 5) continue;
    const meanNet = avg(kept.map(x => x.y)), growth = compoundGrowth(kept), winRate = kept.filter(x => x.y > 0).length / kept.length;
    const robust = meanNet > .001 && growth > 0 && winRate >= .40;
    const score = robust ? growth * 20 + meanNet * 30 + winRate * .05 + Math.min(0.02, kept.length / 1000) : -1e9;
    const row = { q: q0, threshold: th, kept: kept.length, meanNet, growth, winRate, robust, score };
    if (!best || row.score > best.score) best = row;
  }
  if (!best || !best.robust) return { enabled: false, reason: 'no_positive_recent_meta_calibration', calibration: best };
  const full = fitRidge(trainRows);
  if (!full) return { enabled: false, reason: 'full_meta_model_unavailable' };
  const fullScores = trainRows.map(x => predict(full, x.s)).filter(Number.isFinite);
  return { enabled: true, model: full, q: best.q, threshold: quantile(fullScores, best.q), calibration: best };
}

function evaluatePeriod(allSignals, raw, start, end) {
  const gated = [], ungated = [], audit = [];
  for (let day = start; day < end; day += DAY) {
    const evalSignals = allSignals.filter(s => s.t >= day && s.t < Math.min(end, day + DAY));
    ungated.push(...evalSignals);
    const trainFrom = day - META_TRAIN_DAYS * DAY - DAY;
    const trainTo = day - DAY;
    const closed = allSignals
      .filter(s => s.t >= trainFrom && s.t < trainTo)
      .map(s => ({ s, o: baseOutcome(s) }))
      .filter(x => x.o)
      .map(x => ({ s: x.s, y: x.o.net }))
      .sort((a, z) => a.s.t - z.s.t);
    const cfg = chooseDailyMeta(closed);
    const kept = cfg.enabled ? evalSignals.filter(s => predict(cfg.model, s) >= cfg.threshold) : [];
    gated.push(...kept);
    audit.push({ day: iso(day), historicalClosedSignals: closed.length, evalSignals: evalSignals.length, gateOpen: cfg.enabled, kept: kept.length, q: cfg.enabled ? cfg.q : null, threshold: cfg.enabled ? cfg.threshold : null, reason: cfg.enabled ? 'positive_recent_profit_calibration' : cfg.reason, calibration: cfg.calibration || null });
  }
  const all = raw.filter(s => s.t >= start && s.t < end);
  const gm = lib.metrics(gated, all, BASE_EXIT), um = lib.metrics(ungated, all, BASE_EXIT);
  const gp = q.predictionMetrics(gated), up = q.predictionMetrics(ungated);
  return {
    gated: { economic: gm, prediction: gp, signals: gated.length },
    ungated: { economic: um, prediction: up, signals: ungated.length },
    delta: { netGrowth: gm.netGrowth - um.netGrowth, avgNetRet: gm.avgNetRet - um.avgNetRet, winner5Precision: gp.winner5Precision - up.winner5Precision, winner10Precision: gp.winner10Precision - up.winner10Precision },
    audit,
  };
}

function passDev(x) {
  const m = x.gated.economic;
  return x.gated.signals >= 20 && m.netGrowth > 0 && m.avgNetRet > 0 && m.maxDrawdown >= -.06 && x.delta.netGrowth > 0 && x.delta.avgNetRet > 0;
}
function passConfirm(x) {
  const m = x.gated.economic;
  return x.gated.signals >= 8 && m.netGrowth > 0 && m.avgNetRet > 0 && m.maxDrawdown >= -.06 && x.delta.netGrowth >= 0 && x.delta.avgNetRet >= 0;
}

async function main() {
  console.log(`${VERSION} entry=${ENTRY_TRAIN_DAYS}d meta=${META_TRAIN_DAYS}d`);
  const built = await lib.buildRaw();
  const raw = built.raw;
  const preStart = DEV_START - (META_TRAIN_DAYS + 2) * DAY;
  const sig = lib.generateSignals(raw, preStart, CONFIRM_END, ENTRY_TRAIN_DAYS);
  const allSignals = sig.signals;
  const development = evaluatePeriod(allSignals, raw, DEV_START, DEV_END);
  const devPass = passDev(development);
  let confirmation = null;
  if (devPass) {
    confirmation = evaluatePeriod(allSignals, raw, CONFIRM_START, CONFIRM_END);
    confirmation.pass = passConfirm(confirmation);
  }
  const report = {
    generatedAt: new Date().toISOString(), version: VERSION, researchOnly: true, productionTradingTouched: false,
    objective: 'Keep the strongest R7 14d causal winner precursor and the existing BASE_EXIT fixed. Train only an instantaneous profit meta-gate from fully closed prior signals so the system learns which precursor detections are actually monetizable under the current exit.',
    constraints: { entryTrainDays: ENTRY_TRAIN_DAYS, metaTrainDays: META_TRAIN_DAYS, outcomeEmbargoHours: 24, exit: BASE_EXIT, fixedSize: FIXED_SIZE, productionPromotion: 'NONE', noConfirmationTuning: true },
    periods: { development: [iso(DEV_START), iso(DEV_END)], chronologicalConfirmation: [iso(CONFIRM_START), iso(CONFIRM_END)] },
    universe: built.meta,
    development,
    developmentPass: devPass,
    confirmation,
    decision: !devPass
      ? { label: 'PROFIT_META_NO_DEV_EDGE', ready: false, reason: 'The R7 14d precursor remained predictive of movement, but a causal 14d meta-gate trained on fully closed realized returns did not create positive development economics over the same BASE_EXIT.' }
      : confirmation?.pass
        ? { label: 'PROFIT_META_CONFIRMED', ready: false, reason: 'The fixed R7 14d precursor plus causal profit meta-gate produced positive development and chronological confirmation economics while beating ungated R7 on the same fixed exit.' }
        : { label: 'PROFIT_META_NOT_CONFIRMED', ready: false, reason: 'The profit meta-gate passed development but failed untouched chronological confirmation. Do not tune on confirmation.' },
  };
  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ version: report.version, developmentPass: report.developmentPass, development: { gated: development.gated, ungated: development.ungated, delta: development.delta }, confirmation: confirmation ? { pass: confirmation.pass, gated: confirmation.gated, ungated: confirmation.ungated, delta: confirmation.delta } : null, decision: report.decision }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message || String(e)); process.exit(1); });
