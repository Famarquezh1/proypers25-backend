'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const BASE_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2.js');

function loadBase() {
  let src = fs.readFileSync(BASE_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__v72={
    REGIMES,INTERVAL,STEP,DAY,WARM,FWD,PURGE,COOLDOWN,COST,DAYS,POOL_SIZE,MIN_QV,MIN_TEST_TRADES,FIXED_SIZE,
    BASE_EXIT,EXIT_GRID,SPECIALIST_EVAL_CFG,META_FALLBACK,avg,median,clamp,pct,isoDay,v,
    archiveSymbols,targetSymbol,prevCompleteMonth,monthParts,priorMonthLiquidity,mapLimit,loadKlines,contiguous,
    opportunity24h,simulateExit,onsetFor,thresholds,specialistConfigs,entryQuality,dedupeEntries,summarizeTrades,
    withRecall,stripMetrics,simpleTradeMetrics,portfolio,specialistRows,continuousActivation,evaluateEntry,buildCandidates,
    blendExit,exitScore,sizingGrid,asymSize,metaGrid,regimeAttribution,exitReasonAttribution,pairedDelta,writeReport
  };`;
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename: BASE_PATH,
  });
  vm.runInContext(src, c, { filename: BASE_PATH });
  return c.__v72;
}

const b = loadBase();
const {
  REGIMES, INTERVAL, STEP, DAY, WARM, FWD, PURGE, COOLDOWN, COST, DAYS, POOL_SIZE, MIN_QV,
  MIN_TEST_TRADES, FIXED_SIZE, BASE_EXIT, EXIT_GRID, SPECIALIST_EVAL_CFG, META_FALLBACK,
  avg, median, clamp, pct, isoDay, v, archiveSymbols, targetSymbol, prevCompleteMonth, monthParts,
  priorMonthLiquidity, mapLimit, loadKlines, contiguous, opportunity24h, simulateExit, onsetFor,
  thresholds, specialistConfigs, entryQuality, dedupeEntries, summarizeTrades, withRecall, stripMetrics,
  simpleTradeMetrics, portfolio, specialistRows, continuousActivation, evaluateEntry, buildCandidates,
  blendExit, sizingGrid, asymSize, metaGrid, regimeAttribution, exitReasonAttribution, pairedDelta, writeReport,
} = b;

const ROBUST_VERSION = 'V7.2-R2';
const ROBUST_MIN_FOLDS = 2;
const ENTRY_FEATURES = {
  quality: s => s.quality,
  opportunity: s => s.opportunity,
  agreement: s => s.agreement,
  regimeConfidence: s => s.regimeConfidence,
  r15: s => s.f.r15,
  r60: s => s.f.r60,
  vol15: s => Math.log(Math.max(.2, s.f.vol15)),
  breakout60: s => s.f.breakout60,
  rs60: s => s.f.rs60,
  pullback: s => s.f.pullback,
  trendEfficiency: s => s.f.trendEfficiency,
  detectionDelay: s => Number.isFinite(s.detectionDelayMinutes) ? Math.min(360, s.detectionDelayMinutes) / 360 : null,
};

function timeFolds(rows, n = 3) {
  if (!rows.length) return [];
  const sorted = [...rows].sort((a, z) => a.t - z.t);
  const t0 = sorted[0].t, t1 = sorted.at(-1).t, span = Math.max(1, t1 - t0);
  const out = [];
  for (let k = 0; k < n; k++) {
    const a = t0 + span * k / n, z = t0 + span * (k + 1) / n;
    out.push(sorted.filter(s => s.t >= a && (k === n - 1 ? s.t <= z : s.t < z)));
  }
  return out;
}

function positiveFoldCount(folds, key = 'avgNetRet', floor = 0) {
  return folds.filter(x => x.tradeCount >= 2 && Number(x[key]) > floor).length;
}

function safeMetrics(m) {
  return m ? stripMetrics(m) : null;
}

function foldPortfolio(rows, all, cfg, outcomeFn, sizeFn = () => FIXED_SIZE, riskFn = () => BASE_EXIT.hardStop) {
  return timeFolds(rows).map((fr, i) => {
    if (!fr.length) return { fold: i + 1, tradeCount: 0, netGrowth: 0, avgNetRet: 0, maxDrawdown: 0, avgCaptureRatioFixed24h: 0 };
    const a = fr[0].t, z = fr.at(-1).t;
    const fa = all.filter(s => s.t >= a && s.t <= z);
    const m = portfolio(fr, fa, cfg, outcomeFn, sizeFn, riskFn);
    return { fold: i + 1, ...safeMetrics(m) };
  });
}

function robustPolicyActivation(trainM, valM, folds) {
  if (!trainM || !valM || trainM.tradeCount < 5 || valM.tradeCount < 5) return 0;
  const valid = folds.filter(f => f.tradeCount >= 2);
  const pos = positiveFoldCount(valid, 'avgNetRet', 0);
  if (valid.length < ROBUST_MIN_FOLDS || pos < ROBUST_MIN_FOLDS) return 0;
  if (trainM.avgNetRet < -.01 || trainM.netGrowth < -.10) return 0;
  if (valM.avgNetRet < -.002 || valM.maxDrawdown < -.12) return 0;
  const stability = clamp(pos / Math.max(1, valid.length), .35, 1);
  const trainHealth = clamp(1 + trainM.avgNetRet / .02, .35, 1);
  return clamp(continuousActivation(valM) * (.65 + .35 * stability) * trainHealth, .03, 1);
}

function choosePoliciesRobust(train, val, cal) {
  const out = {};
  for (const rg of REGIMES) {
    const tr = train.filter(s => s.primaryRegime === rg), va = val.filter(s => s.primaryRegime === rg);
    let best = null;
    if (tr.length >= 80 && va.length >= 20) {
      for (const cfg of specialistConfigs()) {
        const th = thresholds(tr, cfg.q), policy = { cfg, th };
        const trRows = specialistRows(tr, policy, cal), vaRows = specialistRows(va, policy, cal);
        const tm = portfolio(trRows, tr, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
        const vm = portfolio(vaRows, va, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
        withRecall(tm, tm._trades || [], tr); withRecall(vm, vm._trades || [], va);
        const folds = foldPortfolio(vaRows, va, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT));
        const activation = robustPolicyActivation(tm, vm, folds);
        const trPart = trRows.length ? tm.tradeCount / trRows.length : 0;
        const vaPart = vaRows.length ? vm.tradeCount / vaRows.length : 0;
        const validFolds = folds.filter(f => f.tradeCount >= 2);
        const posFolds = positiveFoldCount(validFolds, 'avgNetRet', 0);
        const robust = activation > 0;
        const score = robust
          ? vm.netGrowth * 5 + vm.avgNetRet * 18 + vm.winRate * .45 + vm.precision * .45 + vm.recall * .45
            + tm.avgNetRet * 6 + posFolds * .12 - Math.max(0, Math.abs(vm.maxDrawdown) - .10) * 18
            - Math.max(0, .05 - vaPart) * 2
          : -1e9;
        const row = {
          cfg, th, activation, score, robust,
          train: safeMetrics(tm), validation: safeMetrics(vm), folds,
          audit: {
            rawTrainSamples: tr.length, rawValidationSamples: va.length,
            trainCandidates: trRows.length, validationCandidates: vaRows.length,
            trainAdmittedTrades: tm.tradeCount, validationAdmittedTrades: vm.tradeCount,
            trainParticipationRate: trPart, validationParticipationRate: vaPart,
            positiveValidationFolds: posFolds, validValidationFolds: validFolds.length,
          },
        };
        if (!best || score > best.score) best = row;
      }
    }
    if (!best || best.score <= -1e8) {
      out[rg] = {
        activation: 0, cfg: null, th: null, train: null, validation: null, folds: [], score: -1e9,
        selectedByEvidence: false,
        audit: { rawTrainSamples: tr.length, rawValidationSamples: va.length, reason: 'No temporally robust specialist configuration.' },
      };
    } else {
      out[rg] = { ...best, selectedByEvidence: true };
    }
  }
  return out;
}

function utilityOf(s) {
  const o = simulateExit(s, BASE_EXIT);
  if (!o) return null;
  return o.net + .12 * Math.min(.15, Math.max(0, o.mfeFixed24h)) - .012 * (o.stopBefore10 ? 1 : 0);
}

function fitTrajectoryModel(trainRows) {
  const labeled = trainRows.map(s => ({ s, utility: utilityOf(s) })).filter(x => Number.isFinite(x.utility));
  if (labeled.length < 30) return null;
  const globalUtility = avg(labeled.map(x => x.utility));
  const features = {};
  for (const [name, fn] of Object.entries(ENTRY_FEATURES)) {
    const values = labeled.map(x => fn(x.s)).filter(Number.isFinite);
    if (values.length < 20) continue;
    const cuts = [.2, .4, .6, .8].map(q => pct(values, q));
    const bins = Array.from({ length: 5 }, () => ({ n: 0, sum: 0 }));
    for (const x of labeled) {
      const value = fn(x.s); if (!Number.isFinite(value)) continue;
      let bi = 0; while (bi < cuts.length && value > cuts[bi]) bi++;
      bins[bi].n++; bins[bi].sum += x.utility;
    }
    const smoothed = bins.map(z => (z.sum + 12 * globalUtility) / (z.n + 12));
    features[name] = { cuts, binUtility: smoothed, counts: bins.map(z => z.n) };
  }
  if (Object.keys(features).length < 5) return null;
  return { globalUtility, features, trainCount: labeled.length };
}

function trajectoryScore(s, model) {
  if (!model) return .5;
  let sum = 0, n = 0;
  for (const [name, z] of Object.entries(model.features)) {
    const value = ENTRY_FEATURES[name](s); if (!Number.isFinite(value)) continue;
    let bi = 0; while (bi < z.cuts.length && value > z.cuts[bi]) bi++;
    const edge = z.binUtility[bi] - model.globalUtility;
    sum += clamp(.5 + edge / .06, 0, 1); n++;
  }
  return n ? sum / n : .5;
}

function scoreRows(rows, model) {
  return rows.map(s => ({ ...s, trajectoryScore: trajectoryScore(s, model) }));
}

function applyTrajectoryGate(rows, gate) {
  const scored = scoreRows(rows, gate.model);
  if (!gate.enabled) return { rows: scored, skipped: 0 };
  const kept = scored.filter(s => s.trajectoryScore >= gate.threshold);
  return { rows: kept, skipped: scored.length - kept.length };
}

function chooseTrajectoryGate(trainRows, valRows, trainAll, valAll) {
  const model = fitTrajectoryModel(trainRows);
  if (!model) return { enabled: false, threshold: null, model: null, selectedByEvidence: false, reason: 'Too few TRAIN candidates for causal trajectory calibration.' };
  const trScored = scoreRows(trainRows, model), vaScored = scoreRows(valRows, model);
  const trainScores = trScored.map(s => s.trajectoryScore);
  const thresholds = [null, .45, .55, .65, .75].map(q => q === null ? null : pct(trainScores, q));
  const base = portfolio(vaScored, valAll, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  withRecall(base, base._trades || [], valAll);
  let best = null;
  const trials = [];
  for (const threshold of thresholds) {
    const rows = threshold === null ? vaScored : vaScored.filter(s => s.trajectoryScore >= threshold);
    const m = portfolio(rows, valAll, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], valAll);
    const folds = foldPortfolio(rows, valAll, SPECIALIST_EVAL_CFG, s => simulateExit(s, BASE_EXIT));
    const validFolds = folds.filter(f => f.tradeCount >= 2), pos = positiveFoldCount(validFolds, 'avgNetRet', 0);
    const participation = vaScored.length ? rows.length / vaScored.length : 0;
    const delta = pairedDelta(base, m);
    const robust = threshold !== null && m.tradeCount >= 10 && validFolds.length >= 2 && pos >= 2 && participation >= .20
      && delta.netGrowth > 0 && delta.avgNetRet > 0 && m.maxDrawdown >= -.12;
    const score = robust
      ? delta.netGrowth * 10 + delta.avgNetRet * 25 + m.precision * .5 + m.recall * .4 + pos * .1
        - Math.max(0, -.02 - delta.maxDrawdown) * 15 - Math.max(0, .30 - participation)
      : -1e9;
    const row = { threshold, metrics: safeMetrics(m), folds, delta: safeMetrics(delta), participation, robust, score };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) {
    return { enabled: false, threshold: null, model, selectedByEvidence: false, baselineValidation: safeMetrics(base), trials, reason: 'No trajectory threshold improved validation economics robustly across time folds.' };
  }
  return { enabled: true, threshold: best.threshold, model, selectedByEvidence: true, baselineValidation: safeMetrics(base), selected: best, trials };
}

function candidateSet(samples, policies, cal, oppFloor, gate, useActivation = true) {
  const built = buildCandidates(samples, policies, cal, oppFloor, useActivation);
  const gated = applyTrajectoryGate(built.rows, gate);
  return { rows: gated.rows, stats: { ...built.stats, skippedByTrajectoryGate: gated.skipped, preGateCandidates: built.rows.length } };
}

function chooseMetaRobust(val, policies, cal, gate) {
  let best = null;
  const trials = [];
  for (const cfg of metaGrid()) {
    const bld = candidateSet(val, policies, cal, cfg.oppFloor, gate, true);
    const m = portfolio(bld.rows, val, cfg, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], val);
    const folds = foldPortfolio(bld.rows, val, cfg, s => simulateExit(s, BASE_EXIT));
    const valid = folds.filter(f => f.tradeCount >= 2), pos = positiveFoldCount(valid, 'avgNetRet', 0);
    const part = bld.rows.length ? m.tradeCount / bld.rows.length : 0;
    const robust = m.tradeCount >= 10 && valid.length >= 2 && pos >= 2 && m.avgNetRet >= -.002 && m.maxDrawdown >= -.12;
    const score = robust
      ? m.netGrowth * 7 + m.avgNetRet * 18 + m.winRate * .45 + m.recall * .4 + pos * .1
        - Math.max(0, .15 - part) * 1.5
      : -1e9;
    const row = { cfg, validation: safeMetrics(m), folds, entryStats: bld.stats, participationRate: part, robust, score };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) {
    const bld = candidateSet(val, policies, cal, META_FALLBACK.oppFloor, gate, true);
    const m = portfolio(bld.rows, val, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], val);
    return { cfg: META_FALLBACK, validation: safeMetrics(m), folds: [], entryStats: bld.stats, score: -1e9, selectedByEvidence: false, trials };
  }
  return { ...best, selectedByEvidence: true, trials };
}

function exitFoldDeltas(rows, profile) {
  return timeFolds(rows).map((fr, i) => {
    const base = simpleTradeMetrics(fr, s => simulateExit(s, BASE_EXIT));
    const cand = simpleTradeMetrics(fr, s => simulateExit(s, profile));
    return { fold: i + 1, base: safeMetrics(base), candidate: safeMetrics(cand), delta: pairedDelta(base, cand) };
  });
}

function chooseExitsRobust(trainC, valC) {
  const selected = {}, evidence = {};
  let evidenceRegimes = 0;
  for (const rg of REGIMES) {
    const tr = trainC.filter(s => s.primaryRegime === rg), va = valC.filter(s => s.primaryRegime === rg);
    const trBase = simpleTradeMetrics(tr, s => simulateExit(s, BASE_EXIT));
    const vaBase = simpleTradeMetrics(va, s => simulateExit(s, BASE_EXIT));
    let best = null; const trials = [];
    for (const profile of EXIT_GRID[rg]) {
      const tm = simpleTradeMetrics(tr, s => simulateExit(s, profile));
      const vm = simpleTradeMetrics(va, s => simulateExit(s, profile));
      const trDelta = pairedDelta(trBase, tm), vaDelta = pairedDelta(vaBase, vm);
      const folds = exitFoldDeltas(va, profile);
      const valid = folds.filter(f => f.base.tradeCount >= 2 && f.candidate.tradeCount >= 2);
      const positive = valid.filter(f => f.delta.netGrowth > 0 && f.delta.avgNetRet >= 0).length;
      const capturePositive = valid.filter(f => f.delta.avgCaptureRatioFixed24h >= 0).length;
      const worstGrowth = valid.length ? Math.min(...valid.map(f => f.delta.netGrowth)) : -1;
      const robust = tm.tradeCount >= 5 && vm.tradeCount >= 5 && valid.length >= 2 && positive >= 2 && capturePositive >= 2
        && vaDelta.netGrowth > 0 && vaDelta.avgNetRet > 0 && vaDelta.avgCaptureRatioFixed24h >= 0
        && vaDelta.avgCaptureLoss24h <= 0 && trDelta.avgNetRet >= -.002 && worstGrowth > -.02;
      const score = robust
        ? vaDelta.netGrowth * 10 + vaDelta.avgNetRet * 30 + vaDelta.avgCaptureRatioFixed24h * 2
          - Math.max(0, vaDelta.avgCaptureLoss24h) * 3 + trDelta.avgNetRet * 10 + positive * .15 + capturePositive * .1
        : -1e9;
      const row = { profile, train: safeMetrics(tm), validation: safeMetrics(vm), trainDelta: trDelta, validationDelta: vaDelta, folds, robust, score };
      trials.push(row); if (!best || score > best.score) best = row;
    }
    if (!best || best.score <= -1e8) {
      selected[rg] = { ...BASE_EXIT, id: `${rg.toLowerCase()}_fallback_baseline` };
      evidence[rg] = { fallback: true, selectedByEvidence: false, trainTrades: tr.length, validationTrades: va.length, baselineTrain: safeMetrics(trBase), baselineValidation: safeMetrics(vaBase), trials };
    } else {
      selected[rg] = best.profile; evidenceRegimes++;
      evidence[rg] = { fallback: false, selectedByEvidence: true, trainTrades: tr.length, validationTrades: va.length, baselineTrain: safeMetrics(trBase), baselineValidation: safeMetrics(vaBase), selected: best, trials };
    }
  }
  return { selected, evidence, evidenceRegimes, selectedByEvidence: evidenceRegimes > 0 };
}

function robustSize(s, cfg) {
  if (!cfg) return FIXED_SIZE;
  const raw = asymSize(s, cfg.base);
  return clamp(FIXED_SIZE + cfg.shrink * (raw - FIXED_SIZE), .008, .12);
}

function sizingFolds(rows, cfg) {
  return timeFolds(rows).map((fr, i) => {
    const fixed = simpleTradeMetrics(fr, s => s.adaptiveOutcome, () => FIXED_SIZE);
    const cand = simpleTradeMetrics(fr, s => s.adaptiveOutcome, s => robustSize(s, cfg));
    return { fold: i + 1, fixed: safeMetrics(fixed), candidate: safeMetrics(cand), delta: pairedDelta(fixed, cand) };
  });
}

function chooseSizingRobust(valC, selected) {
  for (const s of valC) { s.adaptiveExit = blendExit(s, selected); s.adaptiveOutcome = simulateExit(s, s.adaptiveExit); }
  const fixed = simpleTradeMetrics(valC, s => s.adaptiveOutcome, () => FIXED_SIZE);
  let best = null; const trials = [];
  for (const base of sizingGrid()) for (const shrink of [.25, .5, .75, 1]) {
    const cfg = { base, shrink };
    const m = simpleTradeMetrics(valC, s => s.adaptiveOutcome, s => robustSize(s, cfg));
    const delta = pairedDelta(fixed, m), folds = sizingFolds(valC, cfg);
    const valid = folds.filter(f => f.fixed.tradeCount >= 2), pos = valid.filter(f => f.delta.netGrowth > 0).length;
    const worst = valid.length ? Math.min(...valid.map(f => f.delta.netGrowth)) : -1;
    const ddWorsening = Math.min(0, delta.maxDrawdown);
    const robust = m.tradeCount >= 10 && valid.length >= 2 && pos >= 2 && delta.netGrowth > 0 && ddWorsening >= -.02 && worst > -.015;
    const concentrationPenalty = Math.max(0, m.avgSize - .075) * 3;
    const score = robust ? delta.netGrowth * 12 + median(valid.map(f => f.delta.netGrowth)) * 8 + pos * .12 + ddWorsening * 10 - concentrationPenalty : -1e9;
    const row = { cfg, validation: safeMetrics(m), fixedValidation: safeMetrics(fixed), delta, folds, robust, score };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) {
    return { cfg: null, validation: safeMetrics(fixed), fixedValidation: safeMetrics(fixed), score: -1e9, selectedByEvidence: false, mode: 'FIXED_FALLBACK', trials };
  }
  return { ...best, selectedByEvidence: true, mode: 'ASYMMETRIC', trials };
}

function validationStabilityRobust(valC, selected, sizeCfg) {
  return timeFolds(valC).map((rows, i) => {
    const fixed = simpleTradeMetrics(rows, s => simulateExit(s, blendExit(s, selected)), () => FIXED_SIZE);
    const chosen = simpleTradeMetrics(rows, s => simulateExit(s, blendExit(s, selected)), s => robustSize(s, sizeCfg));
    return { fold: i + 1, fixed: safeMetrics(fixed), chosen: safeMetrics(chosen), sizingDelta: pairedDelta(fixed, chosen) };
  });
}

function decideRobust(test) {
  const { baseline, full, pairedExit, participation, selectionEvidence, sizingMode, causalAttribution } = test;
  if (full.tradeCount < MIN_TEST_TRADES || baseline.tradeCount < MIN_TEST_TRADES) {
    return { ready: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'Untouched TEST has too few comparable admitted trades.' };
  }
  if (!selectionEvidence.meta || !selectionEvidence.exit) {
    return { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'TEST is measurable, but META or EXIT lacked temporally robust TRAIN/VALIDATION evidence.' };
  }
  const activeRegimes = REGIMES.filter(r => test.regimeAttribution[r]?.tradeCount >= 3).length;
  const positive = full.netGrowth > 0;
  const econ = full.netGrowth > baseline.netGrowth && full.avgNetRet > baseline.avgNetRet;
  const cap = full.avgCaptureRatioFixed24h > baseline.avgCaptureRatioFixed24h && full.avgCaptureLoss24h < baseline.avgCaptureLoss24h;
  const dd = full.maxDrawdown >= -.12;
  const timing = full.timingCoverage >= .5 && baseline.timingCoverage >= .5 && full.avgDetectionDelayMinutes <= baseline.avgDetectionDelayMinutes + 30;
  const part = full.tradeCount >= baseline.tradeCount * .65 && participation.participationRate >= .30;
  const exitPure = pairedExit.delta.netGrowth > 0 && pairedExit.delta.avgNetRet > 0 && pairedExit.delta.avgCaptureRatioFixed24h > 0;
  const coverage = activeRegimes >= 2;
  const sizingSafe = sizingMode === 'FIXED_FALLBACK' || causalAttribution.sizingEffect.netGrowth >= 0;
  const ready = positive && econ && cap && dd && timing && part && exitPure && coverage && sizingSafe;
  if (ready) return { ready: true, label: 'READY_FOR_SHADOW_VALIDATION', reason: 'Untouched TEST shows robust pure-exit economics/capture, safe risk/timing/participation, multi-regime coverage, and sizing is either validated or safely fixed.' };
  if (!part) return { ready: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'Economic evidence is not accepted because executable participation remains too low.' };
  if (!exitPure && pairedExit.delta.avgCaptureRatioFixed24h <= 0) return { ready: false, label: 'REQUIRES_REDESIGN', reason: 'Pure EXIT attribution still fails fixed-24h capture/economic causality on untouched TEST.' };
  return { ready: false, label: 'REQUIRES_IMPROVEMENT', reason: 'V7.2-R2 is measurable but does not satisfy every robust causal economic, capture, risk, timing and regime-coverage gate.' };
}

async function main() {
  const now = new Date();
  const END = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const START = END - DAYS * DAY, LOAD_START = START - DAY, LOAD_END = END, preMonth = prevCompleteMonth(START);
  console.log(`${ROBUST_VERSION} causal research ${DAYS}d ${isoDay(START)}..${isoDay(END - 1)} pool=${POOL_SIZE}`);

  const allSymbols = await archiveSymbols();
  const audit = {
    archiveSymbols: allSymbols.length, excludedStableFiat: 0, excludedLeveraged: 0, excludedInvalid: 0, excludedOtherQuote: 0,
    priorMonthAvailable: 0, selectedPool: 0, prefilterMonth: monthParts(preMonth).key,
    selectionCutoff: new Date(START).toISOString(), selectionUsesCurrentTicker: false, selectionUsesFutureVolume: false,
    survivorshipControl: 'No current ticker or current exchangeInfo is used. Candidate symbols come from Binance Vision historical archive prefixes; symbols are eligible only if their own pre-window archive history exists.',
    minimumHistoryPolicy: 'Target must have >=10 daily rows in the last complete calendar month strictly before the research window; ranking uses only that pre-window quote volume. Point-in-time 24h rolling quote volume is rechecked at every signal timestamp.',
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
  if (pool.length < 20) return writeReport({ version: ROBUST_VERSION, researchOnly: true, lookbackDays: DAYS, universeAudit: audit, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Historical archive universe produced too few causal pre-window symbols.' } });

  const data = new Map(), loaded = await mapLimit(pool, 8, async s => ({ symbol: s, rows: await loadKlines(s, LOAD_START, LOAD_END, END) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  audit.loadedSymbols = data.size;
  const btc = data.get('BTCUSDT'); if (!btc?.length) throw new Error('BTCUSDT historical archive unavailable');
  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();
  for (const [symbol, r] of data) {
    if (symbol === 'BTCUSDT' || r.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < r.length - FWD; i++) {
      const t = r[i].t; if (t < START || t >= END - FWD * STEP || !contiguous(r, i)) continue;
      let f; try { f = v.feat(r, i, bm); } catch { continue; }
      if (f.qv < MIN_QV) continue;
      const z = breadth.get(t) || { n: 0, up15: 0, up60: 0, breakout: 0, ignite: 0, sum60: 0 };
      z.n++; if (f.r15 > 0) z.up15++; if (f.r60 > 0) z.up60++; if (f.breakout60 > 0) z.breakout++;
      if (f.vol15 > 1.2) z.ignite++; z.sum60 += f.r60; breadth.set(t, z);
      featureRows.push({ symbol, t, f, series: r, index: i });
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
  if (raw.length < 600) return writeReport({ version: ROBUST_VERSION, researchOnly: true, lookbackDays: DAYS, universeAudit: audit, samples: { all: raw.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Too few causal eligible samples after point-in-time universe filtering.' } });

  const t0 = raw[0].t, t1 = raw.at(-1).t, span = t1 - t0, c1 = t0 + span * .45, c2 = t0 + span * .80, horizon = FWD * STEP;
  const train = raw.filter(x => x.t < c1 - horizon), val = raw.filter(x => x.t > c1 + PURGE && x.t < c2 - horizon), test = raw.filter(x => x.t > c2 + PURGE);
  if (train.length < 200 || val.length < 80 || test.length < 80) return writeReport({ version: ROBUST_VERSION, researchOnly: true, lookbackDays: DAYS, universeAudit: audit, samples: { all: raw.length, train: train.length, validation: val.length, test: test.length }, decision: { ready: false, label: 'REQUIRES_MORE_DATA', reason: 'Embargoed chronological split is too small.' } });

  const cal = v.microCal(train);
  const policies = choosePoliciesRobust(train, val, cal);
  const preTrain = buildCandidates(train, policies, cal, 0, true), preVal = buildCandidates(val, policies, cal, 0, true);
  const trajectoryGate = chooseTrajectoryGate(preTrain.rows, preVal.rows, train, val);
  const meta = chooseMetaRobust(val, policies, cal, trajectoryGate);
  const trB = candidateSet(train, policies, cal, meta.cfg.oppFloor, trajectoryGate, true);
  const vaB = candidateSet(val, policies, cal, meta.cfg.oppFloor, trajectoryGate, true);
  const teActivatedPreGate = buildCandidates(test, policies, cal, meta.cfg.oppFloor, true);
  const teB = candidateSet(test, policies, cal, meta.cfg.oppFloor, trajectoryGate, true);
  const teQualityOnly = buildCandidates(test, policies, cal, meta.cfg.oppFloor, false);
  const exitSel = chooseExitsRobust(trB.rows, vaB.rows);
  const sizing = chooseSizingRobust(vaB.rows, exitSel.selected);

  for (const s of teB.rows) {
    s.adaptiveExit = blendExit(s, exitSel.selected); s.baseOutcome = simulateExit(s, BASE_EXIT); s.adaptiveOutcome = simulateExit(s, s.adaptiveExit);
  }
  for (const s of teActivatedPreGate.rows) s.baseOutcome = simulateExit(s, BASE_EXIT);
  for (const s of teQualityOnly.rows) s.baseOutcome = simulateExit(s, BASE_EXIT);

  const pairBaseRaw = simpleTradeMetrics(teB.rows, s => s.baseOutcome);
  const pairAdaptRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome);
  const sizeFixedRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome, () => FIXED_SIZE);
  const sizeChosenRaw = simpleTradeMetrics(teB.rows, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg));
  const qualityRaw = simpleTradeMetrics(teQualityOnly.rows, s => s.baseOutcome);
  const activatedRaw = simpleTradeMetrics(teActivatedPreGate.rows, s => s.baseOutcome);
  const gatedRaw = simpleTradeMetrics(teB.rows, s => s.baseOutcome);
  for (const m of [pairBaseRaw, pairAdaptRaw, sizeFixedRaw, sizeChosenRaw, qualityRaw, activatedRaw, gatedRaw]) withRecall(m, m._trades || [], test);

  const fullBase = portfolio(teB.rows, test, meta.cfg, s => s.baseOutcome, () => FIXED_SIZE, () => BASE_EXIT.hardStop);
  const full = portfolio(teB.rows, test, meta.cfg, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg), s => s.adaptiveExit.hardStop);
  withRecall(fullBase, fullBase._trades || [], test); withRecall(full, full._trades || [], test);
  const reg = regimeAttribution(full._trades || [], test), reasons = exitReasonAttribution(full._trades || []);

  const participation = {
    candidateSignals: teB.rows.length, admittedTrades: full.tradeCount,
    participationRate: teB.rows.length ? full.tradeCount / teB.rows.length : 0,
    qualityOnlyCandidateSignals: teQualityOnly.rows.length, activatedPreGateSignals: teActivatedPreGate.rows.length,
    baselineTrades: fullBase.tradeCount, adaptiveTrades: full.tradeCount,
    skippedByRisk: full.skippedByRisk, skippedByExposure: full.skippedByExposure,
    skippedByRegimeActivation: teB.stats.skippedByRegimeActivation,
    skippedByTrajectoryGate: teB.stats.skippedByTrajectoryGate,
    skippedByQuality: teB.stats.skippedByQuality, skippedByConcurrency: full.skippedByConcurrency,
  };
  const pairedExit = { baselineExitFixedSize: safeMetrics(pairBaseRaw), adaptiveExitFixedSize: safeMetrics(pairAdaptRaw), delta: pairedDelta(pairBaseRaw, pairAdaptRaw) };
  const sizingAttribution = { adaptiveExitFixedSize: safeMetrics(sizeFixedRaw), chosenSizing: safeMetrics(sizeChosenRaw), mode: sizing.mode, delta: pairedDelta(sizeFixedRaw, sizeChosenRaw) };
  const entrySelectionAttribution = {
    qualityOnlyEntrySet: safeMetrics(qualityRaw), activatedPreGateEntrySet: safeMetrics(activatedRaw), trajectoryGatedEntrySet: safeMetrics(gatedRaw),
    activationDelta: pairedDelta(qualityRaw, activatedRaw), trajectoryGateDelta: pairedDelta(activatedRaw, gatedRaw),
    interpretation: 'All entry-selection comparisons use the same baseline exit and fixed 5% size. Regime activation and trajectory gate effects are reported separately before EXIT/SIZING changes.',
  };
  const causalAttribution = {
    selectionEffect: { activation: entrySelectionAttribution.activationDelta, trajectoryGate: entrySelectionAttribution.trajectoryGateDelta },
    exitEffect: pairedExit.delta, sizingEffect: sizingAttribution.delta,
  };
  const activeRegimes = REGIMES.filter(r => reg[r].tradeCount >= 3).length;
  const selectionEvidence = { meta: meta.selectedByEvidence, exit: exitSel.selectedByEvidence, sizing: sizing.selectedByEvidence, trajectoryGate: trajectoryGate.selectedByEvidence };
  const decision = decideRobust({ baseline: fullBase, full, pairedExit, regimeAttribution: reg, participation, selectionEvidence, sizingMode: sizing.mode, causalAttribution });

  const report = {
    generatedAt: new Date().toISOString(), version: ROBUST_VERSION, experiment: 'Causal Opportunity Capture & Regime Attribution — Robust Causal Selector',
    researchOnly: true, publicDataOnly: true, privateBinanceUsed: false, firestoreUsed: false, productionTradingTouched: false, automaticPromotion: false,
    interval: INTERVAL, lookbackDays: DAYS,
    methodology: {
      objective: 'Separate ENTRY selection, EXIT, SIZING and portfolio-control effects while rejecting temporally unstable TRAIN/VALIDATION improvements.',
      costFraction: COST, fixedSizingForPureExit: FIXED_SIZE,
      specialistActivation: 'Cooldown-deduplicated, executable TRAIN and VALIDATION portfolios plus chronological validation folds. Activation is continuous only after stability gates.',
      trajectoryCommittee: 'TRAIN-only smoothed economic calibration across causal entry features; threshold is selected only on chronological VALIDATION folds. TEST never trains or selects the gate.',
      exitSelection: 'Adaptive exits are selected by paired delta versus fixed V7.0 exit, not absolute PnL, with TRAIN health and validation-fold capture/economic stability requirements.',
      sizingSelection: 'Asymmetric sizing is selected only when paired against fixed 5% sizing across validation folds; shrinkage toward 5% is part of the research grid. Otherwise sizing falls back to fixed 5%.',
      universe: 'Historical Binance Vision point-in-time universe inherited from V7.2 base harness.',
    },
    leakageAudit: {
      currentTickerUsedForUniverse: false, currentExchangeInfoUsedForUniverse: false, archiveIndexHistoricalSymbols: true,
      universeRankingCutoffStrictlyBeforeWindow: true, rollingLiquidityUsesOnlyPastAndCurrentBars: true,
      featuresUseFuture: false, regimesUseFuture: false, testUsedForThresholdSelection: false, testUsedForExitSelection: false,
      testUsedForSizingSelection: false, testUsedForTrajectoryCalibration: false, testUsedForTrajectoryThresholdSelection: false,
      trajectoryModelUsesTrainOnly: true, trajectoryThresholdUsesValidationOnly: true,
      mfeFixed24hUsedForEntryDecision: false, mfeFixed24hUsedForTestSelection: false, testUntouchedUntilFreeze: true,
      specialistValidationUsesCooldownDeduplication: true, specialistValidationUsesExecutablePortfolioControl: true,
      componentSelectionRequiresTemporalStability: true, zeroTradeWindowsCountAsSafe: false,
    },
    universeAudit: audit,
    intrabarPolicy: {
      resolution: 'CONSERVATIVE_5M', stopVsHigh: 'Existing stop wins before same-bar favorable high.',
      activationVsBreak: 'Same-bar newly activated break-even/trailing stop is treated adversely if low crosses it.',
    },
    captureMetrics: {
      primary: 'captureRatioFixed24h = max(0, realizedNetReturn) / MFE_fixed_24h, bounded [0,1].',
      secondary: 'captureRatioDuringTrade = max(0, realizedNetReturn) / MFE_during_trade.',
      captureLoss24h: 'MFE_fixed_24h - max(0, realizedNetReturn).',
    },
    timingDefinition: {
      entryExtension24hPct: 'Legacy extension proxy, not timing.',
      detectionDelayMinutes: 'Signal time minus causal momentum onset defined in the base V7.2 harness.',
    },
    split: { trainPct: .45, validationPct: .35, testPct: .20, purgeHours: PURGE / 3600000, forwardEmbargoHours: horizon / 3600000 },
    samples: { all: raw.length, train: train.length, validation: val.length, test: test.length },
    specialists: Object.fromEntries(Object.entries(policies).map(([k, p]) => [k, { activation: p.activation, cfg: p.cfg, train: p.train, validation: p.validation, folds: p.folds, score: p.score, selectedByEvidence: p.selectedByEvidence, audit: p.audit }])),
    trajectoryGate: {
      enabled: trajectoryGate.enabled, threshold: trajectoryGate.threshold, selectedByEvidence: trajectoryGate.selectedByEvidence,
      reason: trajectoryGate.reason || null, trainCount: trajectoryGate.model?.trainCount || 0,
      baselineValidation: trajectoryGate.baselineValidation || null, selected: trajectoryGate.selected || null, trials: trajectoryGate.trials || [],
      featureAudit: trajectoryGate.model ? Object.fromEntries(Object.entries(trajectoryGate.model.features).map(([k, z]) => [k, { cuts: z.cuts, counts: z.counts }])) : {},
    },
    metaController: { cfg: meta.cfg, validation: meta.validation, folds: meta.folds, score: meta.score, selectedByEvidence: meta.selectedByEvidence },
    exitSelection: exitSel,
    asymmetricSizing: { selected: sizing.cfg, validation: sizing.validation, fixedValidation: sizing.fixedValidation, score: sizing.score, selectedByEvidence: sizing.selectedByEvidence, mode: sizing.mode },
    selectionEvidence,
    walkForwardLite: validationStabilityRobust(vaB.rows, exitSel.selected, sizing.cfg),
    entrySelectionAttribution, pairedExitComparison: pairedExit, sizingAttribution, causalAttribution,
    fullSystem: {
      baseline: safeMetrics(fullBase), v72: safeMetrics(full),
      portfolioControlEffectVsUnconstrainedSizing: { netGrowth: full.netGrowth - sizeChosenRaw.netGrowth, tradeCount: full.tradeCount - sizeChosenRaw.tradeCount },
    },
    regimeAttribution: reg, exitReasonAttribution: reasons,
    timing: {
      baseline: { avgDetectionDelayMinutes: fullBase.avgDetectionDelayMinutes, medianDetectionDelayMinutes: fullBase.medianDetectionDelayMinutes, timingCoverage: fullBase.timingCoverage, entryExtension24hPct: fullBase.entryExtension24hPct },
      v72: { avgDetectionDelayMinutes: full.avgDetectionDelayMinutes, medianDetectionDelayMinutes: full.medianDetectionDelayMinutes, timingCoverage: full.timingCoverage, entryExtension24hPct: full.entryExtension24hPct },
    },
    participation,
    entryAttribution: (() => {
      const allClean = new Set(test.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
      const candidateClean = new Set(teB.rows.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
      return {
        rawEligibleSamples: test.length, candidateSignals: teB.rows.length, candidateRate: test.length ? teB.rows.length / test.length : 0,
        candidateOpportunityPrecision: teB.rows.length ? candidateClean.size / teB.rows.length : 0,
        candidateOpportunityRecall: allClean.size ? candidateClean.size / allClean.size : 0,
        avgRawMFEFixed24h: avg(test.map(s => s.opp24?.mfeFixed24h || 0)), avgCandidateMFEFixed24h: avg(teB.rows.map(s => s.opp24?.mfeFixed24h || 0)),
        skippedByQuality: teB.stats.skippedByQuality, skippedByRegimeActivation: teB.stats.skippedByRegimeActivation,
        skippedByTrajectoryGate: teB.stats.skippedByTrajectoryGate,
        avgCandidateQuality: avg(teB.rows.map(s => s.quality)), avgCandidateOpportunity: avg(teB.rows.map(s => s.opportunity)),
        avgTrajectoryScore: avg(teB.rows.map(s => s.trajectoryScore).filter(Number.isFinite)),
      };
    })(),
    baseline: safeMetrics(fullBase),
    deltas: { fullVsBaseline: pairedDelta(fullBase, full), pureExit: pairedExit.delta, pureSizing: sizingAttribution.delta, activationSelection: entrySelectionAttribution.activationDelta, trajectorySelection: entrySelectionAttribution.trajectoryGateDelta },
    regimeCoverage: { activeRegimes, totalRegimes: REGIMES.length }, decision,
    promotion: 'RESEARCH ONLY. No automatic production or shadow promotion.',
  };
  writeReport(report);
}

main().catch(e => { console.error(e); process.exit(1); });
