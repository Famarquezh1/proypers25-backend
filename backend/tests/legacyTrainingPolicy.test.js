'use strict';

const assert = require('assert');
const {
  legacyBackgroundTrainingEnabled,
  deterministicTrainingDataFailure
} = require('../services/legacyTrainingPolicy');

assert.strictEqual(legacyBackgroundTrainingEnabled({}), false, 'legacy background training must be disabled by default');
assert.strictEqual(legacyBackgroundTrainingEnabled({ LEGACY_BACKGROUND_TRAINING_ENABLED: 'false' }), false);
assert.strictEqual(legacyBackgroundTrainingEnabled({ LEGACY_BACKGROUND_TRAINING_ENABLED: 'TRUE' }), true);

assert.strictEqual(deterministicTrainingDataFailure(null), null);
assert.strictEqual(deterministicTrainingDataFailure({ precio: 1 }), null);

const failure = deterministicTrainingDataFailure({ error: 'No se pudieron obtener datos para LINK-USD' });
assert.deepStrictEqual(failure, {
  stop: true,
  reason: 'DETERMINISTIC_DATA_UNAVAILABLE',
  message: 'No se pudieron obtener datos para LINK-USD'
});

console.log('legacyTrainingPolicy.test.js PASS');
