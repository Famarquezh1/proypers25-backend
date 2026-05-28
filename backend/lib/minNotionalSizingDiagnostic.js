const { getBinanceBotConfig } = require('./binanceBotConfig');

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 1));
  const windowMs = sinceExplicit
    ? Math.max(1, until.getTime() - sinceExplicit.getTime())
    : options.days
      ? days * 24 * 60 * 60 * 1000
      : hours * 60 * 60 * 1000;

  return {
    since: sinceExplicit || new Date(until.getTime() - windowMs),
    until
  };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function resolveSourceProfile(row = {}) {
  return String(
    row.source_profile ||
    row.intent?.source_profile ||
    row.signal?.source_profile ||
    row.source ||
    ''
  ).trim().toLowerCase() || 'default';
}

function resolveSymbol(row = {}) {
  return String(row.intent?.symbol || row.symbol || '').toUpperCase() || null;
}

function resolveSide(row = {}) {
  return String(row.intent?.side || row.side || '').toUpperCase() || null;
}

function resolveExecutionScore(row = {}) {
  return (
    toNumber(row.execution_score, null) ??
    toNumber(row.intent?.execution_score, null) ??
    toNumber(row.execution_guard?.execution_score, null) ??
    null
  );
}

function resolveExpectedMove(row = {}) {
  return (
    toNumber(row.intent?.expected_move_percent, null) ??
    toNumber(row.expected_move_percent, null) ??
    toNumber(row.intent?.expected_delta_pct, null) ??
    toNumber(row.expected_delta_pct, null) ??
    null
  );
}

function resolveEntryPrice(row = {}) {
  return (
    toNumber(row.intent?.entry_price, null) ??
    toNumber(row.entry_price, null) ??
    null
  );
}

function resolveStopLoss(row = {}) {
  return (
    toNumber(row.intent?.stop_loss, null) ??
    toNumber(row.stop_loss, null) ??
    null
  );
}

function resolveStopLossDistancePct(row = {}) {
  const entryPrice = resolveEntryPrice(row);
  const stopLoss = resolveStopLoss(row);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(stopLoss) || stopLoss <= 0) {
    return null;
  }
  return Math.abs((entryPrice - stopLoss) / entryPrice) * 100;
}

function isMinNotionalFailed(row = {}) {
  const message = String(
    row.reason ||
    row.fail_reason ||
    row.final_reason ||
    row.last_error_message ||
    row.error_message ||
    row.live_order_diagnostics?.last_error_message ||
    ''
  ).toLowerCase();
  return message.includes('min_notional');
}

function getMinNotionalSnapshot(row = {}) {
  const snapshot = row.live_order_diagnostics?.min_notional_snapshot;
  return snapshot && typeof snapshot === 'object' ? snapshot : null;
}

function selectEffectiveConfig(botConfig = {}, sourceProfile = 'default') {
  if (sourceProfile && botConfig.execution_profiles && botConfig.execution_profiles[sourceProfile]) {
    return {
      ...botConfig,
      ...botConfig.execution_profiles[sourceProfile],
      _config_source: `${String(botConfig._config_source || 'binance_bot_config/defaults')}/execution_profiles/${sourceProfile}`
    };
  }
  return botConfig;
}

function uniqueValues(values = []) {
  return Array.from(new Set(values.filter((value) => value !== null && value !== undefined && value !== '')));
}

function singleOrArray(values = []) {
  const unique = uniqueValues(values);
  if (!unique.length) return null;
  return unique.length === 1 ? unique[0] : unique;
}

function buildSample(row = {}, snapshot = {}, effectiveConfig = {}) {
  const markPrice = toNumber(snapshot.mark_price, null);
  const calculatedQty = toNumber(snapshot.calculated_qty ?? snapshot.quantity, null);
  const requiredQty = toNumber(snapshot.required_qty, null);
  const notional = toNumber(snapshot.notional, null);
  const minNotionalRequired = toNumber(snapshot.min_notional_required, null);
  const capitalAllocated = toNumber(snapshot.capital_allocated, null);
  const leverage = toNumber(snapshot.leverage ?? row.intent?.leverage, null);
  const riskPercentRatio = toNumber(snapshot.risk_percent ?? row.intent?.position_size_percent, null);
  const riskPercentUsed = Number.isFinite(riskPercentRatio) ? riskPercentRatio * 100 : null;
  const additionalNotionalNeeded = Number.isFinite(minNotionalRequired) && Number.isFinite(notional)
    ? Math.max(0, minNotionalRequired - notional)
    : null;
  const requiredCapitalCurrentFormula = Number.isFinite(minNotionalRequired) ? minNotionalRequired : null;
  const requiredLeverageToMeetMinNotional = Number.isFinite(minNotionalRequired) && Number.isFinite(capitalAllocated) && capitalAllocated > 0
    ? minNotionalRequired / capitalAllocated
    : null;
  const capitalAvailable = Number(effectiveConfig.account_capital_usdt || 0) || null;
  const requiredRiskPercentToMeetMinNotional = Number.isFinite(requiredCapitalCurrentFormula) && Number.isFinite(capitalAvailable) && capitalAvailable > 0
    ? (requiredCapitalCurrentFormula / capitalAvailable) * 100
    : null;
  const wouldPassIfRoundedUp = Number.isFinite(requiredQty) &&
    Number.isFinite(markPrice) &&
    Number.isFinite(minNotionalRequired)
      ? requiredQty * markPrice + 1e-9 >= minNotionalRequired
      : null;

  return {
    intent_id: row.id,
    symbol: resolveSymbol(row),
    side: resolveSide(row),
    mark_price: round(markPrice, 8),
    calculated_qty: round(calculatedQty, 8),
    required_qty: round(requiredQty, 8),
    notional: round(notional, 8),
    min_notional_required: round(minNotionalRequired, 8),
    shortfall_pct: round(snapshot.shortfall_pct, 4),
    capital_allocated: round(capitalAllocated, 8),
    leverage: round(leverage, 8),
    risk_percent: round(riskPercentUsed, 4),
    stop_loss_distance_pct: round(resolveStopLossDistancePct(row), 6),
    expected_move: round(resolveExpectedMove(row), 6),
    execution_score: round(resolveExecutionScore(row), 6),
    simulations: {
      required_capital_to_meet_min_notional: round(requiredCapitalCurrentFormula, 8),
      required_leverage_to_meet_min_notional: round(requiredLeverageToMeetMinNotional, 8),
      required_risk_percent_to_meet_min_notional: round(requiredRiskPercentToMeetMinNotional, 4),
      would_pass_min_notional_if_qty_rounded_up: wouldPassIfRoundedUp,
      additional_notional_needed: round(additionalNotionalNeeded, 8)
    }
  };
}

function buildDiagnosis(report = {}) {
  const total = Number(report.total_min_notional_failed || 0);
  const floorApplicableCount = Number(report.min_notional_floor_applicable_count || 0);
  const floorBlockedCount = Number(report.min_notional_floor_blocked_count || 0);
  if (!total) return 'mixed';

  const avgCalculatedQty = Number(report.avg_calculated_qty || 0);
  const avgRequiredQty = Number(report.avg_required_qty || 0);
  const avgCapitalAllocated = Number(report.capital_allocated_per_trade || 0);
  const avgMinNotional = Number(report.avg_min_notional_required || 0);
  const avgLeverage = Number(report.leverage_used || 0);
  const avgRequiredLeverage = Number(report.simulations?.required_leverage_to_meet_min_notional || 0);
  const avgRiskUsed = Number(report.risk_percent_used || 0);
  const avgRequiredRisk = Number(report.simulations?.required_risk_percent_to_meet_min_notional || 0);
  const avgMarkPrice = Number(report.avg_mark_price || 0);
  const roundingGapRatio = avgCalculatedQty > 0 ? avgRequiredQty / avgCalculatedQty : 0;

  if (roundingGapRatio > 1 && roundingGapRatio <= 1.05) {
    return 'quantity_rounding_issue';
  }
  if (floorApplicableCount > 0 && floorBlockedCount === 0) {
    return 'capital_allocation_too_low';
  }
  if (avgCapitalAllocated > 0 && avgMinNotional > avgCapitalAllocated * 1.1) {
    return 'capital_allocation_too_low';
  }
  if (avgRequiredRisk > 0 && avgRiskUsed > 0 && avgRequiredRisk > avgRiskUsed * 1.15) {
    return 'risk_percent_too_low';
  }
  if (avgRequiredLeverage > 0 && avgLeverage > 0 && avgRequiredLeverage > avgLeverage * 1.05) {
    return 'leverage_too_low_for_min_notional';
  }
  if (avgMarkPrice >= 100 && roundingGapRatio >= 2) {
    return 'symbol_price_too_high';
  }
  return 'mixed';
}

async function getMinNotionalSizingDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);
  const scopedRows = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });
  const minNotionalRows = scopedRows.filter((row) => isMinNotionalFailed(row) && getMinNotionalSnapshot(row));
  const sourceProfile = singleOrArray(minNotionalRows.map(resolveSourceProfile));
  const botConfig = await getBinanceBotConfig(db);
  const effectiveConfig = typeof sourceProfile === 'string'
    ? selectEffectiveConfig(botConfig, sourceProfile)
    : botConfig;
  const samples = minNotionalRows.map((row) => buildSample(row, getMinNotionalSnapshot(row), effectiveConfig));
  const floorPolicies = minNotionalRows.map((row) => {
    const snapshot = getMinNotionalSnapshot(row) || {};
    const markPrice = Number(snapshot.mark_price || 0) || 0;
    const entryPrice = resolveEntryPrice(row);
    const stopLoss = resolveStopLoss(row);
    const side = resolveSide(row);
    const stopLossValid =
      ['BUY', 'SELL'].includes(side) &&
      Number.isFinite(entryPrice) &&
      entryPrice > 0 &&
      Number.isFinite(stopLoss) &&
      stopLoss > 0 &&
      ((side === 'BUY' && stopLoss < entryPrice) || (side === 'SELL' && stopLoss > entryPrice));
    const stopLossDistanceUsdt = stopLossValid ? Math.abs(entryPrice - stopLoss) : 0;
    const requiredQty = Number(snapshot.required_qty || 0) || 0;
    const leverage = Number(snapshot.leverage || row.intent?.leverage || 0) || 0;
    const capitalAllocated = Number(snapshot.capital_allocated || row.intent?.notional_usdt || 0) || 0;
    const accountCapital = Number(effectiveConfig.account_capital_usdt || 0) || 0;
    const riskPercentRatio = Number(snapshot.risk_percent || row.intent?.position_size_percent || effectiveConfig.position_size_percent || 0) || 0;
    const requiredNotional = Number(snapshot.required_notional || 0) || (requiredQty > 0 && markPrice > 0 ? requiredQty * markPrice : 0);
    const requiredMargin = requiredNotional > 0 && leverage > 0 ? requiredNotional / leverage : 0;
    const riskAfter = requiredQty > 0 && stopLossDistanceUsdt > 0 ? requiredQty * stopLossDistanceUsdt : 0;
    const maxAllowedRisk = accountCapital > 0 && riskPercentRatio > 0 ? accountCapital * riskPercentRatio : 0;
    const adjustmentSafe =
      stopLossValid &&
      String(row.intent?.margin_type || row.intent?.requested_margin_type || '').toUpperCase() === 'ISOLATED' &&
      leverage > 0 &&
      leverage <= 3 &&
      Number(effectiveConfig.max_concurrent_trades || 0) === 1 &&
      requiredMargin > 0 &&
      capitalAllocated > 0 &&
      requiredMargin <= capitalAllocated + 1e-9 &&
      riskAfter > 0 &&
      maxAllowedRisk > 0 &&
      riskAfter <= maxAllowedRisk + 1e-9;
    return {
      symbol: resolveSymbol(row),
      adjustment_safe: adjustmentSafe,
      blocked: !adjustmentSafe,
      required_margin: requiredMargin,
      risk_after: riskAfter,
      max_allowed_risk: maxAllowedRisk
    };
  });
  const symbolsAffected = uniqueValues(samples.map((sample) => sample.symbol)).sort();
  const symbolsFloorApplicable = uniqueValues(floorPolicies.filter((item) => item.adjustment_safe).map((item) => item.symbol)).sort();
  const symbolsFloorBlocked = uniqueValues(floorPolicies.filter((item) => item.blocked).map((item) => item.symbol)).sort();
  const marginTypes = singleOrArray(uniqueValues(
    minNotionalRows.map((row) => String(row.intent?.margin_type || row.intent?.requested_margin_type || '').toUpperCase() || null)
  ));
  const leverages = uniqueValues(samples.map((sample) => sample.leverage));

  const report = {
    total_min_notional_failed: minNotionalRows.length,
    symbols_affected: symbolsAffected,
    avg_notional: round(average(samples.map((sample) => sample.notional)), 8),
    avg_min_notional_required: round(average(samples.map((sample) => sample.min_notional_required)), 8),
    avg_shortfall_pct: round(average(samples.map((sample) => sample.shortfall_pct)), 4),
    avg_required_qty: round(average(samples.map((sample) => sample.required_qty)), 8),
    avg_calculated_qty: round(average(samples.map((sample) => sample.calculated_qty)), 8),
    avg_mark_price: round(average(samples.map((sample) => sample.mark_price)), 8),
    capital_available: round(toNumber(effectiveConfig.account_capital_usdt, null), 8),
    capital_allocated_per_trade: round(average(samples.map((sample) => sample.capital_allocated)), 8),
    risk_percent_used: round(average(samples.map((sample) => sample.risk_percent)), 4),
    leverage_used: leverages.length === 1 ? leverages[0] : round(average(leverages), 8),
    margin_type: marginTypes,
    max_concurrent_trades: Number(effectiveConfig.max_concurrent_trades || 0) || null,
    sizing_formula_used:
      'current_qty = intent.notional_usdt / entry_price; live_order min_notional precheck uses notional = calculated_qty * mark_price; required_qty = ceil(min_notional_required / mark_price, step_size)',
    min_notional_floor_applicable_count: floorPolicies.filter((item) => item.adjustment_safe).length,
    min_notional_floor_blocked_count: floorPolicies.filter((item) => item.blocked).length,
    avg_required_margin: round(average(floorPolicies.map((item) => item.required_margin)), 8),
    avg_risk_after_floor: round(average(floorPolicies.map((item) => item.risk_after)), 8),
    avg_max_allowed_risk: round(average(floorPolicies.map((item) => item.max_allowed_risk)), 8),
    symbols_floor_applicable: symbolsFloorApplicable,
    symbols_floor_blocked: symbolsFloorBlocked,
    simulations: {
      required_capital_to_meet_min_notional: round(average(samples.map((sample) => sample.simulations.required_capital_to_meet_min_notional)), 8),
      required_leverage_to_meet_min_notional: round(average(samples.map((sample) => sample.simulations.required_leverage_to_meet_min_notional)), 8),
      required_risk_percent_to_meet_min_notional: round(average(samples.map((sample) => sample.simulations.required_risk_percent_to_meet_min_notional)), 4),
      would_pass_min_notional_if_qty_rounded_up: samples.length ? samples.every((sample) => sample.simulations.would_pass_min_notional_if_qty_rounded_up === true) : null,
      additional_notional_needed: round(average(samples.map((sample) => sample.simulations.additional_notional_needed)), 8)
    },
    source_profile: sourceProfile,
    config_source: String(effectiveConfig?._config_source || botConfig?._config_source || 'binance_bot_config/defaults'),
    samples
  };

  return {
    ...report,
    diagnosis: buildDiagnosis(report)
  };
}

module.exports = {
  getMinNotionalSizingDiagnostic
};
