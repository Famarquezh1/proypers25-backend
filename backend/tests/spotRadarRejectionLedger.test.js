'use strict';

const assert = require('assert');
const { updateLedger } = require('../scripts/update-spot-radar-rejection-ledger');

const scan = {
  source: 'BINANCE_VISION',
  notify: false,
  reason: 'no V4.2 candidate passed production quality gate',
  learning_rejections: [
    { symbol:'AAAUSDT', price:1, pct:4, qv:1000000, utility:0.7, base:0.5, stable:0.8, v42:0.93, v42_pass_windows:3, stage:'PRODUCTION_QUALITY_GATE', reasons:['THIN_LIQUIDITY'] },
    { symbol:'BBBUSDT', price:2, pct:5, qv:2000000, utility:0.6, base:0.4, stable:0.7, v42:0.91, v42_pass_windows:2, stage:'V42_PRE_APPROVAL', reasons:['V42_MIN_PASS_WINDOWS'] }
  ]
};

const first = updateLedger({}, scan, '2026-09-20T20:00:00Z');
assert.strictEqual(first.rows.length, 2);
assert.strictEqual(first.rows[0].radar_source, 'BINANCE_VISION');

const duplicate = updateLedger(first, scan, '2026-09-20T20:10:00Z');
assert.strictEqual(duplicate.rows.length, 2);

const later = updateLedger(duplicate, scan, '2026-09-20T20:31:00Z');
assert.strictEqual(later.rows.length, 4);

const bounded = updateLedger({ rows: Array.from({length:130}, (_,i)=>({
  observed_at: new Date(Date.parse('2026-09-20T18:00:00Z') - i*60000).toISOString(),
  symbol:`X${i}USDT`, price:1, stage:'OLD', reasons:['OLD']
})) }, { learning_rejections: [] }, '2026-09-20T21:00:00Z', { maxRows:120 });
assert.strictEqual(bounded.rows.length, 120);

console.log('spotRadarRejectionLedger tests passed');
