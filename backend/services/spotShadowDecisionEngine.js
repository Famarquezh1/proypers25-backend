'use strict';

const { getDiscoveryIntelligence } = require('./spotDiscoveryIntelligence');

const PORTFOLIO_COLLECTION = 'spot_shadow_portfolios';
const POSITION_COLLECTION = 'spot_shadow_positions';
const DECISION_COLLECTION = 'spot_shadow_decisions';
const PORTFOLIO_ID = 'discovery_default';

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

function buildPolicy(options = {}) {
  const initialCapital = Math.max(20, number(options.initialCapital ?? process.env.SPOT_SHADOW_INITIAL_CAPITAL_USDT, 119));
  const reserveCapital = clamp(number(options.reserveCapital ?? process.env.SPOT_SHADOW_RESERVE_USDT, 70), 0, initialCapital);
  return {
    initial_capital_usdt: initialCapital,
    reserve_capital_usdt: reserveCapital,
    max_operating_capital_usdt: round(initialCapital - reserveCapital, 2),
    min_position_usdt: Math.max(2, number(options.minPosition ?? process.env.SPOT_SHADOW_MIN_POSITION_USDT, 3)),
    max_position_usdt: Math.max(3, number(options.maxPosition ?? process.env.SPOT_SHADOW_MAX_POSITION_USDT, 8)),
    max_positions: Math.max(1, Math.min(10, number(options.maxPositions ?? process.env.SPOT_SHADOW_MAX_POSITIONS, 5))),
    fee_rate: clamp(number(options.feeRate ?? process.env.SPOT_SHADOW_FEE_RATE, 0.001), 0, 0.01),
    stop_loss_pct: -Math.abs(number(options.stopLossPct ?? process.env.SPOT_SHADOW_STOP_LOSS_PCT, 6)),
    take_profit_1_pct: Math.abs(number(options.takeProfit1Pct ?? process.env.SPOT_SHADOW_TP1_PCT, 8)),
    take_profit_2_pct: Math.abs(number(options.takeProfit2Pct ?? process.env.SPOT_SHADOW_TP2_PCT, 18)),
    max_holding_hours: Math.max(12, number(options.maxHoldingHours ?? process.env.SPOT_SHADOW_MAX_HOLDING_HOURS, 72)),
    minimum_conviction: clamp(number(options.minimumConviction ?? process.env.SPOT_SHADOW_MIN_CONVICTION, 60), 0, 100),
    maximum_risk: clamp(number(options.maximumRisk ?? process.env.SPOT_SHADOW_MAX_RISK, 70), 0, 100)
  };
}

function suggestedAllocation(candidate, policy) {
  const conviction = number(candidate?.conviction_score);
  const asymmetry = number(candidate?.asymmetry_score);
  const risk = number(candidate?.risk_score);
  const strength = clamp((conviction * 0.65) + (asymmetry * 0.35) - (risk * 0.2), 0, 100);
  const span = policy.max_position_usdt - policy.min_position_usdt;
  return round(policy.min_position_usdt + (span * strength / 100), 2);
}

function buildDecision(candidate, context = {}) {
  const policy = context.policy || buildPolicy();
  const openSymbols = new Set((context.openPositions || []).map((item) => String(item.symbol || '').toUpperCase()));
  const reasons = [];
  let action = 'SKIP';
  let rejection = null;

  if (!candidate?.symbol) rejection = 'MISSING_SYMBOL';
  else if (openSymbols.has(String(candidate.symbol).toUpperCase())) rejection = 'SYMBOL_ALREADY_OPEN';
  else if (number(context.openPositions?.length) >= policy.max_positions) rejection = 'MAX_POSITIONS_REACHED';
  else if (number(candidate.conviction_score) < policy.minimum_conviction) rejection = 'CONVICTION_BELOW_MINIMUM';
  else if (number(candidate.risk_score) > policy.maximum_risk) rejection = 'RISK_ABOVE_MAXIMUM';
  else if (!['HIGH_CONVICTION', 'WATCH_CLOSELY'].includes(candidate.status)) rejection = 'STATUS_NOT_ACTIONABLE';
  else if (number(context.availableOperatingCapital) < policy.min_position_usdt) rejection = 'INSUFFICIENT_OPERATING_CAPITAL';
  else action = 'SHADOW_ENTRY';

  if (number(candidate.conviction_score) >= 75) reasons.push('high_conviction');
  if (number(candidate.asymmetry_score) >= 60) reasons.push('favorable_asymmetry');
  if (number(candidate.risk_score) <= 45) reasons.push('controlled_risk');
  reasons.push(...(Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 5) : []));

  const requested = suggestedAllocation(candidate, policy);
  const allocation = action === 'SHADOW_ENTRY'
    ? round(Math.min(requested, number(context.availableOperatingCapital), policy.max_position_usdt), 2)
    : 0;

  return {
    symbol: String(candidate?.symbol || '').toUpperCase(),
    action,
    rejection_reason: rejection,
    conviction_score: round(candidate?.conviction_score, 2),
    asymmetry_score: round(candidate?.asymmetry_score, 2),
    risk_score: round(candidate?.risk_score, 2),
    allocation_usdt: allocation,
    entry_price: number(candidate?.detection_price, null),
    stop_loss_pct: policy.stop_loss_pct,
    take_profit_1_pct: policy.take_profit_1_pct,
    take_profit_2_pct: policy.take_profit_2_pct,
    max_holding_hours: policy.max_holding_hours,
    reasons,
    shadow_only: true,
    real_order: false
  };
}

function evaluatePosition(position, validation, policy) {
  if (!validation) return { action: 'HOLD', reason: 'NO_VALIDATION_AVAILABLE' };
  const favorable = number(validation.max_favorable_move_pct);
  const adverse = number(validation.max_adverse_move_pct);
  const finalVariation = number(validation.variation_pct);
  const hours = number(validation.hours);

  if (adverse <= policy.stop_loss_pct) {
    return { action: 'CLOSE', reason: 'STOP_LOSS', exit_variation_pct: policy.stop_loss_pct };
  }
  if (favorable >= policy.take_profit_2_pct) {
    return { action: 'CLOSE', reason: 'TAKE_PROFIT_2', exit_variation_pct: policy.take_profit_2_pct };
  }
  if (favorable >= policy.take_profit_1_pct && position.partial_taken !== true) {
    return { action: 'PARTIAL', reason: 'TAKE_PROFIT_1', exit_variation_pct: policy.take_profit_1_pct, fraction: 0.5 };
  }
  if (hours >= policy.max_holding_hours) {
    return { action: 'CLOSE', reason: 'TIMEOUT', exit_variation_pct: finalVariation };
  }
  return { action: 'HOLD', reason: 'EXIT_NOT_REACHED' };
}

function calculateTradePnl(notional, variationPct, feeRate, fraction = 1) {
  const grossNotional = number(notional) * number(fraction, 1);
  const grossPnl = grossNotional * (number(variationPct) / 100);
  const fees = grossNotional * feeRate * 2;
  return { gross_notional_usdt: round(grossNotional, 4), gross_pnl_usdt: round(grossPnl, 4), fees_usdt: round(fees, 4), net_pnl_usdt: round(grossPnl - fees, 4) };
}

async function loadPortfolio(db, policy) {
  const ref = db.collection(PORTFOLIO_COLLECTION).doc(PORTFOLIO_ID);
  const doc = await ref.get();
  if (doc.exists) return { ref, ...doc.data() };
  const initial = {
    id: PORTFOLIO_ID,
    mode: 'SHADOW',
    initial_capital_usdt: policy.initial_capital_usdt,
    cash_usdt: policy.initial_capital_usdt,
    realized_pnl_usdt: 0,
    fees_usdt: 0,
    peak_equity_usdt: policy.initial_capital_usdt,
    max_drawdown_pct: 0,
    last_processed_scan_id: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  };
  await ref.set(initial);
  return { ref, ...initial };
}

async function runShadowDecisionCycle(db, options = {}) {
  if (!db) throw new Error('shadow_decision_requires_db');
  const policy = buildPolicy(options);
  const discovery = await getDiscoveryIntelligence(db, { limit: options.limit || 30, refreshLong: options.refreshLong });
  const portfolio = await loadPortfolio(db, policy);
  const openSnapshot = await db.collection(POSITION_COLLECTION).where('status', '==', 'OPEN').get();
  const openPositions = openSnapshot.docs.map((doc) => ({ id: doc.id, ref: doc.ref, ...(doc.data() || {}) }));

  let cash = number(portfolio.cash_usdt, policy.initial_capital_usdt);
  let realizedPnl = number(portfolio.realized_pnl_usdt);
  let feesTotal = number(portfolio.fees_usdt);
  const exits = [];

  for (const position of openPositions) {
    const candidate = discovery.ranking.find((item) => item.symbol === position.symbol);
    const validation = candidate?.validation || null;
    const evaluation = evaluatePosition(position, validation, policy);
    if (evaluation.action === 'HOLD') continue;
    const pnl = calculateTradePnl(position.remaining_notional_usdt, evaluation.exit_variation_pct, policy.fee_rate, evaluation.fraction || 1);
    cash += pnl.gross_notional_usdt + pnl.net_pnl_usdt;
    realizedPnl += pnl.net_pnl_usdt;
    feesTotal += pnl.fees_usdt;
    if (evaluation.action === 'PARTIAL') {
      await position.ref.set({
        partial_taken: true,
        remaining_notional_usdt: round(number(position.remaining_notional_usdt) * 0.5, 4),
        realized_pnl_usdt: round(number(position.realized_pnl_usdt) + pnl.net_pnl_usdt, 4),
        updated_at: new Date().toISOString()
      }, { merge: true });
    } else {
      await position.ref.set({
        status: 'CLOSED',
        close_reason: evaluation.reason,
        exit_variation_pct: evaluation.exit_variation_pct,
        realized_pnl_usdt: round(number(position.realized_pnl_usdt) + pnl.net_pnl_usdt, 4),
        closed_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      }, { merge: true });
    }
    exits.push({ symbol: position.symbol, ...evaluation, ...pnl });
  }

  const stillOpenSnapshot = await db.collection(POSITION_COLLECTION).where('status', '==', 'OPEN').get();
  const stillOpen = stillOpenSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
  const committed = stillOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0);
  let availableOperatingCapital = Math.max(0, Math.min(cash - policy.reserve_capital_usdt, policy.max_operating_capital_usdt - committed));
  const decisions = [];

  if (portfolio.last_processed_scan_id !== discovery.scan?.id) {
    for (const candidate of discovery.ranking) {
      const decision = buildDecision(candidate, { policy, openPositions: stillOpen, availableOperatingCapital });
      decisions.push(decision);
      const decisionId = `${discovery.scan?.id || 'no_scan'}_${candidate.symbol}`;
      await db.collection(DECISION_COLLECTION).doc(decisionId).set({
        ...decision,
        scan_id: discovery.scan?.id || null,
        created_at: new Date().toISOString()
      }, { merge: true });
      if (decision.action !== 'SHADOW_ENTRY') continue;
      const positionId = `${discovery.scan.id}_${decision.symbol}`;
      const entryFee = round(decision.allocation_usdt * policy.fee_rate, 4);
      const invested = round(decision.allocation_usdt - entryFee, 4);
      await db.collection(POSITION_COLLECTION).doc(positionId).set({
        id: positionId,
        scan_id: discovery.scan.id,
        symbol: decision.symbol,
        status: 'OPEN',
        entry_price: decision.entry_price,
        initial_notional_usdt: invested,
        remaining_notional_usdt: invested,
        entry_fee_usdt: entryFee,
        conviction_score: decision.conviction_score,
        risk_score: decision.risk_score,
        partial_taken: false,
        realized_pnl_usdt: 0,
        shadow_only: true,
        opened_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      });
      cash -= decision.allocation_usdt;
      feesTotal += entryFee;
      availableOperatingCapital -= decision.allocation_usdt;
      stillOpen.push({ symbol: decision.symbol, remaining_notional_usdt: invested });
      if (stillOpen.length >= policy.max_positions || availableOperatingCapital < policy.min_position_usdt) break;
    }
  }

  const equity = round(cash + stillOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0), 4);
  const peak = Math.max(number(portfolio.peak_equity_usdt, policy.initial_capital_usdt), equity);
  const drawdown = peak > 0 ? ((equity - peak) / peak) * 100 : 0;
  const maxDrawdown = Math.min(number(portfolio.max_drawdown_pct, 0), drawdown);
  const updatedAt = new Date().toISOString();
  await portfolio.ref.set({
    mode: 'SHADOW',
    cash_usdt: round(cash, 4),
    realized_pnl_usdt: round(realizedPnl, 4),
    fees_usdt: round(feesTotal, 4),
    equity_usdt: equity,
    peak_equity_usdt: round(peak, 4),
    max_drawdown_pct: round(maxDrawdown, 4),
    last_processed_scan_id: discovery.scan?.id || portfolio.last_processed_scan_id || null,
    updated_at: updatedAt,
    policy
  }, { merge: true });

  return {
    mode: 'SHADOW',
    real_orders_enabled: false,
    scan_id: discovery.scan?.id || null,
    policy,
    portfolio: {
      initial_capital_usdt: policy.initial_capital_usdt,
      cash_usdt: round(cash, 4),
      committed_usdt: round(stillOpen.reduce((sum, item) => sum + number(item.remaining_notional_usdt), 0), 4),
      equity_usdt: equity,
      realized_pnl_usdt: round(realizedPnl, 4),
      fees_usdt: round(feesTotal, 4),
      max_drawdown_pct: round(maxDrawdown, 4),
      open_positions: stillOpen.length
    },
    decisions,
    exits
  };
}

async function getShadowPortfolioDiagnostic(db) {
  const policy = buildPolicy();
  const portfolio = await loadPortfolio(db, policy);
  const [openSnapshot, closedSnapshot, decisionSnapshot] = await Promise.all([
    db.collection(POSITION_COLLECTION).where('status', '==', 'OPEN').get(),
    db.collection(POSITION_COLLECTION).where('status', '==', 'CLOSED').get(),
    db.collection(DECISION_COLLECTION).orderBy('created_at', 'desc').limit(50).get()
  ]);
  return {
    mode: 'SHADOW',
    real_orders_enabled: false,
    portfolio: { ...portfolio, ref: undefined },
    open_positions: openSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    closed_positions: closedSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })),
    recent_decisions: decisionSnapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
  };
}

module.exports = {
  PORTFOLIO_COLLECTION,
  POSITION_COLLECTION,
  DECISION_COLLECTION,
  buildPolicy,
  suggestedAllocation,
  buildDecision,
  evaluatePosition,
  calculateTradePnl,
  runShadowDecisionCycle,
  getShadowPortfolioDiagnostic
};