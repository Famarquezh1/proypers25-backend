'use strict';

const assert = require('assert');
const {
  reconstructInventory,
  historyCoversBalance,
  decideProfitProtection
} = require('../services/spotOrphanProtection');
const {
  DEFAULT_SELECTION_GUARD,
  evaluateProductionCandidate,
  summarizeSelectionRejections
} = require('../services/spotProductionSelection');

const trades = [
  { id: 1, time: 1, isBuyer: true, qty: '100', quoteQty: '10', price: '0.1', commission: '0', commissionAsset: 'BNB' },
  { id: 2, time: 2, isBuyer: true, qty: '100', quoteQty: '20', price: '0.2', commission: '0', commissionAsset: 'BNB' },
  { id: 3, time: 3, isBuyer: false, qty: '50', quoteQty: '10', price: '0.2', commission: '0', commissionAsset: 'BNB' }
];

const position = reconstructInventory(trades, 'SAGA');
assert(Math.abs(position.quantity - 150) < 1e-9);
assert(Math.abs(position.entryPrice - 0.15) < 1e-9);
assert.strictEqual(historyCoversBalance(150, 149), true);
assert.strictEqual(historyCoversBalance(80, 100), false);

const trailing = decideProfitProtection({ entryPrice: 0.02, currentPrice: 0.0234, recentHigh: 0.0255, tickSize: 0.00001 });
assert.strictEqual(trailing.action, 'EXIT');
assert.strictEqual(trailing.protection, 'ORPHAN_TRAILING');
assert(Math.abs(trailing.stopPrice - 0.02397) < 1e-9);

const protect = decideProfitProtection({ entryPrice: 100, currentPrice: 108, recentHigh: 110, tickSize: 0.01 });
assert.strictEqual(protect.action, 'PROTECT');
assert.strictEqual(protect.protection, 'ORPHAN_TRAILING');
assert.strictEqual(protect.stopPrice, 103.4);

const breakEven = decideProfitProtection({ entryPrice: 100, currentPrice: 104, recentHigh: 106, tickSize: 0.01 });
assert.strictEqual(breakEven.action, 'PROTECT');
assert.strictEqual(breakEven.protection, 'ORPHAN_BREAK_EVEN');
assert.strictEqual(breakEven.stopPrice, 100.2);

const unarmed = decideProfitProtection({ entryPrice: 100, currentPrice: 102, recentHigh: 104, tickSize: 0.01 });
assert.strictEqual(unarmed.action, 'HOLD_UNARMED');

assert.strictEqual(DEFAULT_SELECTION_GUARD.minQuoteVolumeUsdt, 750000);

const thinButStrong = evaluateProductionCandidate({
  qv: 253699,
  v42_pass_windows: 3,
  v42_norm: 1,
  v42_detail: { confirm: 1.84, extension: 0.18 }
});
assert.strictEqual(thinButStrong.ok, false);
assert(thinButStrong.reasons.includes('THIN_LIQUIDITY'));

const weakTwoWindow = evaluateProductionCandidate({
  qv: 1646345,
  v42_pass_windows: 2,
  v42_norm: 0.702603,
  v42_detail: { confirm: 0.543708, extension: 0.079973 }
});
assert.strictEqual(weakTwoWindow.ok, false);
assert(weakTwoWindow.reasons.includes('TWO_WINDOW_LIQUIDITY'));
assert(weakTwoWindow.reasons.includes('TWO_WINDOW_SCORE'));

const strongTwoWindow = evaluateProductionCandidate({
  qv: 4500000,
  v42_pass_windows: 2,
  v42_norm: 0.82,
  v42_detail: { confirm: 0.68, extension: 0.09 }
});
assert.strictEqual(strongTwoWindow.ok, true);

const strongThreeWindow = evaluateProductionCandidate({
  qv: 2300000,
  v42_pass_windows: 3,
  v42_norm: 0.96,
  v42_detail: { confirm: 1.1, extension: 0.14 }
});
assert.strictEqual(strongThreeWindow.ok, true);

const rejectionCounts = summarizeSelectionRejections([
  { selection_gate: thinButStrong },
  { selection_gate: weakTwoWindow },
  { selection_gate: strongTwoWindow }
]);
assert.strictEqual(rejectionCounts.THIN_LIQUIDITY, 1);
assert.strictEqual(rejectionCounts.TWO_WINDOW_LIQUIDITY, 1);
assert.strictEqual(rejectionCounts.TWO_WINDOW_SCORE, 1);

console.log('spotOrphanProtection tests OK');
