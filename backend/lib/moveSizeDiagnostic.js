const {
  normalizeBinanceSymbol
} = require('../services/dataSources/binance');

function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value?.toDate === 'function') {
    const date = value.toDate();
    return Number.isFinite(date?.getTime?.()) ? date : null;
  }
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function toNumber(value, fallback = null) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round(value, decimals = 4) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function percentile(values = [], q = 0.5) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  const index = Math.min(finite.length - 1, Math.max(0, Math.ceil(finite.length * q) - 1));
  return finite[index];
}

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const days = Math.max(1, Number(options.days || 0));
  const hours = Math.max(0.1, Number(options.hours || 1));
  const windowMs = sinceExplicit
    ? Math.max(1, until.getTime() - sinceExplicit.getTime())
    : options.days
      ? days * 24 * 60 * 60 * 1000
      : hours * 60 * 60 * 1000;

  return {
    since: sinceExplicit || new Date(until.getTime() - windowMs),
    until
  };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

function resolvePredictionTimestamp(row = {}) {
  return (
    parseDateLike(row.signal_emitted_at) ||
    parseDateLike(row.created_at) ||
    parseDateLike(row.timestamp) ||
    parseDateLike(row.signal_created_at) ||
    parseDateLike(row.ahora)
  );
}

async function fetchMinuteKlines(symbol, startTimeMs, endTimeMs) {
  const normalized = normalizeBinanceSymbol(symbol);
  const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${encodeURIComponent(normalized)}&interval=1m&startTime=${startTimeMs}&endTime=${endTimeMs}&limit=10`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`binance_klines_status_${response.status}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    openTime: Number(row[0]),
    close: Number(row[4]),
    closeTime: Number(row[6])
  })).filter((row) => Number.isFinite(row.close) && Number.isFinite(row.closeTime));
}

function resolvePriceAtTarget(klines = [], targetMs) {
  const exact = klines.find((row) => row.closeTime >= targetMs);
  if (exact) return exact.close;
  const last = klines[klines.length - 1];
  return Number.isFinite(last?.close) ? last.close : null;
}

function directionalMoveAbsPct(direction, entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) return null;
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  if (String(direction || '').toLowerCase() === 'down' || String(direction || '').toLowerCase() === 'sell') {
    return Math.abs(rawPct * -1);
  }
  return Math.abs(rawPct);
}

function deriveDiagnosis(p90Move) {
  const move = toNumber(p90Move, null);
  if (move == null) return 'micro_noise';
  if (move < 0.10) return 'micro_noise';
  if (move < 0.15) return 'insufficient_move';
  return 'tradable_range';
}

async function getMoveSizeDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs);

  const emitted = rows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts &&
      ts >= since &&
      ts <= until &&
      row.signal_emitted === true;
  });

  const moves30 = [];
  const moves60 = [];
  const moves120 = [];

  for (const row of emitted) {
    try {
      const signalAt = resolvePredictionTimestamp(row);
      const symbol = row.simbolo || row.symbol || row.simbolo_normalizado || null;
      const direction = row.direction || null;
      const entryPrice = toNumber(row.spot_price ?? row.precio_actual, null);
      if (!signalAt || !symbol || entryPrice == null) continue;

      const startTimeMs = signalAt.getTime() - 60 * 1000;
      const endTimeMs = signalAt.getTime() + 4 * 60 * 1000;
      const klines = await fetchMinuteKlines(symbol, startTimeMs, endTimeMs);
      if (!klines.length) continue;

      const move30 = directionalMoveAbsPct(direction, entryPrice, resolvePriceAtTarget(klines, signalAt.getTime() + 30 * 1000));
      const move60 = directionalMoveAbsPct(direction, entryPrice, resolvePriceAtTarget(klines, signalAt.getTime() + 60 * 1000));
      const move120 = directionalMoveAbsPct(direction, entryPrice, resolvePriceAtTarget(klines, signalAt.getTime() + 120 * 1000));

      if (Number.isFinite(move30)) moves30.push(move30);
      if (Number.isFinite(move60)) moves60.push(move60);
      if (Number.isFinite(move120)) moves120.push(move120);
    } catch (_err) {
      // Best-effort diagnostic.
    }
  }

  const aggregateMoves = [...moves30, ...moves60, ...moves120];
  const p50 = percentile(aggregateMoves, 0.5);
  const p75 = percentile(aggregateMoves, 0.75);
  const p90 = percentile(aggregateMoves, 0.9);

  return {
    avg_move_30s: round(average(moves30)),
    avg_move_60s: round(average(moves60)),
    avg_move_120s: round(average(moves120)),
    p50_move: round(p50),
    p75_move: round(p75),
    p90_move: round(p90),
    diagnosis: deriveDiagnosis(p90)
  };
}

module.exports = {
  getMoveSizeDiagnostic
};
