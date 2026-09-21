'use strict';

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function clamp(value, min = -1, max = 1) {
  return Math.max(min, Math.min(max, n(value)));
}
function logSafe(value) {
  return Math.log(Math.max(0.2, n(value, 0.2)));
}

function momentumContinuationFactor(features = {}) {
  const r15 = n(features.r15);
  const r60 = n(features.r60);
  const r24 = n(features.r24);
  const vol15 = Math.max(0.2, n(features.vol15, 1));
  const vol30 = Math.max(0.2, n(features.vol30, 1));
  const breakout60 = n(features.breakout60);
  const rs60 = n(features.rs60);

  const accel = r15 - 0.25 * r60;
  const volSlope = logSafe(vol15) - logSafe(vol30);
  const chase = Math.max(0, r24 - 0.08) + Math.max(0, r60 - 0.045) + Math.max(0, r15 - 0.025);

  const accelN = clamp(accel / 0.02);
  const volSlopeN = clamp(volSlope / 0.45);
  const breakoutN = clamp(breakout60 / 0.02);
  const relativeStrengthN = clamp(rs60 / 0.03);
  const chaseN = clamp(chase / 0.08, 0, 1);

  const score =
    0.35 * accelN +
    0.20 * volSlopeN +
    0.20 * breakoutN +
    0.15 * relativeStrengthN -
    0.20 * chaseN;

  return {
    score,
    pass: score > 0,
    components: {
      accel,
      vol_slope: volSlope,
      breakout60,
      rs60,
      chase,
      accel_n: accelN,
      vol_slope_n: volSlopeN,
      breakout_n: breakoutN,
      relative_strength_n: relativeStrengthN,
      chase_n: chaseN
    }
  };
}

module.exports = { momentumContinuationFactor };
