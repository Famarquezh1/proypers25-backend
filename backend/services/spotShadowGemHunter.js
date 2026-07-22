'use strict';

const { getDiscoveryIntelligence } = require('./spotDiscoveryIntelligence');

const PORTFOLIOS = 'spot_shadow_gem_portfolios';
const POSITIONS = 'spot_shadow_gem_positions';
const DECISIONS = 'spot_shadow_gem_decisions';
const PORTFOLIO_ID = 'gem_hunter_default';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  return Number(number(value).toFixed(decimals));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, number(value)));
}

function buildGemPolicy(options = {}) {
  return {
    initial_capital_usdt: Math.max(10, number(options.initialCapital ?? process.env.SPOT_GEM_INITIAL_CAPITAL_USDT, 20)),
    reserve_capital_usdt: Math.max(0, number(options.reserveCapital ?? process.env.SPOT_GEM_RESERVE_USDT, 8)),
    min_position_usdt: Math.max(1, number(options.minPosition ?? process.env.SPOT_GEM_MIN_POSITION_USDT, 2)),
    max_position_usdt: Math.max(2, number(options.maxPosition ?? process.env.SPOT_GEM_MAX_POSITION_USDT, 4)),
    max_positions: Math.max(1, Math.min(5, number(options.maxPositions ?? process.env.SPOT_GEM_MAX_POSITIONS, 3))),
    fee_rate: clamp(number(options.feeRate ?? process.env.SPOT_GEM_FEE_RATE, 0.001), 0, 0.01),
    hard_stop_pct: -Math.abs(number(options.hardStopPct ?? process.env.SPOT_GEM_HARD_STOP_PCT, 18)),
    first_partial_pct: Math.abs(number(options.firstPartialPct ?? process.env.SPOT_GEM_TP1_PCT, 25)),
    second_partial_pct: Math.abs(number(options.secondPartialPct ?? process.env.SPOT_GEM_TP2_PCT, 60)),
    trailing_activation_pct: Math.abs(number(options.trailingActivationPct ?? process.env.SPOT_GEM_TRAILING_ACTIVATION_PCT, 30)),
    trailing_distance_pct: Math.abs(number(options.trailingDistancePct ?? process.env.SPOT_GEM_TRAILING_DISTANCE_PCT, 14)),
    max_holding_hours: Math.max(24, number(options.maxHoldingHours ?? process.env.SPOT_GEM_MAX_HOLDING_HOURS, 168)),
    minimum_conviction: clamp(number(options.minimumConviction ?? process.env.SPOT_GEM_MIN_CONVICTION, 52), 0, 100),
    minimum_asymmetry: clamp(number(options.minimumAsymmetry ?? process.env.SPOT_GEM_MIN_ASYMMETRY, 55), 0, 100),
    maximum_risk: clamp(number(options.maximumRisk ?? process.env.SPOT_GEM_MAX_RISK, 88), 0, 100)
  };
}

function isGemPattern(candidate = {}) {
  const reasons = new Set(candidate.reasons || []);
  return candidate.extraordinary_reaction === true ||
    number(candidate.asymmetry_score) >= 65 ||
    reasons.has('volume_24h_above_recent_average') ||
    reasons.has('recent_high_breakout') ||
    reasons.has('accumulation_then_impulse') ||
    reasons.has('strong_price_move_with_growing_volume');
}

function allocation(candidate, policy) {
  const edge = clamp((number(candidate.asymmetry_score) * 0.55) + (number(candidate.conviction_score) * 0.35) - (number(candidate.risk_score) * 0.15), 0, 100);
  return round(policy.min_position_usdt + ((policy.max_position_usdt - policy.min_position_usdt) * edge / 100), 2);
}

function buildGemDecision(candidate, context = {}) {
  const policy = context.policy || buildGemPolicy();
  const openSymbols = new Set((context.openPositions || []).map((item) => String(item.symbol || '').toUpperCase()));
  let rejection = null;
  if (!candidate?.symbol) rejection = 'MISSING_SYMBOL';
  else if (openSymbols.has(String(candidate.symbol).toUpperCase())) rejection = 'SYMBOL_ALREADY_OPEN';
  else if ((context.openPositions || []).length >= policy.max_positions) rejection = 'MAX_POSITIONS_REACHED';
  else if (number(candidate.conviction_score) < policy.minimum_conviction) rejection = 'CONVICTION_BELOW_GEM_MINIMUM';
  else if (number(candidate.asymmetry_score) < policy.minimum_asymmetry) rejection = 'ASYMMETRY_BELOW_GEM_MINIMUM';
  else if (number(candidate.risk_score) > policy.maximum_risk) rejection = 'RISK_ABOVE_GEM_MAXIMUM';
  else if (!isGemPattern(candidate)) rejection = 'NO_GEM_PATTERN';
  else if (number(context.availableCapital) < policy.min_position_usdt) rejection = 'INSUFFICIENT_GEM_CAPITAL';
  const action = rejection ? 'SKIP' : 'GEM_SHADOW_ENTRY';
  return {
    strategy: 'GEM_HUNTER',
    symbol: String(candidate?.symbol || '').toUpperCase(),
    action,
    rejection_reason: rejection,
    allocation_usdt: action === 'GEM_SHADOW_ENTRY' ? round(Math.min(allocation(candidate, policy), context.availableCapital, policy.max_position_usdt), 2) : 0,
    entry_price: number(candidate?.detection_price, null),
    conviction_score: round(candidate?.conviction_score, 2),
    asymmetry_score: round(candidate?.asymmetry_score, 2),
    risk_score: round(candidate?.risk_score, 2),
    hard_stop_pct: policy.hard_stop_pct,
    first_partial_pct: policy.first_partial_pct,
    second_partial_pct: policy.second_partial_pct,
    trailing_activation_pct: policy.trailing_activation_pct,
    trailing_distance_pct: policy.trailing_distance_pct,
    max_holding_hours: policy.max_holding_hours,
    reasons: Array.isArray(candidate?.reasons) ? candidate.reasons.slice(0, 8) : [],
    shadow_only: true,
    real_order: false
  };
}

function evaluateGemPosition(position, validation, policy) {
  if (!validation) return { action: 'HOLD', reason: 'NO_VALIDATION_AVAILABLE' };
  const favorable = number(validation.max_favorable_move_pct);
  const adverse = number(validation.max_adverse_move_pct);
  const variation = number(validation.variation_pct);
  const hours = number(validation.hours);
  const peak = Math.max(number(position.peak_move_pct), favorable);
  const trailingFloor = peak - policy.trailing_distance_pct;
  if (adverse <= policy.hard_stop_pct) return { action: 'CLOSE', reason: 'HARD_STOP', exit_variation_pct: policy.hard_stop_pct, peak_move_pct: peak };
  if (peak >= policy.trailing_activation_pct && variation <= trailingFloor) return { action: 'CLOSE', reason: 'TRAILING_EXIT', exit_variation_pct: variation, peak_move_pct: peak };
  if (favorable >= policy.second_partial_pct && position.second_partial_taken !== true) return { action: 'PARTIAL', reason: 'SECOND_PARTIAL', exit_variation_pct: policy.second_partial_pct, fraction: 0.35, peak_move_pct: peak };
  if (favorable >= policy.first_partial_pct && position.first_partial_taken !== true) return { action: 'PARTIAL', reason: 'FIRST_PARTIAL', exit_variation_pct: policy.first_partial_pct, fraction: 0.35, peak_move_pct: peak };
  if (hours >= policy.max_holding_hours) return { action: 'CLOSE', reason: 'TIMEOUT_7D', exit_variation_pct: variation, peak_move_pct: peak };
  return { action: 'HOLD', reason: 'LET_WINNER_RUN', peak_move_pct: peak };
}

function tradePnl(notional, variationPct, feeRate, fraction = 1) {
  const grossNotional = number(notional) * number(fraction, 1);
  const grossPnl = grossNotional * number(variationPct) / 100;
  const fees = grossNotional * feeRate * 2;
  return { gross_notional_usdt: round(grossNotional), gross_pnl_usdt: round(grossPnl), fees_usdt: round(fees), net_pnl_usdt: round(grossPnl - fees) };
}

async function loadPortfolio(db, policy) {
  const ref = db.collection(PORTFOLIOS).doc(PORTFOLIO_ID);
  const doc = await ref.get();
  if (doc.exists) return { ref, ...doc.data() };
  const initial = { id: PORTFOLIO_ID, strategy: 'GEM_HUNTER', mode: 'SHADOW', initial_capital_usdt: policy.initial_capital_usdt, cash_usdt: policy.initial_capital_usdt, realized_pnl_usdt: 0, fees_usdt: 0, peak_equity_usdt: policy.initial_capital_usdt, max_drawdown_pct: 0, last_processed_scan_id: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
  await ref.set(initial);
  return { ref, ...initial };
}

async function runGemHunterCycle(db, options = {}) {
  if (!db) throw new Error('gem_hunter_requires_db');
  const policy = buildGemPolicy(options);
  const discovery = await getDiscoveryIntelligence(db, { limit: options.limit || 40 });
  const portfolio = await loadPortfolio(db, policy);
  const openSnapshot = await db.collection(POSITIONS).where('status', '==', 'OPEN').get();
  const open = openSnapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...(doc.data() || {}) }));
  let cash = number(portfolio.cash_usdt, policy.initial_capital_usdt);
  let realized = number(portfolio.realized_pnl_usdt);
  let fees = number(portfolio.fees_usdt);
  const exits = [];

  for (const position of open) {
    const candidate = discovery.ranking.find((item) => item.symbol === position.symbol);
    const evaluation = evaluateGemPosition(position, candidate?.validation || null, policy);
    if (evaluation.action === 'HOLD') {
      await position.ref.set({ peak_move_pct: round(evaluation.peak_move_pct), updated_at: new Date().toISOString() }, { merge: true });
      continue;
    }
    const pnl = tradePnl(position.remaining_notional_usdt, evaluation.exit_variation_pct, policy.fee_rate, evaluation.fraction || 1);
    cash += pnl.gross_notional_usdt + pnl.net_pnl_usdt;
    realized += pnl.net_pnl_usdt;
    fees += pnl.fees_usdt;
    if (evaluation.action === 'PARTIAL') {
      const patch = { remaining_notional_usdt: round(number(position.remaining_notional_usdt) - pnl.gross_notional_usdt), realized_pnl_usdt: round(number(position.realized_pnl_usdt) + pnl.net_pnl_usdt), peak_move_pct: round(evaluation.peak_move_pct), updated_at: new Date().toISOString() };
      if (evaluation.reason === 'FIRST_PARTIAL') patch.first_partial_taken = true;
      if (evaluation.reason === 'SECOND_PARTIAL') patch.second_partial_taken = true;
      await position.ref.set(patch, { merge: true });
    } else {
      await position.ref.set({ status: 'CLOSED', close_reason: evaluation.reason, exit_variation_pct: evaluation.exit_variation_pct, realized_pnl_usdt: round(number(position.realized_pnl_usdt) + pnl.net_pnl_usdt), peak_move_pct: round(evaluation.peak_move_pct), closed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { merge: true });
    }
    exits.push({ symbol: position.symbol, ...evaluation, ...pnl });
  }

  const freshSnapshot = await db.collection(POSITIONS).where('status', '==', 'OPEN').get();
  const freshOpen = freshSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const committed = freshOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0);
  let available = Math.max(0, Math.min(cash - policy.reserve_capital_usdt, policy.initial_capital_usdt - policy.reserve_capital_usdt - committed));
  const decisions = [];

  if (portfolio.last_processed_scan_id !== discovery.scan?.id) {
    for (const candidate of discovery.ranking) {
      const decision = buildGemDecision(candidate, { policy, openPositions: freshOpen, availableCapital: available });
      decisions.push(decision);
      await db.collection(DECISIONS).doc(`${discovery.scan?.id || 'none'}_${candidate.symbol}`).set({ ...decision, scan_id: discovery.scan?.id || null, created_at: new Date().toISOString() }, { merge: true });
      if (decision.action !== 'GEM_SHADOW_ENTRY') continue;
      const entryFee = round(decision.allocation_usdt * policy.fee_rate);
      const invested = round(decision.allocation_usdt - entryFee);
      const id = `${discovery.scan.id}_${decision.symbol}`;
      await db.collection(POSITIONS).doc(id).set({ id, strategy: 'GEM_HUNTER', scan_id: discovery.scan.id, symbol: decision.symbol, status: 'OPEN', entry_price: decision.entry_price, initial_notional_usdt: invested, remaining_notional_usdt: invested, entry_fee_usdt: entryFee, conviction_score: decision.conviction_score, asymmetry_score: decision.asymmetry_score, risk_score: decision.risk_score, first_partial_taken: false, second_partial_taken: false, peak_move_pct: 0, realized_pnl_usdt: 0, shadow_only: true, opened_at: new Date().toISOString(), updated_at: new Date().toISOString() });
      cash -= decision.allocation_usdt;
      fees += entryFee;
      available -= decision.allocation_usdt;
      freshOpen.push({ symbol: decision.symbol, remaining_notional_usdt: invested });
      if (freshOpen.length >= policy.max_positions || available < policy.min_position_usdt) break;
    }
  }

  const equity = round(cash + freshOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0));
  const peak = Math.max(number(portfolio.peak_equity_usdt, policy.initial_capital_usdt), equity);
  const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
  const maxDrawdown = Math.min(number(portfolio.max_drawdown_pct), drawdown);
  await portfolio.ref.set({ strategy: 'GEM_HUNTER', mode: 'SHADOW', cash_usdt: round(cash), realized_pnl_usdt: round(realized), fees_usdt: round(fees), equity_usdt: equity, peak_equity_usdt: round(peak), max_drawdown_pct: round(maxDrawdown), last_processed_scan_id: discovery.scan?.id || portfolio.last_processed_scan_id || null, policy, updated_at: new Date().toISOString() }, { merge: true });

  return { strategy: 'GEM_HUNTER', mode: 'SHADOW', real_orders_enabled: false, scan_id: discovery.scan?.id || null, policy, portfolio: { cash_usdt: round(cash), committed_usdt: round(freshOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0)), equity_usdt: equity, realized_pnl_usdt: round(realized), fees_usdt: round(fees), max_drawdown_pct: round(maxDrawdown), open_positions: freshOpen.length }, decisions, exits };
}

module.exports = { buildGemPolicy, isGemPattern, buildGemDecision, evaluateGemPosition, tradePnl, runGemHunterCycle };
