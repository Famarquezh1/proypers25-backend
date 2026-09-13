'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R3_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-entry-first.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-market-abstention-v7_2-r6-report.json');
const DAY = 86400000;
const VERSION = 'V7.2-R6-MARKET-ABSTENTION';
const TRAIN_WINDOWS = [1, 7, 14];
const RANK_FRACTION = 0.08;
const RANK_CAP = 3;
const DEV_START = Date.parse(process.env.DEV_START || '2026-02-01T00:00:00Z');
const DEV_END = Date.parse(process.env.DEV_END || '2026-03-15T00:00:00Z');
const HOLDOUT_START = Date.parse(process.env.HOLDOUT_START || '2026-03-15T00:00:00Z');
const HOLDOUT_END = Date.parse(process.env.HOLDOUT_END || '2026-03-29T00:00:00Z');
const RIDGE = 0.40;

function loadResearchLib() {
  let src = fs.readFileSync(R3_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__r6={
    b, archiveSymbols, targetSymbol, prevCompleteMonth, monthParts, priorMonthLiquidity,
    mapLimit, loadKlines, contiguous, opportunity24h, onsetFor, dedupeEntries,
    simulateExit, portfolio, withRecall, safeMetrics, pairedDelta,
    fitEntryModel, scoreRows, broadQuality, causalAgreement
  };`;
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename: R3_PATH,
  });
  vm.runInContext(src, c, { filename: R3_PATH });
  return c.__r6;
}

const r = loadResearchLib();
const b = r.b;
const { WARM, FWD, POOL_SIZE, MIN_QV, FIXED_SIZE, BASE_EXIT, META_FALLBACK, v } = b;

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }
function avg(xs) { return xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0; }
function ret(a, z) { return a > 0 && z > 0 ? z / a - 1 : 0; }
function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function quantile(xs, q) {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y), p = (a.length - 1) * q, i = Math.floor(p), f = p - i;
  return a[i] + (a[Math.min(a.length - 1, i + 1)] - a[i]) * f;
}

function makeBroad(samples, cal) {
  return samples.map(s => ({
    ...s,
    quality: r.broadQuality(s, cal),
    rawQuality: r.broadQuality(s, cal),
    agreement: r.causalAgreement(s),
    regimeConfidence: Math.max(...Object.values(s.regimeWeights || {})),
    activationWeight: 1,
    activationConfidence: 1,
  }));
}

function selectCrossSection(rows) {
  const groups = new Map();
  for (const s of rows) {
    const g = groups.get(s.t) || [];
    g.push(s); groups.set(s.t, g);
  }
  const out = [];
  for (const g of groups.values()) {
    g.sort((a, z) => z.entryScore - a.entryScore);
    const n = Math.max(1, Math.min(RANK_CAP, Math.ceil(g.length * RANK_FRACTION)));
    out.push(...g.slice(0, n));
  }
  out.sort((a, z) => a.t - z.t || z.entryScore - a.entryScore);
  return r.dedupeEntries(out);
}

function btcStates(rows) {
  const m = new Map();
  for (let i = 288; i < rows.length; i++) {
    const rets = [];
    for (let j = i - 11; j <= i; j++) if (j > 0) rets.push(ret(rows[j - 1].c, rows[j].c));
    const mu = avg(rets), variance = avg(rets.map(x => (x - mu) ** 2));
    m.set(rows[i].t, {
      r60: ret(rows[i - 12].c, rows[i].c),
      r240: ret(rows[i - 48].c, rows[i].c),
      r24: ret(rows[i - 288].c, rows[i].c),
      vol60: Math.sqrt(Math.max(0, variance)),
    });
  }
  return m;
}

function marketVector(s, btcMap) {
  const z = s.breadth || {}, btc = btcMap.get(s.t) || {};
  const rw = s.regimeWeights || {};
  return [
    Number(btc.r60 || 0),
    Number(btc.r240 || 0),
    Number(btc.r24 || 0),
    Number(btc.vol60 || 0),
    Number(z.up15 ?? .5) - .5,
    Number(z.up60 ?? .5) - .5,
    Number(z.breakout ?? .5) - .5,
    Number(z.ignite ?? .5) - .5,
    Number(z.mean60 || 0),
    Number(rw.TREND_UP || 0) - Number(rw.RISK_OFF || 0),
    Number(rw.VOLATILE || 0),
  ];
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

function fitRidge(states) {
  if (states.length < 40) return null;
  const p = states[0].x.length;
  const mean = Array(p).fill(0), sd = Array(p).fill(0);
  for (const s of states) for (let j = 0; j < p; j++) mean[j] += s.x[j] / states.length;
  for (const s of states) for (let j = 0; j < p; j++) sd[j] += ((s.x[j] - mean[j]) ** 2) / states.length;
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const dim = p + 1, A = Array.from({ length: dim }, () => Array(dim).fill(0)), Y = Array(dim).fill(0);
  for (const s of states) {
    const x = [1, ...s.x.map((v0, j) => (v0 - mean[j]) / sd[j])];
    for (let i = 0; i < dim; i++) {
      Y[i] += x[i] * s.y;
      for (let j = 0; j < dim; j++) A[i][j] += x[i] * x[j];
    }
  }
  for (let j = 1; j < dim; j++) A[j][j] += RIDGE * states.length;
  const beta = solveLinear(A, Y);
  return beta ? { beta, mean, sd, n: states.length } : null;
}

function scoreMarket(model, x0) {
  if (!model) return -Infinity;
  let s = model.beta[0];
  for (let j = 0; j < x0.length; j++) s += model.beta[j + 1] * ((x0[j] - model.mean[j]) / model.sd[j]);
  return s;
}

function marketStatesFromSelected(rows, btcMap) {
  const groups = new Map();
  for (const s of rows) {
    const g = groups.get(s.t) || [];
    g.push(s); groups.set(s.t, g);
  }
  const out = [];
  for (const [t, g] of groups) {
    const nets = g.map(s => r.simulateExit(s, BASE_EXIT)).filter(Boolean).map(o => clamp(Number(o.net || 0), -.12, .12));
    if (!nets.length) continue;
    out.push({ t, x: marketVector(g[0], btcMap), y: avg(nets) });
  }
  return out.sort((a, z) => a.t - z.t);
}

function evaluateRows(rows, all) {
  const m = r.portfolio(rows, all, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  r.withRecall(m, m._trades || [], all);
  return m;
}

function chooseDailyGate(trainSelected, trainAll, btcMap) {
  if (trainSelected.length < 30) return { enabled: false, reason: 'insufficient_ranked_train_rows' };
  const t0 = trainSelected[0].t, t1 = trainSelected[trainSelected.length - 1].t;
  const split = t0 + (t1 - t0) * .65;
  const fitRows = trainSelected.filter(s => s.t < split), calRows = trainSelected.filter(s => s.t >= split);
  const calAll = trainAll.filter(s => s.t >= split);
  const states = marketStatesFromSelected(fitRows, btcMap);
  const model = fitRidge(states);
  if (!model || calRows.length < 12) return { enabled: false, reason: 'market_model_unavailable' };
  const calScores = calRows.map(s => scoreMarket(model, marketVector(s, btcMap))).filter(Number.isFinite);
  if (!calScores.length) return { enabled: false, reason: 'no_calibration_scores' };
  const thresholds = [-Infinity, quantile(calScores, .35), quantile(calScores, .50), quantile(calScores, .65), quantile(calScores, .80)];
  let best = null;
  for (const threshold of [...new Set(thresholds)]) {
    const gated = calRows.filter(s => scoreMarket(model, marketVector(s, btcMap)) >= threshold);
    const m = evaluateRows(gated, calAll);
    const robust = m.tradeCount >= 5 && m.netGrowth > 0 && m.avgNetRet > 0 && m.maxDrawdown >= -.06;
    const score = robust ? m.netGrowth * 10 + m.avgNetRet * 20 + m.winRate * .03 + m.maxDrawdown * .8 : -1e9;
    const row = { threshold, robust, score, metrics: r.safeMetrics(m), signals: gated.length };
    if (!best || row.score > best.score) best = row;
  }
  if (!best || !best.robust) return { enabled: false, model, reason: 'recent_calibration_has_no_positive_absolute_edge' };
  return { enabled: true, model, threshold: best.threshold, selected: best };
}

function foldMetrics(rows, all, start, end, days) {
  const out = [];
  for (let a = start, i = 1; a < end; a += days * DAY, i++) {
    const z = Math.min(end, a + days * DAY);
    const subRows = rows.filter(s => s.t >= a && s.t < z), subAll = all.filter(s => s.t >= a && s.t < z);
    const m = evaluateRows(subRows, subAll);
    out.push({ fold: i, start: iso(a), end: iso(z), ...r.safeMetrics(m) });
  }
  return out;
}

function summarizePeriod(gated, ungated, raw, start, end, audit) {
  const g = r.dedupeEntries(gated), u = r.dedupeEntries(ungated), all = raw.filter(s => s.t >= start && s.t < end);
  const gm = evaluateRows(g, all), um = evaluateRows(u, all), delta = r.pairedDelta(um, gm);
  const f1 = foldMetrics(g, all, start, end, 1), f7 = foldMetrics(g, all, start, end, 7), f14 = foldMetrics(g, all, start, end, 14);
  const positive = xs => xs.filter(x => x.tradeCount >= 2 && x.netGrowth > 0 && x.avgNetRet > 0).length;
  const comparable = xs => xs.filter(x => x.tradeCount >= 2).length;
  return {
    gated: r.safeMetrics(gm), ungated: r.safeMetrics(um), delta,
    signals: { gated: g.length, ungated: u.length, participation: u.length ? g.length / u.length : 0 },
    trainedDays: audit.filter(x => x.trained).length,
    openDays: audit.filter(x => x.gateOpen).length,
    folds: {
      oneDay: { comparable: comparable(f1), positive: positive(f1), rows: f1 },
      sevenDay: { comparable: comparable(f7), positive: positive(f7), rows: f7 },
      fourteenDay: { comparable: comparable(f14), positive: positive(f14), rows: f14 },
    },
    audit,
  };
}

function devGates(summary) {
  const m = summary.gated, p = summary.signals.participation;
  const w7 = summary.folds.sevenDay, w14 = summary.folds.fourteenDay;
  return {
    enoughTrades: m.tradeCount >= 30,
    positiveAbsolute: m.netGrowth > 0 && m.avgNetRet > 0,
    improvesRankOnly: summary.delta.netGrowth > 0 && summary.delta.avgNetRet > 0,
    drawdown: m.maxDrawdown >= -.08,
    sevenDayStability: w7.comparable >= 5 && w7.positive / Math.max(1, w7.comparable) >= .60,
    fourteenDayStability: w14.comparable >= 2 && w14.positive / Math.max(1, w14.comparable) >= .66,
    participation: p >= .02 && p <= .80,
  };
}

async function runPeriod(raw, btcMap, start, end, trainDays) {
  const gatedAll = [], ungatedAll = [], audit = [];
  for (let day = start; day < end; day += DAY) {
    const trainFrom = day - (trainDays + 1) * DAY;
    const trainTo = day - DAY;
    const train = raw.filter(s => s.t >= trainFrom && s.t < trainTo);
    const evalRows = raw.filter(s => s.t >= day && s.t < Math.min(end, day + DAY));
    if (train.length < 80 || evalRows.length < 10) {
      audit.push({ day: iso(day), trained: false, gateOpen: false, trainSamples: train.length, evalSamples: evalRows.length, reason: 'insufficient_samples' });
      continue;
    }
    const cal = v.microCal(train);
    const trainBroad = makeBroad(train, cal), evalBroad = makeBroad(evalRows, cal);
    const entryModel = r.fitEntryModel(r.dedupeEntries(trainBroad));
    if (!entryModel) {
      audit.push({ day: iso(day), trained: false, gateOpen: false, trainSamples: train.length, evalSamples: evalRows.length, reason: 'entry_rank_model_unavailable' });
      continue;
    }
    const trainSelected = selectCrossSection(r.scoreRows(trainBroad, entryModel));
    const evalSelected = selectCrossSection(r.scoreRows(evalBroad, entryModel));
    ungatedAll.push(...evalSelected);
    const gate = chooseDailyGate(trainSelected, train, btcMap);
    const gated = gate.enabled
      ? evalSelected.filter(s => scoreMarket(gate.model, marketVector(s, btcMap)) >= gate.threshold)
      : [];
    gatedAll.push(...gated);
    audit.push({
      day: iso(day), trained: true, gateOpen: gate.enabled, trainSamples: train.length,
      trainRanked: trainSelected.length, evalSamples: evalRows.length, evalRanked: evalSelected.length,
      gatedSignals: gated.length, threshold: gate.enabled ? gate.threshold : null,
      reason: gate.enabled ? 'positive_recent_market_edge' : gate.reason,
    });
  }
  return summarizePeriod(gatedAll, ungatedAll, raw, start, end, audit);
}

async function main() {
  if (![DEV_START, DEV_END, HOLDOUT_START, HOLDOUT_END].every(Number.isFinite)) throw new Error('Invalid R6 dates');
  if (!(DEV_START < DEV_END && DEV_END <= HOLDOUT_START && HOLDOUT_START < HOLDOUT_END)) throw new Error('R6 periods must be chronological and non-overlapping');
  if (Math.round((HOLDOUT_END - HOLDOUT_START) / DAY) !== 14) throw new Error('R6 final holdout must be exactly 14 days');

  const earliest = DEV_START - 16 * DAY;
  const loadStart = earliest - DAY, loadEnd = HOLDOUT_END + DAY;
  const universeMonth = r.prevCompleteMonth(DEV_START);
  console.log(`${VERSION} dev=${iso(DEV_START)}..${iso(DEV_END)} fresh14=${iso(HOLDOUT_START)}..${iso(HOLDOUT_END)} windows=${TRAIN_WINDOWS.join(',')}`);

  const allSymbols = await r.archiveSymbols();
  const targets = allSymbols.filter(s => r.targetSymbol(s).ok);
  const liq = await r.mapLimit(targets, 20, s => r.priorMonthLiquidity(s, universeMonth));
  const ranked = liq.filter(x => x && !x.__error && x.avgDailyQuoteVolume >= MIN_QV).sort((a, z) => z.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  const pool = ranked.slice(0, Number(process.env.HIST_POOL_SIZE || POOL_SIZE || 60)).map(x => x.symbol);
  if (!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');
  if (pool.length < 20) throw new Error('Too few causal historical symbols');

  const data = new Map(), loaded = await r.mapLimit(pool, 8, async symbol => ({ symbol, rows: await r.loadKlines(symbol, loadStart, loadEnd, loadEnd) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  const btc = data.get('BTCUSDT'); if (!btc?.length) throw new Error('BTCUSDT unavailable');
  const bm = v.btcMap(btc), btcMap = btcStates(btc), featureRows = [], breadth = new Map();

  for (const [symbol, series] of data) {
    if (symbol === 'BTCUSDT' || series.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < series.length - FWD; i++) {
      const t = series[i].t;
      if (t < earliest || t >= HOLDOUT_END || !r.contiguous(series, i)) continue;
      let f; try { f = v.feat(series, i, bm); } catch { continue; }
      if (f.qv < MIN_QV) continue;
      const z = breadth.get(t) || { n: 0, up15: 0, up60: 0, breakout: 0, ignite: 0, sum60: 0 };
      z.n++; if (f.r15 > 0) z.up15++; if (f.r60 > 0) z.up60++; if (f.breakout60 > 0) z.breakout++; if (f.vol15 > 1.2) z.ignite++; z.sum60 += f.r60;
      breadth.set(t, z); featureRows.push({ symbol, t, f, series, index: i });
    }
  }

  const raw = [];
  for (const s of featureRows) {
    if (s.f.r24 < .001 || s.f.r24 >= .18 || s.f.r60 >= .10 || s.f.r15 >= .06) continue;
    const z = breadth.get(s.t), bd = z && z.n
      ? { up15: z.up15 / z.n, up60: z.up60 / z.n, breakout: z.breakout / z.n, ignite: z.ignite / z.n, mean60: z.sum60 / z.n }
      : { up15: .5, up60: .5, breakout: .5, ignite: .5, mean60: 0 };
    s.breadth = bd; s.regimeWeights = v.regimeWeights(s.f, bd);
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, z2) => z2[1] - a[1])[0][0];
    s.opportunity = v.opportunityScore(bd); s.opp24 = r.opportunity24h(s); s.o = { clean: Boolean(s.opp24?.clean) };
    s.detectionDelayMinutes = r.onsetFor(s, bm); raw.push(s);
  }
  raw.sort((a, z) => a.t - z.t);

  const development = {};
  let best = null;
  for (const days of TRAIN_WINDOWS) {
    const summary = await runPeriod(raw, btcMap, DEV_START, DEV_END, days);
    const gates = devGates(summary), pass = Object.values(gates).every(Boolean);
    const score = pass
      ? summary.gated.netGrowth * 12 + summary.gated.avgNetRet * 24 + summary.delta.netGrowth * 5 + summary.gated.maxDrawdown
      : -1e9;
    development[`${days}d`] = { trainDays: days, summary, gates, pass, score };
    if (!best || score > best.score) best = { trainDays: days, score, pass };
  }

  const eligible = Object.values(development).filter(x => x.pass).sort((a, z) => z.score - a.score);
  let holdout = null;
  if (eligible.length) {
    const frozenDays = eligible[0].trainDays;
    const summary = await runPeriod(raw, btcMap, HOLDOUT_START, HOLDOUT_END, frozenDays);
    const m = summary.gated, w7 = summary.folds.sevenDay;
    const gates = {
      enoughTrades: m.tradeCount >= 12,
      positiveAbsolute: m.netGrowth > 0 && m.avgNetRet > 0,
      improvesRankOnly: summary.delta.netGrowth > 0 && summary.delta.avgNetRet > 0,
      drawdown: m.maxDrawdown >= -.08,
      bothSevenDayFoldsPositive: w7.comparable >= 2 && w7.positive === w7.comparable,
      participation: summary.signals.participation >= .02 && summary.signals.participation <= .80,
    };
    holdout = { trainDays: frozenDays, summary, gates, pass: Object.values(gates).every(Boolean) };
  }

  const report = {
    generatedAt: new Date().toISOString(), version: VERSION,
    researchOnly: true, productionTradingTouched: false, publicHistoricalDataOnly: true,
    hypothesis: 'Absolute profitability may require causal market-level abstention before the frozen ENTRY rank, rather than more symbol-level ranking complexity.',
    constraints: {
      trainWindowsOnly: TRAIN_WINDOWS, rankFraction: RANK_FRACTION, rankCap: RANK_CAP,
      exit: 'BASE_EXIT', size: FIXED_SIZE, specialistLayer: 'DISABLED', adaptiveSizing: 'DISABLED',
      consumedHoldoutsExcluded: ['2026-06-01..2026-07-01', '2026-07-01..2026-08-01'],
      finalHoldoutNotEvaluatedUnlessDevelopmentPasses: true,
    },
    periods: { development: [iso(DEV_START), iso(DEV_END)], freshHoldout14d: [iso(HOLDOUT_START), iso(HOLDOUT_END)], universeMonth: r.monthParts(universeMonth).key },
    universe: { archiveSymbols: allSymbols.length, liquidSymbols: ranked.length, pool: pool.length, loaded: data.size },
    samples: { raw: raw.length },
    development,
    selectedDevelopmentConfig: eligible.length ? { trainDays: eligible[0].trainDays, score: eligible[0].score } : null,
    freshHoldout: holdout,
    decision: !eligible.length
      ? { label: 'NO_DEVELOPMENT_EDGE', ready: false, reason: 'None of the 1d/7d/14d causal market-abstention windows produced positive, stable absolute economics in development. Fresh holdout was preserved.' }
      : holdout?.pass
        ? { label: 'FRESH_14D_HOLDOUT_PASS', ready: false, reason: 'R6 passed the fresh 14d holdout, but remains research-only and requires independent confirmation before any production consideration.' }
        : { label: 'FRESH_14D_HOLDOUT_FAIL', ready: false, reason: 'Development edge did not generalize to the untouched 14d holdout. Do not tune on that consumed holdout.' },
    promotion: 'NONE. Research only; no production code, orders, balances, Firestore, Cloud Run or private Binance endpoints.',
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ version: report.version, periods: report.periods, selectedDevelopmentConfig: report.selectedDevelopmentConfig, freshHoldout: holdout ? { trainDays: holdout.trainDays, pass: holdout.pass, gated: holdout.summary.gated, ungated: holdout.summary.ungated, gates: holdout.gates } : null, decision: report.decision }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message || String(e)); process.exit(1); });
