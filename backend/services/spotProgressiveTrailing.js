'use strict';

const DEFAULT_TIERS = Object.freeze([
  { mfe_pct: 0.25, distance_pct: 0.035 },
  { mfe_pct: 0.50, distance_pct: 0.03 },
  { mfe_pct: 1.00, distance_pct: 0.025 }
]);

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveTrailingDistance(mfePct, baseDistancePct = 0.04, tiers = DEFAULT_TIERS) {
  const mfe = Math.max(0, n(mfePct));
  let distance = Math.max(0, n(baseDistancePct, 0.04));
  const rows = (Array.isArray(tiers) ? tiers : DEFAULT_TIERS)
    .map((row) => ({
      mfe_pct: Math.max(0, n(row?.mfe_pct)),
      distance_pct: Math.max(0, n(row?.distance_pct, distance))
    }))
    .sort((a, b) => a.mfe_pct - b.mfe_pct);

  for (const row of rows) {
    if (mfe >= row.mfe_pct) distance = Math.min(distance, row.distance_pct);
  }
  return distance;
}

module.exports = { DEFAULT_TIERS, resolveTrailingDistance };
