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
  const grossWins = trades.filter((trade) => Number(trade.gross_pnl_pct || 0) > 0).length;
  const netWins = trades.filter((trade) => Number(trade.net_pnl_pct || 0) > 0).length;
  return {
    count,
    pnl_bruto_total: round(sum(trades.map((trade) => trade.gross_pnl_pct)), 6),
    fees_total: round(sum(trades.map((trade) => trade.fee_roundtrip_pct)), 6),
    pnl_neto_total: round(sum(trades.map((trade) => trade.net_pnl_pct)), 6),
    win_rate_bruto: count ? round((grossWins / count) * 100, 2) : 0,
    win_rate_neto: count ? round((netWins / count) * 100, 2) : 0,
    avg_entry_delay_ms: round(average(trades.map((trade) => trade.entry_delay_ms)), 2),
    avg_duration_ms: round(average(trades.map((trade) => trade.duration_ms)), 2)
  };
}

function buildCloseReasonBreakdownForTrades(trades = []) {
  const grouped = groupBy(trades, (trade) => trade.close_reason || 'unknown');
  return Array.from(grouped.entries())
    .map(([closeReason, items]) => ({
      close_reason: closeReason,
      ...summarizeTrades(items)
    }))
    .sort((a, b) => b.count - a.count);
}

function buildSymbolAttribution(trades = []) {
  const grouped = groupBy(trades, (trade) => trade.symbol || 'UNKNOWN');
  return Array.from(grouped.entries())
    .map(([symbol, items]) => ({
      symbol,
      ...summarizeTrades(items),
      close_reason_breakdown: buildCloseReasonBreakdownForTrades(items)
    }))
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildCloseReasonAttribution(trades = []) {
  const grouped = groupBy(trades, (trade) => trade.close_reason || 'unknown');
  return Array.from(grouped.entries())
    .map(([closeReason, items]) => ({
      close_reason: closeReason,
      ...summarizeTrades(items),
      symbols_involved: unique(items.map((trade) => trade.symbol))
    }))
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildSymbolCloseReasonAttribution(trades = []) {
  const grouped = groupBy(trades, (trade) => `${trade.symbol || 'UNKNOWN'}::${trade.close_reason || 'unknown'}`);
  return Array.from(grouped.entries())
    .map(([key, items]) => {
      const [symbol, closeReason] = key.split('::');
      return {
        symbol,
        close_reason: closeReason,
        ...summarizeTrades(items)
      };
    })
    .sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));
}

function buildDelayBuckets(trades = []) {
  const buckets = [
    { name: '0-30s', min: 0, max: 30000 },
    { name: '30-60s', min: 30000, max: 60000 },
    { name: '60-90s', min: 60000, max: 90000 },
    { name: '90-120s', min: 90000, max: 120000 },
    { name: '>120s', min: 120000, max: Infinity }
  ];

  return buckets.map((bucket) => {
    const items = trades.filter((trade) => {
      const delay = Number(trade.entry_delay_ms || 0);
      if (bucket.max === Infinity) return delay > bucket.min;
      return delay > bucket.min && delay <= bucket.max;
    });
    return {
      bucket: bucket.name,
      ...summarizeTrades(items),
      symbols: unique(items.map((trade) => trade.symbol)),
      close_reasons: unique(items.map((trade) => trade.close_reason))
    };
  });
}

function buildFeeSensitivity(trades = []) {
  const feeLevels = [0.1, 0.08, 0.06, 0.04, 0.02];
  return feeLevels.map((feePct) => {
    const netValues = trades.map((trade) => Number(trade.gross_pnl_pct || 0) - feePct);
    const netWins = netValues.filter((value) => value > 0).length;
    const breakEvenTrades = trades.filter((trade) => Number(trade.gross_pnl_pct || 0) >= feePct).length;
    return {
      fee_roundtrip_pct: round(feePct, 4),
      pnl_neto_simulado: round(sum(netValues), 6),
      win_rate_neto_simulado: trades.length ? round((netWins / trades.length) * 100, 2) : 0,
      break_even_trades_count: breakEvenTrades
    };
  });
}

function classifyDiagnosis(trades = [], symbolAttribution = [], closeReasonAttribution = [], delayBuckets = [], feeSensitivity = []) {
  if (trades.length < 5) return 'insufficient_sample';

  const totalNet = Number(sum(trades.map((trade) => trade.net_pnl_pct)) || 0);
  const worstSymbol = symbolAttribution[0];
  const worstCloseReason = closeReasonAttribution[0];
  const worstDelayBucket = delayBuckets.slice().sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0))[0];
  const bestLowerFee = feeSensitivity.find((row) => Number(row.fee_roundtrip_pct) === 0.04 || Number(row.fee_roundtrip_pct) === 0.02);

  if (worstSymbol && Math.abs(Number(worstSymbol.pnl_neto_total || 0)) >= Math.abs(totalNet) * 0.75 && symbolAttribution.length > 1) {
    return 'symbol_specific_issue';
  }
  if (worstCloseReason && Math.abs(Number(worstCloseReason.pnl_neto_total || 0)) >= Math.abs(totalNet) * 0.7) {
    return 'close_reason_issue';
  }
  if (worstDelayBucket && Number(worstDelayBucket.count || 0) >= 2 && Math.abs(Number(worstDelayBucket.pnl_neto_total || 0)) >= Math.abs(totalNet) * 0.5) {
    return 'delay_bucket_issue';
  }
  if (bestLowerFee && Number(bestLowerFee.pnl_neto_simulado || 0) > totalNet + 0.2) {
    return 'fee_sensitivity_issue';
  }
  return 'broad_no_edge';
}

async function getPnlAttributionDiagnostic(db, options = {}) {
  const base = await getPnlCounterfactualDiagnostic(db, {
    ...options,
    includeTrades: 'true'
  });
  const trades = Array.isArray(base.trades) ? base.trades : [];

  const symbolAttribution = buildSymbolAttribution(trades);
  const closeReasonAttribution = buildCloseReasonAttribution(trades);
  const symbolCloseReasonAttribution = buildSymbolCloseReasonAttribution(trades);
  const delayBuckets = buildDelayBuckets(trades);
  const feeSensitivity = buildFeeSensitivity(trades);
  const diagnosis = classifyDiagnosis(trades, symbolAttribution, closeReasonAttribution, delayBuckets, feeSensitivity);

  return {
    window: base.window,
    closed_trades: trades.length,
    baseline: base.baseline,
    by_symbol: symbolAttribution,
    by_close_reason: closeReasonAttribution,
    by_symbol_and_close_reason: symbolCloseReasonAttribution,
    by_delay_bucket: delayBuckets,
    fee_sensitivity: feeSensitivity,
    diagnosis
  };
}

module.exports = {
  getPnlAttributionDiagnostic
};
