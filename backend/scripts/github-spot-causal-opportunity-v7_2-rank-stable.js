'use strict';

const fs = require('fs');
const path = require('path');
const Module = require('module');

const R3_PATH = path.join(__dirname, 'github-spot-causal-opportunity-v7_2-entry-first.js');
let src = fs.readFileSync(R3_PATH, 'utf8');

function replaceOrThrow(pattern, replacement, label) {
  if (!pattern.test(src)) throw new Error(`R4 patch target not found: ${label}`);
  src = src.replace(pattern, replacement);
}

replaceOrThrow(
  /const VERSION = 'V7\.2-R3-ENTRY-FIRST';/,
  "const VERSION = 'V7.2-R4-RANK-STABLE';",
  'version'
);

replaceOrThrow(
  /const ENTRY_FEATURES = \{[\s\S]*?\n\};/,
  `const ENTRY_FEATURES = {
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
  thrust: s => s.f.r15 * Math.log(Math.max(.2, s.f.vol15)),
  relativeBreakout: s => s.f.rs60 * (1 + Math.max(-.02, Math.min(.05, s.f.breakout60)) * 20),
  efficientMomentum: s => s.f.r60 * Math.max(0, Math.min(1, s.f.trendEfficiency || 0)),
  opportunityMomentum: s => s.opportunity * Math.max(-.02, Math.min(.08, s.f.r60)),
};`,
  'entry features'
);

replaceOrThrow(
  /function makeBroadRows\(samples, cal\) \{[\s\S]*?\n\}\n\nfunction labelUtility/,
  `function makeBroadRows(samples, cal) {
  // Keep the full causal cross-section here. Symbol cooldown is applied only
  // after relative ranking, so the learner can compare contemporaneous assets.
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

function labelUtility`,
  'broad rows'
);

replaceOrThrow(
  /function chooseEntryGate\(trainRows, valRows, trainAll, valAll\) \{[\s\S]*?\n\}\n\nfunction applyEntryGate/,
  `function selectCrossSection(rows, fraction, cap) {
  const groups = new Map();
  for (const s of rows) {
    const g = groups.get(s.t) || [];
    g.push(s); groups.set(s.t, g);
  }
  const selected = [];
  for (const group of groups.values()) {
    group.sort((a, z) => z.entryScore - a.entryScore);
    const n = Math.max(1, Math.min(cap, Math.ceil(group.length * fraction)));
    selected.push(...group.slice(0, n));
  }
  selected.sort((a, z) => a.t - z.t || z.entryScore - a.entryScore);
  return dedupeEntries(selected);
}

function chooseEntryGate(trainRows, valRows, trainAll, valAll) {
  const trainDedup = dedupeEntries(trainRows);
  const model = fitEntryModel(trainDedup);
  if (!model) return { enabled: false, model: null, threshold: null, selectedByEvidence: false, reason: 'Insufficient broad TRAIN rows.' };

  const trScored = scoreRows(trainRows, model), vaScored = scoreRows(valRows, model);
  const vaBaseRows = dedupeEntries(vaScored);
  const base = portfolio(vaBaseRows, valAll, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
  withRecall(base, base._trades || [], valAll);

  const trainCut = trainAll.length ? trainAll[Math.floor(trainAll.length * .65)]?.t : null;
  const trainGuardAll = Number.isFinite(trainCut) ? trainAll.filter(s => s.t >= trainCut) : trainAll;
  const trainGuardRows = Number.isFinite(trainCut) ? trScored.filter(s => s.t >= trainCut) : trScored;

  let best = null; const trials = [];
  for (const fraction of [.08, .12, .18, .25]) for (const cap of [1, 2, 3]) {
    const rows = selectCrossSection(vaScored, fraction, cap);
    const m = portfolio(rows, valAll, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(m, m._trades || [], valAll);
    const folds = foldPortfolio(rows, valAll, META_FALLBACK);
    const valid = folds.filter(f => f.tradeCount >= 2), pos = positiveFoldCount(valid, 'avgNetRet', 0);
    const worstFoldAvg = valid.length ? Math.min(...valid.map(f => f.avgNetRet)) : -1;
    const delta = pairedDelta(base, m);

    const guardRows = selectCrossSection(trainGuardRows, fraction, cap);
    const guard = portfolio(guardRows, trainGuardAll, META_FALLBACK, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);
    withRecall(guard, guard._trades || [], trainGuardAll);

    const participation = vaBaseRows.length ? rows.length / vaBaseRows.length : 0;
    const trainStable = guard.tradeCount >= 8 && guard.avgNetRet >= -.002 && guard.netGrowth >= -.005 && guard.maxDrawdown >= -.10;
    const robust = m.tradeCount >= MIN_GATE_TRADES && valid.length >= 2 && pos >= 2 && participation >= .08
      && m.netGrowth > 0 && m.avgNetRet > 0 && delta.netGrowth > 0 && delta.avgNetRet > 0
      && m.maxDrawdown >= -.12 && worstFoldAvg > -.012 && trainStable;
    const score = robust
      ? m.netGrowth * 12 + m.avgNetRet * 30 + delta.netGrowth * 8 + delta.avgNetRet * 18
        + guard.netGrowth * 4 + guard.avgNetRet * 12 + m.precision * .30 + m.recall * .20 + pos * .12
        - Math.max(0, .12 - participation)
      : -1e9;
    const row = {
      fraction, cap, validation: safeMetrics(m), delta: safeMetrics(delta), folds,
      trainGuard: safeMetrics(guard), participation, trainStable, robust, score,
    };
    trials.push(row); if (!best || score > best.score) best = row;
  }
  if (!best || best.score <= -1e8) {
    return { enabled: false, model, threshold: null, selectedByEvidence: false, baselineValidation: safeMetrics(base), trials, reason: 'No cross-sectional ENTRY rank produced positive and temporally stable TRAIN-guard + VALIDATION economics.' };
  }
  return {
    enabled: true, model, threshold: null, rankFraction: best.fraction, rankCap: best.cap,
    selectedByEvidence: true, baselineValidation: safeMetrics(base), selected: best, trials,
  };
}

function applyEntryGate`,
  'entry gate'
);

replaceOrThrow(
  /function applyEntryGate\(rows, gate\) \{[\s\S]*?\n\}\n\nfunction applyRegimeModifier/,
  `function applyEntryGate(rows, gate) {
  const scored = scoreRows(rows, gate.model);
  if (!gate.enabled) return { rows: [], scored, skipped: dedupeEntries(scored).length };
  const kept = selectCrossSection(scored, gate.rankFraction, gate.rankCap);
  return { rows: kept, scored, skipped: Math.max(0, dedupeEntries(scored).length - kept.length) };
}

function applyRegimeModifier`,
  'apply entry gate'
);

replaceOrThrow(
  /const sizing = chooseSizingRobust\(vaRows, exitSel\.selected\);/,
  `const sizingValidation = simpleTradeMetrics(vaRows, s => simulateExit(s, blendExit(s, exitSel.selected)), () => FIXED_SIZE);
  const sizing = {
    cfg: null,
    validation: safeMetrics(sizingValidation),
    fixedValidation: safeMetrics(sizingValidation),
    selectedByEvidence: false,
    mode: 'FIXED_FALLBACK',
    trials: [],
    reason: 'R4 freezes sizing at 5% until ENTRY generalization is stable across horizons.'
  };`,
  'fixed sizing'
);

replaceOrThrow(
  /const broadRaw = simpleTradeMetrics\(broadTest, s => simulateExit\(s, BASE_EXIT\), \(\) => FIXED_SIZE\);/,
  `const broadTestDedup = dedupeEntries(broadTest);
  const broadRaw = simpleTradeMetrics(broadTestDedup, s => simulateExit(s, BASE_EXIT), () => FIXED_SIZE);`,
  'broad attribution'
);

src = src.replace(
  "counts: { broad: broadTest.length, trajectory: teGate.rows.length, regimeWeighted: teMod.rows.length, meta: teRows.length }",
  "counts: { broad: broadTestDedup.length, trajectory: teGate.rows.length, regimeWeighted: teMod.rows.length, meta: teRows.length }"
);
src = src.replace(
  "broadSignals: broadTest.length, entryGateSignals: teGate.rows.length",
  "broadSignals: broadTestDedup.length, entryGateSignals: teGate.rows.length"
);
src = src.replace(
  "rawEligibleSamples: test.length, broadSignals: broadTest.length, candidateSignals: teRows.length",
  "rawEligibleSamples: test.length, broadSignals: broadTestDedup.length, candidateSignals: teRows.length"
);

src = src.replace(
  "experiment: 'Causal Opportunity Capture & Regime Attribution — ENTRY-first causal selector'",
  "experiment: 'Causal Opportunity Capture & Regime Attribution — Rank-stable ENTRY selector'"
);
src = src.replace(
  "entry: 'TRAIN-only additive smoothed economic model over causal features. Threshold chosen only on chronological VALIDATION folds with positive economics required.'",
  "entry: 'TRAIN-only smoothed causal model with interaction features. Admission is cross-sectional rank at each timestamp; fraction/cap are chosen only with recent-TRAIN guard plus chronological VALIDATION economics.'"
);
src = src.replace(
  "sizing: 'R2 robust paired sizing selector versus fixed 5%; fallback remains fixed 5%.'",
  "sizing: 'Frozen fixed 5% in R4. Adaptive sizing is disabled until ENTRY generalization is stable.'"
);
src = src.replace(
  "promotion: 'RESEARCH ONLY. Reused TEST windows can never produce READY. Fresh unseen holdout required before any shadow consideration.'",
  "promotion: 'RESEARCH ONLY. R4 is diagnostic on reused TEST windows; fresh unseen holdout is mandatory after model freeze.'"
);

const patched = new Module(R3_PATH, module.parent);
patched.filename = R3_PATH;
patched.paths = Module._nodeModulePaths(path.dirname(R3_PATH));
patched._compile(src, R3_PATH);
