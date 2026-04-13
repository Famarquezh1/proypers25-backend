const { FieldValue } = require('firebase-admin/firestore');

const DEFAULT_WINDOW = Math.max(50, Number(process.env.ADAPTIVE_MEMORY_WINDOW || 80));
const MAX_WINDOW = Math.max(DEFAULT_WINDOW, Number(process.env.ADAPTIVE_MEMORY_MAX_WINDOW || 150));
const PROFILE_DOC_ID = 'latest';

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.max(min, Math.min(max, value));
}

function normalizePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function resolveMode(row = {}) {
  const mode = (row.execution_mode || row.mode || row.source_profile || '').toString().toLowerCase();
  if (mode.includes('event')) return 'event_driven';
  return 'timeframe';
}

function resolveSymbol(row = {}) {
  return String(row.symbol || row.simbolo || row.symbol_input || '').toUpperCase();
}

function resolveConfidence(row = {}) {
  const raw = row.confidence ?? row.confianza ?? row.signal_confidence ?? row.entry_context?.signal_confidence;
  return normalizePercent(raw);
}

function resolveOutcome(row = {}) {
  const net = Number(row.net_close_pnl_pct ?? row.close_pnl_pct ?? row.real_close_pnl_pct ?? NaN);
  if (!Number.isFinite(net)) return null;
  if (net > 0.00001) return { net, win: true };
  if (net < -0.00001) return { net, win: false };
  return { net, win: null };
}

function bucketConfidence(confidence = 0) {
  if (confidence >= 0.95) return '0.95-1.00';
  if (confidence >= 0.9) return '0.90-0.95';
  if (confidence >= 0.85) return '0.85-0.90';
  if (confidence >= 0.8) return '0.80-0.85';
  return 'below_0.80';
}

function buildAdjustmentCurve(stats = {}) {
  const buckets = Object.keys(stats);
  if (!buckets.length) return {};
  const overallWinRate =
    buckets.reduce((sum, key) => sum + Number(stats[key]?.win_rate || 0), 0) / buckets.length;
  const curve = {};
  buckets.forEach((key) => {
    const winRate = Number(stats[key]?.win_rate || 0);
    const delta = winRate - overallWinRate;
    curve[key] = clamp(1 + delta, 0.6, 1.4);
  });
  return curve;
}

function buildAdaptiveProfile({ rows = [], window = DEFAULT_WINDOW } = {}) {
  const modeStats = {
    event_driven: { wins: 0, total: 0 },
    timeframe: { wins: 0, total: 0 }
  };
  const symbolStats = {};
  const confidenceStats = {};

  rows.forEach((row) => {
    const outcome = resolveOutcome(row);
    if (!outcome) return;
    const mode = resolveMode(row);
    const symbol = resolveSymbol(row);
    const confidence = resolveConfidence(row);
    const bucket = bucketConfidence(confidence);

    modeStats[mode] = modeStats[mode] || { wins: 0, total: 0 };
    modeStats[mode].total += 1;
    if (outcome.win) modeStats[mode].wins += 1;

    if (symbol) {
      symbolStats[symbol] = symbolStats[symbol] || { wins: 0, total: 0 };
      symbolStats[symbol].total += 1;
      if (outcome.win) symbolStats[symbol].wins += 1;
    }

    confidenceStats[bucket] = confidenceStats[bucket] || { wins: 0, total: 0 };
    confidenceStats[bucket].total += 1;
    if (outcome.win) confidenceStats[bucket].wins += 1;
  });

  const toWinRate = (bucket) =>
    bucket.total > 0 ? Number((bucket.wins / bucket.total).toFixed(4)) : null;

  const modeWinRates = {
    event_driven: toWinRate(modeStats.event_driven),
    timeframe: toWinRate(modeStats.timeframe)
  };

  const symbolWeights = {};
  Object.keys(symbolStats).forEach((symbol) => {
    const winRate = toWinRate(symbolStats[symbol]);
    if (winRate == null) return;
    symbolWeights[symbol] = clamp(0.6 + winRate, 0.6, 1.4);
  });

  const confidenceWinRates = {};
  Object.keys(confidenceStats).forEach((bucket) => {
    confidenceWinRates[bucket] = {
      win_rate: toWinRate(confidenceStats[bucket]),
      total: confidenceStats[bucket].total
    };
  });

  const confidenceAdjustmentCurve = buildAdjustmentCurve(confidenceWinRates);

  const eventDrivenWeight =
    modeWinRates.event_driven == null ? 1 : clamp(0.75 + modeWinRates.event_driven, 0.6, 1.4);
  const timeframeWeight =
    modeWinRates.timeframe == null ? 1 : clamp(0.75 + modeWinRates.timeframe, 0.6, 1.4);

  return {
    window,
    event_driven_weight: eventDrivenWeight,
    timeframe_weight: timeframeWeight,
    symbol_weights: symbolWeights,
    confidence_adjustment_curve: confidenceAdjustmentCurve,
    stats: {
      mode_win_rates: modeWinRates,
      confidence_win_rates: confidenceWinRates,
      total_samples: rows.length
    }
  };
}

async function loadRecentTrades(db, { window = DEFAULT_WINDOW } = {}) {
  const cap = Math.max(20, Math.min(MAX_WINDOW, Number(window || DEFAULT_WINDOW)));
  const positionsSnap = await db
    .collection('binance_open_positions')
    .orderBy('closed_at', 'desc')
    .limit(cap)
    .get();
  const rows = positionsSnap.docs.map((doc) => doc.data()).filter(Boolean);
  if (rows.length) return rows;

  const intentsSnap = await db
    .collection('binance_execution_intents')
    .where('status', '==', 'executed')
    .orderBy('created_at', 'desc')
    .limit(cap)
    .get();
  return intentsSnap.docs.map((doc) => doc.data()).filter(Boolean);
}

async function computeAdaptiveProfile(db, options = {}) {
  const rows = await loadRecentTrades(db, options);
  return buildAdaptiveProfile({ rows, window: options.window || DEFAULT_WINDOW });
}

async function persistAdaptiveProfile(db, profile, extra = {}) {
  if (!profile) return null;
  const payload = {
    ...profile,
    ...extra,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  };
  const collection = db.collection('velas_adaptive_profiles');
  await collection.doc(PROFILE_DOC_ID).set(payload, { merge: true });
  await collection.add(payload);
  console.log('[ADAPTIVE_MEMORY]', {
    window: profile.window,
    event_driven_weight: profile.event_driven_weight,
    timeframe_weight: profile.timeframe_weight,
    samples: profile.stats?.total_samples || 0
  });
  return payload;
}

module.exports = {
  computeAdaptiveProfile,
  persistAdaptiveProfile
};
