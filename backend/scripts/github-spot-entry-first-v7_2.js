'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const R2_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-robust.js');
const VERSION = 'V7.2-ENTRY-FIRST';
const HOLDOUT_PREVIOUSLY_OBSERVED = true;
const FRESH_HOLDOUT_REQUIRED_FOR_READY = true;

function loadR2() {
  let src = fs.readFileSync(R2_PATH, 'utf8').replace(/\nmain\(\)\.catch[\s\S]*$/, '');
  src += `;globalThis.__entryFirstBase={
    REGIMES,INTERVAL,STEP,DAY,WARM,FWD,PURGE,COOLDOWN,COST,DAYS,POOL_SIZE,MIN_QV,MIN_TEST_TRADES,FIXED_SIZE,
    BASE_EXIT,EXIT_GRID,META_FALLBACK,avg,median,clamp,pct,isoDay,v,
    archiveSymbols,targetSymbol,prevCompleteMonth,monthParts,priorMonthLiquidity,mapLimit,loadKlines,contiguous,
    opportunity24h,simulateExit,onsetFor,dedupeEntries,summarizeTrades,withRecall,stripMetrics,simpleTradeMetrics,
    portfolio,blendExit,regimeAttribution,exitReasonAttribution,pairedDelta,
    timeFolds,safeMetrics,fitTrajectoryModel,trajectoryScore,scoreRows,chooseTrajectoryGate,
    chooseExitsRobust,chooseSizingRobust,robustSize,validationStabilityRobust
  };`;
  const c = vm.createContext({
    require, console, process, fetch, URL, URLSearchParams, AbortController, Buffer,
    setTimeout, clearTimeout, __dirname, __filename: R2_PATH,
  });
  vm.runInContext(src, c, { filename: R2_PATH });
  return c.__entryFirstBase;
}

const b = loadR2();
const {
  REGIMES, INTERVAL, STEP, DAY, WARM, FWD, PURGE, COOLDOWN, COST, DAYS, POOL_SIZE, MIN_QV,
  MIN_TEST_TRADES, FIXED_SIZE, BASE_EXIT, META_FALLBACK, avg, median, clamp, pct, isoDay, v,
  archiveSymbols, targetSymbol, prevCompleteMonth, monthParts, priorMonthLiquidity, mapLimit, loadKlines,
  contiguous, opportunity24h, simulateExit, onsetFor, dedupeEntries, withRecall, stripMetrics,
  simpleTradeMetrics, portfolio, blendExit, regimeAttribution, exitReasonAttribution, pairedDelta,
  timeFolds, fitTrajectoryModel, scoreRows, chooseTrajectoryGate, chooseExitsRobust, chooseSizingRobust,
  robustSize, validationStabilityRobust,
} = b;

const PORTFOLIO_CFG = {
  maxOpen: 5,
  maxExposure: 0.35,
  dailyRiskBudget: 0.02,
  ddBrake: 0.12,
  ddScale: 0.5,
};

function broadQuality(s) {
  const f = s.f, bd = s.breadth;
  const m15 = clamp(.5 + f.r15 / .035);
  const m60 = clamp(.5 + f.r60 / .075);
  const rs = clamp(.5 + f.rs60 / .06);
  const br = clamp(.5 + f.breakout60 / .045);
  const vol = clamp((Math.log(Math.max(.35, f.vol15)) + 1) / 2.2);
  const breadth = clamp(.22 * bd.up15 + .24 * bd.up60 + .18 * bd.breakout + .16 * bd.ignite + .20 * clamp(.5 + bd.mean60 / .035));
  const antiChase = clamp((f.r24 - .08) / .10);
  return clamp((.18 * m15 + .20 * m60 + .18 * rs + .15 * br + .11 * vol + .18 * breadth) * (1 - .22 * antiChase));
}

function annotateBroad(s) {
  const votes = [
    s.f.r15 > 0,
    s.f.r60 > 0,
    s.f.rs60 > 0,
    s.f.breakout60 > -.002,
    s.f.vol15 > 1,
    s.breadth.up60 > .5,
  ];
  return {
    ...s,
    quality: broadQuality(s),
    agreement: votes.filter(Boolean).length / votes.length,
    regimeConfidence: Math.max(...Object.values(s.regimeWeights)),
    activationWeight: 1,
    activationConfidence: 1,
  };
}

function prepareEntryModel(train, val) {
  const model = fitTrajectoryModel(train);
  if (!model) {
    return {
      model: null, enabled: false, selectedByEvidence: false, threshold: null, fallbackQuantile: null,
      reason: 'TRAIN did not contain enough broad causal observations to fit the trajectory model.', trials: [],
    };
  }
  const gate = chooseTrajectoryGate(train, val, train, val);
  const trainScored = scoreRows(train, model);
  const fallbackQuantile = .80;
  const fallbackThreshold = pct(trainScored.map(s => s.trajectoryScore), fallbackQuantile);
  return {
    ...gate,
    model,
    effectiveThreshold: gate.enabled ? gate.threshold : fallbackThreshold,
    fallbackQuantile: gate.enabled ? null : fallbackQuantile,
    fallbackThreshold: gate.enabled ? null : fallbackThreshold,
    independentOfSpecialistGate: true,
    specialistGateRequired: false,
  };
}

function buildEntryFirst(rows, entry, thresholdOverride = null) {
  if (!entry.model) return { rows: [], scored: 0, skippedByEntryGate: rows.length };
  const scored = scoreRows(rows, entry.model).map(s => ({
    ...s,
    qualitySeed: s.quality,
    quality: clamp(.55 * s.quality + .45 * s.trajectoryScore),
  }));
  const threshold = thresholdOverride === null ? entry.effectiveThreshold : thresholdOverride;
  const kept = dedupeEntries(scored.filter(s => s.trajectoryScore >= threshold));
  return { rows: kept, scored: scored.length, skippedByEntryGate: scored.length - kept.length, threshold };
}

function cleanIds(rows) {
  return new Set(rows.filter(s => s.opp24?.clean).map(s => `${s.symbol}:${Math.floor(s.t / COOLDOWN)}`));
}

function entryEvidence(cands, all) {
  const cClean = cleanIds(cands), allClean = cleanIds(all);
  const rawMfe = all.map(s => s.opp24?.mfeFixed24h || 0), candMfe = cands.map(s => s.opp24?.mfeFixed24h || 0);
  const rawCleanRate = all.length ? allClean.size / all.length : 0;
  return {
    rawEligibleSamples: all.length,
    candidateSignals: cands.length,
    candidateRate: all.length ? cands.length / all.length : 0,
    rawCleanOpportunityRate: rawCleanRate,
    candidateOpportunityPrecision: cands.length ? cClean.size / cands.length : 0,
    candidateOpportunityRecall: allClean.size ? cClean.size / allClean.size : 0,
    avgRawMFEFixed24h: avg(rawMfe),
    medianRawMFEFixed24h: median(rawMfe),
    avgCandidateMFEFixed24h: avg(candMfe),
    medianCandidateMFEFixed24h: median(candMfe),
    avgMFEFixed24hLift: avg(candMfe) - avg(rawMfe),
    precisionLiftVsRaw: (cands.length ? cClean.size / cands.length : 0) - rawCleanRate,
    avgCandidateEntryScore: avg(cands.map(s => s.trajectoryScore)),
    avgCandidateQuality: avg(cands.map(s => s.quality)),
    avgCandidateOpportunity: avg(cands.map(s => s.opportunity)),
    regimes: Object.fromEntries(REGIMES.map(r => [r, cands.filter(s => s.primaryRegime === r).length])),
  };
}

function foldEntryEvidence(cands, all) {
  if (!all.length) return [];
  const folds = timeFolds(all);
  return folds.map((fr, i) => {
    if (!fr.length) return { fold: i + 1, rawSamples: 0, candidateSignals: 0 };
    const a = fr[0].t, z = fr.at(-1).t;
    const fc = cands.filter(s => s.t >= a && s.t <= z);
    return { fold: i + 1, ...entryEvidence(fc, fr) };
  });
}

function outcomeAttach(rows, exits) {
  for (const s of rows) {
    s.adaptiveExit = blendExit(s, exits);
    s.baseOutcome = simulateExit(s, BASE_EXIT);
    s.adaptiveOutcome = simulateExit(s, s.adaptiveExit);
  }
}

function timingSlice(m) {
  return {
    avgDetectionDelayMinutes: m.avgDetectionDelayMinutes,
    medianDetectionDelayMinutes: m.medianDetectionDelayMinutes,
    timingCoverage: m.timingCoverage,
    entryExtension24hPct: m.entryExtension24hPct,
  };
}

function decide({ baseline, full, pairedExit, participation, regimeAttribution: reg, entry, exitEvidence, sizingMode }) {
  if (full.tradeCount < MIN_TEST_TRADES || baseline.tradeCount < MIN_TEST_TRADES) {
    return {
      ready: false, underlyingReady: false, certificationEligible: false,
      label: 'INSUFFICIENT_PARTICIPATION',
      reason: 'TEST has too few comparable admitted trades after ENTRY-first selection.',
      freshHoldoutRequired: FRESH_HOLDOUT_REQUIRED_FOR_READY,
    };
  }
  if (!entry.selectedByEvidence || !exitEvidence) {
    return {
      ready: false, underlyingReady: false, certificationEligible: false,
      label: 'REQUIRES_MORE_DATA',
      reason: 'ENTRY or EXIT lacked temporally robust TRAIN/VALIDATION evidence; exploratory fallback may be measured but cannot certify an edge.',
      freshHoldoutRequired: FRESH_HOLDOUT_REQUIRED_FOR_READY,
    };
  }
  const activeRegimes = REGIMES.filter(r => reg[r]?.tradeCount >= 3).length;
  const positive = full.netGrowth > 0;
  const econ = full.netGrowth > baseline.netGrowth && full.avgNetRet > baseline.avgNetRet;
  const cap = full.avgCaptureRatioFixed24h > baseline.avgCaptureRatioFixed24h && full.avgCaptureLoss24h < baseline.avgCaptureLoss24h;
  const dd = full.maxDrawdown >= -.12;
  const timing = full.timingCoverage >= .5 && baseline.timingCoverage >= .5 && full.avgDetectionDelayMinutes <= baseline.avgDetectionDelayMinutes + 30;
  const part = full.tradeCount >= baseline.tradeCount * .65 && participation.participationRate >= .30;
  const exitPure = pairedExit.delta.netGrowth > 0 && pairedExit.delta.avgNetRet > 0 && pairedExit.delta.avgCaptureRatioFixed24h > 0;
  const entryLift = entry.avgMFEFixed24hLift > 0 && entry.precisionLiftVsRaw > 0;
  const coverage = activeRegimes >= 2;
  const sizingSafe = sizingMode === 'FIXED_FALLBACK' || participation.sizingNetGrowthDelta >= 0;
  const underlyingReady = positive && econ && cap && dd && timing && part && exitPure && entryLift && coverage && sizingSafe;
  if (underlyingReady && HOLDOUT_PREVIOUSLY_OBSERVED) {
    return {
      ready: false, underlyingReady: true, certificationEligible: false,
      label: 'REQUIRES_MORE_DATA',
      reason: 'Research gates are satisfied, but these TEST windows were observed in prior V7.2 iterations. A fresh unseen holdout is required before any shadow-readiness claim.',
      freshHoldoutRequired: true,
    };
  }
  if (!part) return { ready: false, underlyingReady, certificationEligible: false, label: 'INSUFFICIENT_PARTICIPATION', reason: 'Economic evidence is not accepted because executable participation collapses.', freshHoldoutRequired: true };
  if (!entryLift) return { ready: false, underlyingReady, certificationEligible: false, label: 'REQUIRES_IMPROVEMENT', reason: 'ENTRY-first does not yet enrich fixed-24h opportunity quality versus the broad causal pool.', freshHoldoutRequired: true };
  if (!exitPure && pairedExit.delta.avgCaptureRatioFixed24h <= 0) return { ready: false, underlyingReady, certificationEligible: false, label: 'REQUIRES_REDESIGN', reason: 'With ENTRY separated, pure EXIT still fails to improve paired fixed-24h capture/economics.', freshHoldoutRequired: true };
  return { ready: false, underlyingReady, certificationEligible: false, label: 'REQUIRES_IMPROVEMENT', reason: 'ENTRY-first is measurable but does not satisfy every causal economic, capture, risk, timing, participation and regime-coverage gate.', freshHoldoutRequired: true };
}

function writeReport(r) {
  const d = path.join('backend', 'training-output');
  fs.mkdirSync(d, { recursive: true });
  const p = path.join(d, 'spot-entry-first-v7_2-report.json');
  fs.writeFileSync(p, JSON.stringify(r, null, 2));
  console.log(JSON.stringify(r, null, 2));
}

function earlyReport(reason, extra = {}) {
  writeReport({
    generatedAt: new Date().toISOString(), version: VERSION, experiment: 'ENTRY-first Causal Opportunity Capture',
    researchOnly: true, publicDataOnly: true, privateBinanceUsed: false, firestoreUsed: false,
    productionTradingTouched: false, automaticPromotion: false, lookbackDays: DAYS,
    leakageAudit: { holdoutPreviouslyObserved: HOLDOUT_PREVIOUSLY_OBSERVED, freshHoldoutRequiredForReady: true },
    ...extra,
    decision: { ready: false, underlyingReady: false, certificationEligible: false, label: 'REQUIRES_MORE_DATA', reason, freshHoldoutRequired: true },
    promotion: 'RESEARCH ONLY. No automatic production or shadow promotion.',
  });
}

async function main() {
  const now = new Date();
  const END = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const START = END - DAYS * DAY, LOAD_START = START - DAY, LOAD_END = END, preMonth = prevCompleteMonth(START);
  console.log(`${VERSION} ${DAYS}d ${isoDay(START)}..${isoDay(END - 1)} pool=${POOL_SIZE}`);

  const allSymbols = await archiveSymbols();
  const audit = {
    archiveSymbols: allSymbols.length, excludedStableFiat: 0, excludedLeveraged: 0, excludedInvalid: 0, excludedOtherQuote: 0,
    priorMonthAvailable: 0, selectedPool: 0, prefilterMonth: monthParts(preMonth).key,
    selectionCutoff: new Date(START).toISOString(), selectionUsesCurrentTicker: false, selectionUsesFutureVolume: false,
    survivorshipControl: 'No current ticker or current exchangeInfo is used. Historical Binance Vision archive prefixes plus strictly pre-window liquidity determine the pool.',
    minimumHistoryPolicy: '>=10 daily rows in the last complete calendar month before the research window; rolling 24h quote volume is rechecked causally at every timestamp.',
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
  if (pool.length < 20) return earlyReport('Historical archive universe produced too few causal pre-window symbols.', { universeAudit: audit });

  const data = new Map();
  const loaded = await mapLimit(pool, 8, async symbol => ({ symbol, rows: await loadKlines(symbol, LOAD_START, LOAD_END, END) }));
  for (const x of loaded) if (x && !x.__error && x.rows?.length) data.set(x.symbol, x.rows);
  audit.loadedSymbols = data.size;
  const btc = data.get('BTCUSDT');
  if (!btc?.length) throw new Error('BTCUSDT historical archive unavailable');

  const bm = v.btcMap(btc), featureRows = [], breadth = new Map();
  for (const [symbol, r] of data) {
    if (symbol === 'BTCUSDT' || r.length < WARM + FWD + 2) continue;
    for (let i = WARM; i < r.length - FWD; i++) {
      const t = r[i].t;
      if (t < START || t >= END - FWD * STEP || !contiguous(r, i)) continue;
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
    s.primaryRegime = Object.entries(s.regimeWeights).sort((a, z2) => z2[1] - a[1])[0][0];
    s.opportunity = v.opportunityScore(bd); s.opp24 = opportunity24h(s); s.o = { clean: Boolean(s.opp24?.clean) };
    s.detectionDelayMinutes = onsetFor(s, bm); raw.push(annotateBroad(s));
  }
  raw.sort((a, z) => a.t - z.t);
  if (raw.length < 600) return earlyReport('Too few causal eligible samples after point-in-time universe filtering.', { universeAudit: audit, samples: { all: raw.length } });

  const t0 = raw[0].t, t1 = raw.at(-1).t, span = t1 - t0, c1 = t0 + span * .45, c2 = t0 + span * .80, horizon = FWD * STEP;
  const train = raw.filter(x => x.t < c1 - horizon);
  const val = raw.filter(x => x.t > c1 + PURGE && x.t < c2 - horizon);
  const test = raw.filter(x => x.t > c2 + PURGE);
  if (train.length < 200 || val.length < 80 || test.length < 80) return earlyReport('Embargoed chronological split is too small.', { universeAudit: audit, samples: { all: raw.length, train: train.length, validation: val.length, test: test.length } });

  const entry = prepareEntryModel(train, val);
  if (!entry.model) return earlyReport(entry.reason, { universeAudit: audit, samples: { all: raw.length, train: train.length, validation: val.length, test: test.length } });

  const trE = buildEntryFirst(train, entry), vaE = buildEntryFirst(val, entry), teE = buildEntryFirst(test, entry);
  const trainScores = scoreRows(train, entry.model).map(s => s.trajectoryScore);
  const controlThreshold = pct(trainScores, .55);
  const teControl = buildEntryFirst(test, entry, controlThreshold);

  const exitSel = chooseExitsRobust(trE.rows, vaE.rows);
  const sizing = chooseSizingRobust(vaE.rows, exitSel.selected);
  outcomeAttach(teE.rows, exitSel.selected);
  outcomeAttach(teControl.rows, exitSel.selected);

  const pairBaseRaw = simpleTradeMetrics(teE.rows, s => s.baseOutcome, () => FIXED_SIZE);
  const pairAdaptRaw = simpleTradeMetrics(teE.rows, s => s.adaptiveOutcome, () => FIXED_SIZE);
  const sizeFixedRaw = simpleTradeMetrics(teE.rows, s => s.adaptiveOutcome, () => FIXED_SIZE);
  const sizeChosenRaw = simpleTradeMetrics(teE.rows, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg));
  const controlEntryRaw = simpleTradeMetrics(teControl.rows, s => s.baseOutcome, () => FIXED_SIZE);
  const selectedEntryRaw = simpleTradeMetrics(teE.rows, s => s.baseOutcome, () => FIXED_SIZE);
  for (const m of [pairBaseRaw, pairAdaptRaw, sizeFixedRaw, sizeChosenRaw, controlEntryRaw, selectedEntryRaw]) withRecall(m, m._trades || [], test);

  const fullBase = portfolio(teE.rows, test, PORTFOLIO_CFG, s => s.baseOutcome, () => FIXED_SIZE, () => BASE_EXIT.hardStop);
  const full = portfolio(teE.rows, test, PORTFOLIO_CFG, s => s.adaptiveOutcome, s => robustSize(s, sizing.cfg), s => s.adaptiveExit.hardStop);
  withRecall(fullBase, fullBase._trades || [], test); withRecall(full, full._trades || [], test);

  const reg = regimeAttribution(full._trades || [], test), reasons = exitReasonAttribution(full._trades || []);
  const pairedExit = { baselineExitFixedSize: stripMetrics(pairBaseRaw), adaptiveExitFixedSize: stripMetrics(pairAdaptRaw), delta: pairedDelta(pairBaseRaw, pairAdaptRaw) };
  const sizingAttr = { adaptiveExitFixedSize: stripMetrics(sizeFixedRaw), adaptiveExitSelectedSize: stripMetrics(sizeChosenRaw), delta: pairedDelta(sizeFixedRaw, sizeChosenRaw) };
  const entryAttr = {
    looseControlQuantile: .55,
    looseControlThreshold: controlThreshold,
    looseControlEntrySet: stripMetrics(controlEntryRaw),
    entryFirstSelectedSet: stripMetrics(selectedEntryRaw),
    delta: pairedDelta(controlEntryRaw, selectedEntryRaw),
    interpretation: 'Same baseline exit and fixed size. Thresholds are frozen from TRAIN/VALIDATION; TEST only measures the economic effect of ENTRY selection.',
  };
  const entryTest = entryEvidence(teE.rows, test);
  const participation = {
    rawEligibleSamples: test.length,
    candidateSignals: teE.rows.length,
    candidateRate: test.length ? teE.rows.length / test.length : 0,
    admittedTrades: full.tradeCount,
    participationRate: teE.rows.length ? full.tradeCount / teE.rows.length : 0,
    baselineTrades: fullBase.tradeCount,
    adaptiveTrades: full.tradeCount,
    skippedByEntryGate: teE.skippedByEntryGate,
    skippedBySpecialistGate: 0,
    skippedByRegimeActivation: 0,
    skippedByRisk: full.skippedByRisk,
    skippedByExposure: full.skippedByExposure,
    skippedByConcurrency: full.skippedByConcurrency,
    independentOfSpecialistGate: true,
    sizingNetGrowthDelta: sizingAttr.delta.netGrowth,
  };
  const activeRegimes = REGIMES.filter(r => reg[r]?.tradeCount >= 3).length;
  const decision = decide({ baseline: fullBase, full, pairedExit, participation, regimeAttribution: reg, entry: entryTest, exitEvidence: exitSel.selectedByEvidence, sizingMode: sizing.mode });

  const report = {
    generatedAt: new Date().toISOString(), version: VERSION, experiment: 'ENTRY-first Causal Opportunity Capture & Regime Attribution',
    researchOnly: true, publicDataOnly: true, privateBinanceUsed: false, firestoreUsed: false,
    productionTradingTouched: false, automaticPromotion: false, interval: INTERVAL, lookbackDays: DAYS,
    methodology: {
      objective: 'Select economically promising trajectories from the broad causal pool before any regime/specialist logic, then attribute ENTRY, EXIT and SIZING separately.',
      entryFirst: 'Trajectory model is fit on broad causal TRAIN observations. Validation selects the threshold. No specialist or regime activation can veto candidate creation.',
      regimeRole: 'Regime weights remain causal features for exit blending, sizing and attribution only; they are not an entry prerequisite.',
      portfolioControl: 'A fixed conservative portfolio configuration is shared by baseline and adaptive full-system tests to avoid META-selection confounding.',
      costFraction: COST, fixedSizingForPureExit: FIXED_SIZE,
    },
    leakageAudit: {
      currentTickerUsedForUniverse: false, currentExchangeInfoUsedForUniverse: false, archiveIndexHistoricalSymbols: true,
      universeRankingCutoffStrictlyBeforeWindow: true, rollingLiquidityUsesOnlyPastAndCurrentBars: true,
      featuresUseFuture: false, regimesUseFuture: false,
      testUsedForEntryModelFit: false, testUsedForEntryThresholdSelection: false, testUsedForExitSelection: false, testUsedForSizingSelection: false,
      mfeFixed24hUsedForEntryDecisionOnTest: false, testUntouchedWithinThisRunUntilFreeze: true,
      holdoutPreviouslyObserved: HOLDOUT_PREVIOUSLY_OBSERVED,
      freshHoldoutRequiredForReady: FRESH_HOLDOUT_REQUIRED_FOR_READY,
      holdoutNote: 'These historical TEST windows were observed during earlier V7.2/R2 development. They remain causally evaluated within this run but are no longer an unseen certification holdout.',
      specialistGateRequiredForEntry: false, zeroTradeWindowsCountAsSafe: false,
    },
    universeAudit: audit,
    intrabarPolicy: {
      resolution: 'CONSERVATIVE_5M',
      inheritedFrom: 'V7.2 causal harness',
      rule: 'Adverse ambiguity by default: existing stop precedes favorable same-bar high; newly activated BE/trailing may break in the same bar.',
    },
    captureMetrics: {
      primary: 'captureRatioFixed24h = max(0, realizedNetReturn) / MFE_fixed_24h, bounded [0,1].',
      secondary: 'captureRatioDuringTrade = max(0, realizedNetReturn) / MFE_during_trade.',
      captureLoss24h: 'MFE_fixed_24h - max(0, realizedNetReturn).',
    },
    split: { trainPct: .45, validationPct: .35, testPct: .20, purgeHours: PURGE / 3600000, forwardEmbargoHours: horizon / 3600000 },
    samples: { all: raw.length, train: train.length, validation: val.length, test: test.length },
    entryFirst: {
      independentOfSpecialistGate: true,
      selectedByEvidence: Boolean(entry.selectedByEvidence),
      enabled: Boolean(entry.enabled),
      effectiveThreshold: entry.effectiveThreshold,
      fallbackQuantile: entry.fallbackQuantile,
      fallbackThreshold: entry.fallbackThreshold,
      reason: entry.reason || null,
      selected: entry.selected || null,
      validationBaseline: entry.baselineValidation || null,
      trials: entry.trials || [],
      trainEvidence: entryEvidence(trE.rows, train),
      validationEvidence: entryEvidence(vaE.rows, val),
      validationFolds: foldEntryEvidence(vaE.rows, val),
      testEvidence: entryTest,
    },
    specialistGate: { enabled: false, role: 'None in ENTRY. Regime information is retained only downstream.' },
    portfolioControl: PORTFOLIO_CFG,
    exitSelection: exitSel,
    asymmetricSizing: { selected: sizing.cfg, validation: sizing.validation, score: sizing.score, selectedByEvidence: sizing.selectedByEvidence, mode: sizing.mode, trials: sizing.trials },
    walkForwardLite: validationStabilityRobust(vaE.rows, exitSel.selected, sizing.cfg),
    entryAttribution: entryAttr,
    pairedExitComparison: pairedExit,
    sizingAttribution: sizingAttr,
    causalAttribution: { entryEffect: entryAttr.delta, exitEffect: pairedExit.delta, sizingEffect: sizingAttr.delta },
    fullSystem: {
      baseline: stripMetrics(fullBase), entryFirstV72: stripMetrics(full),
      portfolioControlEffectVsUnconstrainedSizing: { netGrowth: full.netGrowth - sizeChosenRaw.netGrowth, tradeCount: full.tradeCount - sizeChosenRaw.tradeCount },
    },
    regimeAttribution: reg,
    exitReasonAttribution: reasons,
    timing: { baseline: timingSlice(fullBase), entryFirstV72: timingSlice(full) },
    participation,
    baseline: stripMetrics(fullBase),
    deltas: { fullVsBaseline: pairedDelta(fullBase, full), pureEntry: entryAttr.delta, pureExit: pairedExit.delta, pureSizing: sizingAttr.delta },
    regimeCoverage: { activeRegimes, totalRegimes: REGIMES.length },
    decision,
    promotion: 'RESEARCH ONLY. No automatic production or shadow promotion. Fresh unseen holdout is mandatory before any readiness claim.',
  };
  writeReport(report);
}

main().catch(e => { console.error(e); process.exit(1); });
