'use strict';

const fs = require('fs');
const path = require('path');
const { isBotPerformanceResult, performanceExclusionReason } = require('../services/spotPerformanceClassification');

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function toIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function summarizeTrades(trades, now = new Date()) {
  const verified = trades.filter((trade) => isBotPerformanceResult(trade));
  const wins = verified.filter((trade) => number(trade.net_pnl_usdt) > 0);
  const losses = verified.filter((trade) => number(trade.net_pnl_usdt) < 0);
  const breakeven = verified.length - wins.length - losses.length;
  const realizedPnl = verified.reduce((sum, trade) => sum + number(trade.net_pnl_usdt), 0);
  const grossProfit = wins.reduce((sum, trade) => sum + number(trade.net_pnl_usdt), 0);
  const grossLossAbs = Math.abs(losses.reduce((sum, trade) => sum + number(trade.net_pnl_usdt), 0));
  const fees = verified.reduce((sum, trade) => sum + number(trade.total_fee_usdt ?? trade.actual_fee_usdt), 0);
  const allocatedCapital = verified.reduce((sum, trade) => sum + number(trade.allocated_capital_usdt), 0);
  const profitFactor = grossLossAbs > 0 ? grossProfit / grossLossAbs : (grossProfit > 0 ? null : 0);
  const winRate = verified.length > 0 ? (wins.length / verified.length) * 100 : 0;
  const roiPct = allocatedCapital > 0 ? (realizedPnl / allocatedCapital) * 100 : 0;
  const averagePnl = verified.length > 0 ? realizedPnl / verified.length : 0;

  const cutoff = (days) => now.getTime() - days * 86400000;
  const windowSummary = (days) => {
    const rows = verified.filter((trade) => {
      const closedAt = toIso(trade.closed_at || trade.created_at);
      return closedAt && new Date(closedAt).getTime() >= cutoff(days);
    });
    const pnl = rows.reduce((sum, trade) => sum + number(trade.net_pnl_usdt), 0);
    const capital = rows.reduce((sum, trade) => sum + number(trade.allocated_capital_usdt), 0);
    const windowWins = rows.filter((trade) => number(trade.net_pnl_usdt) > 0).length;
    const windowLosses = rows.filter((trade) => number(trade.net_pnl_usdt) < 0).length;
    return {
      days,
      trades: rows.length,
      wins: windowWins,
      losses: windowLosses,
      realized_pnl_usdt: Number(pnl.toFixed(8)),
      win_rate_pct: rows.length ? Number(((windowWins / rows.length) * 100).toFixed(4)) : 0,
      roi_on_closed_capital_pct: capital > 0 ? Number(((pnl / capital) * 100).toFixed(4)) : 0
    };
  };

  return {
    verified_bot_trades: verified.length,
    wins: wins.length,
    losses: losses.length,
    breakeven,
    win_rate_pct: Number(winRate.toFixed(4)),
    realized_pnl_usdt: Number(realizedPnl.toFixed(8)),
    gross_profit_usdt: Number(grossProfit.toFixed(8)),
    gross_loss_abs_usdt: Number(grossLossAbs.toFixed(8)),
    profit_factor: profitFactor === null ? null : Number(profitFactor.toFixed(6)),
    profit_factor_state: grossLossAbs === 0 && grossProfit > 0 ? 'NO_REALIZED_LOSSES' : 'CALCULATED',
    trading_fees_usdt: Number(fees.toFixed(8)),
    closed_capital_usdt: Number(allocatedCapital.toFixed(8)),
    roi_on_closed_capital_pct: Number(roiPct.toFixed(4)),
    average_pnl_per_trade_usdt: Number(averagePnl.toFixed(8)),
    last_7_days: windowSummary(7),
    last_30_days: windowSummary(30)
  };
}

function sanitizeTrade(trade) {
  return {
    id: trade.id || null,
    symbol: trade.symbol || null,
    closed_at: toIso(trade.closed_at || trade.created_at),
    closing_reason: trade.closing_reason || trade.reason || null,
    close_source: trade.close_source || null,
    fully_closed: trade.fully_closed === true,
    quantity: number(trade.quantity, null),
    allocated_capital_usdt: number(trade.allocated_capital_usdt, null),
    quote_received_usdt: number(trade.quote_received_usdt, null),
    entry_price: number(trade.entry_price, null),
    exit_price: number(trade.exit_price, null),
    net_pnl_usdt: number(trade.net_pnl_usdt, null),
    net_pnl_pct: number(trade.net_pnl_pct, null),
    total_fee_usdt: number(trade.total_fee_usdt ?? trade.actual_fee_usdt, 0),
    pnl_verified: trade.pnl_verified === true,
    fee_accounting_complete: trade.fee_accounting_complete === true,
    duration_hours: number(trade.duration_hours, null),
    entry_score: number(trade.entry_score, null),
    final_score: number(trade.final_score, null),
    market_regime: trade.market_regime || null,
    model_version: trade.model_version || null,
    performance_classification: isBotPerformanceResult(trade) ? 'BOT_EXECUTION' : 'EXCLUDED',
    performance_exclusion_reason: performanceExclusionReason(trade)
  };
}

async function buildPerformanceReport(db, { limit = 500, now = new Date() } = {}) {
  const [resultsSnap, balanceSnap, openSnap] = await Promise.all([
    db.collection('real_spot_execution_results').orderBy('closed_at', 'desc').limit(limit).get(),
    db.doc('real_spot_config/balance').get(),
    db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get()
  ]);

  const trades = resultsSnap.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const botTrades = trades.filter(isBotPerformanceResult);
  const excludedTrades = trades.filter((trade) => !isBotPerformanceResult(trade));
  const balance = balanceSnap.exists ? balanceSnap.data() : {};
  const summary = summarizeTrades(trades, now);

  const canonicalRealized = number(balance.realized_pnl_usdt, null);
  const ledgerDelta = canonicalRealized === null ? null : canonicalRealized - summary.realized_pnl_usdt;

  return {
    generated_at: now.toISOString(),
    source: 'FIRESTORE_CANONICAL_SPOT_LEDGER',
    performance_scope: 'BOT_EXECUTION_ONLY',
    real_mode: true,
    spot_only: true,
    sample_limit: limit,
    sampled_results: trades.length,
    excluded_results: excludedTrades.length,
    summary,
    balance: {
      available_usdt: number(balance.available_usdt, null),
      locked_usdt: number(balance.locked_usdt, null),
      in_positions_usdt: number(balance.in_positions_usdt, null),
      total_usdt: number(balance.total_usdt, null),
      realized_pnl_usdt: canonicalRealized,
      paid_trading_fees_usdt: number(balance.paid_trading_fees_usdt, null),
      updated_at: toIso(balance.updated_at),
      source: balance.source || null
    },
    reconciliation: {
      ledger_realized_pnl_usdt: summary.realized_pnl_usdt,
      balance_realized_pnl_usdt: canonicalRealized,
      difference_usdt: ledgerDelta === null ? null : Number(ledgerDelta.toFixed(8)),
      consistent: ledgerDelta === null ? null : Math.abs(ledgerDelta) <= 0.000001
    },
    open_positions_count: openSnap.size,
    recent_bot_closed_trades: botTrades.slice(0, 25).map(sanitizeTrade),
    recent_excluded_results: excludedTrades.slice(0, 10).map(sanitizeTrade)
  };
}

async function main() {
  const db = require('../firebase-admin-config');
  const report = await buildPerformanceReport(db, {
    limit: Math.max(25, Math.min(2000, number(process.env.SPOT_PERFORMANCE_LIMIT, 500)))
  });
  const output = `${JSON.stringify(report, null, 2)}\n`;
  const outputPath = process.env.OUTPUT_PATH;
  if (outputPath) {
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, output, 'utf8');
    console.log(`[SPOT_PERFORMANCE] wrote ${outputPath}`);
  } else {
    process.stdout.write(output);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error('[SPOT_PERFORMANCE] export failed:', error.message);
    process.exitCode = 1;
  });
}

module.exports = { buildPerformanceReport, sanitizeTrade, summarizeTrades, toIso };
