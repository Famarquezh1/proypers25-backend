'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R2_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-robust.js');

function loadR2() {
  let src = fs.readFileSync(R2_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__r2={
    b, timeFolds, positiveFoldCount, safeMetrics, choosePoliciesRobust,
    chooseExitsRobust, chooseSizingRobust, robustSize, validationStabilityRobust
  };`;
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename: R2_PATH,
  });
  vm.runInContext(src, c, { filename: R2_PATH });
  return c.__r2;
}

const r2 = loadR2();
const b = r2.b;
const {
  REGIMES, INTERVAL, STEP, DAY, WARM, FWD, PURGE, COOLDOWN, COST, DAYS, POOL_SIZE, MIN_QV,
  MIN_TEST_TRADES, FIXED_SIZE, BASE_EXIT, META_FALLBACK,
  avg, median, clamp, pct, isoDay, v,
  archiveSymbols, targetSymbol, prevCompleteMonth, monthParts, priorMonthLiquidity, mapLimit, loadKlines, contiguous,
  opportunity24h, simulateExit, onsetFor, dedupeEntries, summarizeTrades, withRecall, stripMetrics,
  simpleTradeMetrics, portfolio, blendExit, metaGrid, regimeAttribution, exitReasonAttribution, pairedDelta, writeReport,
  entryQuality,
} = b;
const {
  timeFolds, positiveFoldCount, safeMetrics, choosePoliciesRobust,
  chooseExitsRobust, chooseSizingRobust, robustSize, validationStabilityRobust,
} = r2;

const VERSION = 'V7.2-R3-ENTRY-FIRST';
const HOLDOUT_INTEGRITY = 'COMPROMISED_BY_ITERATIVE_REVIEW';
const MIN_GATE_TRADES = 8;

const ENTRY_FEATURES = {
  r15: s => s.f.r15,
  r60: s => s.f.r60,
  r24: s => s.f.r24,
  vol15: s => Math.log(Math.max(.2, s.f.vol15)),
  breakout60: s => s.f.breakout60,
  rs60: s => s.f.rs60,
  pullback: s => s.f.pullback,
  trendEfficiency: s => s.f.trendEfficiency,
  opportunity: s => s.opportunity,
  regimeConfidence: s => Math.max(...Object.values(s.regimeWeights || {})),
  detectionDelay: s => Number.isFinite(s.detectionDelayMinutes) ? Math.min(360, s.detectionDelayMinutes) / 360 : null,
};

function causalAgreement(s) {
  const f = s.f;
  const flags = [
    f.r15 > 0,
    f.r60 > 0,
    f.vol15 >= 1.10,
    f.breakout60 >= -.002,
    f.rs60 > 0,
  ];
  return flags.filter(Boolean).length / flags.length;
}

function broadQuality(s, cal) {
  const f = s.f;
  const m15 = clamp(.5 + f.r15 / .03);
  const m60 = clamp(.5 + f.r60 / .07);
  const ignition = clamp(.5 + Math.log(Math.max(.2, f.vol15)) / 1.6);
  const breakout = clamp(.5 + f.breakout60 / .025);
  const relative = clamp(.5 + f.rs60 / .05);
  const efficiency = clamp(f.trendEfficiency || 0);
  const opportunity = clamp(s.opportunity || 0);
  const micro = clamp(v.microScore(f, cal));
  return clamp(
    .14 * m15 + .16 * m60 + .15 * ignition + .13 * breakout + .14 * relative +
    .10 * efficiency + .10 * opportunity + .08 * micro
  );
}

function makeBroadRows(samples, cal) {
  const rows = samples.map(s => ({
    ...s,
    quality: broadQuality(s, cal),
    rawQuality: broadQuality(s, cal),
    agreement: causalAgreement(s),
    regimeConfidence: Math.max(...Object.values(s.regimeWeights || {})),
    activationWeight: 1,
    activationConfidence: 1,
  }));
  return dedupeEntries(rows);
}

function labelUtility(s) {
  const o = simulateExit(s, BASE_EXIT);
  if (!o) return null;
  return o.net + .08 * Math.min(.10, Math.max(0, o.mfeFixed24h)) - .010 * (o.stopBefore10 ? 1 : 0);
}

function fitEntryModel(trainRows) {
  const labeled = trainRows.map(s => ({ s, y: labelUtility(s) })).filter(x => Number.isFinite(x.y));
  if (labeled.length < 40) return null;
  const global = avg(labeled.map(x => x.y));
  const features = {};
  for (const [name, fn] of Object.entries(ENTRY_FEATURES)) {
    const vals = labeled.map(x => fn(x.s)).filter(Number.isFinite);
    if (vals.length < 30) continue;
    const cuts = [.2, .4, .6, .8].map(q => pct(vals, q));
    const bins = Array.from({ length: 5 }, () => ({ n: 0, sum: 0 }));
    for (const x of labeled) {
      const z = fn(x.s); if (!Number.isFinite(z)) continue;
      let i = 0; while (i < cuts.length && z > cuts[i]) i++;
      bins[i].n++; bins[i].sum += x.y;
    }
    const prior = 20;
    features[name] = {
      cuts,
      edge: bins.map(z => ((z.sum + prior * global) / (z.n + prior)) - global),
      counts: bins.map(z => z.n),
    };
  }
  if (Object.keys(features).length < 6) return null;
  return { trainCount: labeled.length, globalUtility: global, features };
}

function entryScore(s, model) {
  if (!model) return .5;
  let sum = 0, weight = 0;
  for (const [name, z] of Object.entries(model.features)) {
    const value = ENTRY_FEATURES[name](s); if (!Number.isFinite(value)) continue;
    let i = 0; while (i < z.cuts.length && value > z.cuts[i]) i++;
    const reliability = clamp(z.counts[i] / 35, .25, 1);
    sum += reliability * clamp(.5 + z.edge[i] / .045);
    weight += reliability;
  }
  return weight ? clamp(sum / weight) : .5;
}

function scoreRows(rows, model) {
  return rows.map(s => ({ ...s, entryScore: entryScore(s, model) }));
}

function foldPortfolio(rows, all, cfg) {
  return timeFolds(rows).map((fr, i) => {
    if (!fr.length) return { fold: i + 1, tradeCount: 0, netGrowth: 0, avgNetRet: 0, maxDrawdown: 0 };
    const a = fr[0].t, z = fr.at(-1).t;
    const fa = all.filter(s => s.t >= a && s.t <= z);
    const m = portfolio(fr, fa, cfg, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    return { fold: i + 1, ...safeMetrics(m) };
  });
}

function chooseEntryGate(trainBroad, valBroad, trainAll, valAll) {
  const model = fitEntryModel(trainBroad);
  if (!model) return { enabled: false, model: null, threshold: null, selectedByEvidence: false, reason: 'Insufficient broad TRAIN rows.' };
  const tr = scoreRows(trainBroad, model), va = scoreRows(valBroad, model);
  const scores = tr.map(s => s.entryScore);
  const candidates = [.40, .50, .60, .70, .78, .84].map(q => pct(scores, q));
  const base = portfolio(va, valAll, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  withRecall(base, base._trades || [], valAll);
  let best = null; const trials = [];
  for (const threshold of candidates) {
    const rows = va.filter(s => s.entryScore >= threshold);
    const m = portfolio(rows, valAll, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], valAll);
    const folds = foldPortfolio(rows, valAll, META_FALLBACK);
    const valid = folds.filter(f => f.tradeCount >= 2);
    const pos = positiveFoldCount(valid, 'avgNetRet', 0);
    const participation = va.length ? rows.length / va.length : 0;
    const delta = pairedDelta(base, m);
    const robust = m.tradeCount >= MIN_GATE_TRADES && valid.length >= 2 && pos >= 2 && participation >= .08
      && m.netGrowth > 0 && m.avgNetRet > 0 && delta.netGrowth > 0 && delta.avgNetRet > 0
      && m.maxDrawdown >= -.12;
    const score = robust
      ? m.netGrowth * 12 + m.avgNetRet * 30 + delta.netGrowth * 8 + delta.avgNetRet * 18
        + m.precision * .35 + m.recall * .25 + pos * .12 - Math.max(0, .12 - participation)
      : -1e9;
    const row = { threshold, validation: safeMetrics(m), delta: safeMetrics(delta), folds, participation, robust, score };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) {
    return { enabled: false, model, threshold: null, selectedByEvidence: false, baselineValidation: safeMetrics(base), trials, reason: 'No ENTRY threshold produced positive, temporally robust VALIDATION economics versus the broad causal pool.' };
  }
  return { enabled: true, model, threshold: best.threshold, selectedByEvidence: true, baselineValidation: safeMetrics(base), selected: best, trials };
}

function applyEntryGate(rows, gate) {
  const scored = scoreRows(rows, gate.model);
  if (!gate.enabled) return { rows: [], scored, skipped: scored.length };
  const kept = scored.filter(s => s.entryScore >= gate.threshold);
  return { rows: kept, scored, skipped: scored.length - kept.length };
}

function applyRegimeModifier(rows, policies, cal) {
  const out = [];
  let withEvidence = 0, withoutEvidence = 0;
  for (const s of rows) {
    let w = 0, activation = 0, specialistQ = 0, agreement = 0;
    for (const rg of REGIMES) {
      const p = policies[rg];
      if (!p?.th || !p?.cfg) continue;
      const rw = s.regimeWeights[rg] || 0;
      if (rw < .10) continue;
      const e = entryQuality(s, p, cal);
      if (!e) continue;
      w += rw; activation += rw * clamp(p.activation || 0); specialistQ += rw * e.quality; agreement += rw * e.agreement;
    }
    let evidenceConfidence, q, a;
    if (w > 0) {
      withEvidence++;
      evidenceConfidence = clamp(activation / w);
      q = clamp(.70 * s.quality + .30 * (specialistQ / w));
      a = clamp(.65 * s.agreement + .35 * (agreement / w));
    } else {
      withoutEvidence++;
      evidenceConfidence = .35;
      q = s.quality;
      a = s.agreement;
    }
    const regimeWeight = .82 + .18 * Math.sqrt(evidenceConfidence);
    out.push({ ...s, quality: clamp(q * regimeWeight), agreement: a, activationWeight: evidenceConfidence, activationConfidence: evidenceConfidence });
  }
  return { rows: out, stats: { withSpecialistEvidence: withEvidence, withoutSpecialistEvidence: withoutEvidence } };
}

function chooseMeta(valRows, valAll) {
  let best = null; const trials = [];
  for (const cfg of metaGrid()) {
    const rows = valRows.filter(s => s.opportunity >= cfg.oppFloor);
    const m = portfolio(rows, valAll, cfg, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], valAll);
    const folds = timeFolds(rows).map((fr, i) => {
      if (!fr.length) return { fold: i + 1, tradeCount: 0, netGrowth: 0, avgNetRet: 0, maxDrawdown: 0 };
      const a = fr[0].t, z = fr.at(-1).t, fa = valAll.filter(s => s.t >= a && s.t <= z);
      const fm = portfolio(fr, fa, cfg, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
      return { fold: i + 1, ...safeMetrics(fm) };
    });
    const valid = folds.filter(f => f.tradeCount >= 2), pos = positiveFoldCount(valid, 'avgNetRet', 0);
    const participation = rows.length ? m.tradeCount / rows.length : 0;
    const robust = m.tradeCount >= MIN_GATE_TRADES && valid.length >= 2 && pos >= 2 && m.netGrowth > 0 && m.avgNetRet > 0 && m.maxDrawdown >= -.12;
    const score = robust ? m.netGrowth * 9 + m.avgNetRet * 24 + m.winRate * .3 + m.recall * .25 + pos * .10 - Math.max(0, .10 - participation) : -1e9;
    const row = { cfg, validation: safeMetrics(m), folds, participation, robust, score, candidates: rows.length };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) return { cfg: META_FALLBACK, selectedByEvidence: false, score: -1e9, trials, reason: 'No META configuration retained positive temporally robust validation economics.' };
  return { ...best, selectedByEvidence: true, trials };
}

function decide(test) {
  const { baseline, full, pairedExit, participation, selectionEvidence, sizingMode, causalAttribution } = test;
  if (full.tradeCount < MIN_TEST_TRADES || baseline.tradeCount < MIN_TEST_TRADES) return { ready: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'TEST has too few comparable admitted trades.' };
  const activeRegimes = REGIMES.filter(r => test.regimeAttribution[r]?.tradeCount >= 3).length;
  const gates = {
    positive: full.netGrowth > 0,
    economicBeat: full.netGrowth > baseline.netGrowth && full.avgNetRet > baseline.avgNetRet,
    capture: full.avgCaptureRatioFixed24h >= baseline.avgCaptureRatioFixed24h && full.avgCaptureLoss24h <= baseline.avgCaptureLoss24h,
    drawdown: full.maxDrawdown >= -.12,
    timing: full.timingCoverage >= .5 && baseline.timingCoverage >= .5 && full.avgDetectionDelayMinutes <= baseline.avgDetectionDelayMinutes + 30,
    participation: participation.participationRate >= .25,
    entryEvidence: selectionEvidence.entry && selectionEvidence.meta,
    exitSafe: !selectionEvidence.exit || (pairedExit.delta.netGrowth >= 0 && pairedExit.delta.avgNetRet >= 0),
    sizingSafe: sizingMode === 'FIXED_FALLBACK' || causalAttribution.sizingEffect.netGrowth >= 0,
    multiRegime: activeRegimes >= 2,
  };
  const promising = Object.values(gates).every(Boolean);
  if (promising) return { ready: false, label: 'PROMISING_REQUIRES_FRESH_HOLDOUT', reason: 'All reused-window gates pass, but iterative review has compromised holdout integrity; a fresh unseen holdout is mandatory.', gates };
  return { ready: false, label: 'REQUIRES_IMPROVEMENT', reason: 'ENTRY-first is measurable but one or more economic, capture, risk, timing, participation or multi-regime gates still fail.', gates };
}

async function main() {
  const now = new Date();
  const END = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const START = END - DAYS * DAY, LOAD_START = START - DAY, LOAD_END = END, preMonth = prevCompleteMonth(START);
  console.log(`${VERSION} research ${DAYS}d ${isoDay(START)}..${isoDay(END - 1)} pool=${POOL_SIZE}`);

  const allSymbols = await archiveSymbols();
  const audit = {
    archiveSymbols: allSymbols.length, excludedStableFiat: 0, excludedLeveraged: 0, excludedInvalid: 0, excludedOtherQuote: 0,
    priorMonthAvailable: 0, selectedPool: 0, prefilterMonth: monthParts(preMonth).key,
    selectionCutoff: new Date(START).toISOString(), selectionUsesCurrentTicker: false, selectionUsesFutureVolume: false,
    survivorshipControl: 'Historical Binance Vision archive prefixes only; no current ticker/exchangeInfo universe.',
  };
  const targets = [];
  for (const s of allSymbols) {
    const t = targetSymbol(s);
    if (t.ok) targets.push(s);
    else if (t.why === 'stableFiat') audit.excludedStableFiat++;
    else if (t.why === 'leveraged') audit.excludedLeveraged++;
    else if (t.why === 'invalid') audit.excludedInvalid++;
    else audit.excludedOtherQuote++;
  }
  const liq = await mapLimit(targets, 20, s => priorMonthLiquidity(s, preMonth));
  const ranked = liq.filter(x => x && !x.__error && x.avgDailyQuoteVolume >= MIN_QV).sort((a, z) => z.avgDailyQuoteVolume - a.avgDailyQuoteVolume);
  audit.priorMonthAvailable = ranked.length;
  const pool = ranked.slice(0, POOL_SIZE).map(x => x.symbol); audit.selectedPool = pool.length;
  if (!pool.includes('BTCUSDT')) pool.unshift('BTCUSDT');
  if (pool.length < 20) return writeReport({ version: VERSION, researchOnly: true, lookbackDays: DAYS, universeAudit: audit, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Too few causal historical symbols.' } });

  const data = new Map(), loaded = await mapLimit(pool, 8, async s => ({ symbol: s, rows: await loadKlines(s, LOAD_START, LOAD_END, END) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  audit.loadedSymbols = data.size;
  const btc = data.get('BTCUSDT'); if (!btc?.length) throw new Error('BTCUSDT historical archive unavailable');
  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();
  for (const [symbol, series] of data) {
    if (symbol === 'BTCUSDT' || series.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < series.length - FWD; i++) {
      const t = series[i].t; if (t < START || t >= END - FWD * STEP || !contiguous(series, i)) continue;
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
    s.opportunity = v.opportunityScore(bd); s.opp24 = opportunity24h(s); s.o = { clean: Boolean(s.opp24?.clean) };
    s.detectionDelayMinutes = onsetFor(s, bm); raw.push(s);
  }
  raw.sort((a, z) => a.t - z.t);
  if (raw.length < 600) return writeReport({ version: VERSION, researchOnly: true, lookbackDays: DAYS, samples: { all: raw.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Too few causal samples.' } });

  const t0 = raw[0].t, t1 = raw.at(-1).t, span = t1 - t0, c1 = t0 + span * .45, c2 = t0 + span * .80, horizon = FWD * STEP;
  const train = raw.filter(x => x.t < c1 - horizon), val = raw.filter(x => x.t > c1 + PURGE && x.t < c2 - horizon), test = raw.filter(x => x.t > c2 + PURGE);
  if (train.length < 200 || val.length < 80 || test.length < 80) return writeReport({ version: VERSION, researchOnly: true, lookbackDays: DAYS, samples: { all: raw.length, train: train.length, validation: val.length, test: test.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Embargoed split too small.' } });

  const cal = v.microCal(train);
  const broadTrain = makeBroadRows(train, cal), broadVal = makeBroadRows(val, cal), broadTest = makeBroadRows(test, cal);
  const entryGate = chooseEntryGate(broadTrain, broadVal, train, val);
  const trGate = applyEntryGate(broadTrain, entryGate), vaGate = applyEntryGate(broadVal, entryGate), teGate = applyEntryGate(broadTest, entryGate);

  const policies = choosePoliciesRobust(trGate.rows, vaGate.rows, cal);
  const trMod = applyRegimeModifier(trGate.rows, policies, cal), vaMod = applyRegimeModifier(vaGate.rows, policies, cal), teMod = applyRegimeModifier(teGate.rows, policies, cal);
  const meta = chooseMeta(vaMod.rows, val);
  const trRows = trMod.rows.filter(s => s.opportunity >= meta.cfg.oppFloor);
  const vaRows = vaMod.rows.filter(s => s.opportunity >= meta.cfg.oppFloor);
  const teRows = teMod.rows.filter(s => s.opportunity >= meta.cfg.oppFloor);

  const exitSel = chooseExitsRobust(trRows, vaRows);
  const sizing = chooseSizingRobust(vaRows, exitSel.selected);
  for (const s of teRows) {
    s.baseOutcome = simulateExit(s, BASE_EXIT);
    s.adaptiveExit = blendExit(s, exitSel.selected);
    s.adaptiveOutcome = simulateExit(s, s.adaptiveExit);
  }

  const broadRaw = simpleTradeMetrics(broadTest, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  const gateRaw = simpleTradeMetrics(teGate.rows, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  const regimeRaw = simpleTradeMetrics(teMod.rows, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  const metaRaw = simpleTradeMetrics(teRows, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  const pairBaseRaw = simpleTradeMetrics(teRows, s => s.baseOutcome, () => FIXED_SIZE);
  const pairAdaptRaw = simpleTradeMetrics(teRows, s => s.adaptiveOutcome, () => FIXED_SIZE);
  const sizeFixedRaw = simpleTradeMetrics(teRows, s => s.adaptiveOutcome, () => FIXED_SIZE);
  const sizeChosenRaw = simpleTradeMetrics(teRows, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg));
  for (const m of [broadRaw, gateRaw, regimeRaw, metaRaw, pairBaseRaw, pairAdaptRaw, sizeFixedRaw, sizeChosenRaw]) withRecall(m, m._trades || [], test);

  const fullBase = portfolio(teRows, test, meta.cfg, s => s.baseOutcome, () => FIXED_SIZE, () => BASE_EXIT.hardStop);
  const full = portfolio(teRows, test, meta.cfg, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg), s => s.adaptiveExit.hardStop);
  withRecall(fullBase, fullBase._trades || [], test); withRecall(full, full._trades || [], test);
  const reg = regimeAttribution(full._trades || [], test), reasons = exitReasonAttribution(full._trades || []);

  const pairedExit = { baselineExitFixedSize: safeMetrics(pairBaseRaw), adaptiveExitFixedSize: safeMetrics(pairAdaptRaw), delta: pairedDelta(pairBaseRaw, pairAdaptRaw) };
  const sizingAttribution = { adaptiveExitFixedSize: safeMetrics(sizeFixedRaw), chosenSizing: safeMetrics(sizeChosenRaw), mode: sizing.mode, delta: pairedDelta(sizeFixedRaw, sizeChosenRaw) };
  const entryAttribution = {
    broadCausalPool: safeMetrics(broadRaw), trajectoryGated: safeMetrics(gateRaw), regimeWeighted: safeMetrics(regimeRaw), metaAdmittedSet: safeMetrics(metaRaw),
    trajectoryDelta: pairedDelta(broadRaw, gateRaw), regimeModifierDelta: pairedDelta(gateRaw, regimeRaw), metaDelta: pairedDelta(regimeRaw, metaRaw),
    counts: { broad: broadTest.length, trajectory: teGate.rows.length, regimeWeighted: teMod.rows.length, meta: teRows.length },
  };
  const participation = {
    broadSignals: broadTest.length, entryGateSignals: teGate.rows.length, regimeWeightedSignals: teMod.rows.length, candidateSignals: teRows.length,
    admittedTrades: full.tradeCount, participationRate: teRows.length ? full.tradeCount / teRows.length : 0,
    skippedByEntryGate: teGate.skipped, skippedByConcurrency: full.skippedByConcurrency, skippedByExposure: full.skippedByExposure, skippedByRisk: full.skippedByRisk,
  };
  const selectionEvidence = { entry: entryGate.selectedByEvidence, meta: meta.selectedByEvidence, exit: exitSel.selectedByEvidence, sizing: sizing.selectedByEvidence };
  const causalAttribution = { entryEffect: entryAttribution.trajectoryDelta, regimeEffect: entryAttribution.regimeModifierDelta, metaEffect: entryAttribution.metaDelta, exitEffect: pairedExit.delta, sizingEffect: sizingAttribution.delta };
  const decision = decide({ baseline: fullBase, full, pairedExit, participation, selectionEvidence, sizingMode: sizing.mode, causalAttribution, regimeAttribution: reg });

  const report = {
    generatedAt: new Date().toISOString(), version: VERSION,
    experiment: 'Causal Opportunity Capture & Regime Attribution — ENTRY-first causal selector',
    researchOnly: true, publicDataOnly: true, privateBinanceUsed: false, firestoreUsed: false, productionTradingTouched: false, automaticPromotion: false,
    lookbackDays: DAYS, interval: INTERVAL,
    researchHoldoutIntegrity: HOLDOUT_INTEGRITY,
    holdoutWarning: 'These 7/14/21/30 TEST windows were already inspected in prior iterations. R3 mechanically excludes TEST from fitting/selection, but no result from these reused windows may authorize shadow or production. A fresh unseen holdout is required.',
    methodology: {
      ordering: ['BROAD_CAUSAL_POOL', 'ENTRY_TRAJECTORY_GATE', 'REGIME_SOFT_MODIFIER', 'META_PORTFOLIO', 'EXIT_PAIRED', 'SIZING_PAIRED'],
      entry: 'TRAIN-only additive smoothed economic model over causal features. Threshold chosen only on chronological VALIDATION folds with positive economics required.',
      regime: 'Specialist evidence is learned after ENTRY and used only as a continuous modifier; missing specialist evidence cannot starve the entry learner.',
      exit: 'R2 robust paired EXIT selector versus BASE_EXIT.',
      sizing: 'R2 robust paired sizing selector versus fixed 5%; fallback remains fixed 5%.',
      universe: 'Historical point-in-time Binance Vision archive; pre-window liquidity ranking only.',
      costFraction: COST,
    },
    leakageAudit: {
      currentTickerUsedForUniverse: false, currentExchangeInfoUsedForUniverse: false, featuresUseFuture: false, regimesUseFuture: false,
      entryModelUsesTrainOnly: true, entryThresholdUsesValidationOnly: true, specialistSelectionUsesTrainValidationOnly: true,
      exitSelectionUsesTrainValidationOnly: true, sizingSelectionUsesValidationOnly: true, testUsedForSelection: false,
      testReuseWarning: true, researchHoldoutIntegrity: HOLDOUT_INTEGRITY, zeroTradeWindowsCountAsSafe: false,
    },
    universeAudit: audit,
    split: { trainPct: .45, validationPct: .35, testPct: .20, purgeHours: PURGE / 3600000, forwardEmbargoHours: horizon / 3600000 },
    samples: { all: raw.length, train: train.length, validation: val.length, test: test.length, broadTrain: broadTrain.length, broadValidation: broadVal.length, broadTest: broadTest.length },
    entryGate: {
      enabled: entryGate.enabled, threshold: entryGate.threshold, selectedByEvidence: entryGate.selectedByEvidence, reason: entryGate.reason || null,
      trainCount: entryGate.model?.trainCount || 0, baselineValidation: entryGate.baselineValidation || null, selected: entryGate.selected || null, trials: entryGate.trials || [],
      featureAudit: entryGate.model ? Object.fromEntries(Object.entries(entryGate.model.features).map(([k, z]) => [k, { cuts: z.cuts, counts: z.counts }])) : {},
    },
    specialists: Object.fromEntries(Object.entries(policies).map(([k, p]) => [k, { activation: p.activation, selectedByEvidence: p.selectedByEvidence, audit: p.audit, train: p.train, validation: p.validation, folds: p.folds }])),
    regimeModifierAudit: { train: trMod.stats, validation: vaMod.stats, test: teMod.stats },
    metaController: { cfg: meta.cfg, validation: meta.validation || null, folds: meta.folds || [], selectedByEvidence: meta.selectedByEvidence, reason: meta.reason || null, trials: meta.trials || [] },
    exitSelection: exitSel,
    asymmetricSizing: { selected: sizing.cfg, validation: sizing.validation, fixedValidation: sizing.fixedValidation, selectedByEvidence: sizing.selectedByEvidence, mode: sizing.mode },
    selectionEvidence,
    walkForwardLite: validationStabilityRobust(vaRows, exitSel.selected, sizing.cfg),
    entrySelectionAttribution: entryAttribution,
    pairedExitComparison: pairedExit,
    sizingAttribution,
    causalAttribution,
    fullSystem: { baseline: safeMetrics(fullBase), v72: safeMetrics(full) },
    regimeAttribution: reg,
    exitReasonAttribution: reasons,
    timing: {
      baseline: { avgDetectionDelayMinutes: fullBase.avgDetectionDelayMinutes, medianDetectionDelayMinutes: fullBase.medianDetectionDelayMinutes, timingCoverage: fullBase.timingCoverage },
      v72: { avgDetectionDelayMinutes: full.avgDetectionDelayMinutes, medianDetectionDelayMinutes: full.medianDetectionDelayMinutes, timingCoverage: full.timingCoverage },
    },
    participation,
    entryAttribution: {
      rawEligibleSamples: test.length, broadSignals: broadTest.length, candidateSignals: teRows.length,
      avgRawMFEFixed24h: avg(test.map(s => s.opp24?.mfeFixed24h || 0)), avgCandidateMFEFixed24h: avg(teRows.map(s => s.opp24?.mfeFixed24h || 0)),
      avgEntryScore: avg(teRows.map(s => s.entryScore).filter(Number.isFinite)),
    },
    baseline: safeMetrics(fullBase),
    deltas: { fullVsBaseline: pairedDelta(fullBase, full), pureEntry: entryAttribution.trajectoryDelta, pureExit: pairedExit.delta, pureSizing: sizingAttribution.delta },
    regimeCoverage: { activeRegimes: REGIMES.filter(r => reg[r]?.tradeCount >= 3).length, totalRegimes: REGIMES.length },
    decision,
    promotion: 'RESEARCH ONLY. Reused TEST windows can never produce READY. Fresh unseen holdout required before any shadow consideration.',
  };
  writeReport(report);
}

main().catch(e => { console.error(e); process.exit(1); });
