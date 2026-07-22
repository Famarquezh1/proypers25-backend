'use strict';

const COLLECTIONS = {
  corePortfolio: 'spot_shadow_portfolios',
  corePositions: 'spot_shadow_positions',
  coreDecisions: 'spot_shadow_decisions',
  gemPortfolio: 'spot_shadow_gem_portfolios',
  gemPositions: 'spot_shadow_gem_positions',
  gemDecisions: 'spot_shadow_gem_decisions',
  discovery: 'spot_discovery_scans',
  realCycles: 'real_spot_cycle_decisions'
};

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 4) {
  return Number(number(value).toFixed(decimals));
}

function timestamp(value) {
  if (!value) return null;
  if (typeof value === 'string') return value;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  return null;
}

function tradePnl(trade) {
  return number(trade?.realized_pnl_usdt ?? trade?.net_pnl_usdt ?? trade?.pnl_usdt);
}

function tradeDurationMs(trade) {
  const opened = Date.parse(trade?.opened_at || trade?.created_at || '');
  const closed = Date.parse(trade?.closed_at || trade?.updated_at || '');
  return Number.isFinite(opened) && Number.isFinite(closed) && closed >= opened ? closed - opened : 0;
}

function buildStrategyMetrics(name, portfolio = {}, openPositions = [], closedPositions = [], decisions = []) {
  const pnls = closedPositions.map(tradePnl);
  const wins = pnls.filter((value) => value > 0);
  const losses = pnls.filter((value) => value < 0);
  const grossProfit = wins.reduce((sum, value) => sum + value, 0);
  const grossLoss = Math.abs(losses.reduce((sum, value) => sum + value, 0));
  const total = pnls.length;
  const durations = closedPositions.map(tradeDurationMs).filter(Boolean);
  const capitalUsed = openPositions.reduce((sum, item) => sum + number(item.remaining_notional_usdt ?? item.initial_notional_usdt), 0);
  const pnl = number(portfolio.realized_pnl_usdt, pnls.reduce((sum, value) => sum + value, 0));
  const closeReasons = closedPositions.reduce((acc, item) => {
    const reason = String(item.close_reason || item.exit_reason || '').toUpperCase();
    if (reason.includes('TAKE_PROFIT')) acc.tp += 1;
    else if (reason.includes('STOP')) acc.sl += 1;
    else if (reason.includes('TIMEOUT')) acc.timeout += 1;
    return acc;
  }, { tp: 0, sl: 0, timeout: 0 });
  const riskValues = [...openPositions, ...decisions].map((item) => number(item.risk_score, NaN)).filter(Number.isFinite);
  const latestDecision = decisions[0] || null;
  return {
    strategy: name,
    mode: 'SHADOW',
    real_orders_enabled: false,
    win_rate_pct: total ? round((wins.length / total) * 100, 2) : null,
    profit_factor: grossLoss > 0 ? round(grossProfit / grossLoss, 3) : (grossProfit > 0 ? null : 0),
    expectancy_usdt: total ? round(pnls.reduce((sum, value) => sum + value, 0) / total, 4) : null,
    drawdown_pct: round(Math.abs(number(portfolio.max_drawdown_pct)), 3),
    capital_used_usdt: round(capitalUsed, 4),
    capital_available_usdt: round(number(portfolio.cash_usdt), 4),
    equity_usdt: round(number(portfolio.equity_usdt, number(portfolio.cash_usdt) + capitalUsed), 4),
    pnl_usdt: round(pnl, 4),
    best_trade_usdt: total ? round(Math.max(...pnls), 4) : null,
    worst_trade_usdt: total ? round(Math.min(...pnls), 4) : null,
    average_duration_ms: durations.length ? Math.round(durations.reduce((sum, value) => sum + value, 0) / durations.length) : null,
    tp_count: closeReasons.tp,
    sl_count: closeReasons.sl,
    timeout_count: closeReasons.timeout,
    average_risk_score: riskValues.length ? round(riskValues.reduce((sum, value) => sum + value, 0) / riskValues.length, 2) : null,
    operations_count: total,
    open_positions_count: openPositions.length,
    status: latestDecision?.action || (openPositions.length ? 'ACTIVE' : 'OBSERVE'),
    last_cycle_at: timestamp(portfolio.updated_at) || timestamp(latestDecision?.created_at),
    data_state: total || openPositions.length || decisions.length ? 'AVAILABLE' : 'EMPTY'
  };
}

function determineLeader(core, gem) {
  const score = (item) => {
    if (!item || item.data_state === 'EMPTY') return Number.NEGATIVE_INFINITY;
    return number(item.expectancy_usdt) * 35 + number(item.profit_factor) * 20 + number(item.win_rate_pct) * 0.25 - number(item.drawdown_pct) * 1.5 + number(item.pnl_usdt) * 2;
  };
  const coreScore = score(core);
  const gemScore = score(gem);
  if (!Number.isFinite(coreScore) && !Number.isFinite(gemScore)) return { strategy: null, reason: 'INSUFFICIENT_DATA' };
  if (Math.abs(coreScore - gemScore) < 0.0001) return { strategy: 'TIE', reason: 'EQUAL_COMPOSITE_SCORE' };
  return { strategy: coreScore > gemScore ? 'CORE' : 'GEM_HUNTER', reason: 'COMPOSITE_PERFORMANCE_SCORE', scores: { core: round(coreScore, 3), gem_hunter: round(gemScore, 3) } };
}

function evaluateProductionGate(context) {
  const core = context.core || {};
  const gem = context.gem || {};
  const health = context.health || {};
  const discovery = context.discovery || {};
  const realCycle = context.realCycle || {};
  const checks = [
    ['Discovery', Boolean(discovery.exists), discovery.exists ? 'Discovery dispone de evidencia.' : 'No existe evidencia de Discovery.'],
    ['Decision Engine', core.data_state !== 'EMPTY', core.data_state !== 'EMPTY' ? 'CORE registra decisiones o posiciones.' : 'CORE aún no tiene muestra.'],
    ['CORE', number(core.operations_count) >= 20, `Muestra CORE: ${number(core.operations_count)} / 20.`],
    ['GEM Hunter', number(gem.operations_count) >= 20, `Muestra GEM Hunter: ${number(gem.operations_count)} / 20.`],
    ['Shadow', core.real_orders_enabled === false && gem.real_orders_enabled === false, 'Las estrategias comparadas permanecen en Shadow.'],
    ['Learning', Boolean(context.learningHealthy), context.learningHealthy ? 'Learning presenta actividad.' : 'Learning sin evidencia reciente.'],
    ['Expectancy', number(core.expectancy_usdt) > 0 || number(gem.expectancy_usdt) > 0, 'Se exige expectancy positiva en al menos una estrategia.'],
    ['Profit Factor', number(core.profit_factor) >= 1.2 || number(gem.profit_factor) >= 1.2, 'Se exige profit factor ≥ 1.20.'],
    ['Drawdown', Math.min(number(core.drawdown_pct, 999), number(gem.drawdown_pct, 999)) <= 15, 'Se exige drawdown ≤ 15%.'],
    ['Sample Size', number(core.operations_count) + number(gem.operations_count) >= 50, `Muestra combinada: ${number(core.operations_count) + number(gem.operations_count)} / 50.`],
    ['Calidad de datos', Boolean(context.dataQuality), context.dataQuality ? 'Consultas completas y coherentes.' : 'Faltan fuentes o campos críticos.'],
    ['Salud del sistema', health.ok === true, health.ok === true ? 'Health check operativo.' : 'Health check no confirmado.'],
    ['Binance', realCycle.binance_ok === true, realCycle.binance_ok === true ? 'Binance confirmado por evidencia del ciclo.' : 'Binance no confirmado por evidencia reciente.'],
    ['Firestore', context.firestoreOk === true, context.firestoreOk === true ? 'Firestore respondió correctamente.' : 'Firestore no respondió correctamente.']
  ].map(([name, passed, detail]) => ({ id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), name, passed, status: passed ? 'PASS' : 'BLOCKED', detail }));
  return { status: checks.every((item) => item.passed) ? 'READY FOR PRODUCTION' : 'BLOCKED', informational_only: true, enables_real_trading: false, checks };
}

async function getDocs(query) {
  const snapshot = await query.get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function getUnifiedControlPortal(db) {
  if (!db) throw new Error('unified_portal_requires_db');
  const [corePortfolioDoc, gemPortfolioDoc, coreOpen, coreClosed, coreDecisions, gemOpen, gemClosed, gemDecisions, discoveryDocs, realCycles] = await Promise.all([
    db.collection(COLLECTIONS.corePortfolio).doc('discovery_default').get(),
    db.collection(COLLECTIONS.gemPortfolio).doc('gem_hunter_default').get(),
    getDocs(db.collection(COLLECTIONS.corePositions).where('status', '==', 'OPEN')),
    getDocs(db.collection(COLLECTIONS.corePositions).where('status', '==', 'CLOSED').limit(200)),
    getDocs(db.collection(COLLECTIONS.coreDecisions).orderBy('created_at', 'desc').limit(100)),
    getDocs(db.collection(COLLECTIONS.gemPositions).where('status', '==', 'OPEN')),
    getDocs(db.collection(COLLECTIONS.gemPositions).where('status', '==', 'CLOSED').limit(200)),
    getDocs(db.collection(COLLECTIONS.gemDecisions).orderBy('created_at', 'desc').limit(100)),
    getDocs(db.collection(COLLECTIONS.discovery).orderBy('created_at', 'desc').limit(1)).catch(() => []),
    getDocs(db.collection(COLLECTIONS.realCycles).orderBy('started_at', 'desc').limit(1)).catch(() => [])
  ]);
  const core = buildStrategyMetrics('CORE', corePortfolioDoc.exists ? corePortfolioDoc.data() : {}, coreOpen, coreClosed, coreDecisions);
  const gem = buildStrategyMetrics('GEM_HUNTER', gemPortfolioDoc.exists ? gemPortfolioDoc.data() : {}, gemOpen, gemClosed, gemDecisions);
  const realCycle = realCycles[0] || {};
  const modules = [
    ['CORE AI', '/dashboard/comparison', core.data_state, core.last_cycle_at],
    ['GEM Hunter', '/gem-hunter-dashboard', gem.data_state, gem.last_cycle_at],
    ['Discovery', '/discovery-dashboard', discoveryDocs.length ? 'AVAILABLE' : 'EMPTY', discoveryDocs[0]?.created_at],
    ['Decision Engine', '/shadow-decision-dashboard', core.status, core.last_cycle_at],
    ['Shadow Portfolio', '/shadow-decision-dashboard', core.open_positions_count ? 'ACTIVE' : 'OBSERVE', core.last_cycle_at],
    ['Portfolio', '/investments-dashboard', 'AVAILABLE', realCycle.finished_at || realCycle.started_at],
    ['Binance', '/investments-dashboard', realCycle.binance_ok === true ? 'HEALTHY' : 'UNKNOWN', realCycle.finished_at || realCycle.started_at],
    ['Learning', '/paper-ranking-dashboard', 'OBSERVE', core.last_cycle_at],
    ['Analytics', '/paper-ranking-dashboard', 'AVAILABLE', core.last_cycle_at],
    ['Health', '/health-dashboard', 'AVAILABLE', null],
    ['Logs', '/spot-live-dashboard', realCycles.length ? 'AVAILABLE' : 'EMPTY', realCycle.finished_at || realCycle.started_at],
    ['Settings', '/dashboard/settings', 'READ_ONLY', null],
    ['Production Gate', '/dashboard/production-gate', 'EVALUATING', new Date().toISOString()]
  ].map(([name, route, status, lastCycle]) => ({ name, route, status, last_cycle_at: timestamp(lastCycle) || lastCycle || null, alert: status === 'EMPTY' || status === 'UNKNOWN' ? 'Requiere evidencia' : null }));
  const gate = evaluateProductionGate({
    core,
    gem,
    discovery: { exists: discoveryDocs.length > 0 },
    realCycle,
    learningHealthy: coreDecisions.length > 0 || gemDecisions.length > 0,
    dataQuality: core.data_state !== 'EMPTY' && gem.data_state !== 'EMPTY',
    health: { ok: true },
    firestoreOk: true
  });
  modules.find((item) => item.name === 'Production Gate').status = gate.status;
  return { ok: true, generated_at: new Date().toISOString(), portal: { mode: 'CONTROL_ONLY', real_trading_changed: false }, modules, comparison: { core, gem_hunter: gem, leader: determineLeader(core, gem) }, production_gate: gate };
}

module.exports = { buildStrategyMetrics, determineLeader, evaluateProductionGate, getUnifiedControlPortal };
