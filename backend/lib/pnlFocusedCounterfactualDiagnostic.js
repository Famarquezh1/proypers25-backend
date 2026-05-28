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

function summarizeTrades(trades = []) {
  const totalTrades = trades.length;
  const grossPnls = trades.map((trade) => trade.gross_pnl_pct);
  const netPnls = trades.map((trade) => trade.net_pnl_pct);
  const fees = trades.map((trade) => trade.fee_roundtrip_pct);
  const grossWins = trades.filter((trade) => Number(trade.gross_pnl_pct || 0) > 0).length;
  const netWins = trades.filter((trade) => Number(trade.net_pnl_pct || 0) > 0).length;
  return {
    trades_kept: totalTrades,
    pnl_bruto_simulado: round(sum(grossPnls), 6),
    fees_simuladas: round(sum(fees), 6),
    pnl_neto_simulado: round(sum(netPnls), 6),
    win_rate_bruto_simulado: totalTrades ? round((grossWins / totalTrades) * 100, 2) : 0,
    win_rate_neto_simulado: totalTrades ? round((netWins / totalTrades) * 100, 2) : 0,
    avg_entry_delay_ms: round(average(trades.map((trade) => trade.entry_delay_ms)), 2),
    avg_duration_ms: round(average(trades.map((trade) => trade.duration_ms)), 2)
  };
}

function buildScenario(name, label, kept = [], allTrades = []) {
  const filtered = allTrades.filter((trade) => !kept.includes(trade));
  return {
    scenario_name: name,
    label,
    ...summarizeTrades(kept),
    trades_filtered: filtered.length,
    filtered_trade_ids: filtered.map((trade) => trade.trade_id)
  };
}

function sortScenarios(scenarios = []) {
  return scenarios
    .filter((scenario) => scenario && Number.isFinite(Number(scenario.pnl_neto_simulado)))
    .sort((a, b) => {
      const pnlDiff = Number(b.pnl_neto_simulado || 0) - Number(a.pnl_neto_simulado || 0);
      if (Math.abs(pnlDiff) > 0.000001) return pnlDiff;
      return Number(b.trades_kept || 0) - Number(a.trades_kept || 0);
    });
}

function buildSymbolStats(trades = []) {
  const map = new Map();
  for (const trade of trades) {
    const symbol = String(trade.symbol || 'UNKNOWN');
    if (!map.has(symbol)) map.set(symbol, []);
    map.get(symbol).push(trade);
  }
  return Array.from(map.entries()).map(([symbol, items]) => ({
    symbol,
    pnl_bruto_total: round(sum(items.map((trade) => trade.gross_pnl_pct)), 6),
    pnl_neto_total: round(sum(items.map((trade) => trade.net_pnl_pct)), 6)
  }));
}

function classifyDiagnosis(allTrades = [], ranked = []) {
  if (allTrades.length < 5) return 'insufficient_sample';
  const best = ranked[0];
  if (!best) return 'insufficient_sample';
  if (best.scenario_name === 'exclude_btcusdt') return 'btc_specific_issue';
  if (best.scenario_name === 'only_solusdt' || best.scenario_name === 'whitelist_positive_gross_symbols') {
    return 'sol_only_promising_but_insufficient_sample';
  }
  if (best.scenario_name.includes('event_timeout_exit') || best.scenario_name.includes('max_hold_reached')) {
    if (best.scenario_name.includes('btcusdt')) return 'symbol_exit_combination_issue';
    return 'exit_reason_issue';
  }
  return 'broad_no_edge';
}

async function getPnlFocusedCounterfactualDiagnostic(db, options = {}) {
  const base = await getPnlCounterfactualDiagnostic(db, {
    ...options,
    includeTrades: 'true'
  });
  const trades = Array.isArray(base.trades) ? base.trades : [];

  const positiveGrossSymbols = buildSymbolStats(trades)
    .filter((row) => Number(row.pnl_bruto_total || 0) > 0)
    .map((row) => row.symbol);

  const scenarios = [
    buildScenario('exclude_btcusdt', 'excluir BTCUSDT', trades.filter((trade) => trade.symbol !== 'BTCUSDT'), trades),
    buildScenario('exclude_solusdt', 'excluir SOLUSDT', trades.filter((trade) => trade.symbol !== 'SOLUSDT'), trades),
    buildScenario('only_btcusdt', 'solo BTCUSDT', trades.filter((trade) => trade.symbol === 'BTCUSDT'), trades),
    buildScenario('only_solusdt', 'solo SOLUSDT', trades.filter((trade) => trade.symbol === 'SOLUSDT'), trades),

    buildScenario('exclude_event_timeout_exit', 'excluir event_timeout_exit', trades.filter((trade) => trade.close_reason !== 'event_timeout_exit'), trades),
    buildScenario('exclude_max_hold_reached', 'excluir max_hold_reached', trades.filter((trade) => trade.close_reason !== 'max_hold_reached'), trades),
    buildScenario('only_event_timeout_exit', 'solo event_timeout_exit', trades.filter((trade) => trade.close_reason === 'event_timeout_exit'), trades),
    buildScenario('only_max_hold_reached', 'solo max_hold_reached', trades.filter((trade) => trade.close_reason === 'max_hold_reached'), trades),

    buildScenario('exclude_btcusdt_event_timeout_exit', 'excluir BTCUSDT + event_timeout_exit', trades.filter((trade) => !(trade.symbol === 'BTCUSDT' && trade.close_reason === 'event_timeout_exit')), trades),
    buildScenario('exclude_btcusdt_max_hold_reached', 'excluir BTCUSDT + max_hold_reached', trades.filter((trade) => !(trade.symbol === 'BTCUSDT' && trade.close_reason === 'max_hold_reached')), trades),
    buildScenario('exclude_btcusdt_complete', 'excluir BTCUSDT completo', trades.filter((trade) => trade.symbol !== 'BTCUSDT'), trades),
    buildScenario('exclude_solusdt_max_hold_reached', 'excluir SOLUSDT + max_hold_reached', trades.filter((trade) => !(trade.symbol === 'SOLUSDT' && trade.close_reason === 'max_hold_reached')), trades),

    buildScenario('whitelist_only_solusdt', 'operar solo SOLUSDT', trades.filter((trade) => trade.symbol === 'SOLUSDT'), trades),
    buildScenario('whitelist_positive_gross_symbols', 'operar solo símbolos con pnl_bruto_total > 0', trades.filter((trade) => positiveGrossSymbols.includes(trade.symbol)), trades),
    buildScenario('block_non_positive_gross_symbols', 'bloquear símbolos con pnl_bruto_total <= 0', trades.filter((trade) => positiveGrossSymbols.includes(trade.symbol)), trades)
  ];

  const ranked = sortScenarios(scenarios);
  const diagnosis = classifyDiagnosis(trades, ranked);

  return {
    window: base.window,
    closed_trades: trades.length,
    baseline: base.baseline,
    symbol_scenarios: scenarios.filter((row) => row.scenario_name.includes('btcusdt') || row.scenario_name.includes('solusdt') || row.scenario_name.includes('whitelist') || row.scenario_name.includes('block_non_positive')),
    close_reason_scenarios: scenarios.filter((row) => row.scenario_name.includes('event_timeout_exit') || row.scenario_name.includes('max_hold_reached')),
    combination_scenarios: scenarios.filter((row) => row.scenario_name.includes('exclude_btcusdt_') || row.scenario_name.includes('exclude_solusdt_')),
    best_scenarios_top_5: ranked.slice(0, 5).map((scenario) => ({
      scenario_name: scenario.scenario_name,
      trades_kept: scenario.trades_kept,
      trades_filtered: scenario.trades_filtered,
      pnl_neto_simulado: scenario.pnl_neto_simulado,
      win_rate_neto_simulado: scenario.win_rate_neto_simulado,
      avg_entry_delay_ms: scenario.avg_entry_delay_ms
    })),
    diagnosis
  };
}

module.exports = {
  getPnlFocusedCounterfactualDiagnostic
};
