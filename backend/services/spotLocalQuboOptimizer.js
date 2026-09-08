'use strict';

const SHADOW_COLLECTION = 'spot_qubo_shadow_decisions';
const STATUS_COLLECTION = 'spot_qubo_optimizer_status';
const VERSION = 'spot_local_qubo_v1';

const DEFAULTS = Object.freeze({
  capitalUsdt: 25,
  unitUsdt: 5,
  maxPositions: 3,
  minCandidates: 2,
  settleAfterHours: 24,
  promotionMinSettled: 30,
  promotionMinWinRate: 0.58,
  promotionMinMeanExcessPct: 0.25,
  promotionMaxDrawdownDeltaPct: 1.5
});

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function clamp(value, min = 0, max = 1) {
  return Math.max(min, Math.min(max, n(value)));
}

function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round(n(value) * factor) / factor;
}

function normalizedLog(value, floor, ceiling) {
  const v = n(value);
  if (v <= floor) return 0;
  if (v >= ceiling) return 1;
  return clamp((Math.log10(v) - Math.log10(floor)) / (Math.log10(ceiling) - Math.log10(floor)));
}

function candidateUtility(candidate = {}) {
  const gem = clamp(n(candidate.gem_score) / 100);
  const components = candidate.gem_components || {};
  const liquidity = clamp(n(components.liquidity) / 26) || normalizedLog(candidate.quote_volume_24h, 5e6, 1.5e8);
  const activity = clamp(n(components.activity) / 18) || normalizedLog(candidate.trades_24h, 1e4, 5e5);
  const momentum = clamp(n(components.momentum) / 18);
  const volatility = clamp(n(components.volatility) / 14);
  const novelty = clamp(n(components.novelty) / 10);
  const penalty = clamp(n(candidate.gem_penalty) / 40);
  const change = n(candidate.price_change_24h_pct);
  const chase = change > 12 ? clamp((change - 12) / 12) : 0;
  const downside = change < 0 ? clamp(Math.abs(change) / 15) : 0;

  return round(
    gem * 0.32 +
    liquidity * 0.17 +
    activity * 0.13 +
    momentum * 0.17 +
    volatility * 0.08 +
    novelty * 0.05 -
    penalty * 0.05 -
    chase * 0.02 -
    downside * 0.01,
    6
  );
}

function pairPenalty(left = {}, right = {}) {
  let penalty = 0;
  if (left.research_lane && right.research_lane && left.research_lane === right.research_lane) penalty += 0.035;

  const leftMove = n(left.price_change_24h_pct);
  const rightMove = n(right.price_change_24h_pct);
  if (leftMove > 0 && rightMove > 0 && Math.abs(leftMove - rightMove) <= 2) penalty += 0.015;

  const leftRisk = new Set(Array.isArray(left.risks) ? left.risks : []);
  const sharedRisk = (Array.isArray(right.risks) ? right.risks : []).some((risk) => leftRisk.has(risk));
  if (sharedRisk) penalty += 0.02;

  return round(penalty, 6);
}

function sanitizeCandidates(candidates = []) {
  const seen = new Set();
  return candidates
    .filter((candidate) => candidate && candidate.symbol && n(candidate.price) > 0)
    .filter((candidate) => {
      const symbol = String(candidate.symbol).toUpperCase();
      if (seen.has(symbol)) return false;
      seen.add(symbol);
      return true;
    })
    .map((candidate) => ({ ...candidate, symbol: String(candidate.symbol).toUpperCase() }));
}

function portfolioObjective(selected = []) {
  const utility = selected.reduce((sum, candidate) => sum + candidateUtility(candidate), 0);
  let diversificationPenalty = 0;
  for (let i = 0; i < selected.length; i += 1) {
    for (let j = i + 1; j < selected.length; j += 1) {
      diversificationPenalty += pairPenalty(selected[i], selected[j]);
    }
  }
  return round(utility - diversificationPenalty, 6);
}

function buildDecision(name, selected, unitUsdt) {
  const allocations = selected.map((candidate) => ({
    symbol: candidate.symbol,
    usdt: unitUsdt,
    entry_price: n(candidate.price),
    utility: candidateUtility(candidate),
    lane: candidate.research_lane || null
  }));
  return {
    method: name,
    symbols: allocations.map((item) => item.symbol),
    allocations,
    capital_usdt: round(allocations.length * unitUsdt, 2),
    objective: portfolioObjective(selected)
  };
}

function greedyOptimize(candidates, config) {
  const maxPositions = Math.min(config.maxPositions, Math.floor(config.capitalUsdt / config.unitUsdt));
  const ranked = [...candidates].sort((a, b) => candidateUtility(b) - candidateUtility(a));
  const selected = [];
  for (const candidate of ranked) {
    if (selected.length >= maxPositions) break;
    const incremental = candidateUtility(candidate) - selected.reduce((sum, prior) => sum + pairPenalty(prior, candidate), 0);
    if (incremental > 0) selected.push(candidate);
  }
  return buildDecision('GREEDY_BASELINE', selected, config.unitUsdt);
}

function exactQuboOptimize(candidates, config) {
  const maxPositions = Math.min(config.maxPositions, Math.floor(config.capitalUsdt / config.unitUsdt));
  const size = candidates.length;
  let best = [];
  let bestObjective = 0;

  for (let mask = 1; mask < (1 << size); mask += 1) {
    const selected = [];
    for (let index = 0; index < size; index += 1) {
      if (mask & (1 << index)) selected.push(candidates[index]);
    }
    if (selected.length > maxPositions) continue;
    const objective = portfolioObjective(selected);
    if (objective > bestObjective) {
      bestObjective = objective;
      best = selected;
    }
  }
  return buildDecision('LOCAL_QUBO_EXACT', best, config.unitUsdt);
}

function seededRandom(seed) {
  let state = (seed >>> 0) || 1;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

function quantumInspiredOptimize(candidates, config, seed = Date.now()) {
  const maxPositions = Math.min(config.maxPositions, Math.floor(config.capitalUsdt / config.unitUsdt));
  if (!candidates.length || maxPositions < 1) return buildDecision('LOCAL_QUANTUM_INSPIRED', [], config.unitUsdt);

  const random = seededRandom(seed);
  let current = new Set();
  let currentObjective = 0;
  let best = new Set();
  let bestObjective = 0;
  let temperature = 0.35;
  const iterations = Math.max(250, candidates.length * 120);

  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const index = Math.floor(random() * candidates.length);
    const next = new Set(current);
    if (next.has(index)) next.delete(index);
    else if (next.size < maxPositions) next.add(index);
    else {
      const victim = [...next][Math.floor(random() * next.size)];
      next.delete(victim);
      next.add(index);
    }

    const selected = [...next].map((candidateIndex) => candidates[candidateIndex]);
    const nextObjective = portfolioObjective(selected);
    const delta = nextObjective - currentObjective;
    if (delta >= 0 || random() < Math.exp(delta / Math.max(temperature, 0.0001))) {
      current = next;
      currentObjective = nextObjective;
    }
    if (currentObjective > bestObjective) {
      best = new Set(current);
      bestObjective = currentObjective;
    }
    temperature *= 0.992;
  }

  const selected = [...best].map((candidateIndex) => candidates[candidateIndex]);
  return buildDecision('LOCAL_QUANTUM_INSPIRED', selected, config.unitUsdt);
}

function resolvedConfig(options = {}) {
  const unitUsdt = Math.max(1, n(options.unitUsdt, DEFAULTS.unitUsdt));
  const capitalUsdt = Math.max(unitUsdt, n(options.capitalUsdt, DEFAULTS.capitalUsdt));
  return {
    capitalUsdt,
    unitUsdt,
    maxPositions: Math.max(1, Math.floor(n(options.maxPositions, DEFAULTS.maxPositions))),
    minCandidates: Math.max(1, Math.floor(n(options.minCandidates, DEFAULTS.minCandidates))),
    settleAfterHours: Math.max(1, n(options.settleAfterHours, DEFAULTS.settleAfterHours)),
    promotionMinSettled: Math.max(10, Math.floor(n(options.promotionMinSettled, DEFAULTS.promotionMinSettled))),
    promotionMinWinRate: clamp(n(options.promotionMinWinRate, DEFAULTS.promotionMinWinRate)),
    promotionMinMeanExcessPct: n(options.promotionMinMeanExcessPct, DEFAULTS.promotionMinMeanExcessPct),
    promotionMaxDrawdownDeltaPct: Math.max(0, n(options.promotionMaxDrawdownDeltaPct, DEFAULTS.promotionMaxDrawdownDeltaPct))
  };
}

function decisionReturn(decision = {}, priceBySymbol = new Map()) {
  const allocations = Array.isArray(decision.allocations) ? decision.allocations : [];
  if (!allocations.length) return { return_pct: 0, worst_asset_return_pct: 0, priced: 0 };
  const returns = [];
  for (const allocation of allocations) {
    const current = n(priceBySymbol.get(allocation.symbol));
    const entry = n(allocation.entry_price);
    if (!(current > 0 && entry > 0)) continue;
    returns.push((current / entry - 1) * 100);
  }
  if (!returns.length) return null;
  return {
    return_pct: round(returns.reduce((sum, value) => sum + value, 0) / returns.length, 4),
    worst_asset_return_pct: round(Math.min(...returns), 4),
    priced: returns.length
  };
}

async function evaluateMaturedShadowDecisions(db, priceBySymbol, now = Date.now(), options = {}) {
  const config = resolvedConfig(options);
  const snapshot = await db.collection(SHADOW_COLLECTION).orderBy('created_at', 'desc').limit(120).get();
  let settled = 0;

  for (const doc of snapshot.docs) {
    const data = doc.data();
    if (data.status !== 'OPEN') continue;
    const createdMs = Date.parse(data.created_at || '');
    if (!Number.isFinite(createdMs) || now - createdMs < config.settleAfterHours * 3600000) continue;

    const greedy = decisionReturn(data.greedy, priceBySymbol);
    const qubo = decisionReturn(data.qubo, priceBySymbol);
    const quantumInspired = decisionReturn(data.quantum_inspired, priceBySymbol);
    if (!greedy || !qubo || !quantumInspired) continue;

    const outcome = {
      settled_at: new Date(now).toISOString(),
      horizon_hours: round((now - createdMs) / 3600000, 2),
      greedy,
      qubo,
      quantum_inspired: quantumInspired,
      qubo_excess_vs_greedy_pct: round(qubo.return_pct - greedy.return_pct, 4),
      quantum_inspired_excess_vs_greedy_pct: round(quantumInspired.return_pct - greedy.return_pct, 4)
    };
    await doc.ref.set({ status: 'SETTLED', outcome }, { merge: true });
    settled += 1;
  }
  return settled;
}

async function computePromotionGate(db, options = {}) {
  const config = resolvedConfig(options);
  const snapshot = await db.collection(SHADOW_COLLECTION).orderBy('created_at', 'desc').limit(200).get();
  const settled = snapshot.docs.map((doc) => doc.data()).filter((item) => item.status === 'SETTLED' && item.outcome);
  const excess = settled.map((item) => n(item.outcome.qubo_excess_vs_greedy_pct));
  const wins = excess.filter((value) => value > 0).length;
  const meanExcess = excess.length ? excess.reduce((sum, value) => sum + value, 0) / excess.length : 0;
  const quboWorst = settled.map((item) => n(item.outcome?.qubo?.worst_asset_return_pct, 0));
  const greedyWorst = settled.map((item) => n(item.outcome?.greedy?.worst_asset_return_pct, 0));
  const worstQubo = quboWorst.length ? Math.min(...quboWorst) : 0;
  const worstGreedy = greedyWorst.length ? Math.min(...greedyWorst) : 0;
  const drawdownDelta = Math.max(0, Math.abs(Math.min(0, worstQubo)) - Math.abs(Math.min(0, worstGreedy)));
  const winRate = settled.length ? wins / settled.length : 0;

  const eligible = settled.length >= config.promotionMinSettled &&
    winRate >= config.promotionMinWinRate &&
    meanExcess >= config.promotionMinMeanExcessPct &&
    drawdownDelta <= config.promotionMaxDrawdownDeltaPct;

  const status = {
    version: VERSION,
    updated_at: new Date().toISOString(),
    mode: 'SHADOW_ONLY',
    external_credentials_required: false,
    paid_quantum_service_required: false,
    settled_samples: settled.length,
    win_rate_vs_greedy: round(winRate, 4),
    mean_excess_vs_greedy_pct: round(meanExcess, 4),
    worst_drawdown_delta_pct: round(drawdownDelta, 4),
    promotion_eligible: eligible,
    promotion_state: eligible ? 'ADVISORY_READY' : 'SHADOW',
    real_execution_enabled: false,
    thresholds: {
      min_settled: config.promotionMinSettled,
      min_win_rate: config.promotionMinWinRate,
      min_mean_excess_pct: config.promotionMinMeanExcessPct,
      max_drawdown_delta_pct: config.promotionMaxDrawdownDeltaPct
    }
  };
  await db.collection(STATUS_COLLECTION).doc('current').set(status, { merge: true });
  return status;
}

async function runLocalQuboShadow(db, candidates = [], options = {}) {
  const config = resolvedConfig(options);
  const clean = sanitizeCandidates(candidates);
  if (clean.length < config.minCandidates) {
    return { ok: true, skipped: true, reason: 'INSUFFICIENT_CANDIDATES', candidate_count: clean.length, version: VERSION };
  }

  const now = Date.now();
  const greedy = greedyOptimize(clean, config);
  const qubo = exactQuboOptimize(clean, config);
  const quantumInspired = quantumInspiredOptimize(clean, config, now & 0xffffffff);
  const id = `qubo_shadow_${now}`;
  const record = {
    id,
    created_at: new Date(now).toISOString(),
    status: 'OPEN',
    version: VERSION,
    mode: 'SHADOW_ONLY',
    spot_only: true,
    no_order_created: true,
    real_execution_enabled: false,
    external_credentials_required: false,
    paid_quantum_service_required: false,
    candidate_count: clean.length,
    candidates: clean.map((candidate) => ({
      symbol: candidate.symbol,
      price: n(candidate.price),
      gem_score: n(candidate.gem_score),
      utility: candidateUtility(candidate),
      lane: candidate.research_lane || null,
      price_change_24h_pct: n(candidate.price_change_24h_pct),
      quote_volume_24h: n(candidate.quote_volume_24h)
    })),
    config,
    greedy,
    qubo,
    quantum_inspired: quantumInspired,
    objective_advantage_vs_greedy: round(qubo.objective - greedy.objective, 6)
  };
  await db.collection(SHADOW_COLLECTION).doc(id).set(record);
  return record;
}

module.exports = {
  VERSION,
  DEFAULTS,
  candidateUtility,
  pairPenalty,
  portfolioObjective,
  greedyOptimize,
  exactQuboOptimize,
  quantumInspiredOptimize,
  runLocalQuboShadow,
  evaluateMaturedShadowDecisions,
  computePromotionGate
};
