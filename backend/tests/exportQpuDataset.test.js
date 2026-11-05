const assert = require('assert');
const { canonicalize } = require('../scripts/export-qpu-dataset');

const row = canonicalize('x', {
  symbol: 'BTCUSDT',
  max_favorable_move_pct: 5,
  max_adverse_move_pct: -2
});

assert.strictEqual(row.document_id, 'x');
assert.strictEqual(row.symbol, 'BTCUSDT');
assert.strictEqual(row.mfe_pct, 5);
assert.strictEqual(row.mae_pct, -2);
assert.strictEqual(row.target_continuator, null, 'must not infer threshold order from MFE/MAE');

const labeled = canonicalize('y', { is_continuator: true });
assert.strictEqual(labeled.target_continuator, true);

console.log('QPU exporter self-test: OK');
