'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R7_PATH = path.join(__dirname, 'github-spot-winner-precursor-trainer-r7.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-winner-capture-r8-report.json');
const DAY = 86400000;
const HOUR = 3600000;
const STEP = 300000;
const VERSION = 'R8-WINNER-CAPTURE';
const TRAIN_WINDOWS = [1, 7, 14];
const DEV_START = Date.parse('2026-04-01T00:00:00Z');
const EXIT_SPLIT = Date.parse('2026-05-01T00:00:00Z');
const DEV_END = Date.parse('2026-05-15T00:00:00Z');
const CONFIRM_START = DEV_END;
const CONFIRM_END = Date.parse('2026-06-01T00:00:00Z');

const EXIT_PROFILES = [
  { id: 'capture_20_10_20_08_3h', hardStop: .020, beTrigger: .010, beLock: .001, trailTrigger: .020, trailGap: .008, staleBars: 36 },
  { id: 'capture_25_12_25_10_4h', hardStop: .025, beTrigger: .012, beLock: .001, trailTrigger: .025, trailGap: .010, staleBars: 48 },
  { id: 'capture_30_15_30_12_6h', hardStop: .030, beTrigger: .015, beLock: .001, trailTrigger: .030, trailGap: .012, staleBars: 72 },
  { id: 'capture_35_18_35_15_8h', hardStop: .035, beTrigger: .018, beLock: .001, trailTrigger: .035, trailGap: .015, staleBars: 96 },
  { id: 'capture_40_20_40_18_10h', hardStop: .040, beTrigger: .020, beLock: .001, trailTrigger: .040, trailGap: .018, staleBars: 120 },
];

function loadR7() {
  let src = fs.readFileSync(R7_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src = src.replace('  ].map(Number);', '  ].map(x => Number.isFinite(Number(x)) ? Number(x) : 0);');
  src += `;globalThis.__r8={
    r,b,breadthAt,futureOutcome,v42,calibrate,score,signalPolicy,predictionMetrics
  };`;
  const c = vm.createContext({ require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer, setTimeout, clearTimeout, __dirname, __filename: R7_PATH });
  vm.runInContext(src, c, { filename: R7_PATH });
  return c.__r8;
}

const q = loadR7();
const r = q.r, b = q.b;
const { WARM, MIN_QV, POOL_SIZE, FIXED_SIZE, BASE_EXIT, META_FALLBACK, v } = b;

function iso(t) { return new Date(t).toISOString().slice(0, 10); }
function metrics(signals, all, exitCfg) {
  const m = r.portfolio(signals, all, META_FALLBACK, s => r.simulateExit(s, exitCfg), () => FIXED_SIZE);
  r.withRecall(m, m._trades || [], all);
  return r.safeMetrics(m);
}
function scoreEconomic(m) {
  return m.netGrowth * 12 + m.avgNetRet * 30 + m.winRate * .03 + m.maxDrawdown * .6;
}
function eligibleEconomics(m, minTrades) {
  return m.tradeCount >= minTrades && m.netGrowth > 0 && m.avgNetRet > 0 && m.maxDrawdown >= -.08;
}

function generateSignals(raw, start, end, trainDays) {
  const out = [], audit = [];
  for (let day = start; day < end; day += DAY) {
    const trainTo = day - 12 * HOUR;
    const trainFrom = trainTo - trainDays * DAY;
    const train = raw.filter(s => s.t >= trainFrom && s.t < trainTo);
    const evalRows = raw.filter(s => s.t >= day && s.t < Math.min(end, day + DAY));
    if (train.length < 100 || evalRows.length < 10 || train.filter(s => s.outcome.winner5).length < 5) {
      audit.push({ day: iso(day), trained: false, reason: 'insufficient_training_labels', trainRows: train.length, evalRows: evalRows.length });
      continue;
    }
    const cfg = q.calibrate(train);
    if (!cfg) {
      audit.push({ day: iso(day), trained: false, reason: 'calibration_failed', trainRows: train.length, evalRows: evalRows.length });
      continue;
    }
    const scored = evalRows.map(s => ({ ...s, modelScore: q.score(cfg.model, s) }));
    const sig = q.signalPolicy(scored, cfg.threshold, 'modelScore');
    out.push(...sig);
    audit.push({ day: iso(day), trained: true, trainRows: train.length, evalRows: evalRows.length, q: cfg.q, threshold: cfg.threshold, signals: sig.length });
  }
  return { signals: out, audit };
}

async function buildRaw() {
  const earliest = DEV_START - 16 * DAY - 12 * HOUR, loadStart = earliest - DAY, loadEnd = CONFIRM_END + DAY;
  const universeMonth = r.prevCompleteMonth(DEV_START);
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
    s.breadth = q.breadthAt(breadth.get(s.t));
    s.regimeWeights = v.regimeWeights(s.f, s.breadth);
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, z) => z[1] - a[1])[0][0];
    s.outcome = q.futureOutcome(s); if (!s.outcome) continue;
    s.v42 = q.v42(s);
    raw.push(s);
  }
  raw.sort((a, z) => a.t - z.t || a.symbol.localeCompare(z.symbol));
  return { raw, meta: { archiveSymbols: allSymbols.length, liquidSymbols: ranked.length, pool: pool.length, loaded: data.size, candidateRows: raw.length, winner5Rows: raw.filter(s => s.outcome.winner5).length, winner10Rows: raw.filter(s => s.outcome.winner10).length, universeMonth: r.monthParts(universeMonth).key } };
}

async function main() {
  console.log(`${VERSION} entryWindows=${TRAIN_WINDOWS.join(',')} exits=${EXIT_PROFILES.length}`);
  const { raw, meta } = await buildRaw();
  const devAll = raw.filter(s => s.t >= DEV_START && s.t < DEV_END);
  const confirmAll = raw.filter(s => s.t >= CONFIRM_START && s.t < CONFIRM_END);
  const candidates = [];

  for (const trainDays of TRAIN_WINDOWS) {
    const g = generateSignals(raw, DEV_START, DEV_END, trainDays);
    const pred = q.predictionMetrics(g.signals);
    const earlySignals = g.signals.filter(s => s.t < EXIT_SPLIT);
    const lateSignals = g.signals.filter(s => s.t >= EXIT_SPLIT);
    const earlyAll = raw.filter(s => s.t >= DEV_START && s.t < EXIT_SPLIT);
    const lateAll = raw.filter(s => s.t >= EXIT_SPLIT && s.t < DEV_END);
    const baseLate = metrics(lateSignals, lateAll, BASE_EXIT);

    for (const exit of EXIT_PROFILES) {
      const early = metrics(earlySignals, earlyAll, exit);
      const late = metrics(lateSignals, lateAll, exit);
      const robust = eligibleEconomics(early, 20) && eligibleEconomics(late, 10) && pred.winner5Precision >= .20 && pred.avgMfe12 >= .04;
      const row = {
        trainDays, exit, robust, prediction: pred, early, late, baseLate,
        lateDeltaVsBase: { netGrowth: late.netGrowth - baseLate.netGrowth, avgNetRet: late.avgNetRet - baseLate.avgNetRet },
        score: robust ? scoreEconomic(late) + scoreEconomic(early) * .5 + pred.winner5Precision + pred.winner10Precision * 1.5 : -1e9,
      };
      candidates.push(row);
    }
  }

  candidates.sort((a, z) => z.score - a.score);
  const selected = candidates.find(x => x.robust) || null;
  let confirmation = null;
  if (selected) {
    const g = generateSignals(raw, CONFIRM_START, CONFIRM_END, selected.trainDays);
    const pred = q.predictionMetrics(g.signals);
    const matched = metrics(g.signals, confirmAll, selected.exit);
    const base = metrics(g.signals, confirmAll, BASE_EXIT);
    const gates = {
      signals: pred.signals >= 8,
      winnerPrecision: pred.winner5Precision >= .20,
      avgMfe12: pred.avgMfe12 >= .04,
      positiveEconomics: matched.netGrowth > 0 && matched.avgNetRet > 0,
      drawdown: matched.maxDrawdown >= -.08,
      beatsBaseExit: matched.netGrowth > base.netGrowth && matched.avgNetRet > base.avgNetRet,
    };
    confirmation = { trainDays: selected.trainDays, exit: selected.exit, prediction: pred, matched, base, gates, pass: Object.values(gates).every(Boolean), audit: g.audit };
  }

  const report = {
    generatedAt: new Date().toISOString(), version: VERSION,
    researchOnly: true, productionTradingTouched: false,
    objective: 'Convert the R7 causal winner-precursor MFE edge into realized economics by training a small frozen family of earlier break-even/trailing exits, selecting on early development, requiring survival on late development, then confirming once on a chronological period not used for selection.',
    constraints: { trainingWindows: TRAIN_WINDOWS, exitProfiles: EXIT_PROFILES, fixedSize: FIXED_SIZE, entryModel: 'R7.1 finite winner precursor', productionPromotion: 'NONE' },
    periods: { exitSelection: [iso(DEV_START), iso(EXIT_SPLIT)], lateDevelopment: [iso(EXIT_SPLIT), iso(DEV_END)], chronologicalConfirmation: [iso(CONFIRM_START), iso(CONFIRM_END)] },
    universe: meta,
    selectedDevelopment: selected ? { trainDays: selected.trainDays, exit: selected.exit, prediction: selected.prediction, early: selected.early, late: selected.late, baseLate: selected.baseLate, lateDeltaVsBase: selected.lateDeltaVsBase, score: selected.score } : null,
    topDevelopmentCandidates: candidates.slice(0, 8).map(x => ({ trainDays: x.trainDays, exit: x.exit, robust: x.robust, prediction: x.prediction, early: x.early, late: x.late, baseLate: x.baseLate, lateDeltaVsBase: x.lateDeltaVsBase, score: x.score })),
    confirmation,
    decision: !selected
      ? { label: 'NO_CAPTURE_EXIT_EDGE', ready: false, reason: 'The R7 precursor predicts future MFE, but none of the small capture-exit family produced positive economics in both early and late development.' }
      : confirmation?.pass
        ? { label: 'WINNER_CAPTURE_CONFIRMED', ready: false, reason: 'A frozen R7 precursor + capture-exit combination produced positive economics in both development phases and in chronological confirmation, while beating the old base exit on the same signals.' }
        : { label: 'WINNER_CAPTURE_NOT_CONFIRMED', ready: false, reason: 'A development combination existed but did not survive chronological confirmation. Do not tune on confirmation.' },
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ version: report.version, selectedDevelopment: report.selectedDevelopment, confirmation: report.confirmation ? { trainDays: report.confirmation.trainDays, exit: report.confirmation.exit, prediction: report.confirmation.prediction, matched: report.confirmation.matched, base: report.confirmation.base, gates: report.confirmation.gates, pass: report.confirmation.pass } : null, decision: report.decision }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message || String(e)); process.exit(1); });
