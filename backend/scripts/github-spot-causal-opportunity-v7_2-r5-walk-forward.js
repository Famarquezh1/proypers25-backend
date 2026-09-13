'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R3_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-entry-first.js');
const OUTPUT = path.join(__dirname, '..', 'training-output', 'spot-causal-opportunity-v7_2-r5-holdout.json');
const DAY = 86400000;
const TRAIN_DAYS = 14;
const RANK_FRACTION = 0.08;
const RANK_CAP = 3;

function loadResearchLib() {
  let src = fs.readFileSync(R3_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__r5={
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
  return c.__r5;
}

const r = loadResearchLib();
const b = r.b;
const {
  WARM, FWD, STEP, POOL_SIZE, MIN_QV, FIXED_SIZE, BASE_EXIT, META_FALLBACK,
  avg, v
} = b;

function parseUtcDate(value, label) {
  const t = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(t)) throw new Error(`Invalid ${label}: ${value}`);
  return t;
}

function isoDay(t) { return new Date(t).toISOString().slice(0, 10); }

function makeBroad(samples, cal) {
  return samples.map(s => ({
    ...s,
    quality: broadQuality(s, cal),
    rawQuality: broadQuality(s, cal),
    agreement: causalAgreement(s),
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
  const selected = [];
  for (const g of groups.values()) {
    g.sort((a, z) => z.entryScore - a.entryScore);
    const n = Math.max(1, Math.min(RANK_CAP, Math.ceil(g.length * RANK_FRACTION)));
    selected.push(...g.slice(0, n));
  }
  selected.sort((a, z) => a.t - z.t || z.entryScore - a.entryScore);
  return r.dedupeEntries(selected);
}

function metricView(m) {
  return r.safeMetrics(m);
}

function buildWeeklyFolds(selected, baseline, holdoutRaw, start, end) {
  const folds = [];
  let i = 0;
  for (let a = start; a < end; a += 7 * DAY) {
    const z = Math.min(end, a + 7 * DAY);
    const all = holdoutRaw.filter(s => s.t >= a && s.t < z);
    const sel = selected.filter(s => s.t >= a && s.t < z);
    const base = baseline.filter(s => s.t >= a && s.t < z);
    const sm = r.portfolio(sel, all, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    const bm = r.portfolio(base, all, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    r.withRecall(sm, sm._trades || [], all); r.withRecall(bm, bm._trades || [], all);
    folds.push({ fold: ++i, start: isoDay(a), end: isoDay(z), selected: metricView(sm), baseline: metricView(bm), delta: r.pairedDelta(bm, sm) });
  }
  return folds;
}

async function main() {
  const holdoutStart = parseUtcDate(process.env.HOLDOUT_START || '', 'HOLDOUT_START');
  const holdoutEnd = parseUtcDate(process.env.HOLDOUT_END || '', 'HOLDOUT_END');
  if (holdoutEnd <= holdoutStart) throw new Error('HOLDOUT_END must be after HOLDOUT_START');

  const earliestTrain = holdoutStart - (TRAIN_DAYS + 1) * DAY;
  const loadStart = earliestTrain - DAY;
  const loadEnd = holdoutEnd + DAY;
  const preMonth = r.prevCompleteMonth(holdoutStart);

  console.log(`V7.2-R5-FROZEN-WALK-FORWARD ${isoDay(holdoutStart)}..${isoDay(holdoutEnd)} train=${TRAIN_DAYS}d rank=${RANK_FRACTION} cap=${RANK_CAP}`);

  const allSymbols = await r.archiveSymbols();
  const targets = allSymbols.filter(s => r.targetSymbol(s).ok);
  const liq = await r.mapLimit(targets, 20, s => r.priorMonthLiquidity(s, preMonth));
  const ranked = liq.filter(x => x && !x.__error && x.avgDailyQuoteVolume >= MIN_QV)
    .sort((a, z) => z.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  const pool = ranked.slice(0, POOL_SIZE).map(x => x.symbol);
  if (!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');
  if (pool.length < 20) throw new Error('Too few causal historical symbols for fresh holdout');

  const data = new Map();
  const loaded = await r.mapLimit(pool, 8, async symbol => ({
    symbol,
    rows: await r.loadKlines(symbol, loadStart, loadEnd, loadEnd)
  }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  const btc = data.get('BTCUSDT');
  if (!btc?.length) throw new Error('BTCUSDT unavailable');
  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();

  for (const [symbol, series] of data) {
    if (symbol === 'BTCUSDT' || series.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < series.length - FWD; i++) {
      const t = series[i].t;
      if (t < earliestTrain || t >= holdoutEnd || !r.contiguous(series, i)) continue;
      let f; try { f = v.feat(series, i, bm); } catch { continue; }
      if (f.qv < MIN_QV) continue;
      const z = breadth.get(t) || { n: 0, up15: 0, up60: 0, breakout: 0, ignite: 0, sum60: 0 };
      z.n++; if (f.r15 > 0) z.up15++; if (f.r60 > 0) z.up60++; if (f.breakout60 > 0) z.breakout++;
      if (f.vol15 > 1.2) z.ignite++; z.sum60 += f.r60; breadth.set(t, z);
      featureRows.push({ symbol, t, f, series, index: i });
    }
  }

  const raw = [];
  for (const s of featureRows) {
    if (s.f.r24 < .001 || s.f.r24 >= .18 || s.f.r60 >= .10 || s.f.r15 >= .06) continue;
    const z = breadth.get(s.t), bd = z && z.n
      ? { up15: z.up15 / z.n, up60: z.up60 / z.n, breakout: z.breakout / z.n, ignite: z.ignite / z.n, mean60: z.sum60 / z.n }
      : { up15: .5, up60: .5, breakout: .5, ignite: .5, mean60: 0 };
    s.breadth = bd; s.regimeWeights = v.regimeWeights(s.f, bd);
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, z) => z[1] - a[1])[0][0];
    s.opportunity = v.opportunityScore(bd); s.opp24 = r.opportunity24h(s); s.o = { clean: Boolean(s.opp24?.clean) };
    s.detectionDelayMinutes = r.onsetFor(s, bm); raw.push(s);
  }
  raw.sort((a, z) => a.t - z.t);

  const selectedAll = [], baselineAll = [], dayAudit = [];
  for (let day = holdoutStart; day < holdoutEnd; day += DAY) {
    const trainFrom = day - (TRAIN_DAYS + 1) * DAY;
    const trainTo = day - DAY; // all TRAIN labels have a complete 24h future before evaluation day
    const train = raw.filter(s => s.t >= trainFrom && s.t < trainTo);
    const evalRows = raw.filter(s => s.t >= day && s.t < Math.min(day + DAY, holdoutEnd));
    if (train.length < 200 || evalRows.length < 20) {
      dayAudit.push({ day: isoDay(day), trained: false, trainSamples: train.length, evalSamples: evalRows.length, reason: 'insufficient_samples' });
      continue;
    }
    const cal = v.microCal(train);
    const trainBroad = r.dedupeEntries(makeBroad(train, cal));
    const evalBroadFull = makeBroad(evalRows, cal);
    const model = r.fitEntryModel(trainBroad);
    if (!model) {
      dayAudit.push({ day: isoDay(day), trained: false, trainSamples: train.length, evalSamples: evalRows.length, reason: 'entry_model_unavailable' });
      continue;
    }
    const scored = r.scoreRows(evalBroadFull, model);
    const selected = selectCrossSection(scored);
    const baseline = r.dedupeEntries(evalBroadFull);
    selectedAll.push(...selected); baselineAll.push(...baseline);
    dayAudit.push({
      day: isoDay(day), trained: true, trainSamples: train.length, trainRows: trainBroad.length,
      evalSamples: evalRows.length, baselineSignals: baseline.length, selectedSignals: selected.length,
      modelTrainCount: model.trainCount,
    });
  }

  const holdoutRaw = raw.filter(s => s.t >= holdoutStart && s.t < holdoutEnd);
  const selected = r.dedupeEntries(selectedAll);
  const baseline = r.dedupeEntries(baselineAll);
  const sm = r.portfolio(selected, holdoutRaw, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  const bmtr = r.portfolio(baseline, holdoutRaw, META_FALLBACK, s => r.simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  r.withRecall(sm, sm._trades || [], holdoutRaw); r.withRecall(bmtr, bmtr._trades || [], holdoutRaw);
  const folds = buildWeeklyFolds(selected, baseline, holdoutRaw, holdoutStart, holdoutEnd);
  const positiveWeeks = folds.filter(f => f.selected.tradeCount >= 2 && f.selected.netGrowth > 0 && f.selected.avgNetRet > 0).length;
  const comparableWeeks = folds.filter(f => f.selected.tradeCount >= 2).length;
  const beatWeeks = folds.filter(f => f.selected.tradeCount >= 2 && f.selected.netGrowth > f.baseline.netGrowth).length;
  const delta = r.pairedDelta(bmtr, sm);
  const trainedDays = dayAudit.filter(d => d.trained).length;
  const participation = baseline.length ? selected.length / baseline.length : 0;

  const gates = {
    enoughDays: trainedDays >= 20,
    enoughTrades: sm.tradeCount >= 20,
    positive: sm.netGrowth > 0 && sm.avgNetRet > 0,
    beatsBroad: delta.netGrowth > 0 && delta.avgNetRet > 0,
    temporal: comparableWeeks >= 4 && positiveWeeks >= 3 && beatWeeks >= 3,
    drawdown: sm.maxDrawdown >= -.10,
    timing: sm.timingCoverage >= .5,
    participation: participation >= .08 && participation <= .85,
  };
  const passed = Object.values(gates).every(Boolean);

  const report = {
    generatedAt: new Date().toISOString(),
    version: 'V7.2-R5-FROZEN-WALK-FORWARD',
    researchOnly: true,
    productionTradingTouched: false,
    publicHistoricalDataOnly: true,
    holdoutIntegrity: 'FRESH_UNSEEN_NON_OVERLAPPING_ANCHORED_PERIOD',
    holdout: { start: isoDay(holdoutStart), endExclusive: isoDay(holdoutEnd), priorMonthUniverse: r.monthParts(preMonth).key },
    frozenDesign: {
      trainDays: TRAIN_DAYS, updateFrequency: 'DAILY', rankFraction: RANK_FRACTION, rankCap: RANK_CAP,
      exit: 'BASE_EXIT', size: FIXED_SIZE, meta: 'META_FALLBACK', specialistLayer: 'DISABLED_FOR_PURE_ENTRY_HOLDOUT',
      noHoldoutTuning: true,
    },
    universe: { archiveSymbols: allSymbols.length, priorMonthLiquidSymbols: ranked.length, selectedPool: pool.length, loadedSymbols: data.size },
    samples: { raw: raw.length, holdoutRaw: holdoutRaw.length, baselineSignals: baseline.length, selectedSignals: selected.length, trainedDays },
    dayAudit,
    baseline: metricView(bmtr),
    selected: metricView(sm),
    delta,
    participation,
    weeklyFolds: folds,
    temporal: { comparableWeeks, positiveWeeks, beatWeeks },
    gates,
    decision: {
      pass: passed,
      label: passed ? 'FRESH_HOLDOUT_PASS' : 'FRESH_HOLDOUT_FAIL',
      reason: passed
        ? 'Frozen daily 14d ENTRY rank generalized on this previously unseen non-overlapping holdout.'
        : 'Frozen ENTRY rank failed one or more economic/temporal/risk gates on this previously unseen holdout; do not tune on this holdout.',
    },
    warning: 'This holdout is consumed after this run and must never be reused for parameter tuning.',
  };

  fs.mkdirSync(path.dirname(OUTPUT), { recursive: true });
  fs.writeFileSync(OUTPUT, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ version: report.version, holdout: report.holdout, selected: report.selected, baseline: report.baseline, delta: report.delta, temporal: report.temporal, gates: report.gates, decision: report.decision }, null, 2));
}

main().catch(e => { console.error(e.stack || e.message || String(e)); process.exit(1); });
