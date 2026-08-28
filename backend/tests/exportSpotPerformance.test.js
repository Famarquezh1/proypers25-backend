'use strict';

const assert = require('assert');
const { summarizeTrades, sanitizeTrade } = require('../scripts/exportSpotPerformance');

const now = new Date('2026-08-28T15:00:00Z');
const trades = [
  {
    id: 'win-1', symbol: 'AAAUSDT', pnl_verified: true, net_pnl_usdt: 2,
    total_fee_usdt: 0.1, allocated_capital_usdt: 10, closed_at: '2026-08-27T12:00:00Z',
    net_pnl_pct: 20, fully_closed: true
  },
  {
    id: 'loss-1', symbol: 'BBBUSDT', pnl_verified: true, net_pnl_usdt: -1,
    total_fee_usdt: 0.1, allocated_capital_usdt: 10, closed_at: '2026-08-20T12:00:00Z',
    net_pnl_pct: -10, fully_closed: true
  },
  {
    id: 'unverified', symbol: 'CCCUSDT', pnl_verified: false, net_pnl_usdt: 99,
    total_fee_usdt: 10, allocated_capital_usdt: 10, closed_at: '2026-08-28T12:00:00Z'
  }
];

const summary = summarizeTrades(trades, now);
assert.strictEqual(summary.verified_trades, 2);
assert.strictEqual(summary.wins, 1);
assert.strictEqual(summary.losses, 1);
assert.strictEqual(summary.realized_pnl_usdt, 1);
assert.strictEqual(summary.gross_profit_usdt, 2);
assert.strictEqual(summary.gross_loss_abs_usdt, 1);
assert.strictEqual(summary.profit_factor, 2);
assert.strictEqual(summary.trading_fees_usdt, 0.2);
assert.strictEqual(summary.closed_capital_usdt, 20);
assert.strictEqual(summary.roi_on_closed_capital_pct, 5);
assert.strictEqual(summary.last_7_days.trades, 1);
assert.strictEqual(summary.last_7_days.realized_pnl_usdt, 2);
assert.strictEqual(summary.last_30_days.trades, 2);

const safe = sanitizeTrade(trades[0]);
assert.deepStrictEqual(Object.keys(safe).sort(), [
  'allocated_capital_usdt','close_source','closed_at','closing_reason','duration_hours',
  'entry_price','entry_score','exit_price','fee_accounting_complete','final_score','fully_closed',
  'id','market_regime','model_version','net_pnl_pct','net_pnl_usdt','pnl_verified','quantity',
  'quote_received_usdt','symbol','total_fee_usdt'
].sort());
assert.strictEqual(safe.symbol, 'AAAUSDT');
assert.strictEqual(safe.net_pnl_usdt, 2);

console.log('exportSpotPerformance.test.js PASS');
