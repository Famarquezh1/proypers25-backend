const { getPnlCounterfactualDiagnostic } = require('./pnlCounterfactualDiagnostic');

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 4) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
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

function unique(values = []) {
  return Array.from(new Set(values.filter(Boolean)));
}

function groupBy(items = [], keyFn = () => 'unknown') {
  const map = new Map();
  for (const item of items) {
    const key = keyFn(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function summarizeTrades(trades = []) {
  const count = trades.length;
  const grossMoves = trades.map((trade) => trade.gross_pnl_pct);
  const netMoves = trades.map((trade) => trade.net_pnl_pct);
  const fees = trades.map((trade) => trade.fee_roundtrip_pct);
  const grossWins = trades.filter((trade) => Number(trade.gross_pnl_pct || 0) > 0).length;
  const netWins = trades.filter((trade) => Number(trade.net_pnl_pct || 0) > 0).length;
  const avgGross = average(grossMoves);
  const avgFee = average(fees);
  return {
    trades_count: count,
    pnl_bruto_total: round(sum(grossMoves), 6),
    fees_total: round(sum(fees), 6),
    pnl_neto_total: round(sum(netMoves), 6),
    win_rate_bruto: count ? round((grossWins / count) * 100, 2) : 0,
    win_rate_neto: count ? round((netWins / count) * 100, 2) : 0,
    avg_entry_delay_ms: round(average(trades.map((trade) => trade.entry_delay_ms)), 2),
    avg_duration_ms: round(average(trades.map((trade) => trade.duration_ms)), 2),
    avg_gross_move: round(avgGross, 6),
    avg_net_move: round(average(netMoves), 6),
    break_even_required_pct: round(avgFee, 6),
    required_gross_move_for_positive_net: round(avgFee, 6),
    gap_to_break_even: round((avgFee || 0) - (avgGross || 0), 6),
    avg_expected_move_at_entry: round(average(trades.map((trade) => trade.expected_move_pct)), 6),
    avg_realized_move: round(avgGross, 6)
  };
}

function buildCloseReasonBreakdown(trades = []) {
  const grouped = groupBy(trades, (trade) => trade.close_reason || 'unknown');
  return Array.from(grouped.entries())
    .map(([closeReason, items]) => ({
      close_reason: closeReason,
      count: items.length,
      pnl_bruto_total: round(sum(items.map((trade) => trade.gross_pnl_pct)), 6),
      fees_total: round(sum(items.map((trade) => trade.fee_roundtrip_pct)), 6),
      pnl_neto_total: round(sum(items.map((trade) => trade.net_pnl_pct)), 6),
      avg_entry_delay_ms: round(average(items.map((trade) => trade.entry_delay_ms)), 2),
      avg_duration_ms: round(average(items.map((trade) => trade.duration_ms)), 2)
    }))
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildBySymbol(trades = []) {
  const grouped = groupBy(trades, (trade) => trade.symbol || 'UNKNOWN');
  return Array.from(grouped.entries())
    .map(([symbol, items]) => ({
      symbol,
      ...summarizeTrades(items),
      close_reason_breakdown: buildCloseReasonBreakdown(items)
    }))
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildBySymbolCloseReason(trades = []) {
  const grouped = groupBy(trades, (trade) => `${trade.symbol || 'UNKNOWN'}::${trade.close_reason || 'unknown'}`);
  return Array.from(grouped.entries())
    .map(([key, items]) => {
      const [symbol, closeReason] = key.split('::');
      return {
        symbol,
        close_reason: closeReason,
        count: items.length,
        pnl_bruto_total: round(sum(items.map((trade) => trade.gross_pnl_pct)), 6),
        fees_total: round(sum(items.map((trade) => trade.fee_roundtrip_pct)), 6),
        pnl_neto_total: round(sum(items.map((trade) => trade.net_pnl_pct)), 6),
        avg_entry_delay_ms: round(average(items.map((trade) => trade.entry_delay_ms)), 2),
        avg_duration_ms: round(average(items.map((trade) => trade.duration_ms)), 2)
      };
    })
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildDelayBucketsBySymbol(trades = []) {
  const buckets = [
    { name: '0-30s', min: 0, max: 30000 },
    { name: '30-60s', min: 30000, max: 60000 },
    { name: '60-90s', min: 60000, max: 90000 },
    { name: '90-120s', min: 90000, max: 120000 },
    { name: '>120s', min: 120000, max: Infinity }
  ];
  const symbols = unique(trades.map((trade) => trade.symbol));
  const rows = [];
  for (const symbol of symbols) {
    const symbolTrades = trades.filter((trade) => trade.symbol === symbol);
    for (const bucket of buckets) {
      const items = symbolTrades.filter((trade) => {
        const delay = Number(trade.entry_delay_ms || 0);
        if (bucket.max === Infinity) return delay > bucket.min;
        return delay > bucket.min && delay <= bucket.max;
      });
      rows.push({
        symbol,
        delay_bucket: bucket.name,
        count: items.length,
        pnl_bruto_total: round(sum(items.map((trade) => trade.gross_pnl_pct)), 6),
        fees_total: round(sum(items.map((trade) => trade.fee_roundtrip_pct)), 6),
        pnl_neto_total: round(sum(items.map((trade) => trade.net_pnl_pct)), 6),
        close_reasons: unique(items.map((trade) => trade.close_reason))
      });
    }
  }
  return rows;
}

function buildScenario(name, label, kept = [], allTrades = []) {
  const filtered = allTrades.filter((trade) => !kept.includes(trade));
  return {
    scenario_name: name,
    label,
    trades_kept: kept.length,
    trades_filtered: filtered.length,
    pnl_bruto_simulado: round(sum(kept.map((trade) => trade.gross_pnl_pct)), 6),
    fees_simuladas: round(sum(kept.map((trade) => trade.fee_roundtrip_pct)), 6),
    pnl_neto_simulado: round(sum(kept.map((trade) => trade.net_pnl_pct)), 6),
    win_rate_bruto_simulado: kept.length ? round((kept.filter((trade) => Number(trade.gross_pnl_pct || 0) > 0).length / kept.length) * 100, 2) : 0,
    win_rate_neto_simulado: kept.length ? round((kept.filter((trade) => Number(trade.net_pnl_pct || 0) > 0).length / kept.length) * 100, 2) : 0,
    avg_entry_delay_ms: round(average(kept.map((trade) => trade.entry_delay_ms)), 2),
    avg_duration_ms: round(average(kept.map((trade) => trade.duration_ms)), 2)
  };
}

function sortPolicies(rows = []) {
  return rows
    .filter((row) => row && Number.isFinite(Number(row.pnl_neto_simulado)))
    .sort((a, b) => {
      const pnlDiff = Number(b.pnl_neto_simulado || 0) - Number(a.pnl_neto_simulado || 0);
      if (Math.abs(pnlDiff) > 0.000001) return pnlDiff;
      return Number(b.trades_kept || 0) - Number(a.trades_kept || 0);
    });
}

function buildPolicies(trades = [], bySymbol = []) {
  const positiveGrossSymbols = bySymbol
    .filter((row) => Number(row.pnl_bruto_total || 0) > 0)
    .map((row) => row.symbol);

  return [
    buildScenario('exclude_btcusdt', 'exclude BTCUSDT', trades.filter((trade) => trade.symbol !== 'BTCUSDT'), trades),
    buildScenario('only_solusdt', 'only SOLUSDT', trades.filter((trade) => trade.symbol === 'SOLUSDT'), trades),
    buildScenario('btcusdt_delay_lte_60s', 'BTCUSDT only if entry_delay <= 60s', trades.filter((trade) => trade.symbol !== 'BTCUSDT' || Number(trade.entry_delay_ms || 0) <= 60000), trades),
    buildScenario('btcusdt_delay_lte_90s', 'BTCUSDT only if entry_delay <= 90s', trades.filter((trade) => trade.symbol !== 'BTCUSDT' || Number(trade.entry_delay_ms || 0) <= 90000), trades),
    buildScenario('btcusdt_expected_edge_gte_0_20', 'BTCUSDT only if expected_edge >= 0.20%', trades.filter((trade) => trade.symbol !== 'BTCUSDT' || Number(trade.expected_move_pct || 0) >= 0.20), trades),
    buildScenario('btcusdt_expected_edge_gte_0_25', 'BTCUSDT only if expected_edge >= 0.25%', trades.filter((trade) => trade.symbol !== 'BTCUSDT' || Number(trade.expected_move_pct || 0) >= 0.25), trades),
    buildScenario('solusdt_expected_edge_gte_0_15', 'SOLUSDT only if expected_edge >= 0.15%', trades.filter((trade) => trade.symbol !== 'SOLUSDT' || Number(trade.expected_move_pct || 0) >= 0.15), trades),
    buildScenario('solusdt_expected_edge_gte_0_20', 'SOLUSDT only if expected_edge >= 0.20%', trades.filter((trade) => trade.symbol !== 'SOLUSDT' || Number(trade.expected_move_pct || 0) >= 0.20), trades),
    buildScenario('positive_gross_symbols_only', 'operate only symbols with pnl_bruto_total > 0', trades.filter((trade) => positiveGrossSymbols.includes(trade.symbol)), trades)
  ];
}

function classifyDiagnosis(trades = [], bySymbol = [], policies = []) {
  if (trades.length < 5) return 'insufficient_sample';
  const btc = bySymbol.find((row) => row.symbol === 'BTCUSDT');
  const sol = bySymbol.find((row) => row.symbol === 'SOLUSDT');
  const best = sortPolicies(policies)[0];

  if (btc && Number(btc.pnl_bruto_total || 0) <= 0 && Number(btc.trades_count || 0) < 10) {
    return 'btc_suspicious_but_sample_insufficient';
  }
  if (btc && Number(btc.pnl_bruto_total || 0) <= 0 && best && best.scenario_name === 'exclude_btcusdt') {
    return 'btc_specific_issue_confirmed';
  }
  if (sol && Number(sol.pnl_bruto_total || 0) > 0 && Number(sol.pnl_neto_total || 0) < 0) {
    return 'sol_positive_gross_but_fee_limited';
  }
  if (best && String(best.scenario_name).includes('delay')) return 'delay_dominates';
  if (best && String(best.scenario_name).includes('event_timeout') || String(best?.scenario_name).includes('max_hold')) return 'exit_reason_dominates';
  return 'fees_dominate';
}

function buildRecommendation(diagnosis) {
  switch (diagnosis) {
    case 'btc_specific_issue_confirmed':
      return 'btc_pause_candidate_but_insufficient_sample';
    case 'btc_suspicious_but_sample_insufficient':
      return 'observar_btc_y_acumular_mas_muestra';
    case 'sol_positive_gross_but_fee_limited':
      return 'sol_requiere_mas_edge_real_antes_de_cualquier_whitelist';
    case 'delay_dominates':
      return 'simular_mas_delay_especifico_en_btc_antes_de_filtrar';
    case 'exit_reason_dominates':
      return 'revisar_atribucion_btc_por_salida_antes_de_tocar_reglas';
    default:
      return 'no_tocar_nada_y_seguir_observando';
  }
}

async function getSymbolEdgeReviewDiagnostic(db, options = {}) {
  const base = await getPnlCounterfactualDiagnostic(db, {
    ...options,
    includeTrades: 'true'
  });
  const trades = Array.isArray(base.trades) ? base.trades : [];
  const bySymbol = buildBySymbol(trades);
  const bySymbolCloseReason = buildBySymbolCloseReason(trades);
  const bySymbolDelayBucket = buildDelayBucketsBySymbol(trades);
  const policies = buildPolicies(trades, bySymbol);
  const rankedPolicies = sortPolicies(policies);
  const bestPolicy = rankedPolicies[0] || null;
  const diagnosis = classifyDiagnosis(trades, bySymbol, policies);
  const recommendation = buildRecommendation(diagnosis);
  const btc = bySymbol.find((row) => row.symbol === 'BTCUSDT') || null;
  const sol = bySymbol.find((row) => row.symbol === 'SOLUSDT') || null;
  const btcByCloseReason = bySymbolCloseReason.filter((row) => row.symbol === 'BTCUSDT');
  const btcByDelayBucket = bySymbolDelayBucket.filter((row) => row.symbol === 'BTCUSDT');
  const comparisonVsSol = {
    btcusdt: btc,
    solusdt: sol
  };
  const btcExpectedVsRealized = btc
    ? {
        avg_expected_move_at_entry: btc.avg_expected_move_at_entry,
        avg_realized_move: btc.avg_realized_move,
        break_even_required_pct: btc.break_even_required_pct,
        gap_to_break_even: btc.gap_to_break_even
      }
    : null;

  const bestExitPolicy = sortPolicies(policies.filter((row) => row.scenario_name.includes('exclude_btcusdt') || row.scenario_name.includes('only_solusdt') || row.scenario_name.includes('positive_gross')))[0] || null;
  const bestDelayPolicy = sortPolicies(policies.filter((row) => row.scenario_name.includes('delay')))[0] || null;
  const bestNetEdgePolicy = sortPolicies(policies.filter((row) => row.scenario_name.includes('expected_edge')))[0] || null;

  return {
    window: base.window,
    closed_trades: trades.length,
    by_symbol: bySymbol,
    by_symbol_and_close_reason: bySymbolCloseReason,
    by_symbol_and_delay_bucket: bySymbolDelayBucket,
    policies,
    best_symbol_policy: bestPolicy,
    best_exit_policy: bestExitPolicy,
    best_delay_policy: bestDelayPolicy,
    best_net_edge_policy: bestNetEdgePolicy,
    diagnosis,
    recommendation,
    btc_trades_count: btc?.trades_count || 0,
    btc_pnl_bruto: btc?.pnl_bruto_total ?? 0,
    btc_fees: btc?.fees_total ?? 0,
    btc_pnl_neto: btc?.pnl_neto_total ?? 0,
    btc_by_close_reason: btcByCloseReason,
    btc_by_delay_bucket: btcByDelayBucket,
    btc_expected_vs_realized: btcExpectedVsRealized,
    btc_gap_to_break_even: btc?.gap_to_break_even ?? null,
    btc_counterfactuals_top_5: rankedPolicies.slice(0, 5),
    comparison_vs_sol: comparisonVsSol
  };
}

module.exports = {
  getSymbolEdgeReviewDiagnostic
};
