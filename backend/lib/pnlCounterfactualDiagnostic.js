const { resolveTradeCostConfig } = require('../services/execution/tradeCostModel');
const { fetchCandles } = require('../services/dataSources/fetchCandles');

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 4) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

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

function pickNumber(...values) {
  for (const value of values) {
    const parsed = toNumber(value, null);
    if (parsed !== null) return parsed;
  }
  return null;
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function sum(values = []) {
  return values
    .map((value) => Number(value))
    .filter(Number.isFinite)
    .reduce((acc, value) => acc + value, 0);
}

function normalizeSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'unknown';
}

function normalizeSymbol(value) {
  return String(value || '').trim().toUpperCase() || null;
}

function getWindowBounds(options = {}) {
  const now = Date.now();
  const until = parseDateLike(options.until) || new Date(now);
  const sinceExplicit = parseDateLike(options.since);
  const hours = Math.max(1, Number(options.hours || 0));
  const days = Math.max(1, Number(options.days || 0));
  const fallbackWindowMs = options.hours
    ? hours * 60 * 60 * 1000
    : days * 24 * 60 * 60 * 1000;
  const since = sinceExplicit || new Date(until.getTime() - fallbackWindowMs);
  return { since, until };
}

async function loadRecentCollectionRows(db, collectionName, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy('updated_at', 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function buildIntentIndex(intentRows = []) {
  const index = new Map();
  for (const row of intentRows) {
    const sourceProfile = normalizeSource(row.source_profile || row.source);
    const keys = [
      row.linked_position_id,
      row.prediction_id ? `${row.prediction_id}::${sourceProfile}` : null,
      row.prediction_id || null
    ].filter(Boolean);
    for (const key of keys) {
      if (!index.has(key)) {
        index.set(key, row);
      }
    }
  }
  return index;
}

function resolveTradeFees(position = {}, intent = {}, defaultCostConfig = resolveTradeCostConfig()) {
  const feeRoundtripPct = pickNumber(
    position.actual_fee_roundtrip_pct,
    position.fee_roundtrip_pct,
    position.estimated_fee_roundtrip_pct,
    position.trade_cost_model?.roundtrip_fee_pct,
    intent.actual_fee_roundtrip_pct,
    intent.fee_roundtrip_pct,
    intent.estimated_fee_roundtrip_pct,
    intent.execution_audit?.fee_roundtrip_pct,
    intent.execution_audit?.estimated_fee_roundtrip_pct,
    intent.execution_audit?.trade_cost_model?.roundtrip_fee_pct,
    defaultCostConfig.roundtrip_fee_pct
  );

  const feeTotalUsdt = pickNumber(
    position.fees_total_usdt,
    position.total_fee_usdt,
    position.fee_usdt,
    position.execution_audit?.fees_total_usdt,
    intent.fees_total_usdt,
    intent.total_fee_usdt,
    intent.execution_audit?.fees_total_usdt
  );

  return {
    fee_roundtrip_pct: round(feeRoundtripPct),
    fee_total_usdt: round(feeTotalUsdt, 8)
  };
}

function resolveDirectionalMovePct(side, fromPrice, toPrice) {
  const from = toNumber(fromPrice, null);
  const to = toNumber(toPrice, null);
  if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
  const normalizedSide = String(side || '').toUpperCase();
  if (normalizedSide === 'SELL') {
    return ((from - to) / from) * 100;
  }
  return ((to - from) / from) * 100;
}

function resolveMoveLostBeforeEntryPct(side, signalPrice, entryPrice) {
  const movePct = resolveDirectionalMovePct(side, signalPrice, entryPrice);
  if (!Number.isFinite(movePct)) return null;
  return Math.max(0, movePct);
}

function resolveTradeDurationMs(position = {}) {
  const openedAt = parseDateLike(position.opened_at);
  const closedAt = parseDateLike(position.closed_at);
  if (!openedAt || !closedAt) return null;
  return Math.max(0, closedAt.getTime() - openedAt.getTime());
}

function resolveExecutionDelayMs(position = {}, intent = {}) {
  const trace = position.execution_trace || intent.execution_trace || {};
  const signalAt = pickNumber(
    trace.signal_emitted_at,
    trace.signal_created_at
  );
  const entryAt = pickNumber(
    trace.order_ack_at,
    trace.order_sent_at,
    trace.execution_attempt_at
  );
  if (!Number.isFinite(signalAt) || !Number.isFinite(entryAt)) {
    const signalDate =
      parseDateLike(position.execution_audit?.signal_at) ||
      parseDateLike(intent.execution_audit?.signal_at) ||
      parseDateLike(position.entry_execution_snapshot?.signal_timestamp) ||
      parseDateLike(intent.entry_execution_snapshot?.signal_timestamp);
    const executionDate =
      parseDateLike(position.execution_audit?.executed_at) ||
      parseDateLike(intent.execution_audit?.executed_at) ||
      parseDateLike(position.opened_at);
    if (!signalDate || !executionDate) return null;
    return Math.max(0, executionDate.getTime() - signalDate.getTime());
  }
  return Math.max(0, entryAt - signalAt);
}

function resolveTradeRecord(position = {}, intent = {}, defaultCostConfig = resolveTradeCostConfig()) {
  const closedAt = parseDateLike(position.closed_at);
  if (!closedAt) return null;

  const grossPnlPct = pickNumber(position.close_pnl_pct, position.gross_close_pnl_pct);
  if (grossPnlPct === null) return null;

  const side = String(position.side || intent.side || intent.intent?.side || '').toUpperCase() || null;
  const entryPrice = pickNumber(position.entry_price, intent.entry_price, intent.intent?.entry_price);
  const signalPrice = pickNumber(
    position.entry_execution_snapshot?.signal_price,
    position.signal_entry_price,
    intent.entry_execution_snapshot?.signal_price,
    intent.intent?.entry_price
  );
  const closePrice = pickNumber(position.close_price, position.exit_price);
  const expectedMovePct = pickNumber(
    position.expected_move_percent,
    intent.expected_move_percent,
    intent.intent?.expected_move_percent,
    intent.trade_plan?.expected_move_percent
  );
  const fees = resolveTradeFees(position, intent, defaultCostConfig);
  const netPnlPct = grossPnlPct - (fees.fee_roundtrip_pct || 0);
  const entryDelayMs = resolveExecutionDelayMs(position, intent);
  const moveLostBeforeEntryPct = resolveMoveLostBeforeEntryPct(side, signalPrice, entryPrice);

  return {
    trade_id: position.id || null,
    linked_intent_id: intent.id || null,
    prediction_id: position.prediction_id || intent.prediction_id || null,
    symbol: normalizeSymbol(position.symbol || intent.symbol || intent.intent?.symbol),
    source_profile: normalizeSource(position.source_profile || position.source || intent.source_profile || intent.source),
    side,
    close_reason: position.close_reason || null,
    opened_at: parseDateLike(position.opened_at)?.toISOString() || null,
    closed_at: closedAt.toISOString(),
    duration_ms: resolveTradeDurationMs(position),
    entry_price: round(entryPrice, 8),
    price_at_signal: round(signalPrice, 8),
    price_at_entry: round(entryPrice, 8),
    close_price: round(closePrice, 8),
    expected_move_pct: round(expectedMovePct, 6),
    gross_pnl_pct: round(grossPnlPct, 6),
    fee_roundtrip_pct: round(fees.fee_roundtrip_pct, 6),
    net_pnl_pct: round(netPnlPct, 6),
    entry_delay_ms: entryDelayMs,
    avg_signal_to_entry_ms: entryDelayMs,
    move_lost_before_entry_pct: round(moveLostBeforeEntryPct, 6),
    break_even_pass: netPnlPct > 0
  };
}

function summarizeTradeSet(trades = []) {
  const totalTrades = trades.length;
  const grossPnls = trades.map((trade) => trade.gross_pnl_pct);
  const netPnls = trades.map((trade) => trade.net_pnl_pct);
  const feePnls = trades.map((trade) => trade.fee_roundtrip_pct);
  const grossWins = trades.filter((trade) => Number(trade.gross_pnl_pct) > 0).length;
  const netWins = trades.filter((trade) => Number(trade.net_pnl_pct) > 0).length;
  return {
    trades_kept: totalTrades,
    pnl_bruto_simulado: round(sum(grossPnls), 6),
    fees_simuladas: round(sum(feePnls), 6),
    pnl_neto_simulado: round(sum(netPnls), 6),
    win_rate_bruto_simulado: totalTrades ? round((grossWins / totalTrades) * 100, 2) : 0,
    win_rate_neto_simulado: totalTrades ? round((netWins / totalTrades) * 100, 2) : 0
  };
}

function buildScenarioResult(name, label, keptTrades = [], filteredTrades = [], extra = {}) {
  const summary = summarizeTradeSet(keptTrades);
  return {
    scenario: name,
    label,
    trades_kept: summary.trades_kept,
    trades_filtered: filteredTrades.length,
    filtered_trade_ids: filteredTrades.map((trade) => trade.trade_id),
    pnl_bruto_simulado: summary.pnl_bruto_simulado,
    fees_simuladas: summary.fees_simuladas,
    pnl_neto_simulado: summary.pnl_neto_simulado,
    win_rate_bruto_simulado: summary.win_rate_bruto_simulado,
    win_rate_neto_simulado: summary.win_rate_neto_simulado,
    avg_entry_delay_kept: round(average(keptTrades.map((trade) => trade.entry_delay_ms)), 2),
    avg_entry_delay_filtered: round(average(filteredTrades.map((trade) => trade.entry_delay_ms)), 2),
    ...extra
  };
}

function selectBestScenario(scenarios = []) {
  const valid = scenarios.filter((scenario) => {
    const pnl = Number(scenario?.pnl_neto_simulado);
    const kept = Number(scenario?.trades_kept || 0);
    return Number.isFinite(pnl) && kept > 0;
  });
  if (!valid.length) return null;
  return valid.sort((a, b) => {
    const pnlDiff = Number(b.pnl_neto_simulado) - Number(a.pnl_neto_simulado);
    if (Math.abs(pnlDiff) > 0.000001) return pnlDiff;
    const keptDiff = Number(b.trades_kept || 0) - Number(a.trades_kept || 0);
    if (keptDiff !== 0) return keptDiff;
    return Number(a.trades_filtered || 0) - Number(b.trades_filtered || 0);
  })[0];
}

function buildExpectedMoveScenarios(trades = []) {
  const staticThresholds = [
    { name: 'expected_move_gte_0_15', label: 'expected_move >= 0.15%', threshold: 0.15 },
    { name: 'expected_move_gte_0_20', label: 'expected_move >= 0.20%', threshold: 0.2 },
    { name: 'expected_move_gte_0_25', label: 'expected_move >= 0.25%', threshold: 0.25 }
  ];
  const dynamicThresholds = [
    {
      name: 'expected_move_gte_fee_x_1_5',
      label: 'expected_move >= fee_roundtrip * 1.5',
      resolveThreshold: (trade) => Number(trade.fee_roundtrip_pct || 0) * 1.5
    },
    {
      name: 'expected_move_gte_fee_x_2_0',
      label: 'expected_move >= fee_roundtrip * 2.0',
      resolveThreshold: (trade) => Number(trade.fee_roundtrip_pct || 0) * 2.0
    }
  ];

  const scenarios = [];
  for (const scenario of staticThresholds) {
    const kept = trades.filter((trade) => Number(trade.expected_move_pct || 0) >= scenario.threshold);
    const filtered = trades.filter((trade) => !kept.includes(trade));
    scenarios.push(
      buildScenarioResult(scenario.name, scenario.label, kept, filtered, {
        threshold_pct: round(scenario.threshold, 6)
      })
    );
  }
  for (const scenario of dynamicThresholds) {
    const kept = trades.filter((trade) => Number(trade.expected_move_pct || 0) >= Number(scenario.resolveThreshold(trade) || 0));
    const filtered = trades.filter((trade) => !kept.includes(trade));
    scenarios.push(
      buildScenarioResult(scenario.name, scenario.label, kept, filtered)
    );
  }
  return scenarios;
}

function buildEntryFilterScenarios(trades = []) {
  const scenarios = [
    {
      name: 'entry_delay_lte_30s',
      label: 'entry_delay_ms <= 30s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 30000,
      keepMatching: true
    },
    {
      name: 'entry_delay_lte_45s',
      label: 'entry_delay_ms <= 45s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 45000,
      keepMatching: true
    },
    {
      name: 'entry_delay_lte_60s',
      label: 'entry_delay_ms <= 60s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 60000,
      keepMatching: true
    },
    {
      name: 'entry_delay_lte_75s',
      label: 'entry_delay_ms <= 75s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 75000,
      keepMatching: true
    },
    {
      name: 'entry_delay_lte_90s',
      label: 'entry_delay_ms <= 90s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 90000,
      keepMatching: true
    },
    {
      name: 'entry_delay_lte_120s',
      label: 'entry_delay_ms <= 120s',
      predicate: (trade) => Number(trade.entry_delay_ms || 0) <= 120000,
      keepMatching: true
    },
    {
      name: 'block_if_move_lost_gt_0_05',
      label: 'bloquear si move_lost_before_entry_pct > 0.05%',
      predicate: (trade) => Number(trade.move_lost_before_entry_pct || 0) > 0.05,
      keepMatching: false
    },
    {
      name: 'block_if_move_lost_gt_0_10',
      label: 'bloquear si move_lost_before_entry_pct > 0.10%',
      predicate: (trade) => Number(trade.move_lost_before_entry_pct || 0) > 0.1,
      keepMatching: false
    }
  ];

  return scenarios.map((scenario) => {
    const kept = trades.filter((trade) => scenario.keepMatching ? scenario.predicate(trade) : !scenario.predicate(trade));
    const filtered = trades.filter((trade) => !kept.includes(trade));
    return buildScenarioResult(scenario.name, scenario.label, kept, filtered);
  });
}

function buildCombinedDelayEdgeScenarios(trades = []) {
  const delayThresholds = [45000, 60000, 75000];
  const edgeMultipliers = [1.5, 2.0];
  const scenarios = [];

  for (const delayThreshold of delayThresholds) {
    for (const edgeMultiplier of edgeMultipliers) {
      const kept = trades.filter((trade) => {
        const delayOk = Number(trade.entry_delay_ms || 0) <= delayThreshold;
        const expectedMove = Number(trade.expected_move_pct || 0);
        const requiredEdge = Number(trade.fee_roundtrip_pct || 0) * edgeMultiplier;
        return delayOk && expectedMove >= requiredEdge;
      });
      const filtered = trades.filter((trade) => !kept.includes(trade));
      scenarios.push(buildScenarioResult(
        `entry_delay_lte_${Math.round(delayThreshold / 1000)}s_and_expected_move_gte_fee_x_${String(edgeMultiplier).replace('.', '_')}`,
        `entry_delay_ms <= ${Math.round(delayThreshold / 1000)}s AND expected_move >= fee_roundtrip * ${edgeMultiplier}`,
        kept,
        filtered,
        {
          delay_threshold_ms: delayThreshold,
          edge_multiplier: edgeMultiplier
        }
      ));
    }
  }

  return scenarios;
}

async function getCandleCache(symbol, candleCache) {
  const normalized = normalizeSymbol(symbol);
  if (!normalized) return [];
  if (!candleCache.has(normalized)) {
    try {
      const candles = await fetchCandles(normalized, '1m');
      candleCache.set(normalized, Array.isArray(candles) ? candles : []);
    } catch (error) {
      candleCache.set(normalized, []);
    }
  }
  return candleCache.get(normalized) || [];
}

function findCandleAtOrBefore(candles = [], targetTs) {
  let candidate = null;
  for (const candle of candles) {
    const ts = Number(candle?.timestamp || 0);
    if (!Number.isFinite(ts) || ts > targetTs) break;
    candidate = candle;
  }
  return candidate;
}

async function buildMaxHoldSimulation(trades = []) {
  const maxHoldTrades = trades.filter((trade) => trade.close_reason === 'max_hold_reached');
  const candleCache = new Map();
  const offsets = [2, 5, 10];
  const scenarios = [];

  for (const minutes of offsets) {
    const offsetMs = minutes * 60 * 1000;
    const tradeResults = [];
    for (const trade of maxHoldTrades) {
      const candles = await getCandleCache(trade.symbol, candleCache);
      const closedAt = parseDateLike(trade.closed_at);
      const entryPrice = toNumber(trade.entry_price, null);
      const feeRoundtripPct = toNumber(trade.fee_roundtrip_pct, 0) || 0;
      if (!closedAt || !Number.isFinite(entryPrice) || entryPrice <= 0 || !candles.length) {
        tradeResults.push({
          trade_id: trade.trade_id,
          symbol: trade.symbol,
          offset_minutes: minutes,
          data_available: false
        });
        continue;
      }
      const targetTs = closedAt.getTime() + offsetMs;
      const candle = findCandleAtOrBefore(candles, targetTs);
      if (!candle || Number(candle.timestamp) <= closedAt.getTime()) {
        tradeResults.push({
          trade_id: trade.trade_id,
          symbol: trade.symbol,
          offset_minutes: minutes,
          data_available: false
        });
        continue;
      }
      const hypotheticalClose = toNumber(candle.close, null);
      const hypotheticalGrossPct = resolveDirectionalMovePct(trade.side, entryPrice, hypotheticalClose);
      const hypotheticalNetPct =
        Number.isFinite(hypotheticalGrossPct) ? hypotheticalGrossPct - feeRoundtripPct : null;
      tradeResults.push({
        trade_id: trade.trade_id,
        symbol: trade.symbol,
        offset_minutes: minutes,
        data_available: true,
        hypothetical_close_price: round(hypotheticalClose, 8),
        hypothetical_gross_pnl_pct: round(hypotheticalGrossPct, 6),
        hypothetical_net_pnl_pct: round(hypotheticalNetPct, 6),
        real_gross_pnl_pct: trade.gross_pnl_pct,
        real_net_pnl_pct: trade.net_pnl_pct,
        improved_gross: Number.isFinite(hypotheticalGrossPct) && hypotheticalGrossPct > Number(trade.gross_pnl_pct || 0),
        improved_net: Number.isFinite(hypotheticalNetPct) && hypotheticalNetPct > Number(trade.net_pnl_pct || 0),
        break_even_pass: Number.isFinite(hypotheticalNetPct) && hypotheticalNetPct > 0
      });
    }

    const available = tradeResults.filter((trade) => trade.data_available);
    scenarios.push({
      offset_minutes: minutes,
      trades_evaluated: maxHoldTrades.length,
      trades_with_data: available.length,
      pnl_bruto_simulado: round(sum(available.map((trade) => trade.hypothetical_gross_pnl_pct)), 6),
      pnl_neto_simulado: round(sum(available.map((trade) => trade.hypothetical_net_pnl_pct)), 6),
      improved_net_count: available.filter((trade) => trade.improved_net).length,
      break_even_pass_count: available.filter((trade) => trade.break_even_pass).length,
      assessment: available.length
        ? (available.filter((trade) => trade.improved_net).length > available.length / 2
          ? 'max_hold_may_be_short'
          : 'trade_never_developed_edge')
        : 'insufficient_post_close_data',
      samples: tradeResults.slice(0, 10)
    });
  }

  return {
    total_max_hold_trades: maxHoldTrades.length,
    scenarios
  };
}

function buildCloseReasonBreakdown(trades = []) {
  const byReason = new Map();
  for (const trade of trades) {
    const reason = trade.close_reason || 'unknown';
    if (!byReason.has(reason)) {
      byReason.set(reason, []);
    }
    byReason.get(reason).push(trade);
  }

  return Array.from(byReason.entries())
    .map(([reason, items]) => ({
      close_reason: reason,
      count: items.length,
      pnl_bruto: round(sum(items.map((trade) => trade.gross_pnl_pct)), 6),
      fees: round(sum(items.map((trade) => trade.fee_roundtrip_pct)), 6),
      pnl_neto: round(sum(items.map((trade) => trade.net_pnl_pct)), 6),
      avg_duration_ms: round(average(items.map((trade) => trade.duration_ms)), 2),
      avg_move_pct: round(average(items.map((trade) => trade.gross_pnl_pct)), 6),
      break_even_pass_count: items.filter((trade) => Number(trade.net_pnl_pct) > 0).length
    }))
    .sort((a, b) => b.count - a.count);
}

function buildCloseReasonDelayAnalysis(trades = []) {
  const byReason = new Map();
  for (const trade of trades) {
    const reason = trade.close_reason || 'unknown';
    if (!byReason.has(reason)) {
      byReason.set(reason, []);
    }
    byReason.get(reason).push(trade);
  }

  const rows = Array.from(byReason.entries()).map(([reason, items]) => ({
    close_reason: reason,
    avg_entry_delay_ms: round(average(items.map((trade) => trade.entry_delay_ms)), 2),
    pnl_neto_total: round(sum(items.map((trade) => trade.net_pnl_pct)), 6),
    distribution: {
      lte_30s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 30000).length,
      lte_45s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 45000).length,
      lte_60s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 60000).length,
      lte_75s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 75000).length,
      lte_90s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 90000).length,
      lte_120s: items.filter((trade) => Number(trade.entry_delay_ms || 0) <= 120000).length,
      gt_120s: items.filter((trade) => Number(trade.entry_delay_ms || 0) > 120000).length
    }
  }));

  return {
    avg_entry_delay_by_close_reason: rows.map((row) => ({
      close_reason: row.close_reason,
      avg_entry_delay_ms: row.avg_entry_delay_ms
    })),
    pnl_neto_by_close_reason: rows.map((row) => ({
      close_reason: row.close_reason,
      pnl_neto_total: row.pnl_neto_total
    })),
    entry_delay_distribution_by_close_reason: rows.map((row) => ({
      close_reason: row.close_reason,
      distribution: row.distribution
    }))
  };
}

function buildBreakdownMap(rows = [], fieldName = 'source_profile') {
  const counts = new Map();
  for (const row of rows) {
    const key = String(row?.[fieldName] || 'unknown');
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Array.from(counts.entries())
    .map(([key, count]) => ({ key, count }))
    .sort((a, b) => b.count - a.count);
}

function classifyDiagnosis(trades = [], expectedMoveScenarios = [], entryScenarios = [], combinedScenarios = [], maxHoldSimulation = null) {
  if (trades.length < 5) return 'insufficient_sample';
  const currentNet = sum(trades.map((trade) => trade.net_pnl_pct));
  const currentGross = sum(trades.map((trade) => trade.gross_pnl_pct));
  const allBelowBreakEven = trades.every((trade) => Number(trade.gross_pnl_pct || 0) < Number(trade.fee_roundtrip_pct || 0));

  const bestExpected = selectBestScenario(expectedMoveScenarios);
  const bestEntry = selectBestScenario(entryScenarios);
  const bestCombined = selectBestScenario(combinedScenarios);
  const bestHold = selectBestScenario((maxHoldSimulation?.scenarios || []).map((scenario) => ({
    scenario: `extend_max_hold_${scenario.offset_minutes}m`,
    label: `extender max_hold +${scenario.offset_minutes}m`,
    trades_kept: scenario.trades_with_data,
    trades_filtered: 0,
    pnl_bruto_simulado: scenario.pnl_bruto_simulado,
    fees_simuladas: round(sum(trades.filter((trade) => trade.close_reason === 'max_hold_reached').map((trade) => trade.fee_roundtrip_pct)), 6),
    pnl_neto_simulado: scenario.pnl_neto_simulado,
    win_rate_neto_simulado: 0,
    improved_net_count: scenario.improved_net_count
  })));

  if (allBelowBreakEven && currentGross > 0 && currentNet < 0) return 'fees_eat_edge';

  const expectedImprovement = bestExpected ? Number(bestExpected.pnl_neto_simulado || 0) - currentNet : -Infinity;
  const entryImprovement = bestEntry ? Number(bestEntry.pnl_neto_simulado || 0) - currentNet : -Infinity;
  const combinedImprovement = bestCombined ? Number(bestCombined.pnl_neto_simulado || 0) - currentNet : -Infinity;
  const holdImprovement = bestHold ? Number(bestHold.pnl_neto_simulado || 0) - currentNet : -Infinity;

  if (expectedImprovement > entryImprovement && expectedImprovement > holdImprovement && expectedImprovement > combinedImprovement && expectedImprovement > 0.05) {
    return 'expected_move_filter_needed';
  }
  if (combinedImprovement > expectedImprovement && combinedImprovement > entryImprovement && combinedImprovement > holdImprovement && combinedImprovement > 0.05) {
    return 'entry_delay_plus_edge_needed';
  }
  if (entryImprovement > expectedImprovement && entryImprovement > holdImprovement && entryImprovement > combinedImprovement && entryImprovement > 0.05) {
    if (bestEntry && Number(bestEntry.trades_kept || 0) <= Math.max(1, Math.floor(trades.length * 0.3))) {
      return 'entry_delay_filter_too_aggressive';
    }
    return 'entry_delay_filter_strong_candidate';
  }
  if (holdImprovement > expectedImprovement && holdImprovement > entryImprovement && holdImprovement > 0.05) {
    return 'max_hold_adjustment_needed';
  }
  return 'no_clear_fix_yet';
}

async function getPnlCounterfactualDiagnostic(db, options = {}) {
  const maxDocs = Math.max(100, Math.min(5000, Number(options.maxDocs || 2000)));
  const includeTrades = String(options.includeTrades || '').toLowerCase() === 'true';
  const { since, until } = getWindowBounds(options);
  const defaultCostConfig = resolveTradeCostConfig();

  const [positionRows, intentRows] = await Promise.all([
    loadRecentCollectionRows(db, 'binance_open_positions', maxDocs),
    loadRecentCollectionRows(db, 'binance_execution_intents', maxDocs)
  ]);

  const scopedIntents = intentRows.filter((row) => {
    const ts = parseDateLike(row.updated_at) || parseDateLike(row.created_at);
    return ts && ts >= since && ts <= until;
  });
  const intentIndex = buildIntentIndex(scopedIntents);

  const closedTrades = positionRows
    .filter((row) => String(row.status || '').toLowerCase() === 'closed')
    .filter((row) => {
      const closedAt = parseDateLike(row.closed_at) || parseDateLike(row.updated_at);
      return closedAt && closedAt >= since && closedAt <= until;
    })
    .map((position) => {
      const sourceProfile = normalizeSource(position.source_profile || position.source);
      const intent = intentIndex.get(position.id)
        || intentIndex.get(position.prediction_id ? `${position.prediction_id}::${sourceProfile}` : null)
        || intentIndex.get(position.prediction_id || null)
        || {};
      return resolveTradeRecord(position, intent, defaultCostConfig);
    })
    .filter(Boolean);

  const expectedMoveScenarios = buildExpectedMoveScenarios(closedTrades);
  const entryFilterScenarios = buildEntryFilterScenarios(closedTrades);
  const combinedDelayEdgeScenarios = buildCombinedDelayEdgeScenarios(closedTrades);
  const maxHoldSimulation = await buildMaxHoldSimulation(closedTrades);
  const closeReasonBreakdown = buildCloseReasonBreakdown(closedTrades);
  const closeReasonDelayAnalysis = buildCloseReasonDelayAnalysis(closedTrades);

  const lateEntryBlockedCount = scopedIntents.filter((row) => String(row.reason || row.final_reason || '').toLowerCase() === 'late_entry_blocked').length;
  const signalOriginNotAllowedCount = scopedIntents.filter((row) => String(row.reason || row.final_reason || '').toLowerCase() === 'signal_origin_not_allowed').length;

  const bestExpectedScenario = selectBestScenario(expectedMoveScenarios);
  const bestEntryScenario = selectBestScenario(entryFilterScenarios);
  const bestCombinedScenario = selectBestScenario(combinedDelayEdgeScenarios);
  const bestHoldScenario = selectBestScenario((maxHoldSimulation.scenarios || []).map((scenario) => ({
    scenario: `extend_max_hold_${scenario.offset_minutes}m`,
    label: `extender max_hold +${scenario.offset_minutes}m`,
    trades_kept: scenario.trades_with_data,
    trades_filtered: 0,
    pnl_bruto_simulado: scenario.pnl_bruto_simulado,
    fees_simuladas: round(sum(closedTrades.filter((trade) => trade.close_reason === 'max_hold_reached').map((trade) => trade.fee_roundtrip_pct)), 6),
    pnl_neto_simulado: scenario.pnl_neto_simulado,
    win_rate_neto_simulado: 0
  })));

  const diagnosis = classifyDiagnosis(closedTrades, expectedMoveScenarios, entryFilterScenarios, combinedDelayEdgeScenarios, maxHoldSimulation);

  const scenarioCandidates = [bestExpectedScenario, bestEntryScenario, bestCombinedScenario, bestHoldScenario].filter(Boolean);
  const bestScenario = selectBestScenario(scenarioCandidates);
  const bestScenariosTop5 = scenarioCandidates
    .concat(expectedMoveScenarios, entryFilterScenarios, combinedDelayEdgeScenarios)
    .filter((scenario) => scenario && Number.isFinite(Number(scenario.pnl_neto_simulado)))
    .sort((a, b) => {
      const pnlDiff = Number(b.pnl_neto_simulado || 0) - Number(a.pnl_neto_simulado || 0);
      if (Math.abs(pnlDiff) > 0.000001) return pnlDiff;
      return Number(b.trades_kept || 0) - Number(a.trades_kept || 0);
    })
    .filter((scenario, index, arr) => arr.findIndex((item) => item.scenario === scenario.scenario) === index)
    .slice(0, 5)
    .map((scenario) => ({
      scenario_name: scenario.scenario,
      trades_kept: scenario.trades_kept,
      trades_filtered: scenario.trades_filtered,
      pnl_neto_simulado: scenario.pnl_neto_simulado,
      win_rate_neto_simulado: scenario.win_rate_neto_simulado,
      avg_entry_delay_kept: scenario.avg_entry_delay_kept
    }));

  return {
    window: {
      since: since.toISOString(),
      until: until.toISOString()
    },
    closed_trades: closedTrades.length,
    baseline: {
      pnl_bruto_total: round(sum(closedTrades.map((trade) => trade.gross_pnl_pct)), 6),
      fees_total: round(sum(closedTrades.map((trade) => trade.fee_roundtrip_pct)), 6),
      pnl_neto_total: round(sum(closedTrades.map((trade) => trade.net_pnl_pct)), 6),
      pnl_bruto_promedio: round(average(closedTrades.map((trade) => trade.gross_pnl_pct)), 6),
      pnl_neto_promedio: round(average(closedTrades.map((trade) => trade.net_pnl_pct)), 6),
      win_rate_bruto: closedTrades.length ? round((closedTrades.filter((trade) => Number(trade.gross_pnl_pct) > 0).length / closedTrades.length) * 100, 2) : 0,
      win_rate_neto: closedTrades.length ? round((closedTrades.filter((trade) => Number(trade.net_pnl_pct) > 0).length / closedTrades.length) * 100, 2) : 0,
      trades_bruto_positivo_neto_negativo: closedTrades.filter((trade) => Number(trade.gross_pnl_pct) > 0 && Number(trade.net_pnl_pct) < 0).length,
      avg_fee_per_trade: round(average(closedTrades.map((trade) => trade.fee_roundtrip_pct)), 6),
      avg_gross_move: round(average(closedTrades.map((trade) => trade.gross_pnl_pct)), 6),
      avg_net_move: round(average(closedTrades.map((trade) => trade.net_pnl_pct)), 6),
      break_even_required_pct: round(average(closedTrades.map((trade) => trade.fee_roundtrip_pct)), 6)
    },
    expected_move_filter_scenarios: expectedMoveScenarios,
    entry_filter_scenarios: entryFilterScenarios,
    combined_delay_edge_scenarios: combinedDelayEdgeScenarios,
    max_hold_counterfactual: maxHoldSimulation,
    close_reason_breakdown: closeReasonBreakdown,
    close_reason_delay_analysis: closeReasonDelayAnalysis,
    late_entry_analysis: {
      late_entry_blocked_count: lateEntryBlockedCount,
      signal_origin_not_allowed_count: signalOriginNotAllowedCount,
      señales_ejecutadas_count: closedTrades.length,
      avg_signal_to_entry_ms: round(average(closedTrades.map((trade) => trade.avg_signal_to_entry_ms)), 2),
      avg_entry_delay_ms: round(average(closedTrades.map((trade) => trade.entry_delay_ms)), 2),
      avg_move_lost_before_entry_pct: round(average(closedTrades.map((trade) => trade.move_lost_before_entry_pct)), 6)
    },
    origin_breakdown: buildBreakdownMap(closedTrades, 'source_profile'),
    symbol_breakdown: buildBreakdownMap(closedTrades, 'symbol'),
    best_scenario: bestScenario,
    best_scenarios_top_5: bestScenariosTop5,
    diagnosis,
    trades: includeTrades ? closedTrades : undefined
  };
}

module.exports = {
  getPnlCounterfactualDiagnostic
};
