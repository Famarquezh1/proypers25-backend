/**
 * evaluate-mid-confidence.js
 *
 * Evalua el comportamiento de mid_confidence contra high_conviction usando
 * colecciones operativas reales y fallbacks enlazados por prediction_id.
 *
 * Uso:
 *   node scripts/evaluate-mid-confidence.js
 *
 * Variables opcionales:
 *   MID_CONFIDENCE_AUDIT_DAYS=60
 *   MID_CONFIDENCE_AUDIT_MAX_DOCS=5000
 *   MID_CONFIDENCE_MATCH_WINDOW_MINUTES=30
 *   MID_CONFIDENCE_REPORT_JSON=backend/scripts/mid_confidence_evaluation_report.json
 *   MID_CONFIDENCE_REPORT_CSV=backend/scripts/mid_confidence_evaluation_rows.csv
 */

const fs = require('fs');
const path = require('path');

const db = require('../firebase-admin-config');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const { extractOfficialWinModel } = require('../utils/executionContract');

const DEFAULT_DAYS = Math.max(1, Number(process.env.MID_CONFIDENCE_AUDIT_DAYS || process.env.AUDIT_DAYS || 60));
const DEFAULT_MAX_DOCS = Math.max(0, Number(process.env.MID_CONFIDENCE_AUDIT_MAX_DOCS || 5000));
const DEFAULT_MATCH_WINDOW_MINUTES = Math.max(
  1,
  Math.min(120, Number(process.env.MID_CONFIDENCE_MATCH_WINDOW_MINUTES || process.env.EXEC_MATCH_WINDOW_MINUTES || 30))
);
const DEFAULT_MARKET_INTERVAL = String(process.env.MID_CONFIDENCE_MARKET_INTERVAL || '1m').toLowerCase();
const DEFAULT_MARKET_WINDOWS_MINUTES = parseMarketWindowMinutes(
  process.env.MID_CONFIDENCE_MARKET_WINDOWS_MINUTES || '3,5,10'
);

const MID_CAPTURE_MIN_CONFIDENCE = clampRatio(process.env.MID_CONFIDENCE_MIN, 0.55);
const MID_CAPTURE_MAX_CONFIDENCE = Math.max(
  MID_CAPTURE_MIN_CONFIDENCE,
  clampRatio(process.env.MID_CONFIDENCE_MAX, 0.75)
);
const MID_CAPTURE_MIN_QUANTUM = clampRatio(process.env.MID_CONFIDENCE_MIN_QUANTUM, 0.6);
const MID_CAPTURE_MIN_TIMING = clampRatio(process.env.MID_CONFIDENCE_MIN_TIMING, 0.65);
const MID_CAPTURE_MIN_STABILITY = clampRatio(process.env.MID_CONFIDENCE_MIN_STABILITY, 0.6);

const REPORT_JSON_PATH =
  process.env.MID_CONFIDENCE_REPORT_JSON ||
  path.resolve(__dirname, 'mid_confidence_evaluation_report.json');
const REPORT_CSV_PATH =
  process.env.MID_CONFIDENCE_REPORT_CSV ||
  path.resolve(__dirname, 'mid_confidence_evaluation_rows.csv');

const PROMOTION_MIN_RESOLVED = Math.max(
  5,
  Number(process.env.MID_CONFIDENCE_PROMOTION_MIN_RESOLVED || 30)
);
const PROMOTION_MIN_DIRECT_MATCHES = Math.max(
  0,
  Number(process.env.MID_CONFIDENCE_PROMOTION_MIN_DIRECT_MATCHES || 10)
);
const PROMOTION_MIN_BUCKET_RESOLVED = Math.max(
  3,
  Number(process.env.MID_CONFIDENCE_PROMOTION_MIN_BUCKET_RESOLVED || 8)
);
const PROMOTION_MIN_WIN_RATE = clampRatio(
  process.env.MID_CONFIDENCE_PROMOTION_MIN_WIN_RATE,
  0.57
);
const PROMOTION_MAX_GAP_VS_HIGH = clampRatio(
  process.env.MID_CONFIDENCE_PROMOTION_MAX_GAP_VS_HIGH,
  0.05
);
const PROMOTION_MAX_UNKNOWN_RATE = clampRatio(
  process.env.MID_CONFIDENCE_PROMOTION_MAX_UNKNOWN_RATE,
  0.5
);
const PROMOTION_MIN_WILSON = clampRatio(
  process.env.MID_CONFIDENCE_PROMOTION_MIN_WILSON,
  0.5
);
const PROMOTION_MIN_EXPECTANCY_PCT = Number(
  process.env.MID_CONFIDENCE_PROMOTION_MIN_EXPECTANCY_PCT || 0
);

function clampRatio(value, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(1, numeric));
}

function parseMarketWindowMinutes(value) {
  const values = String(value || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item >= 1 && item <= 60)
    .map((item) => Math.floor(item));
  const unique = [...new Set(values)].sort((a, b) => a - b);
  return unique.length ? unique : [3, 5, 10];
}

function toNum(value, fallback = null) {
  if (value == null || value === '') return fallback;
  if (typeof value === 'string') {
    const normalized = value.replace(/[%,$\s]/g, '').replace(/,/g, '');
    const numeric = Number(normalized);
    return Number.isFinite(numeric) ? numeric : fallback;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function toDate(value) {
  if (!value) return null;
  if (value instanceof Date && Number.isFinite(value.getTime())) return value;
  if (typeof value?.toDate === 'function') {
    const out = value.toDate();
    return out instanceof Date && Number.isFinite(out.getTime()) ? out : null;
  }
  if (typeof value === 'number') {
    const out = new Date(value < 1e12 ? value * 1000 : value);
    return Number.isFinite(out.getTime()) ? out : null;
  }
  const out = new Date(value);
  return Number.isFinite(out.getTime()) ? out : null;
}

function mean(values = []) {
  const filtered = values.filter((value) => Number.isFinite(value));
  if (!filtered.length) return null;
  return filtered.reduce((sum, value) => sum + value, 0) / filtered.length;
}

function percentile(values = [], p = 50) {
  const filtered = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!filtered.length) return null;
  const idx = (p / 100) * (filtered.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return filtered[lo];
  const weight = idx - lo;
  return filtered[lo] * (1 - weight) + filtered[hi] * weight;
}

function pct(value) {
  if (!Number.isFinite(value)) return null;
  return Number((value * 100).toFixed(2));
}

function round(value, digits = 4) {
  if (!Number.isFinite(value)) return null;
  return Number(value.toFixed(digits));
}

function marketWindowKey(minutes) {
  return `${Number(minutes)}m`;
}

function intervalToMs(interval) {
  switch (String(interval || '').toLowerCase()) {
    case '1m':
      return 60 * 1000;
    case '5m':
      return 5 * 60 * 1000;
    case '15m':
      return 15 * 60 * 1000;
    case '30m':
      return 30 * 60 * 1000;
    case '1h':
      return 60 * 60 * 1000;
    case '4h':
      return 4 * 60 * 60 * 1000;
    default:
      return 60 * 1000;
  }
}

function marketLookbackDaysForInterval(interval) {
  switch (String(interval || '').toLowerCase()) {
    case '1m':
      return 2;
    case '5m':
      return 5;
    case '15m':
      return 7;
    case '30m':
      return 10;
    case '1h':
      return 14;
    case '4h':
      return 30;
    default:
      return 7;
  }
}

function computeSignalStability(confidenceRaw, quantumRaw, timingRaw) {
  const confidence = Number(confidenceRaw || 0);
  const quantum = Number(quantumRaw || 0);
  const timing = Number(timingRaw || 0);
  const avg = (confidence + quantum + timing) / 3;
  const dispersion =
    (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
  return Math.max(0, Math.min(1, avg * (1 - Math.min(dispersion, 0.5))));
}

function resolveMidCaptureZone(confidenceRaw) {
  const confidence = Number(confidenceRaw);
  if (!Number.isFinite(confidence)) {
    return 'unknown';
  }
  if (confidence < MID_CAPTURE_MIN_CONFIDENCE) {
    return 'low';
  }
  if (confidence <= MID_CAPTURE_MAX_CONFIDENCE) {
    return 'mid';
  }
  return 'high';
}

function normalizeOutcome(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'UNKNOWN';
  if (value.includes('LUCKY_WIN') || value.includes('VALID_WIN') || value === 'WIN') return 'WIN';
  if (value.includes('LOSS') || value.includes('FAIL') || value.includes('PERD')) return 'LOSS';
  if (value.includes('BREAKEVEN') || value === 'BE') return 'BREAKEVEN';
  if (value.includes('SUPP')) return 'SUPPRESSED';
  if (value.includes('EXPIRED')) return 'EXPIRED';
  if (value.includes('PEND')) return 'PENDING';
  return value;
}

function normalizeDirection(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (['up', 'buy', 'long', 'alza'].includes(value)) return 'up';
  if (['down', 'sell', 'short', 'baja'].includes(value)) return 'down';
  return 'neutral';
}

function normalizeSystemSymbol(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase().replace('/', '-').replace(/\s+/g, '');
  if (upper.endsWith('-USD')) return upper;
  if (upper.endsWith('-USDT')) return `${upper.slice(0, -5)}-USD`;
  if (upper.endsWith('USDT')) return `${upper.slice(0, -4)}-USD`;
  if (upper.endsWith('USD')) return `${upper.slice(0, -3)}-USD`;
  return upper;
}

function normalizeBinanceSymbol(symbol) {
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (upper.endsWith('USDT')) return upper;
  if (upper.endsWith('USD')) return `${upper.slice(0, -3)}USDT`;
  return upper;
}

function isComparableOutcome(outcome) {
  return outcome === 'WIN' || outcome === 'LOSS';
}

function isResolvedOutcome(outcome) {
  return outcome === 'WIN' || outcome === 'LOSS' || outcome === 'BREAKEVEN';
}

function classifyResolutionType(source) {
  if (!source) return 'unknown';
  if (source.includes('execution_intent')) return 'trade_outcome';
  if (source.includes('velas_verificaciones')) return 'market_verification';
  if (source.includes('prediction_')) return 'linked_prediction';
  return 'unknown';
}

function directionallyClassifyReturn(value) {
  if (!Number.isFinite(value)) return 'UNKNOWN';
  if (value > 0) return 'WIN';
  if (value < 0) return 'LOSS';
  return 'BREAKEVEN';
}

function resolveEntryPrice(data = {}) {
  return (
    toNum(data.entry_price) ??
    toNum(data.trade_plan?.entry_price) ??
    toNum(data.price_at_signal) ??
    toNum(data.precio_actual) ??
    toNum(data.spot_price) ??
    toNum(data.base_price) ??
    null
  );
}

function resolvePredictionTimestamp(data = {}) {
  return toDate(data.created_at || data.timestamp || data.signal_at || data.generated_at || null);
}

function resolvePredictionCounterfactualOutcome(data = {}) {
  return normalizeOutcome(
    data?.suppressed_verification?.counterfactual_outcome ||
      data?.verification?.suppressed_verification?.counterfactual_outcome ||
      data?.verification?.counterfactual_outcome ||
      data?.counterfactual_outcome
  );
}

function resolvePredictionVerificationOutcome(data = {}) {
  return normalizeOutcome(
    data?.verification_outcome ||
      data?.verification?.verification_outcome ||
      data?.verification?.outcome_label ||
      data?.status
  );
}

function resolvePredictionDirectionalReturnPct(data = {}, directionOverride = null) {
  const direction = directionOverride || normalizeDirection(data.direction);
  const actualChange =
    toNum(data?.suppressed_verification?.actual_change) ??
    toNum(data?.verification?.suppressed_verification?.actual_change) ??
    toNum(data?.verification?.actual_change) ??
    toNum(data?.actual_change) ??
    null;
  if (!Number.isFinite(actualChange)) return null;
  if (direction === 'up') return actualChange;
  if (direction === 'down') return -actualChange;
  return actualChange;
}

function resolveVerificationOutcome(data = {}) {
  return normalizeOutcome(
    data?.verification_outcome ||
      data?.outcome ||
      data?.result ||
      data?.counterfactual_outcome ||
      data?.status
  );
}

function resolveVerificationTimestamp(data = {}) {
  return toDate(data.signal_at || data.created_at || data.timestamp || data.prediction_timestamp || data.verified_at || null);
}

function resolveVerificationDirectionalReturnPct(data = {}, directionOverride = null) {
  const direction = directionOverride || normalizeDirection(data.direction || data.trade_direction || data.side);
  const actualChange =
    toNum(data?.actual_change) ??
    toNum(data?.price_change_pct) ??
    toNum(data?.directional_return_pct) ??
    toNum(data?.return_pct) ??
    null;
  if (Number.isFinite(actualChange)) {
    if (direction === 'up') return actualChange;
    if (direction === 'down') return -actualChange;
    return actualChange;
  }
  const pnlPct = toNum(data?.net_close_pnl_pct) ?? toNum(data?.close_pnl_pct) ?? null;
  return Number.isFinite(pnlPct) ? pnlPct : null;
}

function resolveIntentMatchTime(data = {}) {
  return toDate(
    data?.execution_audit?.signal_at ||
      data?.intent_created_at ||
      data?.created_at ||
      data?.execution_audit?.executed_at ||
      null
  );
}

function resolveIntentOutcome(data = {}) {
  const official = normalizeOutcome(extractOfficialWinModel(data));
  if (official !== 'UNKNOWN' && official !== 'PENDING') return official;
  const pnlPct =
    toNum(data?.execution_audit?.win_exchange_net) ??
    toNum(data?.execution_audit?.net_close_pnl_pct) ??
    toNum(data?.execution_audit?.close_pnl_pct) ??
    toNum(data?.net_close_pnl_pct) ??
    toNum(data?.close_pnl_pct) ??
    null;
  if (Number.isFinite(pnlPct)) return directionallyClassifyReturn(pnlPct);
  return official;
}

function resolveIntentEntryPrice(data = {}) {
  return (
    toNum(data?.exchange_response?.order?.avgPrice) ??
    toNum(data?.intent?.entry_price) ??
    toNum(data?.entry_price) ??
    null
  );
}

function buildCsv(rows, explicitHeaders = []) {
  const headers = explicitHeaders.length
    ? explicitHeaders
    : rows.length
      ? Object.keys(rows[0])
      : [];
  if (!headers.length) return '';
  const escape = (value) => {
    if (value == null) return '';
    const str = String(value);
    if (str.includes('"') || str.includes(',') || str.includes('\n')) {
      return `"${str.replace(/"/g, '""')}"`;
    }
    return str;
  };
  return [headers.join(','), ...rows.map((row) => headers.map((key) => escape(row[key])).join(','))].join('\n');
}

function groupBy(rows, keyFn) {
  return rows.reduce((acc, row) => {
    const key = keyFn(row);
    if (!acc.has(key)) acc.set(key, []);
    acc.get(key).push(row);
    return acc;
  }, new Map());
}

function uniqueStrings(values = []) {
  return [...new Set(values.filter(Boolean))];
}

function chunkArray(values = [], size = 5) {
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function wilsonLowerBound(wins, total, z = 1.96) {
  if (!Number.isFinite(wins) || !Number.isFinite(total) || total <= 0) return null;
  const p = wins / total;
  const z2 = z * z;
  const denominator = 1 + z2 / total;
  const centre = p + z2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z2 / (4 * total)) / total);
  return (centre - margin) / denominator;
}

function confidenceBucket(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 'unknown';
  if (numeric < 0.6) return '0.55-0.60';
  if (numeric < 0.65) return '0.60-0.65';
  if (numeric < 0.7) return '0.65-0.70';
  if (numeric <= 0.75) return '0.70-0.75';
  return '0.75+';
}

function sortByTotalThenWinrate(items = []) {
  return [...items].sort((a, b) => {
    if (Number(b.resolved || 0) !== Number(a.resolved || 0)) {
      return Number(b.resolved || 0) - Number(a.resolved || 0);
    }
    return Number(b.win_rate || 0) - Number(a.win_rate || 0);
  });
}

function selectBestWindowMatch(signal, candidates = [], matchWindowMs) {
  if (!signal?.timestamp_ms || !candidates.length) return null;
  const targetSymbol = signal.binance_symbol || signal.symbol;
  const targetDirection = signal.direction;

  return candidates
    .filter((candidate) => candidate.timestamp_ms)
    .filter((candidate) => {
      const candidateSymbol = candidate.binance_symbol || candidate.symbol;
      return candidateSymbol && targetSymbol && candidateSymbol === targetSymbol;
    })
    .filter((candidate) => Math.abs(candidate.timestamp_ms - signal.timestamp_ms) <= matchWindowMs)
    .map((candidate) => {
      const directionPenalty =
        targetDirection !== 'neutral' &&
        candidate.direction !== 'neutral' &&
        candidate.direction !== targetDirection
          ? matchWindowMs
          : 0;
      return {
        candidate,
        score: Math.abs(candidate.timestamp_ms - signal.timestamp_ms) + directionPenalty
      };
    })
    .sort((a, b) => a.score - b.score)[0]?.candidate || null;
}

function chooseResolvedIntent(intents = []) {
  if (!Array.isArray(intents) || !intents.length) return null;
  const sorted = [...intents].sort((a, b) => {
    const aResolved = isResolvedOutcome(a.outcome) ? 1 : 0;
    const bResolved = isResolvedOutcome(b.outcome) ? 1 : 0;
    if (bResolved !== aResolved) return bResolved - aResolved;
    return Number(b.timestamp_ms || 0) - Number(a.timestamp_ms || 0);
  });
  return sorted[0] || null;
}

function chooseResolvedVerification(verifications = []) {
  if (!Array.isArray(verifications) || !verifications.length) return null;
  const sorted = [...verifications].sort((a, b) => {
    const aResolved = isResolvedOutcome(a.outcome) ? 1 : 0;
    const bResolved = isResolvedOutcome(b.outcome) ? 1 : 0;
    if (bResolved !== aResolved) return bResolved - aResolved;
    return Number(b.timestamp_ms || 0) - Number(a.timestamp_ms || 0);
  });
  return sorted[0] || null;
}

function buildPredictionRecord(docId, data = {}) {
  const timestamp = resolvePredictionTimestamp(data);
  const direction = normalizeDirection(data.direction || data.trade_direction || data.side);
  const directionalReturnPct = resolvePredictionDirectionalReturnPct(data, direction);

  return {
    prediction_id: docId,
    symbol: normalizeSystemSymbol(data.symbol || data.simbolo || data.simbolo_normalizado),
    binance_symbol: normalizeBinanceSymbol(data.symbol || data.simbolo || data.simbolo_normalizado),
    direction,
    entry_price: resolveEntryPrice(data),
    timestamp: timestamp ? timestamp.toISOString() : null,
    timestamp_ms: timestamp ? timestamp.getTime() : null,
    verification_outcome: resolvePredictionVerificationOutcome(data),
    counterfactual_outcome: resolvePredictionCounterfactualOutcome(data),
    directional_return_pct: directionalReturnPct,
    raw: data
  };
}

async function loadRecentCollection(collectionName, options = {}) {
  const maxDocs = Math.max(0, Number(options.maxDocs || DEFAULT_MAX_DOCS));
  let query = db.collection(collectionName);
  try {
    query = query.orderBy('created_at', 'desc');
  } catch (_) {
    query = db.collection(collectionName);
  }
  if (maxDocs > 0) {
    query = query.limit(maxDocs);
  }

  try {
    return await query.get();
  } catch (err) {
    const fallback = maxDocs > 0 ? db.collection(collectionName).limit(maxDocs) : db.collection(collectionName);
    return fallback.get();
  }
}

async function loadMidConfidenceCandidates(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await loadRecentCollection('mid_confidence_candidates', { maxDocs });
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = toDate(data.created_at || data.timestamp || null);
      return {
        candidate_id: doc.id,
        prediction_id: data.prediction_id || null,
        symbol: normalizeSystemSymbol(data.symbol),
        binance_symbol: normalizeBinanceSymbol(data.symbol),
        direction: normalizeDirection(data.direction),
        timestamp: timestamp ? timestamp.toISOString() : null,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        entry_price: resolveEntryPrice(data),
        confidence_before: toNum(data.confidence_before),
        confidence_after: toNum(data.confidence_after),
        confidence_zone: data.confidence_zone || null,
        quantum: toNum(data.quantum),
        timing: toNum(data.timing),
        stability: toNum(data.stability),
        reason: data.reason || null,
        suppression_reason: data.suppression_reason || null,
        raw: data
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
}

async function loadHighConvictionSignals(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await loadRecentCollection('high_conviction_signals', { maxDocs });
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = toDate(data.created_at || data.timestamp || null);
      return {
        signal_id: doc.id,
        prediction_id: data.prediction_id || doc.id,
        symbol: normalizeSystemSymbol(data.symbol),
        binance_symbol: normalizeBinanceSymbol(data.symbol),
        direction: normalizeDirection(data.direction),
        timestamp: timestamp ? timestamp.toISOString() : null,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        entry_price: resolveEntryPrice(data),
        confidence: toNum(data.confidence),
        quantum: toNum(data.quantum_score),
        timing: toNum(data.timing_score),
        stability: toNum(data.stability),
        verification_outcome: normalizeOutcome(data.verification_outcome),
        status: data.status || null,
        raw: data
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
}

async function loadExecutionIntents(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await loadRecentCollection('binance_execution_intents', { maxDocs });
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = resolveIntentMatchTime(data);
      return {
        intent_id: doc.id,
        prediction_id: data.prediction_id || null,
        source_profile: data.source_profile || data.source || null,
        symbol: normalizeSystemSymbol(data?.intent?.symbol || data.symbol),
        binance_symbol: normalizeBinanceSymbol(data?.intent?.symbol || data.symbol),
        direction: normalizeDirection(data?.intent?.direction || data?.intent?.side || data.direction),
        timestamp: timestamp ? timestamp.toISOString() : null,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        entry_price: resolveIntentEntryPrice(data),
        close_pnl_pct:
          toNum(data?.execution_audit?.net_close_pnl_pct) ??
          toNum(data?.execution_audit?.close_pnl_pct) ??
          toNum(data?.net_close_pnl_pct) ??
          toNum(data?.close_pnl_pct) ??
          null,
        outcome: resolveIntentOutcome(data),
        status: String(data.status || '').toLowerCase() || null,
        raw: data
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
}

async function loadVelasVerificaciones(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await loadRecentCollection('velas_verificaciones', { maxDocs });
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = resolveVerificationTimestamp(data);
      const direction = normalizeDirection(data.direction || data.trade_direction || data.side);
      return {
        verification_id: doc.id,
        prediction_id: data.prediction_id || null,
        symbol: normalizeSystemSymbol(data.symbol || data.simbolo),
        binance_symbol: normalizeBinanceSymbol(data.symbol || data.simbolo),
        direction,
        timestamp: timestamp ? timestamp.toISOString() : null,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        entry_price: resolveEntryPrice(data),
        outcome: resolveVerificationOutcome(data),
        directional_return_pct: resolveVerificationDirectionalReturnPct(data, direction),
        raw: data
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs)
    .sort((a, b) => b.timestamp_ms - a.timestamp_ms);
}

async function loadPredictionDocs(predictionIds = []) {
  const ids = uniqueStrings(predictionIds);
  const map = new Map();
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50);
    const docs = await Promise.all(
      chunk.map(async (id) => {
        const doc = await db.collection('velas_predicciones').doc(id).get();
        return { id, doc };
      })
    );
    for (const item of docs) {
      if (!item.doc.exists) continue;
      map.set(item.id, buildPredictionRecord(item.id, item.doc.data() || {}));
    }
  }
  return map;
}

async function loadPredictionAuditRows(days, maxDocs) {
  const cutoffMs = Date.now() - days * 24 * 60 * 60 * 1000;
  const snap = await loadRecentCollection('velas_predicciones', { maxDocs });
  return snap.docs
    .map((doc) => {
      const data = doc.data() || {};
      const timestamp = resolvePredictionTimestamp(data);
      const confidenceAfter = toNum(data.confidence_after) ?? toNum(data.confianza);
      const quantum = toNum(data.quantum_score);
      const timing = toNum(data.timing_score);
      return {
        prediction_id: doc.id,
        timestamp_ms: timestamp ? timestamp.getTime() : null,
        suppression_reason: data.suppression_reason || null,
        confidence_after: confidenceAfter,
        confidence_zone: data.confidence_zone || resolveMidCaptureZone(confidenceAfter),
        quantum,
        timing,
        stability: computeSignalStability(confidenceAfter, quantum, timing),
        direction: normalizeDirection(data.direction),
        impulse_present: Boolean(data?.impulse_metrics?.impulse_present),
        context_allowed: data?.event_context_filter?.allow_event !== false
      };
    })
    .filter((row) => row.timestamp_ms && row.timestamp_ms >= cutoffMs);
}

function identifyMidCaptureBlocker(row = {}) {
  if (resolveMidCaptureZone(row.confidence_after) !== 'mid') return 'outside_mid_zone';
  if (row.direction !== 'up' && row.direction !== 'down') return 'neutral_direction';
  if (!row.impulse_present) return 'impulse_inactive';
  if (!row.context_allowed) return 'event_context_blocked';
  if (!Number.isFinite(row.quantum) || row.quantum < MID_CAPTURE_MIN_QUANTUM) {
    return 'quantum_below_mid_min';
  }
  if (!Number.isFinite(row.timing) || row.timing < MID_CAPTURE_MIN_TIMING) {
    return 'timing_below_mid_min';
  }
  if (!Number.isFinite(row.stability) || row.stability < MID_CAPTURE_MIN_STABILITY) {
    return 'stability_below_mid_min';
  }
  return 'candidate_like';
}

function buildPredictionFunnelDiagnostics(rows = []) {
  const suppressionReasons = rows.reduce((acc, row) => {
    const key = row.suppression_reason || 'none';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});

  const lowConfidenceRows = rows.filter((row) => row.suppression_reason === 'low_confidence');
  const blockerCounts = lowConfidenceRows.reduce((acc, row) => {
    const blocker = identifyMidCaptureBlocker(row);
    acc[blocker] = (acc[blocker] || 0) + 1;
    return acc;
  }, {});

  return {
    recent_predictions: rows.length,
    mid_zone_predictions: rows.filter((row) => resolveMidCaptureZone(row.confidence_after) === 'mid').length,
    suppression_reasons: suppressionReasons,
    low_confidence_funnel: {
      total: lowConfidenceRows.length,
      confidence_in_mid_zone: lowConfidenceRows.filter(
        (row) => resolveMidCaptureZone(row.confidence_after) === 'mid'
      ).length,
      directional: lowConfidenceRows.filter(
        (row) => row.direction === 'up' || row.direction === 'down'
      ).length,
      impulse_present: lowConfidenceRows.filter((row) => row.impulse_present).length,
      context_allowed: lowConfidenceRows.filter((row) => row.context_allowed).length,
      quantum_ok: lowConfidenceRows.filter(
        (row) => Number.isFinite(row.quantum) && row.quantum >= MID_CAPTURE_MIN_QUANTUM
      ).length,
      timing_ok: lowConfidenceRows.filter(
        (row) => Number.isFinite(row.timing) && row.timing >= MID_CAPTURE_MIN_TIMING
      ).length,
      stability_ok: lowConfidenceRows.filter(
        (row) => Number.isFinite(row.stability) && row.stability >= MID_CAPTURE_MIN_STABILITY
      ).length,
      candidate_like_saved_fields: lowConfidenceRows.filter(
        (row) => identifyMidCaptureBlocker(row) === 'candidate_like'
      ).length,
      primary_blockers: blockerCounts,
      thresholds: {
        confidence: {
          min: MID_CAPTURE_MIN_CONFIDENCE,
          max: MID_CAPTURE_MAX_CONFIDENCE
        },
        quantum: MID_CAPTURE_MIN_QUANTUM,
        timing: MID_CAPTURE_MIN_TIMING,
        stability: MID_CAPTURE_MIN_STABILITY
      }
    }
  };
}

function findCandleAtOrBefore(candles = [], timestampMs) {
  for (let index = candles.length - 1; index >= 0; index -= 1) {
    const candle = candles[index];
    if (Number(candle?.timestamp) <= timestampMs) {
      return candle;
    }
  }
  return null;
}

function findCandleAtOrAfter(candles = [], timestampMs) {
  for (const candle of candles) {
    if (Number(candle?.timestamp) >= timestampMs) {
      return candle;
    }
  }
  return null;
}

function computeDirectionalReturnPctFromPrices(entryPrice, exitPrice, direction) {
  const entry = Number(entryPrice);
  const exit = Number(exitPrice);
  if (!Number.isFinite(entry) || !Number.isFinite(exit) || entry <= 0) {
    return null;
  }
  const rawPct = ((exit - entry) / entry) * 100;
  if (direction === 'down') return -rawPct;
  return rawPct;
}

function resolveMarketEntryAnchor(row = {}, candles = []) {
  const candleBefore = findCandleAtOrBefore(candles, row.timestamp_ms);
  const candleAfter = findCandleAtOrAfter(candles, row.timestamp_ms);
  const anchor = candleBefore || candleAfter;
  const anchorPrice = toNum(anchor?.close);
  if (!Number.isFinite(anchorPrice) || anchorPrice <= 0) {
    const explicitEntry = toNum(row.entry_price);
    if (Number.isFinite(explicitEntry) && explicitEntry > 0) {
      return {
        price: explicitEntry,
        source: 'row_entry_price_fallback',
        timestamp_ms: row.timestamp_ms || null
      };
    }
    return null;
  }

  return {
    price: anchorPrice,
    source: candleBefore ? 'candle_close_before_signal' : 'candle_close_after_signal',
    timestamp_ms: Number(anchor.timestamp)
  };
}

async function buildMarketWindowContext(rows = [], options = {}) {
  const interval = String(options.interval || DEFAULT_MARKET_INTERVAL).toLowerCase();
  const windowsMinutes = Array.isArray(options.windowsMinutes) && options.windowsMinutes.length
    ? options.windowsMinutes
    : DEFAULT_MARKET_WINDOWS_MINUTES;
  const lookbackDays = marketLookbackDaysForInterval(interval);
  const recentCutoffMs =
    Date.now() - lookbackDays * 24 * 60 * 60 * 1000 - Math.max(...windowsMinutes) * 60 * 1000;
  const eligibleRows = rows.filter(
    (row) => row?.timestamp_ms && row.timestamp_ms >= recentCutoffMs && (row.symbol || row.binance_symbol)
  );
  const symbols = uniqueStrings(
    eligibleRows.map((row) => row.binance_symbol || row.symbol)
  );
  const candlesBySymbol = new Map();
  const coverageBySymbol = new Map();
  const fetchErrors = [];

  for (const chunk of chunkArray(symbols, 5)) {
    const results = await Promise.allSettled(
      chunk.map(async (symbol) => {
        const candles = await fetchCandles(symbol, interval, { disableCache: false });
        candlesBySymbol.set(symbol, candles);
        if (candles.length) {
          const coverage = {
            min_timestamp: Number(candles[0]?.timestamp),
            max_timestamp: Number(candles[candles.length - 1]?.timestamp)
          };
          coverageBySymbol.set(symbol, coverage);
          const systemSymbol = normalizeSystemSymbol(symbol);
          const binanceSymbol = normalizeBinanceSymbol(symbol);
          if (systemSymbol) coverageBySymbol.set(systemSymbol, coverage);
          if (binanceSymbol) coverageBySymbol.set(binanceSymbol, coverage);
        }
        const systemSymbol = normalizeSystemSymbol(symbol);
        const binanceSymbol = normalizeBinanceSymbol(symbol);
        if (systemSymbol) candlesBySymbol.set(systemSymbol, candles);
        if (binanceSymbol) candlesBySymbol.set(binanceSymbol, candles);
      })
    );
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        fetchErrors.push({
          symbol: chunk[index],
          error: result.reason?.message || String(result.reason)
        });
      }
    });
  }

  return {
    interval,
    interval_ms: intervalToMs(interval),
    windows_minutes: windowsMinutes,
    lookback_days: lookbackDays,
    eligible_cutoff_ms: recentCutoffMs,
    eligible_rows: eligibleRows.length,
    fetched_symbols: symbols.length,
    fetch_errors: fetchErrors,
    coverageBySymbol,
    candlesBySymbol
  };
}

function resolveMarketWindowRow(row = {}, marketContext = {}) {
  const windows = {};
  const symbolKey = row.binance_symbol || row.symbol;
  const candles = marketContext.candlesBySymbol?.get(symbolKey) || [];
  const coverage = marketContext.coverageBySymbol?.get(symbolKey) || null;
  const rangeSlackMs = Math.max(0, Number(marketContext.interval_ms || 0));

  for (const minutes of marketContext.windows_minutes || []) {
    const key = marketWindowKey(minutes);
    windows[key] = {
      available: false,
      window_minutes: minutes,
      reason: 'missing_market_data'
    };
  }

  if (!row.timestamp_ms || !candles.length) {
    return windows;
  }

  if (
    Number.isFinite(marketContext.eligible_cutoff_ms) &&
    row.timestamp_ms < Number(marketContext.eligible_cutoff_ms)
  ) {
    for (const minutes of marketContext.windows_minutes || []) {
      const key = marketWindowKey(minutes);
      windows[key] = {
        ...windows[key],
        reason: 'outside_market_lookback'
      };
    }
    return windows;
  }

  if (
    coverage &&
    Number.isFinite(coverage.min_timestamp) &&
    Number.isFinite(coverage.max_timestamp) &&
    (row.timestamp_ms < coverage.min_timestamp - rangeSlackMs || row.timestamp_ms > coverage.max_timestamp)
  ) {
    for (const minutes of marketContext.windows_minutes || []) {
      const key = marketWindowKey(minutes);
      windows[key] = {
        ...windows[key],
        reason: 'outside_candle_range'
      };
    }
    return windows;
  }

  const anchor = resolveMarketEntryAnchor(row, candles);
  if (!anchor) {
    for (const minutes of marketContext.windows_minutes || []) {
      const key = marketWindowKey(minutes);
      windows[key] = {
        ...windows[key],
        reason: 'missing_entry_anchor'
      };
    }
    return windows;
  }

  for (const minutes of marketContext.windows_minutes || []) {
    const key = marketWindowKey(minutes);
    const targetTimestampMs = row.timestamp_ms + minutes * 60 * 1000;

    if (coverage && Number.isFinite(coverage.max_timestamp) && targetTimestampMs > coverage.max_timestamp) {
      windows[key] = {
        ...windows[key],
        reason: 'target_outside_candle_range'
      };
      continue;
    }

    const targetCandle = findCandleAtOrAfter(candles, targetTimestampMs);
    const exitPrice = toNum(targetCandle?.close);
    const returnPct = computeDirectionalReturnPctFromPrices(anchor.price, exitPrice, row.direction);

    if (!targetCandle || !Number.isFinite(exitPrice) || !Number.isFinite(returnPct)) {
      windows[key] = {
        ...windows[key],
        reason: 'missing_target_price'
      };
      continue;
    }

    windows[key] = {
      available: true,
      window_minutes: minutes,
      anchor_source: anchor.source,
      entry_price: round(anchor.price, 8),
      exit_price: round(exitPrice, 8),
      entry_timestamp: anchor.timestamp_ms ? new Date(anchor.timestamp_ms).toISOString() : null,
      target_timestamp: new Date(targetTimestampMs).toISOString(),
      actual_timestamp: new Date(Number(targetCandle.timestamp)).toISOString(),
      return_pct: round(returnPct, 4),
      outcome: directionallyClassifyReturn(returnPct)
    };
  }

  return windows;
}

function attachMarketWindows(rows = [], marketContext = {}) {
  return rows.map((row) => ({
    ...row,
    market_windows: resolveMarketWindowRow(row, marketContext)
  }));
}

function buildMarketWindowMetrics(rows = [], windowsMinutes = []) {
  return Object.fromEntries(
    windowsMinutes.map((minutes) => {
      const key = marketWindowKey(minutes);
      const coveredRows = rows
        .map((row) => {
          const market = row.market_windows?.[key];
          if (!market?.available) return null;
          return {
            ...row,
            outcome: market.outcome,
            directional_return_pct: market.return_pct
          };
        })
        .filter(Boolean);

      const metrics = buildPerformanceMetrics(coveredRows);
      return [
        key,
        {
          total_rows: rows.length,
          available_rows: coveredRows.length,
          coverage_rate: rows.length ? coveredRows.length / rows.length : null,
          ...metrics
        }
      ];
    })
  );
}

function buildIndexes(intents = [], verifications = []) {
  return {
    intentsByPredictionId: groupBy(intents.filter((row) => row.prediction_id), (row) => row.prediction_id),
    intentsBySymbol: groupBy(intents.filter((row) => row.symbol || row.binance_symbol), (row) => row.binance_symbol || row.symbol),
    verificationsByPredictionId: groupBy(
      verifications.filter((row) => row.prediction_id),
      (row) => row.prediction_id
    ),
    verificationsBySymbol: groupBy(
      verifications.filter((row) => row.symbol || row.binance_symbol),
      (row) => row.binance_symbol || row.symbol
    )
  };
}

function resolveMidCandidate(candidate, context) {
  const prediction = candidate.prediction_id ? context.predictionsById.get(candidate.prediction_id) || null : null;
  const exactIntent = chooseResolvedIntent(context.indexes.intentsByPredictionId.get(candidate.prediction_id) || []);
  const exactVerification = chooseResolvedVerification(
    context.indexes.verificationsByPredictionId.get(candidate.prediction_id) || []
  );
  const symbolKey = candidate.binance_symbol || candidate.symbol;
  const windowIntent = selectBestWindowMatch(
    candidate,
    context.indexes.intentsBySymbol.get(symbolKey) || [],
    context.matchWindowMs
  );
  const windowVerification = selectBestWindowMatch(
    candidate,
    context.indexes.verificationsBySymbol.get(symbolKey) || [],
    context.matchWindowMs
  );

  const exactIntentOutcome = normalizeOutcome(exactIntent?.outcome);
  if (isResolvedOutcome(exactIntentOutcome)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: exactIntentOutcome,
      source: 'execution_intent_prediction_id',
      matchedIntent: exactIntent,
      directionalReturnPct: exactIntent.close_pnl_pct,
      entryPrice: exactIntent.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const exactVerificationOutcome = normalizeOutcome(exactVerification?.outcome);
  if (isResolvedOutcome(exactVerificationOutcome)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: exactVerificationOutcome,
      source: 'velas_verificaciones_prediction_id',
      matchedVerification: exactVerification,
      directionalReturnPct: exactVerification.directional_return_pct,
      entryPrice: exactVerification.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const predictionCounterfactual = normalizeOutcome(prediction?.counterfactual_outcome);
  if (isResolvedOutcome(predictionCounterfactual)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: predictionCounterfactual,
      source: 'prediction_counterfactual',
      directionalReturnPct: prediction?.directional_return_pct,
      entryPrice: prediction?.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const predictionVerification = normalizeOutcome(prediction?.verification_outcome);
  if (isResolvedOutcome(predictionVerification)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: predictionVerification,
      source: 'prediction_verification',
      directionalReturnPct: prediction?.directional_return_pct,
      entryPrice: prediction?.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const windowIntentOutcome = normalizeOutcome(windowIntent?.outcome);
  if (isResolvedOutcome(windowIntentOutcome)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: windowIntentOutcome,
      source: 'execution_intent_window_match',
      matchedIntent: windowIntent,
      directionalReturnPct: windowIntent.close_pnl_pct,
      entryPrice: windowIntent.entry_price,
      matchDistanceSeconds: candidate.timestamp_ms && windowIntent?.timestamp_ms
        ? Math.abs(candidate.timestamp_ms - windowIntent.timestamp_ms) / 1000
        : null
    });
  }

  const windowVerificationOutcome = normalizeOutcome(windowVerification?.outcome);
  if (isResolvedOutcome(windowVerificationOutcome)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: windowVerificationOutcome,
      source: 'velas_verificaciones_window_match',
      matchedVerification: windowVerification,
      directionalReturnPct: windowVerification.directional_return_pct,
      entryPrice: windowVerification.entry_price,
      matchDistanceSeconds: candidate.timestamp_ms && windowVerification?.timestamp_ms
        ? Math.abs(candidate.timestamp_ms - windowVerification.timestamp_ms) / 1000
        : null
    });
  }

  if (Number.isFinite(prediction?.directional_return_pct)) {
    return finalizeResolvedRow(candidate, prediction, {
      outcome: directionallyClassifyReturn(prediction.directional_return_pct),
      source: 'prediction_directional_return',
      directionalReturnPct: prediction.directional_return_pct,
      entryPrice: prediction?.entry_price,
      matchDistanceSeconds: 0
    });
  }

  return finalizeResolvedRow(candidate, prediction, {
    outcome: 'UNKNOWN',
    source: 'unknown',
    entryPrice: prediction?.entry_price ?? candidate.entry_price,
    directionalReturnPct: null,
    matchDistanceSeconds: null
  });
}

function resolveHighSignal(signal, context) {
  const prediction = signal.prediction_id ? context.predictionsById.get(signal.prediction_id) || null : null;
  const exactIntent = chooseResolvedIntent(context.indexes.intentsByPredictionId.get(signal.prediction_id) || []);
  const exactVerification = chooseResolvedVerification(
    context.indexes.verificationsByPredictionId.get(signal.prediction_id) || []
  );
  const symbolKey = signal.binance_symbol || signal.symbol;
  const windowIntent = selectBestWindowMatch(
    signal,
    context.indexes.intentsBySymbol.get(symbolKey) || [],
    context.matchWindowMs
  );
  const windowVerification = selectBestWindowMatch(
    signal,
    context.indexes.verificationsBySymbol.get(symbolKey) || [],
    context.matchWindowMs
  );

  const exactIntentOutcome = normalizeOutcome(exactIntent?.outcome);
  if (isResolvedOutcome(exactIntentOutcome)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: exactIntentOutcome,
      source: 'execution_intent_prediction_id',
      matchedIntent: exactIntent,
      directionalReturnPct: exactIntent.close_pnl_pct,
      entryPrice: exactIntent.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const signalOutcome = normalizeOutcome(signal.verification_outcome);
  if (isResolvedOutcome(signalOutcome)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: signalOutcome,
      source: 'high_signal_verification',
      directionalReturnPct: prediction?.directional_return_pct,
      entryPrice: prediction?.entry_price ?? signal.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const exactVerificationOutcome = normalizeOutcome(exactVerification?.outcome);
  if (isResolvedOutcome(exactVerificationOutcome)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: exactVerificationOutcome,
      source: 'velas_verificaciones_prediction_id',
      matchedVerification: exactVerification,
      directionalReturnPct: exactVerification.directional_return_pct,
      entryPrice: exactVerification.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const predictionVerification = normalizeOutcome(prediction?.verification_outcome);
  if (isResolvedOutcome(predictionVerification)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: predictionVerification,
      source: 'prediction_verification',
      directionalReturnPct: prediction?.directional_return_pct,
      entryPrice: prediction?.entry_price ?? signal.entry_price,
      matchDistanceSeconds: 0
    });
  }

  const windowIntentOutcome = normalizeOutcome(windowIntent?.outcome);
  if (isResolvedOutcome(windowIntentOutcome)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: windowIntentOutcome,
      source: 'execution_intent_window_match',
      matchedIntent: windowIntent,
      directionalReturnPct: windowIntent.close_pnl_pct,
      entryPrice: windowIntent.entry_price,
      matchDistanceSeconds: signal.timestamp_ms && windowIntent?.timestamp_ms
        ? Math.abs(signal.timestamp_ms - windowIntent.timestamp_ms) / 1000
        : null
    });
  }

  const windowVerificationOutcome = normalizeOutcome(windowVerification?.outcome);
  if (isResolvedOutcome(windowVerificationOutcome)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: windowVerificationOutcome,
      source: 'velas_verificaciones_window_match',
      matchedVerification: windowVerification,
      directionalReturnPct: windowVerification.directional_return_pct,
      entryPrice: windowVerification.entry_price,
      matchDistanceSeconds: signal.timestamp_ms && windowVerification?.timestamp_ms
        ? Math.abs(signal.timestamp_ms - windowVerification.timestamp_ms) / 1000
        : null
    });
  }

  if (Number.isFinite(prediction?.directional_return_pct)) {
    return finalizeResolvedRow(signal, prediction, {
      outcome: directionallyClassifyReturn(prediction.directional_return_pct),
      source: 'prediction_directional_return',
      directionalReturnPct: prediction.directional_return_pct,
      entryPrice: prediction?.entry_price ?? signal.entry_price,
      matchDistanceSeconds: 0
    });
  }

  return finalizeResolvedRow(signal, prediction, {
    outcome: 'UNKNOWN',
    source: 'unknown',
    directionalReturnPct: null,
    entryPrice: prediction?.entry_price ?? signal.entry_price,
    matchDistanceSeconds: null
  });
}

function finalizeResolvedRow(base, prediction, resolution) {
  const entryPrice =
    resolution.entryPrice ??
    base.entry_price ??
    prediction?.entry_price ??
    null;
  const timestamp = base.timestamp || prediction?.timestamp || null;
  const confidenceValue =
    toNum(base.confidence_after) ??
    toNum(base.confidence) ??
    toNum(base.confidence_before) ??
    null;

  return {
    ...base,
    entry_price: entryPrice,
    timestamp,
    timestamp_ms: base.timestamp_ms || prediction?.timestamp_ms || null,
    outcome: resolution.outcome || 'UNKNOWN',
    resolution_source: resolution.source || 'unknown',
    resolution_type: classifyResolutionType(resolution.source || 'unknown'),
    directional_return_pct: Number.isFinite(resolution.directionalReturnPct)
      ? round(resolution.directionalReturnPct, 4)
      : null,
    matched_intent_id: resolution.matchedIntent?.intent_id || null,
    matched_verification_id: resolution.matchedVerification?.verification_id || null,
    matched_prediction_id: prediction?.prediction_id || base.prediction_id || null,
    match_distance_seconds: Number.isFinite(resolution.matchDistanceSeconds)
      ? round(resolution.matchDistanceSeconds, 2)
      : null,
    confidence_bucket: confidenceBucket(confidenceValue)
  };
}

function buildPerformanceMetrics(rows = []) {
  const wins = rows.filter((row) => row.outcome === 'WIN').length;
  const losses = rows.filter((row) => row.outcome === 'LOSS').length;
  const breakevens = rows.filter((row) => row.outcome === 'BREAKEVEN').length;
  const comparable = wins + losses;
  const unknown = rows.filter((row) => !isResolvedOutcome(row.outcome)).length;
  const winRate = comparable > 0 ? wins / comparable : null;
  const returns = rows.map((row) => row.directional_return_pct).filter((value) => Number.isFinite(value));
  const positiveReturns = returns.filter((value) => value > 0);
  const negativeReturns = returns.filter((value) => value < 0).map((value) => Math.abs(value));
  const expectancy = comparable > 0
    ? (winRate * (mean(positiveReturns) || 0)) - ((1 - winRate) * (mean(negativeReturns) || 0))
    : null;

  const resolutionSources = sortByTotalThenWinrate(
    Array.from(groupBy(rows, (row) => row.resolution_source).entries()).map(([source, sourceRows]) => {
      const sourceWins = sourceRows.filter((row) => row.outcome === 'WIN').length;
      const sourceLosses = sourceRows.filter((row) => row.outcome === 'LOSS').length;
      const sourceComparable = sourceWins + sourceLosses;
      return {
        source,
        total: sourceRows.length,
        resolved: sourceComparable,
        win_rate: sourceComparable > 0 ? sourceWins / sourceComparable : null
      };
    })
  );

  return {
    total: rows.length,
    resolved: comparable,
    wins,
    losses,
    breakevens,
    unknown,
    unknown_rate: rows.length ? unknown / rows.length : null,
    win_rate: winRate,
    win_rate_pct: pct(winRate),
    wilson_lower_bound: comparable > 0 ? round(wilsonLowerBound(wins, comparable), 4) : null,
    avg_return_pct: round(mean(returns), 4),
    median_return_pct: round(percentile(returns, 50), 4),
    p25_return_pct: round(percentile(returns, 25), 4),
    p75_return_pct: round(percentile(returns, 75), 4),
    avg_win_pct: round(mean(positiveReturns), 4),
    avg_loss_pct: round(mean(negativeReturns), 4),
    expectancy_pct: round(expectancy, 4),
    avg_confidence: round(mean(rows.map((row) => toNum(row.confidence_after) ?? toNum(row.confidence))), 4),
    avg_quantum: round(mean(rows.map((row) => toNum(row.quantum))), 4),
    avg_timing: round(mean(rows.map((row) => toNum(row.timing))), 4),
    avg_stability: round(mean(rows.map((row) => toNum(row.stability))), 4),
    direct_match_count: rows.filter((row) => row.resolution_source.includes('prediction_id')).length,
    resolution_sources: resolutionSources
  };
}

function buildMidBuckets(rows = []) {
  return sortByTotalThenWinrate(
    Array.from(groupBy(rows, (row) => row.confidence_bucket || 'unknown').entries()).map(([bucket, bucketRows]) => {
      const metrics = buildPerformanceMetrics(bucketRows);
      return {
        bucket,
        total: bucketRows.length,
        resolved: metrics.resolved,
        wins: metrics.wins,
        losses: metrics.losses,
        win_rate: metrics.win_rate,
        win_rate_pct: metrics.win_rate_pct,
        expectancy_pct: metrics.expectancy_pct,
        wilson_lower_bound: metrics.wilson_lower_bound,
        avg_return_pct: metrics.avg_return_pct
      };
    })
  );
}

function buildTopSymbols(rows = []) {
  return sortByTotalThenWinrate(
    Array.from(groupBy(rows, (row) => row.symbol || 'UNKNOWN').entries()).map(([symbol, symbolRows]) => {
      const metrics = buildPerformanceMetrics(symbolRows);
      return {
        symbol,
        total: symbolRows.length,
        resolved: metrics.resolved,
        win_rate: metrics.win_rate,
        win_rate_pct: metrics.win_rate_pct,
        expectancy_pct: metrics.expectancy_pct
      };
    })
  ).slice(0, 20);
}

function buildComparison(midMetrics, highMetrics) {
  const winRateDelta =
    Number.isFinite(midMetrics.win_rate) && Number.isFinite(highMetrics.win_rate)
      ? midMetrics.win_rate - highMetrics.win_rate
      : null;
  const expectancyDelta =
    Number.isFinite(midMetrics.expectancy_pct) && Number.isFinite(highMetrics.expectancy_pct)
      ? midMetrics.expectancy_pct - highMetrics.expectancy_pct
      : null;

  return {
    mid_win_rate_pct: midMetrics.win_rate_pct,
    high_win_rate_pct: highMetrics.win_rate_pct,
    win_rate_delta_pct_points: Number.isFinite(winRateDelta) ? round(winRateDelta * 100, 2) : null,
    mid_expectancy_pct: midMetrics.expectancy_pct,
    high_expectancy_pct: highMetrics.expectancy_pct,
    expectancy_delta_pct: Number.isFinite(expectancyDelta) ? round(expectancyDelta, 4) : null,
    mid_unknown_rate_pct: pct(midMetrics.unknown_rate),
    high_unknown_rate_pct: pct(highMetrics.unknown_rate)
  };
}

function buildMarketWindowComparison(midWindowMetrics = {}, highWindowMetrics = {}) {
  const keys = uniqueStrings([...Object.keys(midWindowMetrics), ...Object.keys(highWindowMetrics)]);
  return Object.fromEntries(
    keys.map((key) => {
      const mid = midWindowMetrics[key] || {};
      const high = highWindowMetrics[key] || {};
      const delta =
        Number.isFinite(mid.win_rate) && Number.isFinite(high.win_rate)
          ? mid.win_rate - high.win_rate
          : null;

      return [
        key,
        {
          mid_available_rows: mid.available_rows || 0,
          high_available_rows: high.available_rows || 0,
          mid_win_rate_pct: mid.win_rate_pct ?? null,
          high_win_rate_pct: high.win_rate_pct ?? null,
          win_rate_delta_pct_points: Number.isFinite(delta) ? round(delta * 100, 2) : null,
          mid_expectancy_pct: mid.expectancy_pct ?? null,
          high_expectancy_pct: high.expectancy_pct ?? null
        }
      ];
    })
  );
}

function buildPromotionDecision(midMetrics, highMetrics, bucketMetrics = []) {
  const reasons = [];
  const directEvidence = Number(midMetrics.direct_match_count || 0);

  if (midMetrics.total === 0) reasons.push('no_mid_confidence_candidates');
  if (midMetrics.resolved < PROMOTION_MIN_RESOLVED) reasons.push('insufficient_resolved_sample');
  if (Number.isFinite(midMetrics.unknown_rate) && midMetrics.unknown_rate > PROMOTION_MAX_UNKNOWN_RATE) {
    reasons.push('unknown_rate_too_high');
  }
  if (!Number.isFinite(midMetrics.win_rate)) reasons.push('mid_win_rate_unavailable');
  if (!Number.isFinite(midMetrics.expectancy_pct)) reasons.push('mid_expectancy_unavailable');
  if (Number.isFinite(midMetrics.expectancy_pct) && midMetrics.expectancy_pct <= PROMOTION_MIN_EXPECTANCY_PCT) {
    reasons.push('expectancy_not_positive');
  }
  if (Number.isFinite(midMetrics.win_rate) && midMetrics.win_rate < PROMOTION_MIN_WIN_RATE) {
    reasons.push('absolute_win_rate_below_floor');
  }
  if (
    Number.isFinite(midMetrics.win_rate) &&
    Number.isFinite(highMetrics.win_rate) &&
    midMetrics.win_rate < highMetrics.win_rate - PROMOTION_MAX_GAP_VS_HIGH
  ) {
    reasons.push('gap_vs_high_too_large');
  }
  if (Number.isFinite(midMetrics.wilson_lower_bound) && midMetrics.wilson_lower_bound < PROMOTION_MIN_WILSON) {
    reasons.push('wilson_lower_bound_too_low');
  }
  if (directEvidence < PROMOTION_MIN_DIRECT_MATCHES) {
    reasons.push('direct_match_evidence_too_low');
  }

  const eligibleBucket = bucketMetrics.find((bucket) => {
    if (bucket.resolved < PROMOTION_MIN_BUCKET_RESOLVED) return false;
    if (!Number.isFinite(bucket.win_rate) || !Number.isFinite(bucket.expectancy_pct)) return false;
    if (bucket.expectancy_pct <= PROMOTION_MIN_EXPECTANCY_PCT) return false;
    if (bucket.win_rate < PROMOTION_MIN_WIN_RATE) return false;
    if (
      Number.isFinite(highMetrics.win_rate) &&
      bucket.win_rate < highMetrics.win_rate - PROMOTION_MAX_GAP_VS_HIGH
    ) {
      return false;
    }
    if (Number.isFinite(bucket.wilson_lower_bound) && bucket.wilson_lower_bound < PROMOTION_MIN_WILSON) {
      return false;
    }
    return true;
  });

  const promote = reasons.length === 0;
  let recommendedStage = 'keep_collecting';
  if (promote) {
    recommendedStage = 'promote_mid_confidence';
  } else if (eligibleBucket) {
    recommendedStage = 'promote_best_bucket_only';
  } else if (
    midMetrics.resolved >= Math.max(5, Math.floor(PROMOTION_MIN_RESOLVED / 2)) &&
    Number.isFinite(midMetrics.expectancy_pct) &&
    midMetrics.expectancy_pct > PROMOTION_MIN_EXPECTANCY_PCT
  ) {
    recommendedStage = 'manual_prealert_or_shadow_mode';
  }

  return {
    promote_to_production: promote,
    recommended_stage: recommendedStage,
    reasons,
    strongest_bucket: eligibleBucket || null,
    evidence: {
      resolved_mid_samples: midMetrics.resolved,
      direct_match_samples: directEvidence,
      high_baseline_resolved: highMetrics.resolved
    },
    thresholds: {
      min_resolved: PROMOTION_MIN_RESOLVED,
      min_direct_matches: PROMOTION_MIN_DIRECT_MATCHES,
      min_bucket_resolved: PROMOTION_MIN_BUCKET_RESOLVED,
      min_win_rate: PROMOTION_MIN_WIN_RATE,
      max_gap_vs_high: PROMOTION_MAX_GAP_VS_HIGH,
      max_unknown_rate: PROMOTION_MAX_UNKNOWN_RATE,
      min_wilson_lower_bound: PROMOTION_MIN_WILSON,
      min_expectancy_pct: PROMOTION_MIN_EXPECTANCY_PCT
    }
  };
}

function summarizeCollections(midCandidates, highSignals, intents, verifications) {
  return {
    mid_confidence_candidates: midCandidates.length,
    high_conviction_signals: highSignals.length,
    binance_execution_intents: intents.length,
    velas_verificaciones: verifications.length
  };
}

async function run(options = {}) {
  const days = Math.max(1, Number(options.days || DEFAULT_DAYS));
  const maxDocs = Math.max(0, Number(options.maxDocs || DEFAULT_MAX_DOCS));
  const matchWindowMinutes = Math.max(
    1,
    Math.min(120, Number(options.matchWindowMinutes || DEFAULT_MATCH_WINDOW_MINUTES))
  );
  const marketInterval = String(options.marketInterval || DEFAULT_MARKET_INTERVAL).toLowerCase();
  const marketWindowsMinutes = Array.isArray(options.marketWindowsMinutes) && options.marketWindowsMinutes.length
    ? options.marketWindowsMinutes
    : DEFAULT_MARKET_WINDOWS_MINUTES;
  const writeFiles = options.writeFiles !== false;
  const reportJsonPath = options.reportJsonPath || REPORT_JSON_PATH;
  const reportCsvPath = options.reportCsvPath || REPORT_CSV_PATH;

  const [midCandidates, highSignals, intents, verifications, predictionAuditRows] = await Promise.all([
    loadMidConfidenceCandidates(days, maxDocs),
    loadHighConvictionSignals(days, maxDocs),
    loadExecutionIntents(days, maxDocs),
    loadVelasVerificaciones(days, maxDocs),
    loadPredictionAuditRows(days, maxDocs)
  ]);

  const predictionsById = await loadPredictionDocs([
    ...midCandidates.map((row) => row.prediction_id),
    ...highSignals.map((row) => row.prediction_id)
  ]);

  const context = {
    matchWindowMs: matchWindowMinutes * 60 * 1000,
    predictionsById,
    indexes: buildIndexes(intents, verifications)
  };

  const resolvedMidRowsBase = midCandidates.map((row) => resolveMidCandidate(row, context));
  const resolvedHighRowsBase = highSignals.map((row) => resolveHighSignal(row, context));
  const marketContext = await buildMarketWindowContext(
    [...resolvedMidRowsBase, ...resolvedHighRowsBase],
    {
      interval: marketInterval,
      windowsMinutes: marketWindowsMinutes
    }
  );
  const resolvedMidRows = attachMarketWindows(resolvedMidRowsBase, marketContext);
  const resolvedHighRows = attachMarketWindows(resolvedHighRowsBase, marketContext);

  const midMetrics = buildPerformanceMetrics(resolvedMidRows);
  const highMetrics = buildPerformanceMetrics(resolvedHighRows);
  const midMarketWindows = buildMarketWindowMetrics(resolvedMidRows, marketWindowsMinutes);
  const highMarketWindows = buildMarketWindowMetrics(resolvedHighRows, marketWindowsMinutes);
  const midBuckets = buildMidBuckets(resolvedMidRows);
  const topMidSymbols = buildTopSymbols(resolvedMidRows);
  const topHighSymbols = buildTopSymbols(resolvedHighRows);
  const comparison = buildComparison(midMetrics, highMetrics);
  comparison.market_windows = buildMarketWindowComparison(midMarketWindows, highMarketWindows);
  const promotionDecision = buildPromotionDecision(midMetrics, highMetrics, midBuckets);
  const predictionFunnel = buildPredictionFunnelDiagnostics(predictionAuditRows);

  const report = {
    generated_at: new Date().toISOString(),
    window_days: days,
    max_docs: maxDocs > 0 ? maxDocs : null,
    match_window_minutes: matchWindowMinutes,
    market_window_analysis: {
      interval: marketContext.interval,
      windows_minutes: marketContext.windows_minutes,
      lookback_days: marketContext.lookback_days,
      eligible_rows: marketContext.eligible_rows,
      fetched_symbols: marketContext.fetched_symbols,
      fetch_errors: marketContext.fetch_errors
    },
    collections_scanned: summarizeCollections(midCandidates, highSignals, intents, verifications),
    prediction_funnel: predictionFunnel,
    mid_confidence: {
      metrics: midMetrics,
      market_windows: midMarketWindows,
      by_confidence_bucket: midBuckets,
      top_symbols: topMidSymbols
    },
    high_confidence: {
      metrics: highMetrics,
      market_windows: highMarketWindows,
      top_symbols: topHighSymbols
    },
    comparison,
    promotion_decision: promotionDecision
  };

  const csvRows = resolvedMidRows.map((row) => ({
    candidate_id: row.candidate_id || null,
    prediction_id: row.prediction_id || null,
    symbol: row.symbol || null,
    timestamp: row.timestamp || null,
    direction: row.direction || null,
    entry_price: row.entry_price,
    outcome: row.outcome,
    resolution_source: row.resolution_source,
    resolution_type: row.resolution_type,
    matched_intent_id: row.matched_intent_id,
    matched_verification_id: row.matched_verification_id,
    match_distance_seconds: row.match_distance_seconds,
    directional_return_pct: row.directional_return_pct,
    confidence_before: row.confidence_before,
    confidence_after: row.confidence_after,
    confidence_bucket: row.confidence_bucket,
    quantum: row.quantum,
    timing: row.timing,
    stability: row.stability,
    suppression_reason: row.suppression_reason,
    reason: row.reason,
    ...Object.fromEntries(
      marketWindowsMinutes.flatMap((minutes) => {
        const key = marketWindowKey(minutes);
        const market = row.market_windows?.[key] || null;
        return [
          [`market_available_${key}`, Boolean(market?.available)],
          [`market_anchor_source_${key}`, market?.anchor_source || null],
          [`market_return_pct_${key}`, market?.return_pct ?? null],
          [`market_outcome_${key}`, market?.outcome || null]
        ];
      })
    )
  }));
  const csvHeaders = [
    'candidate_id',
    'prediction_id',
    'symbol',
    'timestamp',
    'direction',
    'entry_price',
    'outcome',
    'resolution_source',
    'resolution_type',
    'matched_intent_id',
    'matched_verification_id',
    'match_distance_seconds',
    'directional_return_pct',
    'confidence_before',
    'confidence_after',
    'confidence_bucket',
    'quantum',
    'timing',
    'stability',
    'suppression_reason',
    'reason',
    ...marketWindowsMinutes.flatMap((minutes) => {
      const key = marketWindowKey(minutes);
      return [
        `market_available_${key}`,
        `market_anchor_source_${key}`,
        `market_return_pct_${key}`,
        `market_outcome_${key}`
      ];
    })
  ];

  if (writeFiles) {
    fs.writeFileSync(reportJsonPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    fs.writeFileSync(reportCsvPath, buildCsv(csvRows, csvHeaders), 'utf8');
  }

  console.log('[MID_CONFIDENCE_EVALUATION]', {
    generated_at: report.generated_at,
    mid_total: midMetrics.total,
    mid_resolved: midMetrics.resolved,
    mid_win_rate_pct: midMetrics.win_rate_pct,
    high_total: highMetrics.total,
    high_resolved: highMetrics.resolved,
    high_win_rate_pct: highMetrics.win_rate_pct,
    market_interval: marketContext.interval,
    market_windows_minutes: marketContext.windows_minutes,
    recent_market_eligible_rows: marketContext.eligible_rows,
    recommended_stage: promotionDecision.recommended_stage,
    promote_to_production: promotionDecision.promote_to_production
  });

  if (promotionDecision.strongest_bucket) {
    console.log('[MID_CONFIDENCE_STRONGEST_BUCKET]', promotionDecision.strongest_bucket);
  }

  return {
    report,
    rows: resolvedMidRows
  };
}

if (require.main === module) {
  run()
    .then(() => process.exit(0))
    .catch((error) => {
      console.error('[MID_CONFIDENCE_EVALUATION_ERROR]', error?.stack || error?.message || error);
      process.exit(1);
    });
}

module.exports = { run };
