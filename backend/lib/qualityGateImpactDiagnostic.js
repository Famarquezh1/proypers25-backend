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

function round(value, decimals = 2) {
  const num = toNumber(value, null);
  if (num === null) return null;
  return Number(num.toFixed(decimals));
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
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

function resolveIntentTimestamp(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.updated_at);
}

function normalizeReason(row = {}) {
  return String(
    row.reason ||
    row.validation?.reason ||
    row.execution_discipline?.reason ||
    row.error_message ||
    ''
  ).trim() || 'unknown';
}

function resolveSignalAt(row = {}) {
  return (
    parseDateLike(row.execution_audit?.signal_at) ||
    parseDateLike(row.execution_trace?.signal_emitted_at) ||
    parseDateLike(row.created_at)
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
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
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

function directionalMovePct(direction, entryPrice, exitPrice) {
  if (!Number.isFinite(entryPrice) || !Number.isFinite(exitPrice) || entryPrice <= 0) return null;
  const rawPct = ((exitPrice - entryPrice) / entryPrice) * 100;
  if (String(direction || '').toLowerCase() === 'down' || String(direction || '').toLowerCase() === 'sell') {
    return rawPct * -1;
  }
  return rawPct;
}

function classifyOutcome(movePct) {
  if (!Number.isFinite(movePct)) return null;
  if (movePct >= 0.15) return 'win';
  if (movePct <= -0.15) return 'loss';
  return 'neutral';
}

function deriveDiagnosis(blockedTotal, wouldBeWin, wouldBeLoss) {
  if (!blockedTotal) return 'mixed';
  if (wouldBeWin > wouldBeLoss) return 'blocking_edge';
  if (wouldBeLoss > wouldBeWin) return 'blocking_noise';
  return 'mixed';
}

async function getQualityGateImpactDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);

  const blocked = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts &&
      ts >= since &&
      ts <= until &&
      normalizeReason(row) === 'event_quality_gate';
  });

  let wouldBeWin = 0;
  let wouldBeLoss = 0;
  const moves30 = [];
  const moves60 = [];

  for (const row of blocked) {
    try {
      const signalAt = resolveSignalAt(row);
      const direction = row.intent?.direction || row.intent?.side || null;
      const entryPrice = toNumber(row.intent?.entry_price, null);
      const symbol = row.intent?.symbol || row.symbol || null;
      if (!signalAt || !symbol || entryPrice == null) continue;

      const startTimeMs = signalAt.getTime() - 60 * 1000;
      const endTimeMs = signalAt.getTime() + 3 * 60 * 1000;
      const klines = await fetchMinuteKlines(symbol, startTimeMs, endTimeMs);
      if (!klines.length) continue;

      const price30 = resolvePriceAtTarget(klines, signalAt.getTime() + 30 * 1000);
      const price60 = resolvePriceAtTarget(klines, signalAt.getTime() + 60 * 1000);
      const move30 = directionalMovePct(direction, entryPrice, price30);
      const move60 = directionalMovePct(direction, entryPrice, price60);

      if (Number.isFinite(move30)) moves30.push(move30);
      if (Number.isFinite(move60)) moves60.push(move60);

      const outcome = classifyOutcome(move60 ?? move30);
      if (outcome === 'win') wouldBeWin += 1;
      if (outcome === 'loss') wouldBeLoss += 1;
    } catch (_err) {
      // Best-effort diagnostic: skip symbols that fail market lookup.
    }
  }

  return {
    blocked_total: blocked.length,
    would_be_win: wouldBeWin,
    would_be_loss: wouldBeLoss,
    avg_move_after_30s: round(average(moves30), 4),
    avg_move_after_60s: round(average(moves60), 4),
    diagnosis: deriveDiagnosis(blocked.length, wouldBeWin, wouldBeLoss)
  };
}

module.exports = {
  getQualityGateImpactDiagnostic
};
