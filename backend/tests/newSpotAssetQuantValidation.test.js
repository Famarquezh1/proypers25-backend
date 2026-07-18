'use strict';

const assert = require('assert');
const { nextValidationState } = require('../services/newSpotAssetDiscovery');

function run() {
  const first = nextValidationState({}, true, 'run-1');
  assert.strictEqual(first.total_runs, 1);
  assert.strictEqual(first.consecutive_positive, 1);
  assert.strictEqual(first.quant_ready, false);
  assert.strictEqual(first.approved_for_real, false);
  assert.strictEqual(first.no_order_created, true);

  const second = nextValidationState(first, true, 'run-2');
  assert.strictEqual(second.consecutive_positive, 2);
  assert.strictEqual(second.quant_ready, false);

  const third = nextValidationState(second, true, 'run-3');
  assert.strictEqual(third.consecutive_positive, 3);
  assert.strictEqual(third.quant_ready, true);
  assert.strictEqual(third.approved_for_real, false);
  assert.strictEqual(third.requires_paper_validation, true);
  assert.strictEqual(third.requires_runtime_gate, true);

  const reset = nextValidationState(third, false, 'run-4');
  assert.strictEqual(reset.total_runs, 4);
  assert.strictEqual(reset.consecutive_positive, 0);
  assert.strictEqual(reset.quant_ready, false);

  console.log('newSpotAssetQuantValidation.test.js: PASS');
}

run();
