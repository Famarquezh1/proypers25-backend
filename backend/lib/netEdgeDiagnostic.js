const { resolveTradeCostConfig } = require('../services/execution/tradeCostModel');

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

function ratio(numerator, denominator) {
  const num = toNumber(numerator, null);
  const den = toNumber(denominator, null);
  if (num === null || den === null || Math.abs(den) < 0.0000001) return null;
  return num / den;
}

function normalizeSource(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'high_conviction') return 'high_conviction';
  if (normalized === 'event_emitted') return 'event_emitted';
  if (normalized === 'manual_prealert') return 'manual_prealert';
  return normalized || 'unknown';
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
  return {
    since,
    until
  };
}

async function loadRecentCollectionRows(db, collectionName, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy('updated_at', 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function buildIntentIndex(intentRows = []) {
  const index = new Map();
  for (const row of intentRows) {
    const keys = [
      row.linked_position_id,
      row.prediction_id ? `${row.prediction_id}::${normalizeSource(row.source_profile || row.source)}` : null,
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
  const feeSidePct = pickNumber(
    position.fee_per_side_pct,
    position.trade_cost_model?.fee_per_side_pct,
    intent.fee_per_side_pct,
    intent.execution_audit?.trade_cost_model?.fee_per_side_pct,
    defaultCostConfig.fee_per_side_pct
  );
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
  const actualFeeUsdt = pickNumber(
    position.fees_total_usdt,
    position.total_fee_usdt,
    position.fee_usdt,
    position.commission_usdt,
    position.execution_audit?.fees_total_usdt,
    intent.fees_total_usdt,
    intent.total_fee_usdt,
    intent.fee_usdt,
    intent.commission_usdt,
    intent.execution_audit?.fees_total_usdt
  );

  const qty = pickNumber(position.quantity, intent.quantity, intent.intent?.quantity);
  const entryPrice = pickNumber(position.entry_price, intent.entry_price, intent.intent?.entry_price);
  const exitPrice = pickNumber(
    position.close_price,
    position.exit_price,
    intent.close_price,
    intent.execution_audit?.close_price,
    intent.exit_price
  );
  const entryNotional = qty !== null && entryPrice !== null ? qty * entryPrice : null;
  const exitNotional = qty !== null && exitPrice !== null ? qty * exitPrice : entryNotional;

  let feeUsdt = actualFeeUsdt;
  let feeSource = actualFeeUsdt !== null ? 'actual' : 'estimated';
  if (feeUsdt === null && feeSidePct !== null && entryNotional !== null) {
    feeUsdt = (entryNotional * feeSidePct) / 100 + ((exitNotional || entryNotional) * feeSidePct) / 100;
  }

  return {
    fee_per_side_pct: round(feeSidePct),
    fee_roundtrip_pct: round(feeRoundtripPct),
    fee_total_usdt: round(feeUsdt, 8),
    fee_source: feeSource
  };
}

function toTradeRecord(position = {}, intent = {}, defaultCostConfig = resolveTradeCostConfig()) {
  const closedAt =
    parseDateLike(position.closed_at) ||
    parseDateLike(intent.closed_at) ||
    parseDateLike(position.updated_at) ||
    parseDateLike(intent.updated_at);
  if (!closedAt) return null;

  const grossPnlPct = pickNumber(
    position.close_pnl_pct,
    position.gross_close_pnl_pct,
    intent.close_pnl_pct,
    intent.gross_close_pnl_pct,
    intent.execution_audit?.close_pnl_pct
  );
  if (grossPnlPct === null) return null;

  const fees = resolveTradeFees(position, intent, defaultCostConfig);
  const netPnlPct = grossPnlPct - (fees.fee_roundtrip_pct || 0);
  const sourceProfile = normalizeSource(position.source_profile || position.source || intent.source_profile || intent.source);
  const expectedMovePct = pickNumber(
    position.expected_move_percent,
    intent.expected_move_percent,
    intent.intent?.expected_move_percent,
    intent.trade_plan?.expected_move_percent
  );

  return {
    trade_id: position.id || intent.id || null,
    linked_intent_id: intent.id || null,
    position_id: position.id || intent.linked_position_id || null,
    prediction_id: position.prediction_id || intent.prediction_id || null,
    symbol: position.symbol || intent.symbol || intent.intent?.symbol || 'UNKNOWN',
    source_profile: sourceProfile,
    side: String(position.side || intent.side || intent.intent?.side || '').toUpperCase() || null,
    closed_at: closedAt.toISOString(),
    close_reason: position.close_reason || intent.close_reason || intent.execution_audit?.close_reason || null,
    entry_price: pickNumber(position.entry_price, intent.entry_price, intent.intent?.entry_price),
    exit_price: pickNumber(
      position.close_price,
      position.exit_price,
      intent.close_price,
      intent.execution_audit?.close_price,
      intent.exit_price
    ),
    quantity: pickNumber(position.quantity, intent.quantity, intent.intent?.quantity),
    gross_pnl_pct: round(grossPnlPct),
    net_pnl_pct: round(netPnlPct),
    expected_move_pct: round(expectedMovePct),
    fee_roundtrip_pct: fees.fee_roundtrip_pct,
    fee_total_usdt: fees.fee_total_usdt,
    fee_source: fees.fee_source,
    is_false_positive: grossPnlPct > 0 && netPnlPct < 0,
    movement_below_break_even: false
  };
}

function summarizeTrades(trades = []) {
  const totalTrades = trades.length;
  const grossPnls = trades.map((trade) => trade.gross_pnl_pct);
  const netPnls = trades.map((trade) => trade.net_pnl_pct);
  const feePctValues = trades.map((trade) => trade.fee_roundtrip_pct);
  const feeUsdtValues = trades.map((trade) => trade.fee_total_usdt);
  const falsePositiveCount = trades.filter((trade) => trade.is_false_positive).length;
  const grossWins = trades.filter((trade) => trade.gross_pnl_pct > 0).length;
  const netWins = trades.filter((trade) => trade.net_pnl_pct > 0).length;

  return {
    total_trades: totalTrades,
    win_rate_bruto: totalTrades ? round((grossWins / totalTrades) * 100, 2) : 0,
    win_rate_neto: totalTrades ? round((netWins / totalTrades) * 100, 2) : 0,
    pnl_bruto_total_pct: round(sum(grossPnls)),
    pnl_neto_total_pct: round(sum(netPnls)),
    fees_total_pct: round(sum(feePctValues)),
    fees_total_usdt: round(sum(feeUsdtValues), 8),
    fees_total: {
      pct: round(sum(feePctValues)),
      usdt: round(sum(feeUsdtValues), 8)
    },
    pnl_promedio_por_trade_bruto_pct: round(average(grossPnls)),
    pnl_promedio_por_trade_neto_pct: round(average(netPnls)),
    pnl_promedio_por_trade: {
      bruto_pct: round(average(grossPnls)),
      neto_pct: round(average(netPnls))
    },
    promedio_fee_por_trade_pct: round(average(feePctValues)),
    promedio_fee_por_trade_usdt: round(average(feeUsdtValues), 8),
    promedio_fee_por_trade: {
      pct: round(average(feePctValues)),
      usdt: round(average(feeUsdtValues), 8)
    },
    edge_promedio_bruto_pct: round(average(grossPnls)),
    edge_promedio_neto_pct: round(average(netPnls)),
    edge_promedio: {
      bruto_pct: round(average(grossPnls)),
      neto_pct: round(average(netPnls))
    },
    false_positive_trades: falsePositiveCount,
    false_positive_pct: totalTrades ? round((falsePositiveCount / totalTrades) * 100, 2) : 0
  };
}

function buildSourceSegmentation(trades = [], sources = ['high_conviction', 'event_emitted']) {
  return sources.map((source) => {
    const rows = trades.filter((trade) => trade.source_profile === source);
    const summary = summarizeTrades(rows);
    return {
      source_profile: source,
      trades: summary.total_trades,
      win_rate_neto: summary.win_rate_neto,
      pnl_neto_total_pct: summary.pnl_neto_total_pct,
      fee_ratio: round(ratio(summary.fees_total_pct, summary.pnl_bruto_total_pct)),
      fees_total_pct: summary.fees_total_pct,
      fees_total_usdt: summary.fees_total_usdt
    };
  });
}

function buildThresholdDiagnostics(trades = []) {
  const grossWinnerMoves = trades.filter((trade) => trade.gross_pnl_pct > 0).map((trade) => trade.gross_pnl_pct);
  const grossLoserMoves = trades.filter((trade) => trade.gross_pnl_pct < 0).map((trade) => trade.gross_pnl_pct);
  const breakEvenEdge = average(trades.map((trade) => trade.fee_roundtrip_pct)) || 0;
  let belowBreakEvenCount = 0;

  for (const trade of trades) {
    trade.movement_below_break_even = Math.abs(Number(trade.gross_pnl_pct || 0)) < breakEvenEdge;
    if (trade.movement_below_break_even) {
      belowBreakEvenCount += 1;
    }
  }

  return {
    movimiento_bruto_promedio_ganador_pct: round(average(grossWinnerMoves)),
    movimiento_bruto_promedio_perdedor_pct: round(average(grossLoserMoves)),
    break_even_edge_pct: round(breakEvenEdge),
    trades_below_break_even: belowBreakEvenCount,
    trades_below_break_even_pct: trades.length ? round((belowBreakEvenCount / trades.length) * 100, 2) : 0
  };
}

function buildSimulation(trades = [], breakEvenEdgePct = 0) {
  const filteredTrades = trades.filter((trade) => {
    const expectedMove = toNumber(trade.expected_move_pct, null);
    if (expectedMove === null) return true;
    return expectedMove >= breakEvenEdgePct * 1.5;
  });
  const filteredOut = trades.length - filteredTrades.length;
  const summary = summarizeTrades(filteredTrades);

  return {
    applied: true,
    threshold_pct: round(breakEvenEdgePct * 1.5),
    filtered_out_trades: filteredOut,
    remaining_trades: filteredTrades.length,
    win_rate_neto_filtrado: summary.win_rate_neto,
    pnl_neto_filtrado_pct: summary.pnl_neto_total_pct
  };
}

function buildDiagnosticText(summary, thresholdDiagnostics) {
  return [
    `El sistema requiere un edge minimo de ${round(thresholdDiagnostics.break_even_edge_pct, 4)}% para cubrir comisiones.`,
    `El ${round(thresholdDiagnostics.trades_below_break_even_pct, 2)}% de los trades actuales no supera ese umbral.`,
    `El win rate efectivo cae de ${round(summary.win_rate_bruto, 2)}% (bruto) a ${round(summary.win_rate_neto, 2)}% (neto).`,
    `Se detectan ${summary.false_positive_trades} trades donde la prediccion fue correcta pero no rentable.`
  ];
}

async function persistSnapshot(db, payload) {
  await db.collection('velas_training_stats').doc('GLOBAL_DIAGNOSTICO_NETO').set(
    {
      latest_net_edge_diagnostic: payload,
      updated_at: new Date().toISOString()
    },
    { merge: true }
  );
}

async function getNetEdgeDiagnostic(db, options = {}) {
  const maxDocs = Math.max(100, Math.min(5000, Number(options.maxDocs || 2000)));
  const includeTrades = String(options.includeTrades || '').toLowerCase() === 'true';
  const persist = String(options.persist || '').toLowerCase() === 'true';
  const { since, until } = getWindowBounds(options);
  const defaultCostConfig = resolveTradeCostConfig();

  const [positionRows, intentRows] = await Promise.all([
    loadRecentCollectionRows(db, 'binance_open_positions', maxDocs),
    loadRecentCollectionRows(db, 'binance_execution_intents', maxDocs)
  ]);

  const closedPositions = positionRows
    .filter((row) => String(row.status || '').toLowerCase() === 'closed')
    .filter((row) => {
      const closedAt = parseDateLike(row.closed_at || row.updated_at);
      return closedAt && closedAt >= since && closedAt <= until;
    });

  const candidateIntents = intentRows.filter((row) => {
    const closedAt = parseDateLike(row.closed_at || row.updated_at);
    const hasTradeClose = pickNumber(row.close_pnl_pct, row.execution_audit?.close_pnl_pct) !== null;
    return hasTradeClose && closedAt && closedAt >= since && closedAt <= until;
  });

  const intentIndex = buildIntentIndex(candidateIntents);
  let trades = closedPositions
    .map((position) => {
      const source = normalizeSource(position.source_profile || position.source);
      const intent =
        intentIndex.get(position.id) ||
        intentIndex.get(`${position.prediction_id}::${source}`) ||
        intentIndex.get(position.prediction_id) ||
        {};
      return toTradeRecord(position, intent, defaultCostConfig);
    })
    .filter(Boolean)
    .sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime());

  if (!trades.length) {
    trades = candidateIntents
      .map((intent) => toTradeRecord({}, intent, defaultCostConfig))
      .filter(Boolean)
      .sort((a, b) => new Date(b.closed_at).getTime() - new Date(a.closed_at).getTime());
  }

  const summary = summarizeTrades(trades);
  const bySource = buildSourceSegmentation(trades);
  const thresholdDiagnostics = buildThresholdDiagnostics(trades);
  const simulation = buildSimulation(trades, thresholdDiagnostics.break_even_edge_pct || 0);
  const diagnosticLines = buildDiagnosticText(summary, thresholdDiagnostics);

  const payload = {
    generated_at: new Date().toISOString(),
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2)
    },
    data_sources: {
      primary_closed_positions_collection: 'binance_open_positions',
      supporting_intents_collection: 'binance_execution_intents',
      positions_scanned: closedPositions.length,
      intents_scanned: candidateIntents.length,
      fee_mode: 'fees_only',
      default_fee_per_side_pct: defaultCostConfig.fee_per_side_pct,
      default_fee_roundtrip_pct: defaultCostConfig.roundtrip_fee_pct
    },
    resumen_general: summary,
    impacto_fees: {
      promedio_fee_por_trade: summary.promedio_fee_por_trade,
      trades_bruto_positivo_neto_negativo: summary.false_positive_trades,
      trades_bruto_positivo_neto_negativo_pct: summary.false_positive_pct,
      edge_promedio_bruto_pct: summary.edge_promedio_bruto_pct,
      edge_promedio_neto_pct: summary.edge_promedio_neto_pct,
      edge_promedio: summary.edge_promedio
    },
    segmentacion_por_origen: bySource,
    umbral_minimo_viable: thresholdDiagnostics,
    simulacion_movimiento_esperado: simulation,
    diagnostico: diagnosticLines
  };

  if (includeTrades) {
    payload.trades = trades.slice(0, Math.max(10, Math.min(500, Number(options.tradeLimit || 100))));
  }

  if (persist) {
    await persistSnapshot(db, payload);
    payload.persisted_snapshot = true;
  } else {
    payload.persisted_snapshot = false;
  }

  console.log('[NET_EDGE_DIAGNOSTIC]', JSON.stringify({
    generated_at: payload.generated_at,
    window: payload.window,
    total_trades: payload.resumen_general.total_trades,
    win_rate_bruto: payload.resumen_general.win_rate_bruto,
    win_rate_neto: payload.resumen_general.win_rate_neto,
    pnl_bruto_total_pct: payload.resumen_general.pnl_bruto_total_pct,
    pnl_neto_total_pct: payload.resumen_general.pnl_neto_total_pct,
    fees_total_pct: payload.resumen_general.fees_total_pct,
    fees_total_usdt: payload.resumen_general.fees_total_usdt,
    false_positive_trades: payload.resumen_general.false_positive_trades,
    break_even_edge_pct: payload.umbral_minimo_viable.break_even_edge_pct
  }));

  return payload;
}

module.exports = {
  getNetEdgeDiagnostic
};
