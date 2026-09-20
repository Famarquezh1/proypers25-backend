'use strict';

const DAY_MS = 24 * 60 * 60 * 1000;

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function highHistoryCadence(startTime, endTime = Date.now()) {
  const ageMs = Math.max(0, n(endTime) - n(startTime));
  if (ageMs > 180 * DAY_MS) {
    return { interval: '1d', interval_ms: DAY_MS, max_pages: 4 };
  }
  if (ageMs > 10 * DAY_MS) {
    return { interval: '1h', interval_ms: 60 * 60 * 1000, max_pages: 4 };
  }
  return { interval: '5m', interval_ms: 5 * 60 * 1000, max_pages: 4 };
}

module.exports = { DAY_MS, highHistoryCadence };
