'use strict';

const VALIDATIONS = 'spot_opportunity_validations';
const BINANCE_KLINES_URL = 'https://api.binance.com/api/v3/klines';
const HORIZON_KEY = 'h168';
const HORIZON_HOURS = 168;
const FETCH_TIMEOUT_MS = Math.max(5000, Number(process.env.DISCOVERY_LONG_HORIZON_TIMEOUT_MS || 12000));

function parseDate(value) {
  if (!value) return null;
  if (typeof value?.toDate === 'function') return value.toDate();
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
}

function round(value, decimals = 4) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Number(numeric.toFixed(decimals)) : null;
}

function movePct(base, value) {
  const initial = Number(base);
  const observed = Number(value);
  if (!(initial > 0) || !(observed > 0)) return null;
  return ((observed - initial) / initial) * 100;
}

async function fetchSevenDayKlines(symbol, startMs, endMs) {
  const query = new URLSearchParams({
    symbol: String(symbol || '').toUpperCase(),
    interval: '15m',
    startTime: String(startMs),
    endTime: String(endMs),
    limit: '1000'
  });
  const response = await fetch(`${BINANCE_KLINES_URL}?${query.toString()}`, {
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS)
  });
  if (!response.ok) throw new Error(`discovery_long_horizon_status_${response.status}`);
  const rows = await response.json();
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4])
  })).filter((row) => Number.isFinite(row.high) && Number.isFinite(row.low) && Number.isFinite(row.close));
}

function evaluateSevenDay(initialPrice, rows) {
  if (!(Number(initialPrice) > 0) || !rows.length) return null;
  const favorable = rows.map((row) => movePct(initialPrice, row.high)).filter(Number.isFinite);
  const adverse = rows.map((row) => movePct(initialPrice, row.low)).filter(Number.isFinite);
  const maxFavorable = favorable.length ? Math.max(...favorable) : null;
  const maxAdverse = adverse.length ? Math.min(...adverse) : null;
  const variation = movePct(initialPrice, rows[rows.length - 1].close);
  return {
    key: HORIZON_KEY,
    label: '7d',
    hours: HORIZON_HOURS,
    status: 'completed',
    end_price: round(rows[rows.length - 1].close, 8),
    variation_pct: round(variation),
    max_favorable_move_pct: round(maxFavorable),
    max_adverse_move_pct: round(maxAdverse),
    hit_plus_5_pct: Number(maxFavorable || 0) >= 5,
    hit_plus_10_pct: Number(maxFavorable || 0) >= 10,
    hit_plus_20_pct: Number(maxFavorable || 0) >= 20,
    hit_plus_50_pct: Number(maxFavorable || 0) >= 50,
    hit_plus_100_pct: Number(maxFavorable || 0) >= 100,
    drop_below_minus_10_pct: Number(maxAdverse || 0) <= -10,
    candle_samples: rows.length
  };
}

async function processSevenDayDiscoveryValidations(db, options = {}) {
  if (!db) throw new Error('discovery_long_horizon_requires_db');
  const now = parseDate(options.now) || new Date();
  const limit = Math.max(1, Math.min(50, Number(options.limit || 10)));
  const snapshot = await db.collection(VALIDATIONS).orderBy('observed_at', 'asc').limit(300).get();
  let eligible = 0;
  let completed = 0;
  let failed = 0;

  for (const doc of snapshot.docs) {
    if (completed >= limit) break;
    const value = doc.data() || {};
    if (value?.horizons?.[HORIZON_KEY]?.status === 'completed') continue;
    const observedAt = parseDate(value.observed_at);
    const initialPrice = Number(value.initial_price || 0);
    if (!observedAt || !(initialPrice > 0) || !value.symbol) continue;
    const targetMs = observedAt.getTime() + HORIZON_HOURS * 60 * 60 * 1000;
    if (targetMs > now.getTime()) continue;
    eligible += 1;
    try {
      const rows = await fetchSevenDayKlines(value.symbol, observedAt.getTime(), targetMs);
      const evaluation = evaluateSevenDay(initialPrice, rows);
      if (!evaluation) continue;
      evaluation.completed_at = now.toISOString();
      evaluation.evaluated_until = new Date(targetMs).toISOString();
      await doc.ref.set({
        horizons: { ...(value.horizons || {}), [HORIZON_KEY]: evaluation },
        discovery_long_horizon_updated_at: now.toISOString()
      }, { merge: true });
      completed += 1;
    } catch (error) {
      failed += 1;
      console.warn('[DISCOVERY_7D] validation failed', value.symbol, error?.message || error);
    }
  }

  return { horizon: '7d', eligible, completed, failed, limit };
}

module.exports = {
  HORIZON_KEY,
  HORIZON_HOURS,
  evaluateSevenDay,
  processSevenDayDiscoveryValidations
};