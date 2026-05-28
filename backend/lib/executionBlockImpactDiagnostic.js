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

function resolveSignalAt(row = {}) {
  return (
    parseDateLike(row.execution_audit?.signal_at) ||
    parseDateLike(row.execution_trace?.signal_emitted_at) ||
    parseDateLike(row.created_at)
  );
}

function normalizeReason(row = {}) {
  return String(
    row.reason ||
    row.final_evaluation?.reason ||
    row.validation?.reason ||
    row.execution_discipline?.reason ||
    row.error_message ||
    ''
  ).trim() || 'unknown';
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

function deriveDiagnosis(stats) {
  const qualityEdge = Number(stats.would_be_win_quality || 0);
  const rrEdge = Number(stats.would_be_win_rr || 0);
  const qualityBlocked = Number(stats.blocked_by_quality || 0);
  const rrBlocked = Number(stats.blocked_by_rr || 0);

  const qualityRatio = qualityBlocked > 0 ? qualityEdge / qualityBlocked : 0;
  const rrRatio = rrBlocked > 0 ? rrEdge / rrBlocked : 0;

  if (qualityRatio > rrRatio && qualityEdge > 0) return 'quality_too_strict';
  if (rrRatio > qualityRatio && rrEdge > 0) return 'rr_too_strict';
  if (qualityEdge > 0 && rrEdge > 0) return 'both';
  return qualityBlocked >= rrBlocked ? 'quality_too_strict' : 'rr_too_strict';
}

async function summarizeBlocked(rows = [], reasonKey) {
  let wouldBeWin = 0;
  const moves = [];

  for (const row of rows) {
    try {
      if (normalizeReason(row) !== reasonKey) continue;
      const signalAt = resolveSignalAt(row);
      const symbol = row.intent?.symbol || row.symbol || null;
      const direction = row.intent?.direction || row.intent?.side || null;
      const entryPrice = toNumber(row.intent?.entry_price, null);
      if (!signalAt || !symbol || entryPrice == null) continue;

      const startTimeMs = signalAt.getTime() - 60 * 1000;
      const endTimeMs = signalAt.getTime() + 3 * 60 * 1000;
      const klines = await fetchMinuteKlines(symbol, startTimeMs, endTimeMs);
      if (!klines.length) continue;

      const move60 = directionalMovePct(direction, entryPrice, resolvePriceAtTarget(klines, signalAt.getTime() + 60 * 1000));
      if (Number.isFinite(move60)) {
        moves.push(move60);
      }
      if (classifyOutcome(move60) === 'win') {
        wouldBeWin += 1;
      }
    } catch (_err) {
      // best-effort diagnostic
    }
  }

  return {
    blocked: rows.filter((row) => normalizeReason(row) === reasonKey).length,
    wouldBeWin,
    avgMove: round(average(moves))
  };
}

async function getExecutionBlockImpactDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);
  const rows = await loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs);
  const intents = rows.filter((row) => {
    const ts = resolveIntentTimestamp(row);
    return ts && ts >= since && ts <= until;
  });

  const quality = await summarizeBlocked(intents, 'event_quality_gate');
  const rr = await summarizeBlocked(intents, 'risk_reward_low');

  const report = {
    total_intents: intents.length,
    blocked_by_quality: quality.blocked,
    blocked_by_rr: rr.blocked,
    would_be_win_quality: quality.wouldBeWin,
    would_be_win_rr: rr.wouldBeWin,
    avg_move_quality: quality.avgMove,
    avg_move_rr: rr.avgMove
  };

  return {
    ...report,
    diagnosis: deriveDiagnosis(report)
  };
}

module.exports = {
  getExecutionBlockImpactDiagnostic
};
