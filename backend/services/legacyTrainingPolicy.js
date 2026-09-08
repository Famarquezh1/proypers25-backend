'use strict';

function legacyBackgroundTrainingEnabled(env = process.env) {
  return String(env.LEGACY_BACKGROUND_TRAINING_ENABLED || 'false').trim().toLowerCase() === 'true';
}

function deterministicTrainingDataFailure(data) {
  if (!data || typeof data !== 'object') return null;
  const message = String(data.error || '').trim();
  if (!message) return null;
  return {
    stop: true,
    reason: 'DETERMINISTIC_DATA_UNAVAILABLE',
    message
  };
}

module.exports = {
  legacyBackgroundTrainingEnabled,
  deterministicTrainingDataFailure
};
