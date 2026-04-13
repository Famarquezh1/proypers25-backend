const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { getBinanceBotConfig } = require('./binanceBotConfig');
const { loadAdaptiveExecutionProfile } = require('./adaptive_calibration_engine');
const {
  evaluateEntryDiscipline,
  evaluateFilledOrderDiscipline,
  logExecutionDiscipline
} = require('./execution_discipline_engine');
const {
  buildInitialExecutionTrace,
  advanceExecutionTrace,
  persistExecutionLatencyObservation
} = require('./execution_latency_engine');
const {
  ensureSymbolObservation,
  releaseSymbolObservation,
  getMarketSnapshot
} = require('../services/market/marketStreamWorker');
const {
  normalizeToBinance,
  normalizeToInternal,
  isValidBinanceFuturesSymbol
} = require('../services/utils/symbolNormalizer');
const {
  resolveExecutionGuardConfig,
  resolveSignalTimestamp,
  resolveSnapshotTimestamp,
  evaluateExecutionGuard
} = require('../services/execution/executionGuard');
const {
  INTENT_STAGE_TIMEOUT_MS,
  withTimeout,
  markIntentFailed,
  updateIntentProcessingStage
} = require('../services/execution/intentWatchdog');
const { syncPredictionExecutionState } = require('../services/execution/predictionExecutionSync');

const BINANCE_EXECUTION_ENABLED = process.env.BINANCE_EXECUTION_ENABLED === 'true';
const BINANCE_EXECUTION_DRY_RUN = String(process.env.BINANCE_EXECUTION_DRY_RUN || '').toLowerCase() === 'true';
const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BINANCE_API_KEY = resolveBinanceCredential(
  process.env.BINANCE_API_KEY,
  process.env.BINANCE_FUTURES_API_KEY,
  process.env.BINANCE_KEY,
  process.env.BINANCE_APIKEY
);
const BINANCE_API_SECRET = resolveBinanceCredential(
  process.env.BINANCE_API_SECRET,
  process.env.BINANCE_FUTURES_API_SECRET,
  process.env.BINANCE_SECRET_KEY,
  process.env.BINANCE_SECRET
);
const BINANCE_SIGNED_TIMESTAMP_SAFETY_MS = Math.max(
  0,
  Number(process.env.BINANCE_SIGNED_TIMESTAMP_SAFETY_MS || 350)
);
const BINANCE_SIGNED_RECV_WINDOW_MS = Math.max(
  5000,
  Number(process.env.BINANCE_SIGNED_RECV_WINDOW_MS || 10000)
);
const BINANCE_DEFAULT_LEVERAGE = Math.max(1, Number(process.env.BINANCE_DEFAULT_LEVERAGE || 5));
const BINANCE_TRADE_NOTIONAL_USDT = Math.max(5, Number(process.env.BINANCE_TRADE_NOTIONAL_USDT || 35));
const BINANCE_MIN_CONFIDENCE = Number(process.env.BINANCE_EXEC_MIN_CONFIDENCE || 0.9);
const BINANCE_MIN_QUANTUM = Number(process.env.BINANCE_EXEC_MIN_QUANTUM || 0.85);
const BINANCE_MIN_TIMING = Number(process.env.BINANCE_EXEC_MIN_TIMING || 0.8);
const BINANCE_EVENT_MIN_CONFIDENCE = Math.max(
  BINANCE_MIN_CONFIDENCE,
  Number(process.env.BINANCE_EVENT_MIN_CONFIDENCE || 0.9)
);
const BINANCE_EVENT_MIN_QUANTUM = Math.max(
  BINANCE_MIN_QUANTUM,
  Number(process.env.BINANCE_EVENT_MIN_QUANTUM || 0.96)
);
const BINANCE_EVENT_MIN_TIMING = Math.max(
  BINANCE_MIN_TIMING,
  Number(process.env.BINANCE_EVENT_MIN_TIMING || 0.88)
);
const BINANCE_EVENT_MIN_EXPECTED_MOVE_PCT = Math.max(
  0,
  Number(process.env.BINANCE_EVENT_MIN_EXPECTED_MOVE_PCT || 1)
);
const BINANCE_EVENT_MIN_RISK_REWARD = Math.max(
  0.1,
  Number(process.env.BINANCE_EVENT_MIN_RISK_REWARD || 1.35)
);
const BINANCE_EVENT_POSITION_SIZE_FACTOR = Math.min(
  1,
  Math.max(0.2, Number(process.env.BINANCE_EVENT_POSITION_SIZE_FACTOR || 0.55))
);
const BINANCE_EVENT_MAX_NOTIONAL_USDT = Math.max(
  5,
  Number(process.env.BINANCE_EVENT_MAX_NOTIONAL_USDT || 18)
);
const BINANCE_HC_MIN_CONFIDENCE = Math.max(
  BINANCE_MIN_CONFIDENCE,
  Number(process.env.BINANCE_HC_MIN_CONFIDENCE || 0.97)
);
const BINANCE_HC_MIN_QUANTUM = Math.max(
  BINANCE_MIN_QUANTUM,
  Number(process.env.BINANCE_HC_MIN_QUANTUM || 0.88)
);
const BINANCE_HC_MIN_TIMING = Math.max(
  BINANCE_MIN_TIMING,
  Number(process.env.BINANCE_HC_MIN_TIMING || 0.78)
);
const BINANCE_HC_MIN_EXPECTED_MOVE_PCT = Math.max(
  0,
  Number(process.env.BINANCE_HC_MIN_EXPECTED_MOVE_PCT || 0.45)
);
const BINANCE_HC_MIN_RISK_REWARD = Math.max(
  0.1,
  Number(process.env.BINANCE_HC_MIN_RISK_REWARD || 1.5)
);
const BINANCE_HC_MIN_LIVE_NOTIONAL_USDT = Math.max(
  5,
  Number(process.env.BINANCE_HC_MIN_LIVE_NOTIONAL_USDT || 20)
);
const BINANCE_EVENT_EMITTED_OBSERVE_MODE =
  String(process.env.BINANCE_EVENT_EMITTED_OBSERVE_MODE || 'true').toLowerCase() === 'true';
const BINANCE_MANUAL_PREALERT_OBSERVE_MODE =
  String(process.env.BINANCE_MANUAL_PREALERT_OBSERVE_MODE || 'true').toLowerCase() === 'true';
const SOURCE_PROFILE_KEYS = new Set(['high_conviction', 'event_emitted', 'manual_prealert']);
const EXCHANGE_INFO_TTL_MS = 10 * 60 * 1000;
const exchangeInfoCache = new Map();
const exchangeInfoInflight = new Map();
let exchangeInfoSnapshotCache = {
  symbolsByName: null,
  fetchedAt: 0
};
let exchangeInfoSnapshotInflight = null;
const leverageBracketCache = new Map();
const leverageBracketInflight = new Map();
const BINANCE_TIME_SYNC_TTL_MS = Math.max(30 * 1000, Number(process.env.BINANCE_TIME_SYNC_TTL_MS || 5 * 60 * 1000));
let binanceTimeOffsetMs = 0;
let binanceTimeOffsetFetchedAt = 0;
const BINANCE_POSITION_MAX_HOLD_MINUTES = Math.max(
  1,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10)
);
const BINANCE_POSITION_MAX_HOLD_MINUTES_HIGH_CONVICTION = Math.max(
  BINANCE_POSITION_MAX_HOLD_MINUTES,
  Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES_HIGH_CONVICTION || 20)
);
const BINANCE_BOT_CONFIG_CACHE_TTL_MS = Math.max(1000, Number(process.env.BINANCE_BOT_CONFIG_CACHE_TTL_MS || 5000));
const EXECUTION_VALIDATION_CACHE_TTL_MS = Math.max(1000, Number(process.env.EXECUTION_VALIDATION_CACHE_TTL_MS || 5000));
const RECENT_RECORDS_CACHE_TTL_MS = Math.max(1000, Number(process.env.RECENT_RECORDS_CACHE_TTL_MS || 30000));
const BINANCE_BALANCE_CACHE_TTL_MS = Math.max(
  5000,
  Number(process.env.BINANCE_BALANCE_CACHE_TTL_MS || 30000)
);
const BINANCE_INCOME_CACHE_TTL_MS = Math.max(
  5000,
  Number(process.env.BINANCE_INCOME_CACHE_TTL_MS || 60000)
);
const BINANCE_FETCH_RETRY_ATTEMPTS = Math.max(
  1,
  Math.min(3, Number(process.env.BINANCE_FETCH_RETRY_ATTEMPTS || 2))
);
const BINANCE_FETCH_RETRY_DELAY_MS = Math.max(
  100,
  Number(process.env.BINANCE_FETCH_RETRY_DELAY_MS || 350)
);
const POSITION_HOLD_MIN_SECONDS = Math.max(60, Number(process.env.BINANCE_POSITION_MIN_HOLD_SECONDS || 120));
const POSITION_HOLD_MULTIPLIER = Math.max(1, Number(process.env.BINANCE_POSITION_SIGNAL_HOLD_MULTIPLIER || 3));
const POSITION_HOLD_MULTIPLIER_HIGH_CONVICTION = Math.max(
  POSITION_HOLD_MULTIPLIER,
  Number(process.env.BINANCE_POSITION_SIGNAL_HOLD_MULTIPLIER_HIGH_CONVICTION || 4)
);
const MANUAL_PREALERT_TIMESTAMP_DRIFT_MS = Math.max(
  5000,
  Number(process.env.MANUAL_PREALERT_TIMESTAMP_DRIFT_MS || 15000)
);
const BINANCE_PUBLIC_FETCH_TIMEOUT_MS = Math.max(
  3000,
  Number(process.env.BINANCE_PUBLIC_FETCH_TIMEOUT_MS || 6000)
);
const BINANCE_PUBLIC_FETCH_RETRY_TIMEOUT_MS = Math.max(
  BINANCE_PUBLIC_FETCH_TIMEOUT_MS,
  Number(process.env.BINANCE_PUBLIC_FETCH_RETRY_TIMEOUT_MS || 12000)
);
const BINANCE_LIVE_ORDER_TIMEOUT_MS = Math.max(
  INTENT_STAGE_TIMEOUT_MS,
  Number(process.env.BINANCE_LIVE_ORDER_TIMEOUT_MS || 20000)
);
const BINANCE_PROTECTIVE_ORDER_TIMEOUT_MS = Math.max(
  INTENT_STAGE_TIMEOUT_MS,
  Number(process.env.BINANCE_PROTECTIVE_ORDER_TIMEOUT_MS || 15000)
);
let botConfigCache = { value: null, fetchedAt: 0 };
const validationQueryCache = new Map();
const futuresBalanceCache = new Map();
const futuresIncomeCache = new Map();
const marginSetupCache = new Map();
const binanceAuthState = {
  invalid: false,
  code: null,
  message: null,
  path: null,
  lastErrorAt: null
};

function resolveBinanceCredential(...candidates) {
  for (const candidate of candidates) {
    if (candidate == null) continue;
    const sanitized = String(candidate)
      .trim()
      .replace(/^['"]+|['"]+$/g, '')
      .replace(/\r/g, '')
      .replace(/\n/g, '')
      .trim();
    if (sanitized) return sanitized;
  }
  return '';
}
function parseDateLike(value) {
  if (!value) return null;
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null;
  }
  if (value && typeof value.toDate === 'function') {
    const d = value.toDate();
    return Number.isFinite(d?.getTime?.()) ? d : null;
  }
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d : null;
}

function getCacheValue(cacheKey, ttlMs) {
  const hit = validationQueryCache.get(cacheKey);
  if (!hit) return null;
  if (Date.now() - hit.fetchedAt > ttlMs) {
    validationQueryCache.delete(cacheKey);
    return null;
  }
  return hit.value;
}

function getStaleCacheEntry(cacheKey) {
  const hit = validationQueryCache.get(cacheKey);
  return hit && hit.value != null ? hit : null;
}

function setCacheValue(cacheKey, value) {
  validationQueryCache.set(cacheKey, {
    value,
    fetchedAt: Date.now()
  });
  return value;
}

function toIsoOrNull(dateLike) {
  const d = parseDateLike(dateLike);
  return d ? d.toISOString() : null;
}

function combineUtcDateAndHms(baseDate, hms) {
  if (!baseDate || !hms || typeof hms !== 'string') return null;
  const match = hms.match(/^(\d{2}):(\d{2}):(\d{2})$/);
  if (!match) return null;
  const out = new Date(baseDate);
  out.setUTCHours(Number(match[1]), Number(match[2]), Number(match[3]), 0);
  return Number.isFinite(out.getTime()) ? out : null;
}

function resolveSignalAt(signalData) {
  return parseDateLike(
    signalData?.signal_at ||
      signalData?.created_at ||
      signalData?.timestamp ||
      signalData?.ahora ||
      signalData?.entry_time ||
      signalData?.entry_window_start_at
  );
}

function resolveWindowEndAt(signalData, signalAt) {
  const direct =
    parseDateLike(signalData?.entry_window_end_at) ||
    parseDateLike(signalData?.window_end_at) ||
    parseDateLike(signalData?.entry_window_ends_at);
  if (direct) return direct;

  const hms =
    signalData?.entry_window_utc?.end ||
    signalData?.entry_window?.end ||
    signalData?.window_utc?.end;
  if (!hms || !signalAt) return null;
  return combineUtcDateAndHms(signalAt, hms);
}

function addSeconds(dateLike, seconds) {
  const base = parseDateLike(dateLike);
  if (!base || !Number.isFinite(seconds)) return null;
  return new Date(base.getTime() + seconds * 1000);
}

function normalizeSignalDataForExecution(signalData = {}, sourceProfile, receivedAtIso) {
  const fallbackIso = receivedAtIso || new Date().toISOString();
  if (sourceProfile !== 'manual_prealert') {
    return {
      ...signalData,
      pipeline_type: sourceProfile,
      signal_emitted_at:
        signalData?.signal_emitted_at || signalData?.emitted_at || signalData?.timestamp || fallbackIso,
      timestamp: signalData?.timestamp || fallbackIso
    };
  }

  const receivedAt = parseDateLike(fallbackIso) || new Date();
  const prealertAnchor =
    parseDateLike(signalData?.manual_prealert_generated_at) ||
    parseDateLike(signalData?.prealert_generated_at) ||
    parseDateLike(signalData?.generated_at) ||
    parseDateLike(signalData?.signal_emitted_at) ||
    parseDateLike(signalData?.emitted_at) ||
    parseDateLike(signalData?.ahora) ||
    receivedAt;

  const rawSignalAt = resolveSignalAt(signalData);
  const normalizedSignalAt =
    !rawSignalAt || Math.abs(prealertAnchor.getTime() - rawSignalAt.getTime()) > MANUAL_PREALERT_TIMESTAMP_DRIFT_MS
      ? prealertAnchor
      : rawSignalAt;

  const normalizedWindowStart =
    parseDateLike(signalData?.entry_window_start_at) ||
    parseDateLike(signalData?.entry_window?.start) ||
    normalizedSignalAt;
  let normalizedWindowEnd = resolveWindowEndAt(signalData, normalizedSignalAt);
  if (!normalizedWindowEnd || normalizedWindowEnd.getTime() < normalizedSignalAt.getTime()) {
    normalizedWindowEnd = addSeconds(normalizedSignalAt, Number(process.env.ENTRY_WINDOW_SECONDS || 30));
  }

  return {
    ...signalData,
    pipeline_type: 'manual_prealert',
    signal_created_at: toIsoOrNull(normalizedSignalAt),
    signal_emitted_at: toIsoOrNull(prealertAnchor),
    emitted_at: toIsoOrNull(prealertAnchor),
    timestamp: toIsoOrNull(normalizedSignalAt),
    created_at: signalData?.created_at || toIsoOrNull(normalizedSignalAt),
    ahora: signalData?.ahora || toIsoOrNull(prealertAnchor),
    entry_window_start_at: toIsoOrNull(normalizedWindowStart),
    entry_window_end_at: toIsoOrNull(normalizedWindowEnd)
  };
}

function normalizeModelOutcome(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'PENDING';
  if (value.includes('WIN') || value.includes('VALIDADO')) return 'WIN';
  if (value.includes('LOSS') || value.includes('FAIL')) return 'LOSS';
  if (value.includes('SUPRIMIDA')) return 'SUPPRESSED';
  if (value.includes('PEND')) return 'PENDING';
  return value;
}

async function getCachedBinanceBotConfig(db) {
  const now = Date.now();
  if (botConfigCache.fetchedAt && now - botConfigCache.fetchedAt < BINANCE_BOT_CONFIG_CACHE_TTL_MS && botConfigCache.value) {
    return botConfigCache.value;
  }
  const value = await getBinanceBotConfig(db);
  botConfigCache = {
    value,
    fetchedAt: now
  };
  return value;
}

function buildExecutionAudit(signalData, executedAt = null) {
  const signalAt = resolveSignalAt(signalData);
  const windowEndAt = resolveWindowEndAt(signalData, signalAt);
  const executed = parseDateLike(executedAt);

  const delaySeconds =
    signalAt && executed ? Number(((executed.getTime() - signalAt.getTime()) / 1000).toFixed(3)) : null;
  const remainingSeconds =
    windowEndAt && executed ? Number(((windowEndAt.getTime() - executed.getTime()) / 1000).toFixed(3)) : null;

  let isLateEntry = null;
  if (windowEndAt && executed) {
    isLateEntry = executed.getTime() > windowEndAt.getTime();
  }

  return {
    signal_at: toIsoOrNull(signalAt),
    executed_at: toIsoOrNull(executed),
    window_end_at: toIsoOrNull(windowEndAt),
    delay_seconds: delaySeconds,
    window_remaining_seconds_at_execution: remainingSeconds,
    is_late_entry: isLateEntry,
    win_model: normalizeModelOutcome(signalData?.verification_outcome || signalData?.status),
    win_exchange: null
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, Number(ms || 0))));
}

function logLiveStageTiming({ stage, startedAtMs, symbol = null, predictionId = null, extra = {} } = {}) {
  const durationMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
  console.info('[PREALERT_STAGE_TIMING]', {
    stage,
    duration_ms: durationMs,
    symbol,
    prediction_id: predictionId,
    ...extra
  });
  return durationMs;
}

function sanitizeBinanceErrorMessage(message) {
  return String(message || '')
    .replace(BINANCE_API_KEY, '[REDACTED_API_KEY]')
    .replace(BINANCE_API_SECRET, '[REDACTED_API_SECRET]');
}

function maskCredential(value = '') {
  const raw = String(value || '');
  if (!raw) return null;
  if (raw.length <= 8) return `${raw.slice(0, 2)}***`;
  return `${raw.slice(0, 4)}***${raw.slice(-4)}`;
}

function parseBinanceError(bodyText = '') {
  try {
    const body = JSON.parse(bodyText);
    return {
      code: Number(body?.code),
      msg: String(body?.msg || body?.message || '')
    };
  } catch (_) {
    return {
      code: null,
      msg: String(bodyText || '')
    };
  }
}

function isBinanceAuthInvalidError(err) {
  const code = Number(err?.binanceCode ?? err?.code ?? NaN);
  const message = String(err?.message || '');
  return code === -2014 || code === -2015 || message.includes('"code":-2014') || message.includes('"code":-2015');
}

function setBinanceAuthInvalid(err, path) {
  const message = sanitizeBinanceErrorMessage(err?.message || err);
  binanceAuthState.invalid = true;
  binanceAuthState.code = Number(err?.binanceCode ?? err?.code ?? NaN) || null;
  binanceAuthState.message = message;
  binanceAuthState.path = path || null;
  binanceAuthState.lastErrorAt = new Date().toISOString();
  console.error('[BINANCE_API_AUTH_ERROR]', {
    path: path || null,
    code: binanceAuthState.code,
    message,
    api_key: maskCredential(BINANCE_API_KEY)
  });
}

function clearBinanceAuthInvalid() {
  binanceAuthState.invalid = false;
  binanceAuthState.code = null;
  binanceAuthState.message = null;
  binanceAuthState.path = null;
  binanceAuthState.lastErrorAt = null;
}

async function withFetchRetry(taskFactory, options = {}) {
  const attempts = Math.max(1, Number(options.attempts || BINANCE_FETCH_RETRY_ATTEMPTS));
  const label = options.label || 'fetch';
  const retryDelayMs = Math.max(0, Number(options.retryDelayMs || BINANCE_FETCH_RETRY_DELAY_MS));
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await taskFactory(attempt);
    } catch (err) {
      lastErr = err;
      const shouldRetry = attempt < attempts && (options.retryOn ? options.retryOn(err) : isTimeoutLikeError(err));
      console.warn('[FETCH_TIMEOUT]', {
        label,
        attempt,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
      if (!shouldRetry) break;
      console.warn('[FETCH_RETRY]', {
        label,
        attempt,
        next_attempt: attempt + 1,
        delay_ms: retryDelayMs
      });
      if (retryDelayMs > 0) {
        await sleep(retryDelayMs);
      }
    }
  }
  throw lastErr;
}

function isSnapshotFresh(snapshot, maxStalenessMs) {
  const snapshotTime = resolveSnapshotTimestamp(snapshot);
  if (!snapshotTime) return false;
  return Date.now() - snapshotTime.getTime() <= Math.max(1000, Number(maxStalenessMs || 0));
}

async function fetchPersistedMarketSnapshot(db, symbol) {
  if (!db || !symbol) return null;
  try {
    const doc = await db.collection('market_microstructure_snapshots').doc(String(symbol).toUpperCase()).get();
    if (!doc.exists) return null;
    const data = doc.data() || {};
    const snapshot = data.snapshot && typeof data.snapshot === 'object'
      ? { ...data.snapshot }
      : null;
    if (!snapshot) return null;
    if (!snapshot.published_at && data.published_at) {
      snapshot.published_at = data.published_at;
    }
    return snapshot;
  } catch (_) {
    return null;
  }
}

async function resolveExecutionSnapshot(db, symbol, botConfig = {}) {
  const guardConfig = resolveExecutionGuardConfig(botConfig);
  const pollIntervalMs = Math.max(100, Number(guardConfig.snapshot_poll_interval_ms || 200));
  const deadline = Date.now() + Math.max(0, Number(guardConfig.snapshot_wait_ms || 0));
  let snapshot = getMarketSnapshot(symbol);

  while (
    (!snapshot || !isSnapshotFresh(snapshot, guardConfig.max_snapshot_staleness_ms)) &&
    Date.now() < deadline
  ) {
    await sleep(pollIntervalMs);
    snapshot = getMarketSnapshot(symbol);
  }

  if (snapshot && isSnapshotFresh(snapshot, guardConfig.max_snapshot_staleness_ms)) {
    return snapshot;
  }

  const persisted = await fetchPersistedMarketSnapshot(db, symbol);
  if (persisted && isSnapshotFresh(persisted, guardConfig.max_snapshot_staleness_ms * 2)) {
    console.warn('[STALE_SNAPSHOT_USED]', {
      symbol,
      source: 'persisted_snapshot',
      snapshot_at: persisted?.snapshot_at || persisted?.published_at || null
    });
    console.warn('[FETCH_FALLBACK_USED]', {
      label: 'execution_snapshot',
      symbol,
      source: 'persisted_snapshot',
      live_snapshot_available: Boolean(snapshot),
      live_snapshot_fresh: Boolean(snapshot && isSnapshotFresh(snapshot, guardConfig.max_snapshot_staleness_ms))
    });
    console.info('[EXECUTION_WITH_FALLBACK]', {
      symbol,
      source: 'persisted_snapshot',
      snapshot_at: persisted?.snapshot_at || persisted?.published_at || null
    });
    return persisted;
  }

  if (snapshot || persisted) {
    console.warn('[STALE_SNAPSHOT_USED]', {
      symbol,
      source: snapshot ? 'stale_live_snapshot' : 'stale_persisted_snapshot',
      snapshot_at:
        snapshot?.snapshot_at ||
        snapshot?.published_at ||
        persisted?.snapshot_at ||
        persisted?.published_at ||
        null
    });
    console.warn('[FETCH_FALLBACK_USED]', {
      label: 'execution_snapshot',
      symbol,
      source: snapshot ? 'stale_live_snapshot' : 'stale_persisted_snapshot'
    });
  }
  return snapshot || persisted || null;
}

function buildEntrySnapshotPersistence(guardResult, liveEntryPrice = null, expectedEntryPrice = null) {
  const microstructure = guardResult?.microstructure || {};
  const executionReferencePrice =
    Number(microstructure.execution_reference_price || liveEntryPrice || 0) || null;
  return {
    signal_timestamp: guardResult?.signalTimestamp || null,
    signal_age_ms: Number.isFinite(Number(guardResult?.signalAgeMs)) ? Number(guardResult.signalAgeMs) : null,
    signal_expiration_ms: Number.isFinite(Number(guardResult?.signalExpirationMs))
      ? Number(guardResult.signalExpirationMs)
      : null,
    signal_price: Number.isFinite(Number(guardResult?.signalPrice)) ? Number(guardResult.signalPrice) : null,
    expected_entry_price: Number.isFinite(Number(expectedEntryPrice)) ? Number(expectedEntryPrice) : null,
    execution_reference_price: executionReferencePrice,
    execution_price: Number.isFinite(Number(liveEntryPrice)) ? Number(liveEntryPrice) : executionReferencePrice,
    price_deviation_pct: Number.isFinite(Number(guardResult?.priceDeviationPct))
      ? Number(guardResult.priceDeviationPct)
      : null,
    estimated_slippage_pct: Number.isFinite(Number(guardResult?.estimatedSlippagePct))
      ? Number(guardResult.estimatedSlippagePct)
      : null,
    entry_quality_score: Number.isFinite(Number(guardResult?.entryQualityScore))
      ? Number(guardResult.entryQualityScore)
      : null,
    entry_quality_threshold: Number.isFinite(Number(guardResult?.qualityThreshold))
      ? Number(guardResult.qualityThreshold)
      : null,
    entry_quality_components: guardResult?.entryQualityComponents || null,
    negative_signals: Number.isFinite(Number(guardResult?.negativeSignals))
      ? Number(guardResult.negativeSignals)
      : null,
    momentum_aligned: Boolean(guardResult?.momentumAligned),
    deterioration_detected: Boolean(guardResult?.deteriorationDetected),
    strong_stall: Boolean(guardResult?.strongStall),
    snapshot_age_ms: Number.isFinite(Number(guardResult?.snapshotAgeMs)) ? Number(guardResult.snapshotAgeMs) : null,
    snapshot_available: Boolean(guardResult?.snapshotAvailable),
    snapshot_fresh: Boolean(guardResult?.snapshotFresh),
    microstructure: {
      last_price: Number.isFinite(Number(microstructure.last_price)) ? Number(microstructure.last_price) : null,
      bid: Number.isFinite(Number(microstructure.bid)) ? Number(microstructure.bid) : null,
      ask: Number.isFinite(Number(microstructure.ask)) ? Number(microstructure.ask) : null,
      spread_bps: Number.isFinite(Number(microstructure.spread_bps)) ? Number(microstructure.spread_bps) : null,
      recent_trades_window: Number.isFinite(Number(microstructure.recent_trades_window))
        ? Number(microstructure.recent_trades_window)
        : 0,
      velocity: Number.isFinite(Number(microstructure.velocity)) ? Number(microstructure.velocity) : null,
      acceleration: Number.isFinite(Number(microstructure.acceleration))
        ? Number(microstructure.acceleration)
        : null,
      imbalance: Number.isFinite(Number(microstructure.imbalance)) ? Number(microstructure.imbalance) : null,
      micro_high: Number.isFinite(Number(microstructure.micro_high)) ? Number(microstructure.micro_high) : null,
      micro_low: Number.isFinite(Number(microstructure.micro_low)) ? Number(microstructure.micro_low) : null,
      snapshot_at: microstructure.snapshot_at || null,
      price_history_points: Number.isFinite(Number(microstructure.price_history_points))
        ? Number(microstructure.price_history_points)
        : null,
      velocity_history_points: Number.isFinite(Number(microstructure.velocity_history_points))
        ? Number(microstructure.velocity_history_points)
        : null
    }
  };
}

function toNum(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function sanitizeIntentDocIdPart(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 120);
}

function buildIntentDocRef(db, predictionId, sourceProfile) {
  if (predictionId) {
    const docId = `${sanitizeIntentDocIdPart(predictionId)}__${sanitizeIntentDocIdPart(sourceProfile || 'default')}`;
    return db.collection('binance_execution_intents').doc(docId);
  }
  return db.collection('binance_execution_intents').doc();
}

async function writeIntentDoc(ref, payload = {}) {
  if (!ref) return;
  await ref.set(
    {
      ...payload,
      updated_at: FieldValue.serverTimestamp()
    },
    { merge: true }
  );
}

async function syncPredictionTerminalState(db, {
  predictionId,
  sourceProfile,
  status,
  reason,
  dryRun = false,
  executed = false,
  orderId = null,
  tracePayload = null,
  symbol = null,
  failureStage = null,
  errorMessage = null,
  pendingStateResolution = 'binance_terminal_sync'
} = {}) {
  if (!predictionId || !status) return;
  await syncPredictionExecutionState(db, {
    predictionId,
    sourceProfile,
    status,
    reason,
    dryRun,
    executed,
    orderId,
    traceId: tracePayload?.trace_id || null,
    symbol,
    failureStage,
    errorMessage,
    pendingStateResolution
  });
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  if (max < min) return min;
  return Math.max(min, Math.min(max, value));
}

function resolveExpectedDurationWindow(signalData = {}) {
  const raw =
    signalData?.expected_duration_seconds ??
    signalData?.window_seconds ??
    signalData?.trade_plan?.expected_duration_seconds ??
    signalData?.event_driven_info?.impulseDurationSeconds ??
    signalData?.max_duration_seconds ??
    null;

  if (raw && typeof raw === 'object') {
    const min = toNum(raw.min, null);
    const max = toNum(raw.max, null);
    return {
      min: Number.isFinite(min) ? min : null,
      max: Number.isFinite(max) ? max : Number.isFinite(min) ? min : null
    };
  }

  const single = toNum(raw, null);
  return {
    min: Number.isFinite(single) ? single : null,
    max: Number.isFinite(single) ? single : null
  };
}

function resolvePositionMaxHoldSeconds({ signalData = {}, adaptiveProfile = null }) {
  const sourceProfile = String(signalData?.source_profile || signalData?.source || 'event_emitted').toLowerCase();
  const expectedWindow = resolveExpectedDurationWindow(signalData);
  const expectedMax = Number(expectedWindow?.max || 0);
  const adaptiveHorizon = Number(
    adaptiveProfile?.adaptive_horizon_seconds ?? adaptiveProfile?.adaptive_horizon ?? 0
  );
  const globalMaxMinutes =
    sourceProfile === 'high_conviction'
      ? BINANCE_POSITION_MAX_HOLD_MINUTES_HIGH_CONVICTION
      : BINANCE_POSITION_MAX_HOLD_MINUTES;
  const globalMax = globalMaxMinutes * 60;
  const holdMultiplier =
    sourceProfile === 'high_conviction'
      ? POSITION_HOLD_MULTIPLIER_HIGH_CONVICTION
      : POSITION_HOLD_MULTIPLIER;

  if (expectedMax > 0) {
    const expectedWindowBased = expectedMax * holdMultiplier;
    return Math.round(clamp(expectedWindowBased, POSITION_HOLD_MIN_SECONDS, globalMax));
  }
  if (adaptiveHorizon > 0) {
    return Math.round(clamp(adaptiveHorizon, POSITION_HOLD_MIN_SECONDS, globalMax));
  }
  return globalMax;
}

function normalizePercent(value) {
  const n = Number(value ?? 0);
  if (!Number.isFinite(n)) return 0;
  return n > 1 ? n / 100 : n;
}

function toBinanceSymbol(symbol) {
  return normalizeToBinance(symbol);
}

function toSystemUsdSymbol(binanceSymbol) {
  return normalizeToInternal(binanceSymbol);
}

function getOrderSide(direction) {
  if (direction === 'up') return 'BUY';
  if (direction === 'down') return 'SELL';
  return null;
}

function createSignature(queryString) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = BINANCE_PUBLIC_FETCH_TIMEOUT_MS) {
  return fetch(url, {
    ...options,
    signal: AbortSignal.timeout(timeoutMs)
  });
}

function isTimeoutLikeError(err) {
  const message = String(err?.message || err || '');
  const name = String(err?.name || '');
  return (
    name.includes('Timeout') ||
    message.includes('TimeoutError') ||
    message.toLowerCase().includes('aborted due to timeout')
  );
}

function isRetryableFetchError(err) {
  const code = String(err?.code || '').toLowerCase();
  const message = String(err?.message || err || '').toLowerCase();
  return (
    isTimeoutLikeError(err) ||
    code === 'deadline-exceeded' ||
    code === 'unavailable' ||
    code === 'aborted' ||
    code === 'resource-exhausted' ||
    code === 'internal' ||
    message.includes('deadline exceeded') ||
    message.includes('timed out') ||
    message.includes('socket hang up') ||
    message.includes('econnreset') ||
    message.includes('network error')
  );
}

function resolveFailureReason(err, fallback = 'failed_error') {
  return isTimeoutLikeError(err) ? 'failed_timeout' : fallback;
}

async function runCachedTaskWithFallback({
  cacheKey,
  ttlMs,
  label,
  task,
  fallbackValue,
  timeoutMs = Math.max(2500, Math.min(INTENT_STAGE_TIMEOUT_MS - 1000, 5000))
} = {}) {
  if (cacheKey && Number.isFinite(ttlMs) && ttlMs > 0) {
    const cached = getCacheValue(cacheKey, ttlMs);
    if (cached != null) return cached;
  }

  try {
    const value = await withFetchRetry(
      () => withTimeout(Promise.resolve().then(() => task()), timeoutMs, label || 'cached_task'),
      {
        label: label || cacheKey || 'cached_task',
        retryOn: isRetryableFetchError
      }
    );
    if (cacheKey) {
      setCacheValue(cacheKey, value);
    }
    return value;
  } catch (err) {
    const stale = cacheKey ? getStaleCacheEntry(cacheKey) : null;
    if (stale) {
      console.warn('[FETCH_FALLBACK_USED]', {
        label: label || cacheKey || 'cached_task',
        source: 'stale_cache',
        age_ms: Date.now() - stale.fetchedAt,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
      return stale.value;
    }

    if (fallbackValue !== undefined) {
      const resolvedFallback = typeof fallbackValue === 'function' ? fallbackValue(err) : fallbackValue;
      console.warn('[FETCH_FALLBACK_USED]', {
        label: label || cacheKey || 'cached_task',
        source: 'default_fallback',
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
      return resolvedFallback;
    }

    throw err;
  }
}

async function refreshBinanceServerTimeOffset(force = false) {
  const now = Date.now();
  if (!force && binanceTimeOffsetFetchedAt && now - binanceTimeOffsetFetchedAt < BINANCE_TIME_SYNC_TTL_MS) {
    return binanceTimeOffsetMs;
  }

  const response = await fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/time`);
  if (!response.ok) {
    throw new Error(`Binance server time failed (${response.status})`);
  }
  const data = await response.json();
  const serverTime = Number(data?.serverTime || 0);
  if (!Number.isFinite(serverTime) || serverTime <= 0) {
    throw new Error('invalid Binance server time');
  }

  binanceTimeOffsetMs = serverTime - now;
  binanceTimeOffsetFetchedAt = now;
  return binanceTimeOffsetMs;
}

async function signedRequest(path, params, method = 'POST', options = {}) {
  const { retryOnTimestamp = true, forceTimeSync = false } = options;
  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
    const missingErr = new Error(`Binance API credentials missing for ${path}`);
    missingErr.binancePath = path;
    throw missingErr;
  }
  const offsetMs = await refreshBinanceServerTimeOffset(forceTimeSync);
  const timestamp = Date.now() + offsetMs - BINANCE_SIGNED_TIMESTAMP_SAFETY_MS;
  const payload = new URLSearchParams({
    ...params,
    timestamp,
    recvWindow: BINANCE_SIGNED_RECV_WINDOW_MS
  });
  const signature = createSignature(payload.toString());
  payload.append('signature', signature);
  const url = `${BINANCE_FUTURES_BASE_URL}${path}?${payload.toString()}`;
  const response = await fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': BINANCE_API_KEY
    }
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch (_) {
    body = bodyText;
  }
  if (!response.ok) {
    const parsedError = parseBinanceError(bodyText);
    if (
      retryOnTimestamp &&
      response.status === 400 &&
      typeof bodyText === 'string' &&
      bodyText.includes('"code":-1021')
    ) {
      await refreshBinanceServerTimeOffset(true);
      return signedRequest(path, params, method, {
        retryOnTimestamp: false,
        forceTimeSync: true
      });
    }
    const err = new Error(`Binance API ${path} failed (${response.status}): ${bodyText}`);
    err.httpStatus = response.status;
    err.binanceCode = Number.isFinite(parsedError.code) ? parsedError.code : null;
    err.binanceMessage = parsedError.msg || null;
    err.binancePath = path;
    if (isBinanceAuthInvalidError(err)) {
      setBinanceAuthInvalid(err, path);
    }
    throw err;
  }
  clearBinanceAuthInvalid();
  return body;
}

async function setLeverage(symbol, leverage) {
  return signedRequest('/fapi/v1/leverage', {
    symbol,
    leverage: Math.max(1, Math.floor(leverage))
  });
}

async function getFuturesLeverageBracket(symbol) {
  if (!symbol) return null;
  const requestedSymbol = String(symbol || '').toUpperCase();
  const now = Date.now();
  const cached = leverageBracketCache.get(requestedSymbol);
  if (cached && now - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) {
    return cached.data;
  }
  if (leverageBracketInflight.has(requestedSymbol)) {
    return leverageBracketInflight.get(requestedSymbol);
  }

  const task = (async () => {
    try {
      const data = await signedRequest('/fapi/v1/leverageBracket', { symbol: requestedSymbol }, 'GET');
      const normalized = Array.isArray(data) ? data[0] : data;
      leverageBracketCache.set(requestedSymbol, { fetchedAt: Date.now(), data: normalized || null });
      return normalized || null;
    } catch (err) {
      if (cached?.data) return cached.data;
      throw err;
    } finally {
      leverageBracketInflight.delete(requestedSymbol);
    }
  })();

  leverageBracketInflight.set(requestedSymbol, task);
  return task;
}

function resolveMaxAllowedLeverage(bracketData) {
  const brackets = Array.isArray(bracketData?.brackets) ? bracketData.brackets : [];
  const maxFromBrackets = brackets.reduce((max, item) => {
    const current = Number(item?.initialLeverage || 0);
    return Number.isFinite(current) && current > max ? current : max;
  }, 0);
  if (maxFromBrackets > 0) return Math.floor(maxFromBrackets);
  const direct = Number(bracketData?.initialLeverage || 0);
  return Number.isFinite(direct) && direct > 0 ? Math.floor(direct) : null;
}

async function resolveValidLeverage(symbol, requestedLeverage) {
  const requested = Math.max(1, Math.floor(Number(requestedLeverage || BINANCE_DEFAULT_LEVERAGE)));
  try {
    const bracketData = await getFuturesLeverageBracket(symbol);
    const maxAllowed = resolveMaxAllowedLeverage(bracketData);
    if (Number.isFinite(maxAllowed) && maxAllowed > 0) {
      return {
        requested,
        applied: Math.max(1, Math.min(requested, maxAllowed)),
        max_allowed: maxAllowed
      };
    }
  } catch (_) {
    // fall through
  }
  return {
    requested,
    applied: requested,
    max_allowed: null
  };
}

async function setLeverageSafely(symbol, leverage) {
  const leveragePlan = await resolveValidLeverage(symbol, leverage);
  try {
    const response = await setLeverage(symbol, leveragePlan.applied);
    return {
      ...response,
      requested_leverage: leveragePlan.requested,
      applied_leverage: leveragePlan.applied,
      leverage_fallback_applied: leveragePlan.applied !== leveragePlan.requested,
      leverage_max_allowed: leveragePlan.max_allowed
    };
  } catch (err) {
    const message = String(err?.message || '');
    if (!message.includes('"code":-4028')) {
      throw err;
    }
    for (const candidate of [20, 10, 5, 3, 2, 1]) {
      if (candidate >= leveragePlan.applied) continue;
      try {
        const response = await setLeverage(symbol, candidate);
        return {
          ...response,
          requested_leverage: leveragePlan.requested,
          applied_leverage: candidate,
          leverage_fallback_applied: true,
          leverage_max_allowed: leveragePlan.max_allowed
        };
      } catch (_) {
        continue;
      }
    }
    throw err;
  }
}

async function getMarkPrice(symbol) {
  const response = await fetchWithTimeout(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) {
    throw new Error(`Binance premiumIndex failed (${response.status})`);
  }
  const data = await response.json();
  const markPrice = Number(data?.markPrice || 0);
  if (!Number.isFinite(markPrice) || markPrice <= 0) {
    throw new Error('invalid mark price');
  }
  return markPrice;
}

function decimalsFromStep(step) {
  const n = Number(step || 0);
  if (!Number.isFinite(n) || n <= 0) return 0;
  const s = String(step);
  if (s.includes('e-')) {
    return Number(s.split('e-')[1] || 0);
  }
  const parts = s.split('.');
  if (parts.length < 2) return 0;
  return parts[1].replace(/0+$/, '').length;
}

function toPlainFixed(value, decimals) {
  const n = Number(value || 0);
  const d = Math.max(0, Number(decimals || 0));
  if (!Number.isFinite(n)) return '0';
  return n.toFixed(d);
}

function floorToStep(value, step) {
  const v = Number(value || 0);
  const st = Number(step || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (!Number.isFinite(st) || st <= 0) return v;
  const d = decimalsFromStep(step);
  const floored = Math.floor((v + st * 1e-9) / st) * st;
  return Number(floored.toFixed(d));
}

function roundToTick(value, tick) {
  const v = Number(value || 0);
  const tk = Number(tick || 0);
  if (!Number.isFinite(v) || v <= 0) return 0;
  if (!Number.isFinite(tk) || tk <= 0) return v;
  const d = decimalsFromStep(tick);
  const rounded = Math.round(v / tk) * tk;
  return Number(rounded.toFixed(d));
}

function buildRulesFromExchangeInfo(info, requestedSymbol) {
  if (!info || typeof info !== 'object') return null;
  const filters = Array.isArray(info.filters) ? info.filters : [];
  const lot = filters.find((f) => f.filterType === 'LOT_SIZE') || {};
  const marketLot = filters.find((f) => f.filterType === 'MARKET_LOT_SIZE') || {};
  const price = filters.find((f) => f.filterType === 'PRICE_FILTER') || {};

  return {
    symbol: requestedSymbol,
    quantityPrecision: Number(info.quantityPrecision),
    pricePrecision: Number(info.pricePrecision),
    stepSize: Number(lot.stepSize || 0),
    minQty: Number(lot.minQty || 0),
    marketStepSize: Number(marketLot.stepSize || 0),
    marketMinQty: Number(marketLot.minQty || 0),
    tickSize: Number(price.tickSize || 0),
    minNotional: Number(
      filters.find((f) => f.filterType === 'MIN_NOTIONAL')?.notional ||
      filters.find((f) => f.filterType === 'NOTIONAL')?.minNotional ||
      0
    )
  };
}

async function getExchangeInfoSnapshot() {
  const now = Date.now();
  if (
    exchangeInfoSnapshotCache.symbolsByName &&
    now - exchangeInfoSnapshotCache.fetchedAt < EXCHANGE_INFO_TTL_MS
  ) {
    return exchangeInfoSnapshotCache.symbolsByName;
  }
  if (exchangeInfoSnapshotInflight) {
    return exchangeInfoSnapshotInflight;
  }

  exchangeInfoSnapshotInflight = (async () => {
    try {
      let lastErr = null;
      const timeoutPlan = [BINANCE_PUBLIC_FETCH_TIMEOUT_MS, BINANCE_PUBLIC_FETCH_RETRY_TIMEOUT_MS];
      for (const timeoutMs of timeoutPlan) {
        try {
          const response = await fetchWithTimeout(
            `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`,
            {},
            timeoutMs
          );
          if (!response.ok) {
            throw new Error(`Binance exchangeInfo failed (${response.status})`);
          }
          const data = await response.json();
          const symbolsByName = new Map();
          for (const item of Array.isArray(data?.symbols) ? data.symbols : []) {
            const requestedSymbol = String(item?.symbol || '').toUpperCase();
            if (!requestedSymbol) continue;
            const rules = buildRulesFromExchangeInfo(item, requestedSymbol);
            if (!rules) continue;
            symbolsByName.set(requestedSymbol, rules);
            exchangeInfoCache.set(requestedSymbol, {
              fetchedAt: Date.now(),
              rules
            });
          }
          exchangeInfoSnapshotCache = {
            symbolsByName,
            fetchedAt: Date.now()
          };
          return symbolsByName;
        } catch (err) {
          lastErr = err;
          if (!isTimeoutLikeError(err)) throw err;
        }
      }
      if (exchangeInfoSnapshotCache.symbolsByName) {
        return exchangeInfoSnapshotCache.symbolsByName;
      }
      throw lastErr || new Error('Binance exchangeInfo snapshot unavailable');
    } finally {
      exchangeInfoSnapshotInflight = null;
    }
  })();

  return exchangeInfoSnapshotInflight;
}

async function warmExchangeInfoCache() {
  const symbolsByName = await getExchangeInfoSnapshot();
  const symbolsTotal = symbolsByName instanceof Map ? symbolsByName.size : 0;
  return {
    warmed: symbolsTotal > 0,
    symbols_total: symbolsTotal,
    fetched_at: exchangeInfoSnapshotCache.fetchedAt
      ? new Date(exchangeInfoSnapshotCache.fetchedAt).toISOString()
      : null,
    age_ms: exchangeInfoSnapshotCache.fetchedAt ? Math.max(0, Date.now() - exchangeInfoSnapshotCache.fetchedAt) : null
  };
}

function getExchangeInfoCacheStatus() {
  return {
    symbols_total: exchangeInfoSnapshotCache?.symbolsByName instanceof Map
      ? exchangeInfoSnapshotCache.symbolsByName.size
      : 0,
    fetched_at: exchangeInfoSnapshotCache.fetchedAt
      ? new Date(exchangeInfoSnapshotCache.fetchedAt).toISOString()
      : null,
    age_ms: exchangeInfoSnapshotCache.fetchedAt
      ? Math.max(0, Date.now() - exchangeInfoSnapshotCache.fetchedAt)
      : null
  };
}

function buildEntryDisciplineTimeoutFallback(signalData = {}, err = null) {
  const signalAt = resolveSignalAt(signalData);
  const now = new Date();
  const signalAgeMs =
    signalAt && Number.isFinite(signalAt.getTime())
      ? Math.max(0, now.getTime() - signalAt.getTime())
      : null;
  return {
    blocked: false,
    reason: null,
    details: {
      enabled: true,
      degraded_fallback: true,
      degraded_reason: resolveFailureReason(err, 'entry_discipline_timeout'),
      execution_delay_ms: signalAgeMs,
      entry_window_seconds: Number(process.env.ENTRY_WINDOW_SECONDS || 30),
      late_entry_type: 'unknown',
      override_applied: false,
      override_reason: 'entry_discipline_timeout_fallback',
      fallback_at: now.toISOString()
    }
  };
}

async function getFuturesSymbolRules(symbol) {
  if (!symbol) return null;
  const requestedSymbol = String(symbol || '').toUpperCase();
  const now = Date.now();
  const cached = exchangeInfoCache.get(requestedSymbol);
  if (cached && now - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) {
    console.info('[EXCHANGE_INFO_CACHE_HIT]', {
      symbol: requestedSymbol,
      source: 'symbol_cache',
      age_ms: now - cached.fetchedAt
    });
    return {
      ...cached.rules,
      cache_source: 'symbol_cache'
    };
  }
  if (exchangeInfoInflight.has(requestedSymbol)) {
    return exchangeInfoInflight.get(requestedSymbol);
  }

  const task = (async () => {
    try {
      let snapshotRules = exchangeInfoSnapshotCache?.symbolsByName?.get?.(requestedSymbol) || null;
      if (!snapshotRules) {
        try {
          const snapshot = await getExchangeInfoSnapshot();
          snapshotRules = snapshot?.get?.(requestedSymbol) || null;
        } catch (err) {
          if (isTimeoutLikeError(err)) {
            console.warn('[EXCHANGE_INFO_TIMEOUT]', {
              symbol: requestedSymbol,
              message: sanitizeBinanceErrorMessage(err?.message || err)
            });
          }
        }
      }
      if (snapshotRules) {
        const snapshotAgeMs = exchangeInfoSnapshotCache.fetchedAt
          ? Math.max(0, now - exchangeInfoSnapshotCache.fetchedAt)
          : null;
        if (!exchangeInfoCache.has(requestedSymbol)) {
          exchangeInfoCache.set(requestedSymbol, {
            fetchedAt: exchangeInfoSnapshotCache.fetchedAt || Date.now(),
            rules: snapshotRules
          });
        }
        console.info('[EXCHANGE_INFO_CACHE_HIT]', {
          symbol: requestedSymbol,
          source:
            exchangeInfoSnapshotCache.fetchedAt && now - exchangeInfoSnapshotCache.fetchedAt >= EXCHANGE_INFO_TTL_MS
              ? 'stale_snapshot_cache'
              : 'snapshot_cache',
          age_ms: snapshotAgeMs
        });
        if (exchangeInfoSnapshotCache.fetchedAt && now - exchangeInfoSnapshotCache.fetchedAt >= EXCHANGE_INFO_TTL_MS) {
          console.warn('[FETCH_FALLBACK_USED]', {
            label: `exchange_info:${requestedSymbol}`,
            source: 'stale_snapshot_cache',
            age_ms: snapshotAgeMs
          });
        }
        return {
          ...snapshotRules,
          cache_source:
            exchangeInfoSnapshotCache.fetchedAt && now - exchangeInfoSnapshotCache.fetchedAt >= EXCHANGE_INFO_TTL_MS
              ? 'stale_snapshot_cache'
              : 'snapshot_cache'
        };
      }

      const response = await withFetchRetry(
        () => fetchWithTimeout(
          `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(requestedSymbol)}`,
          {},
          BINANCE_PUBLIC_FETCH_TIMEOUT_MS
        ),
        {
          label: `exchange_info:${requestedSymbol}`,
          retryOn: isTimeoutLikeError
        }
      );
      if (!response.ok) {
        throw new Error(`Binance exchangeInfo failed (${response.status})`);
      }
      const data = await response.json();
      const info = Array.isArray(data?.symbols)
        ? data.symbols.find(item => String(item?.symbol || '').toUpperCase() === requestedSymbol) || null
        : null;
      if (!info) {
        if (cached?.rules) {
          console.warn('[FETCH_FALLBACK_USED]', {
            label: `exchange_info:${requestedSymbol}`,
            source: 'symbol_rule_cache'
          });
          return cached.rules;
        }
        return null;
      }
      const rules = buildRulesFromExchangeInfo(info, requestedSymbol);
      exchangeInfoCache.set(requestedSymbol, { fetchedAt: Date.now(), rules });
      return {
        ...rules,
        cache_source: 'remote_symbol_fetch'
      };
    } catch (err) {
      if (isTimeoutLikeError(err)) {
        console.warn('[EXCHANGE_INFO_TIMEOUT]', {
          symbol: requestedSymbol,
          message: sanitizeBinanceErrorMessage(err?.message || err)
        });
      }
      if (cached?.rules) {
        console.warn('[FETCH_FALLBACK_USED]', {
          label: `exchange_info:${requestedSymbol}`,
          source: 'symbol_rule_cache',
          message: sanitizeBinanceErrorMessage(err?.message || err)
        });
        return {
          ...cached.rules,
          cache_source: 'stale_symbol_cache'
        };
      }
      throw err;
    } finally {
      exchangeInfoInflight.delete(requestedSymbol);
    }
  })();

  exchangeInfoInflight.set(requestedSymbol, task);
  return task;
}

function resolveExecutedQuantity(orderResponse, fallbackQuantity) {
  const candidates = [
    Number(orderResponse?.executedQty || 0),
    Number(orderResponse?.origQty || 0),
    Number(fallbackQuantity || 0)
  ];
  return candidates.find((value) => Number.isFinite(value) && value > 0) || Number(fallbackQuantity || 0);
}

function resolveFilledEntryPrice(orderResponse, fallbackEntryPrice, executedQuantity) {
  const avgPrice = Number(orderResponse?.avgPrice || 0);
  if (Number.isFinite(avgPrice) && avgPrice > 0) return avgPrice;

  const cumQuote = Number(orderResponse?.cumQuote || orderResponse?.cumQuoteQty || 0);
  if (Number.isFinite(cumQuote) && cumQuote > 0 && Number.isFinite(executedQuantity) && executedQuantity > 0) {
    return cumQuote / executedQuantity;
  }

  const fills = Array.isArray(orderResponse?.fills) ? orderResponse.fills : [];
  if (fills.length > 0) {
    const fillStats = fills.reduce((acc, fill) => {
      const price = Number(fill?.price || 0);
      const qty = Number(fill?.qty || fill?.quantity || 0);
      if (Number.isFinite(price) && price > 0 && Number.isFinite(qty) && qty > 0) {
        acc.qty += qty;
        acc.quote += price * qty;
      }
      return acc;
    }, { qty: 0, quote: 0 });
    if (fillStats.qty > 0 && fillStats.quote > 0) {
      return fillStats.quote / fillStats.qty;
    }
  }

  return Number(fallbackEntryPrice || 0) || 0;
}

function resolveOrderExecutedAt(orderResponse) {
  const raw = Number(orderResponse?.updateTime || orderResponse?.transactTime || orderResponse?.time || 0);
  if (Number.isFinite(raw) && raw > 0) {
    return new Date(raw);
  }
  return new Date();
}

function reanchorExitLevelsToFill(intent, filledEntryPrice) {
  const entryPrice = Number(intent?.entry_price || 0);
  const takeProfit = Number(intent?.take_profit || 0);
  const stopLoss = Number(intent?.stop_loss || 0);
  const side = String(intent?.side || '').toUpperCase();
  if (!Number.isFinite(filledEntryPrice) || filledEntryPrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
    return {
      take_profit: takeProfit,
      stop_loss: stopLoss
    };
  }

  const tpOffsetRatio =
    side === 'BUY'
      ? Math.max(0, (takeProfit - entryPrice) / entryPrice)
      : Math.max(0, (entryPrice - takeProfit) / entryPrice);
  const slOffsetRatio =
    side === 'BUY'
      ? Math.max(0, (entryPrice - stopLoss) / entryPrice)
      : Math.max(0, (stopLoss - entryPrice) / entryPrice);

  if (side === 'BUY') {
    return {
      take_profit: filledEntryPrice * (1 + tpOffsetRatio),
      stop_loss: filledEntryPrice * (1 - slOffsetRatio)
    };
  }
  if (side === 'SELL') {
    return {
      take_profit: filledEntryPrice * (1 - tpOffsetRatio),
      stop_loss: filledEntryPrice * (1 + slOffsetRatio)
    };
  }
  return {
    take_profit: takeProfit,
    stop_loss: stopLoss
  };
}

function applyIntentPrecision(intent, rules) {
  if (!rules) return intent;
  const adjusted = { ...intent };

  // For market orders Binance may enforce MARKET_LOT_SIZE instead of LOT_SIZE.
  const isMarketOrder = String(adjusted.order_type || '').toUpperCase() === 'MARKET';
  const qtyStep = isMarketOrder && Number(rules.marketStepSize) > 0 ? Number(rules.marketStepSize) : Number(rules.stepSize);
  const qtyMin = isMarketOrder && Number(rules.marketMinQty) > 0 ? Number(rules.marketMinQty) : Number(rules.minQty);

  adjusted.quantity = floorToStep(adjusted.quantity, qtyStep);
  if (Number.isFinite(qtyMin) && qtyMin > 0) {
    if (adjusted.quantity < qtyMin) {
      adjusted.quantity = Number(qtyMin);
    }
    adjusted.quantity = floorToStep(adjusted.quantity, qtyStep);
  }

  adjusted.entry_price = roundToTick(adjusted.entry_price, rules.tickSize);
  adjusted.take_profit = roundToTick(adjusted.take_profit, rules.tickSize);
  adjusted.stop_loss = roundToTick(adjusted.stop_loss, rules.tickSize);

  const qtyStepDecimals = decimalsFromStep(qtyStep);
  if (Number.isFinite(rules.quantityPrecision) && rules.quantityPrecision >= 0) {
    const qtyPrecision = qtyStepDecimals > 0
      ? Math.min(Number(rules.quantityPrecision), qtyStepDecimals)
      : Number(rules.quantityPrecision);
    adjusted.quantity = Number(adjusted.quantity.toFixed(qtyPrecision));
    adjusted._quantity_precision = qtyPrecision;
  } else if (qtyStepDecimals > 0) {
    adjusted.quantity = Number(adjusted.quantity.toFixed(qtyStepDecimals));
    adjusted._quantity_precision = qtyStepDecimals;
  }
  if (Number.isFinite(rules.pricePrecision) && rules.pricePrecision >= 0) {
    adjusted.entry_price = Number(adjusted.entry_price.toFixed(rules.pricePrecision));
    adjusted.take_profit = Number(adjusted.take_profit.toFixed(rules.pricePrecision));
    adjusted.stop_loss = Number(adjusted.stop_loss.toFixed(rules.pricePrecision));
  }
  adjusted._quantity_step = qtyStep;

  return adjusted;
}

async function getPositionRisk(symbol) {
  const list = await signedRequest('/fapi/v2/positionRisk', { symbol }, 'GET');
  return Array.isArray(list) ? list[0] : list;
}

async function getFuturesWalletBalance(asset = 'USDT') {
  const upperAsset = String(asset || 'USDT').toUpperCase();
  const cached = futuresBalanceCache.get(upperAsset);
  if (cached && Date.now() - cached.fetchedAt < BINANCE_BALANCE_CACHE_TTL_MS) {
    return {
      ...cached.value,
      _cache_fallback: false,
      _cache_age_ms: Date.now() - cached.fetchedAt
    };
  }

  try {
    const list = await signedRequest('/fapi/v2/balance', {}, 'GET');
    if (!Array.isArray(list)) return null;
    const balance = list.find((item) => String(item?.asset || '').toUpperCase() === upperAsset) || null;
    if (balance) {
      futuresBalanceCache.set(upperAsset, {
        value: balance,
        fetchedAt: Date.now()
      });
      console.info('[BINANCE_BALANCE_REFRESH]', {
        asset: upperAsset,
        balance: Number(balance?.balance || 0),
        availableBalance: Number(balance?.availableBalance || 0),
        crossWalletBalance: Number(balance?.crossWalletBalance || 0)
      });
    }
    return balance
      ? {
          ...balance,
          _cache_fallback: false,
          _cache_age_ms: 0
        }
      : null;
  } catch (err) {
    if (cached?.value) {
      console.warn('[FETCH_FALLBACK_USED]', {
        label: 'futures_balance',
        asset: upperAsset,
        source: 'last_valid_balance',
        age_ms: Date.now() - cached.fetchedAt,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
      return {
        ...cached.value,
        _cache_fallback: true,
        _cache_age_ms: Date.now() - cached.fetchedAt,
        _auth_invalid: binanceAuthState.invalid
      };
    }
    throw err;
  }
}

async function getFuturesIncomeHistory(params = {}) {
  const cacheKey = JSON.stringify(
    Object.keys(params || {})
      .sort()
      .reduce((acc, key) => {
        acc[key] = params[key];
        return acc;
      }, {})
  );
  const cached = futuresIncomeCache.get(cacheKey);
  if (cached && Date.now() - cached.fetchedAt < BINANCE_INCOME_CACHE_TTL_MS) {
    return cached.value;
  }
  try {
    const rows = await signedRequest('/fapi/v1/income', params, 'GET');
    const normalizedRows = Array.isArray(rows) ? rows : [];
    futuresIncomeCache.set(cacheKey, {
      value: normalizedRows,
      fetchedAt: Date.now()
    });
    return normalizedRows;
  } catch (err) {
    if (cached?.value) {
      console.warn('[FETCH_FALLBACK_USED]', {
        label: 'futures_income',
        source: 'last_valid_income',
        age_ms: Date.now() - cached.fetchedAt,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
      return cached.value;
    }
    throw err;
  }
}

async function closePositionMarket(intent) {
  const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';
  let quantity = Number(intent.quantity || 0);
  let quantityPrecision = Number.isFinite(Number(intent?._quantity_precision))
    ? Number(intent._quantity_precision)
    : null;
  let qtyStep = Number(intent?._quantity_step || 0);

  if (!(Number.isFinite(quantityPrecision) && quantityPrecision >= 0) || !(qtyStep > 0)) {
    try {
      const rules = await getFuturesSymbolRules(intent.symbol);
      const marketStep = Number(rules?.marketStepSize || 0);
      const lotStep = Number(rules?.stepSize || 0);
      qtyStep = marketStep > 0 ? marketStep : lotStep;
      const qtyStepDecimals = decimalsFromStep(qtyStep);
      if (Number.isFinite(Number(rules?.quantityPrecision)) && Number(rules.quantityPrecision) >= 0) {
        quantityPrecision = qtyStepDecimals > 0
          ? Math.min(Number(rules.quantityPrecision), qtyStepDecimals)
          : Number(rules.quantityPrecision);
      } else if (qtyStepDecimals > 0) {
        quantityPrecision = qtyStepDecimals;
      }
    } catch (_) {
      // Best effort: keep the raw quantity if exchange metadata is unavailable.
    }
  }

  if (qtyStep > 0) {
    quantity = floorToStep(quantity, qtyStep);
  }
  if (Number.isFinite(quantityPrecision) && quantityPrecision >= 0) {
    quantity = Number(quantity.toFixed(quantityPrecision));
  }

  return signedRequest('/fapi/v1/order', {
    symbol: intent.symbol,
    side: oppositeSide,
    type: 'MARKET',
    quantity:
      Number.isFinite(quantityPrecision) && quantityPrecision >= 0
        ? toPlainFixed(quantity, quantityPrecision)
        : String(quantity),
    reduceOnly: true,
    newOrderRespType: 'RESULT'
  });
}

function startOfUtcDay(date = new Date()) {
  const d = new Date(date);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function resolveNotional(config) {
  const accountCapital = Number(config?.account_capital_usdt || 0);
  const fundsPct = Number(config?.use_funds_percent || 0);
  if (accountCapital > 0 && fundsPct > 0) {
    return Math.max(5, Number(((accountCapital * fundsPct) / 100).toFixed(2)));
  }
  return BINANCE_TRADE_NOTIONAL_USDT;
}

function averageFinite(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function resolveSizingFactor(signalData, config) {
  if (!config?.dynamic_sizing_enabled) return 1;
  const contextScore = Number(signalData?.context_score || 0);
  if (contextScore >= 4) return Number(config?.sizing_high_context_factor || 1);
  if (contextScore <= 2) return Number(config?.sizing_low_context_factor || 1);
  return 1;
}

function resolveSourceProfileKey(sourceProfile) {
  const key = String(sourceProfile || 'high_conviction').toLowerCase();
  if (SOURCE_PROFILE_KEYS.has(key)) return key;
  return 'high_conviction';
}

function shouldForceObserveMode(profileKey) {
  if (profileKey === 'event_emitted') return BINANCE_EVENT_EMITTED_OBSERVE_MODE;
  if (profileKey === 'manual_prealert') return BINANCE_MANUAL_PREALERT_OBSERVE_MODE;
  return false;
}

function buildEffectiveConfig(config, sourceProfile) {
  const profileKey = resolveSourceProfileKey(sourceProfile);
  const profile =
    config?.execution_profiles && typeof config.execution_profiles === 'object'
      ? (config.execution_profiles[profileKey] || {})
      : {};
  const mode = profile.mode && profile.mode !== 'inherit' ? profile.mode : config.mode;
  const forcedObserveMode = shouldForceObserveMode(profileKey);
  const profileAllowlist = Array.isArray(profile.symbols_allowlist) ? profile.symbols_allowlist : null;
  const allowUnlistedGlobal = Boolean(config.allow_unlisted_symbols);
  const allowUnlistedProfile = Boolean(profile.allow_unlisted_symbols);
  return {
    ...config,
    ...profile,
    mode: forcedObserveMode ? 'dry-run' : mode,
    allow_unlisted_symbols:
      profileKey === 'high_conviction'
        ? false
        : (allowUnlistedGlobal || allowUnlistedProfile),
    symbols_allowlist: profileAllowlist && profileAllowlist.length > 0 ? profileAllowlist : config.symbols_allowlist,
    source_profile: profileKey,
    observe_mode_forced: forcedObserveMode,
    min_confidence:
      profileKey === 'high_conviction'
        ? Math.max(Number(profile.min_confidence ?? config.min_confidence ?? 0), BINANCE_HC_MIN_CONFIDENCE)
        : Number(profile.min_confidence ?? config.min_confidence ?? 0),
    min_quantum:
      profileKey === 'high_conviction'
        ? Math.max(Number(profile.min_quantum ?? config.min_quantum ?? 0), BINANCE_HC_MIN_QUANTUM)
        : Number(profile.min_quantum ?? config.min_quantum ?? 0),
    min_timing:
      profileKey === 'high_conviction'
        ? Math.max(Number(profile.min_timing ?? config.min_timing ?? 0), BINANCE_HC_MIN_TIMING)
        : Number(profile.min_timing ?? config.min_timing ?? 0),
    min_risk_reward:
      profileKey === 'high_conviction'
        ? Math.max(Number(profile.min_risk_reward ?? config.min_risk_reward ?? 0), BINANCE_HC_MIN_RISK_REWARD)
        : Math.max(0.1, Number(profile.min_risk_reward ?? config.min_risk_reward ?? 0)),
    min_expected_move_pct:
      profileKey === 'high_conviction'
        ? Math.max(Number(profile.min_expected_move_pct ?? config.min_expected_move_pct ?? 0), BINANCE_HC_MIN_EXPECTED_MOVE_PCT)
        : Math.max(0, Number(profile.min_expected_move_pct ?? config.min_expected_move_pct ?? 0))
  };
}

function buildExecutionIntent(signalData, config) {
  const sourceProfile = resolveSourceProfileKey(signalData?.source_profile || signalData?.source);
  const symbol = toBinanceSymbol(signalData?.symbol || signalData?.simbolo);
  const direction = signalData?.direction;
  const side = getOrderSide(direction);
  const confidence = normalizePercent(signalData?.confidence ?? signalData?.confianza);
  const quantum = normalizePercent(signalData?.quantum_score);
  const timing = normalizePercent(signalData?.timing_score);

  const sizingFactor = resolveSizingFactor(signalData, config);
  const sourceSizeFactor = sourceProfile === 'event_emitted' ? BINANCE_EVENT_POSITION_SIZE_FACTOR : 1;
  const computedNotional = resolveNotional(config) * sizingFactor * sourceSizeFactor;
  const notionalCap =
    sourceProfile === 'event_emitted'
      ? Math.min(Number(config?.max_notional_usdt || Number.MAX_SAFE_INTEGER), BINANCE_EVENT_MAX_NOTIONAL_USDT)
      : Number(config?.max_notional_usdt || 0);
  const notionalUsdt =
    Number.isFinite(notionalCap) && notionalCap > 0
      ? Math.max(5, Math.min(computedNotional, notionalCap))
      : Math.max(5, computedNotional);
  const entry = Number(signalData?.trade_plan?.entry_price || signalData?.spot_price || 0);
  const quantity = entry > 0 ? Number((notionalUsdt / entry).toFixed(6)) : 0;

  return {
    symbol,
    side,
    direction,
    confidence,
    quantum,
    timing,
    context_score: Number(signalData?.context_score || 0),
    context_quality: Number(
      signalData?.context_quality ??
        signalData?.event_context_filter?.context_quality ??
        NaN
    ),
    structural_context_score: Number(
      signalData?.structural_context_score ??
        signalData?.event_context_filter?.structural_context_score ??
        NaN
    ),
    volatility_context_score: Number(
      signalData?.volatility_context_score ??
        signalData?.event_context_filter?.volatility_context_score ??
        NaN
    ),
    volume_flow_context_score: Number(
      signalData?.volume_flow_context_score ??
        signalData?.event_context_filter?.volume_flow_context_score ??
        NaN
    ),
    liquidity_context_score: Number(
      signalData?.liquidity_context_score ??
        signalData?.event_context_filter?.liquidity_context_score ??
        NaN
    ),
    expected_move_percent: Number(signalData?.expected_move_percent || signalData?.expected_delta_pct || 0),
    risk_reward_ratio: Number(signalData?.trade_plan?.risk_reward_ratio || 0),
    entry_price: entry,
    stop_loss: Number(signalData?.trade_plan?.stop_loss || 0),
    take_profit: Number(signalData?.trade_plan?.take_profit || 0),
    quantity,
    notional_usdt: notionalUsdt,
    leverage: Math.max(1, Number(config?.default_leverage || BINANCE_DEFAULT_LEVERAGE)),
    margin_type: String(config?.margin_type || 'CROSSED').toUpperCase(),
    order_type: 'MARKET',
    enable_tp_sl: config?.enable_tp_sl !== false,
    tp_order_type: 'TAKE_PROFIT_MARKET',
    sl_order_type: 'STOP_MARKET',
    tp_buffer_pct: Number(config?.tp_buffer_pct || 0),
    sl_buffer_pct: Number(config?.sl_buffer_pct || 0),
    source_profile: sourceProfile
  };
}

function createExecutionIntent(signalData, config, sourceProfile) {
  return buildExecutionIntent(
    {
      ...signalData,
      source_profile: resolveSourceProfileKey(sourceProfile || signalData?.source_profile || signalData?.source)
    },
    config
  );
}

async function hasEnoughRecentValidRecords(db, intent, config) {
  const minRequired = Math.max(0, Math.floor(Number(config?.min_recent_valid_records || 0)));
  if (!minRequired) return true;

  const windowMinutes = Math.max(30, Math.floor(Number(config?.recent_records_window_minutes || 180)));
  const fromTs = Date.now() - windowMinutes * 60 * 1000;
  const systemSymbol = toSystemUsdSymbol(intent.symbol);
  const cacheKey = `recent:${systemSymbol}:${minRequired}:${windowMinutes}`;
  const cached = getCacheValue(cacheKey, RECENT_RECORDS_CACHE_TTL_MS);
  if (cached != null) return cached;

  return runCachedTaskWithFallback({
    cacheKey,
    ttlMs: RECENT_RECORDS_CACHE_TTL_MS,
    label: `recent_records:${systemSymbol}`,
    task: async () => {
      const snap = await db
        .collection('velas_predicciones')
        .where('simbolo', '==', systemSymbol)
        .limit(Math.max(minRequired * 4, 20))
        .get();
      const recent = snap.docs.filter((doc) => {
        const data = doc.data() || {};
        const createdAt = parseDateLike(data.created_at || data.timestamp);
        const spot = Number(data.spot_price || data.precio_actual || 0);
        return createdAt && createdAt.getTime() >= fromTs && Number.isFinite(spot) && spot > 0;
      });
      return recent.length >= minRequired;
    },
    fallbackValue: true
  });
}

function evaluateEventExecutionGate(intent = {}, config = {}) {
  const minConfidence = Math.max(Number(config.min_confidence ?? 0), BINANCE_EVENT_MIN_CONFIDENCE);
  const minQuantum = Math.max(Number(config.min_quantum ?? 0), BINANCE_EVENT_MIN_QUANTUM);
  const minTiming = Math.max(Number(config.min_timing ?? 0), BINANCE_EVENT_MIN_TIMING);
  const minExpectedMovePct = Math.max(
    Number(config.min_expected_move_pct ?? 0),
    BINANCE_EVENT_MIN_EXPECTED_MOVE_PCT
  );
  const minRiskReward = Math.max(Number(config.min_risk_reward ?? 0), BINANCE_EVENT_MIN_RISK_REWARD);
  const contextAverage = averageFinite([
    intent.context_quality,
    intent.structural_context_score,
    intent.volatility_context_score,
    intent.volume_flow_context_score,
    intent.liquidity_context_score
  ]);
  const contextStrong =
    Number(intent.context_score || 0) >= 2 ||
    (Number.isFinite(contextAverage) && contextAverage >= 55);
  const signalStrong =
    Number(intent.confidence || 0) >= minConfidence &&
    Number(intent.quantum || 0) >= minQuantum &&
    Number(intent.timing || 0) >= minTiming &&
    Number(intent.expected_move_percent || 0) >= minExpectedMovePct &&
    Number(intent.risk_reward_ratio || 0) >= minRiskReward;
  const noContextFallback =
    !Number.isFinite(contextAverage) &&
    Number(intent.confidence || 0) >= 0.985 &&
    Number(intent.quantum || 0) >= Math.max(minQuantum, 0.96) &&
    Number(intent.timing || 0) >= Math.max(minTiming, 0.9) &&
    Number(intent.expected_move_percent || 0) >= Math.max(minExpectedMovePct, 1);

  if (signalStrong && (contextStrong || noContextFallback)) {
    return { ok: true };
  }

  return {
    ok: false,
    reason: 'event_quality_gate',
    details: {
      min_confidence: minConfidence,
      min_quantum: minQuantum,
      min_timing: minTiming,
      min_expected_move_pct: minExpectedMovePct,
      min_risk_reward: minRiskReward,
      context_average: Number.isFinite(contextAverage) ? Number(contextAverage.toFixed(2)) : null,
      context_score: Number(intent.context_score || 0)
    }
  };
}

async function validateExecutionIntent(db, intent, config, options = {}) {
  const sourceProfile = resolveSourceProfileKey(options.source_profile);
  const rules = options.rules || null;
  if (!BINANCE_EXECUTION_ENABLED) return { ok: false, reason: 'disabled_by_env' };
  if (config.enabled === false) return { ok: false, reason: 'profile_disabled' };
  if (config.mode === 'off') return { ok: false, reason: 'mode_off' };
  if (!intent.symbol) return { ok: false, reason: 'symbol_missing' };
  if (!intent.side) return { ok: false, reason: 'neutral_direction' };
  if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) return { ok: false, reason: 'invalid_quantity' };
  if (!config.allow_unlisted_symbols && Array.isArray(config.symbols_allowlist) && config.symbols_allowlist.length > 0) {
    const symbolListed = config.symbols_allowlist.includes(intent.symbol);
    const hcOperableOnBinance =
      sourceProfile === 'high_conviction' &&
      String(rules?.symbol || '').toUpperCase() === String(intent.symbol || '').toUpperCase();
    if (!symbolListed && !hcOperableOnBinance) return { ok: false, reason: 'symbol_not_allowed' };
  }
  if (intent.confidence < Number(config.min_confidence ?? BINANCE_MIN_CONFIDENCE)) return { ok: false, reason: 'confidence_low' };
  if (intent.quantum < Number(config.min_quantum ?? BINANCE_MIN_QUANTUM)) return { ok: false, reason: 'quantum_low' };
  if (intent.timing < Number(config.min_timing ?? BINANCE_MIN_TIMING)) return { ok: false, reason: 'timing_low' };
  const minContextQuality = Number(config.min_context_quality ?? 0);
  const hasContextQuality = Number.isFinite(Number(intent.context_quality));
  if (minContextQuality > 0 && hasContextQuality) {
    if (Number(intent.context_quality) < minContextQuality) return { ok: false, reason: 'context_quality_low' };
  } else if (intent.context_score < Number(config.min_context_score ?? 0)) {
    return { ok: false, reason: 'context_score_low' };
  }
  if (intent.risk_reward_ratio < Number(config.min_risk_reward ?? 0)) return { ok: false, reason: 'risk_reward_low' };
  if (intent.expected_move_percent < Number(config.min_expected_move_pct ?? 0)) return { ok: false, reason: 'expected_move_low' };
  if (sourceProfile === 'event_emitted') {
    const eventGate = evaluateEventExecutionGate(intent, config);
    if (!eventGate.ok) {
      return {
        ok: false,
        reason: eventGate.reason,
        details: eventGate.details
      };
    }
  }
  if (intent.notional_usdt > Number(config.max_notional_usdt || Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'notional_cap_exceeded' };
  }
  const todayStart = startOfUtcDay();
  const symbolCooldownMinutes = Math.max(0, Math.floor(Number(config.symbol_cooldown_minutes || 0)));
  const dayKey = todayStart.toISOString().slice(0, 10);
  const dailyCacheKey = `daily:${sourceProfile}:${dayKey}:${Number(config.max_daily_trades || 1)}`;
  const cooldownCacheKey = `cooldown:${sourceProfile}:${symbolCooldownMinutes}`;

  const tasks = [
    hasEnoughRecentValidRecords(db, intent, config),
    runCachedTaskWithFallback({
      cacheKey: dailyCacheKey,
      ttlMs: EXECUTION_VALIDATION_CACHE_TTL_MS,
      label: `daily_trade_limit:${sourceProfile}`,
      task: async () => {
        const daily = await db
          .collection('binance_execution_intents')
          .where('status', '==', 'executed')
          .where('source_profile', '==', sourceProfile)
          .where('created_at', '>=', todayStart)
          .limit(Number(config.max_daily_trades || 1))
          .get();
        return daily.size;
      },
      fallbackValue: 0
    }),
    symbolCooldownMinutes > 0
      ? runCachedTaskWithFallback({
          cacheKey: cooldownCacheKey,
          ttlMs: EXECUTION_VALIDATION_CACHE_TTL_MS,
          label: `symbol_cooldown:${sourceProfile}`,
          task: async () => {
            const cooldownStart = new Date(Date.now() - symbolCooldownMinutes * 60 * 1000);
            const recentExecuted = await db
              .collection('binance_execution_intents')
              .where('status', '==', 'executed')
              .where('source_profile', '==', sourceProfile)
              .where('created_at', '>=', cooldownStart)
              .limit(50)
              .get();
            return new Set(
              recentExecuted.docs
                .map((doc) => doc.data()?.intent?.symbol || null)
                .filter(Boolean)
            );
          },
          fallbackValue: () => new Set()
        })
      : Promise.resolve(null)
  ];

  const [hasRecentRecords, dailySize, recentSymbols] = await Promise.all(tasks);
  if (!hasRecentRecords) return { ok: false, reason: 'insufficient_recent_records' };
  if (Number(dailySize || 0) >= Number(config.max_daily_trades || 1)) return { ok: false, reason: 'daily_trade_limit' };
  if (symbolCooldownMinutes > 0 && recentSymbols instanceof Set && recentSymbols.has(intent.symbol)) {
    return { ok: false, reason: 'symbol_cooldown_active' };
  }

  if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return { ok: false, reason: 'missing_api_credentials' };
  return { ok: true };
}

async function setMarginType(symbol, marginType) {
  try {
    return await signedRequest('/fapi/v1/marginType', {
      symbol,
      marginType
    });
  } catch (err) {
    const message = String(err?.message || '');
    if (message.includes('No need to change margin type')) {
      return { ok: true, skipped: 'already_set' };
    }
    throw err;
  }
}

function buildMarginSetupCacheKey(symbol, marginType, leverage) {
  return `${String(symbol || '').toUpperCase()}::${String(marginType || '').toUpperCase()}::${Math.max(
    1,
    Math.floor(Number(leverage || 1))
  )}`;
}

async function configureMarginAndLeverageWithFallback(symbol, marginType, leverage) {
  const cacheKey = buildMarginSetupCacheKey(symbol, marginType, leverage);
  const cached = marginSetupCache.get(cacheKey) || null;
  const timeoutMs = Math.max(5000, Math.min(BINANCE_LIVE_ORDER_TIMEOUT_MS, 8000));

  const marginTask = async () =>
    withFetchRetry(
      () => withTimeout(setMarginType(symbol, marginType), timeoutMs, `margin_type:${symbol}`),
      {
        label: `margin_type:${symbol}`,
        retryOn: isRetryableFetchError
      }
    );
  const leverageTask = async () =>
    withFetchRetry(
      () => withTimeout(setLeverageSafely(symbol, leverage), timeoutMs, `leverage:${symbol}`),
      {
        label: `leverage:${symbol}`,
        retryOn: isRetryableFetchError
      }
    );

  const [marginResult, leverageResult] = await Promise.allSettled([marginTask(), leverageTask()]);
  const fallbackUsed = {
    margin: false,
    leverage: false
  };

  const handleResult = (result, type) => {
    if (result.status === 'fulfilled') {
      return result.value;
    }
    const err = result.reason;
    if (!isRetryableFetchError(err)) {
      throw err;
    }
    console.warn('[MARGIN_SETUP_TIMEOUT]', {
      symbol,
      type,
      message: sanitizeBinanceErrorMessage(err?.message || err),
      cache_available: Boolean(cached)
    });
    fallbackUsed[type] = true;
    return cached?.[type] || {
      ok: true,
      timeout_fallback: true,
      assumed_applied: false
    };
  };

  const margin = handleResult(marginResult, 'margin');
  const leverageResponse = handleResult(leverageResult, 'leverage');

  marginSetupCache.set(cacheKey, {
    fetchedAt: Date.now(),
    margin,
    leverage: leverageResponse
  });

  if (fallbackUsed.margin || fallbackUsed.leverage) {
    console.info('[EXECUTION_WITH_FALLBACK]', {
      symbol,
      source: 'margin_leverage_setup',
      margin_timeout_fallback: fallbackUsed.margin,
      leverage_timeout_fallback: fallbackUsed.leverage
    });
  }

  return {
    margin,
    leverage: leverageResponse,
    fallback_used: fallbackUsed.margin || fallbackUsed.leverage,
    fallback_detail: fallbackUsed
  };
}

function adjustExitPrice(base, side, bufferPct, kind) {
  const price = Number(base || 0);
  const buffer = Number(bufferPct || 0) / 100;
  if (!price || !buffer) return price;
  if (kind === 'tp') {
    return side === 'BUY' ? price * (1 + buffer) : price * (1 - buffer);
  }
  return side === 'BUY' ? price * (1 - buffer) : price * (1 + buffer);
}

function normalizeProtectiveStopPrice(stopPrice, rules = null) {
  let normalized = Number(stopPrice || 0);
  if (!Number.isFinite(normalized) || normalized <= 0) return null;
  if (rules?.tickSize) {
    normalized = roundToTick(normalized, rules.tickSize);
  }
  if (Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0) {
    normalized = Number(normalized.toFixed(rules.pricePrecision));
  }
  return Number.isFinite(normalized) && normalized > 0 ? normalized : null;
}

function createProtectiveOrderValidation({
  symbol,
  side,
  orderType,
  triggerPrice,
  rules = null,
  referencePrice = null
}) {
  const errors = [];
  const normalizedSymbol = toBinanceSymbol(symbol);
  if (!normalizedSymbol || !isValidBinanceFuturesSymbol(normalizedSymbol)) {
    errors.push('invalid_symbol');
  }
  const normalizedTriggerPrice = normalizeProtectiveStopPrice(triggerPrice, rules);
  if (!normalizedTriggerPrice) {
    errors.push('invalid_trigger_price');
  }

  const normalizedOrderType = String(orderType || '').toUpperCase();
  if (!['STOP_MARKET', 'TAKE_PROFIT_MARKET'].includes(normalizedOrderType)) {
    errors.push('unsupported_order_type');
  }

  const positionSide = String(side || '').toUpperCase();
  const refPrice = Number(referencePrice || 0);
  if (Number.isFinite(refPrice) && refPrice > 0 && normalizedTriggerPrice) {
    if (positionSide === 'BUY' && normalizedOrderType === 'TAKE_PROFIT_MARKET' && normalizedTriggerPrice <= refPrice) {
      errors.push('tp_not_above_reference');
    }
    if (positionSide === 'BUY' && normalizedOrderType === 'STOP_MARKET' && normalizedTriggerPrice >= refPrice) {
      errors.push('sl_not_below_reference');
    }
    if (positionSide === 'SELL' && normalizedOrderType === 'TAKE_PROFIT_MARKET' && normalizedTriggerPrice >= refPrice) {
      errors.push('tp_not_below_reference');
    }
    if (positionSide === 'SELL' && normalizedOrderType === 'STOP_MARKET' && normalizedTriggerPrice <= refPrice) {
      errors.push('sl_not_above_reference');
    }
  }

  return {
    ok: errors.length === 0,
    errors,
    symbol: normalizedSymbol,
    side: positionSide === 'BUY' ? 'SELL' : 'BUY',
    triggerPrice: normalizedTriggerPrice,
    pricePrecision: Number.isFinite(rules?.pricePrecision) ? Number(rules.pricePrecision) : 8,
    referencePrice: Number.isFinite(refPrice) ? refPrice : null,
    orderType: normalizedOrderType,
    algoType: 'CONDITIONAL',
    closePosition: true,
    endpoint: '/fapi/v1/algoOrder'
  };
}

function extractBinanceErrorDetails(errorMessage) {
  const raw = String(errorMessage || '');
  const codeMatch = raw.match(/"code":\s*(-?\d+)/);
  const msgMatch = raw.match(/"msg":"([^"]+)"/);
  return {
    code: codeMatch ? Number(codeMatch[1]) : null,
    msg: msgMatch ? msgMatch[1] : null
  };
}

async function placeProtectiveMarketOrder(intent, orderType, triggerPrice, rules = null, options = {}) {
  const validation = createProtectiveOrderValidation({
    symbol: intent.symbol,
    side: intent.side,
    orderType,
    triggerPrice,
    rules,
    referencePrice: options.referencePrice ?? intent.entry_price
  });
  if (!validation.ok) {
    return {
      placed: false,
      reason: 'protection_failed_validation',
      validation
    };
  }

  const payload = {
    symbol: validation.symbol,
    side: validation.side,
    type: validation.orderType,
    algoType: validation.algoType,
    triggerPrice: toPlainFixed(validation.triggerPrice, validation.pricePrecision),
    closePosition: 'true',
    workingType: 'CONTRACT_PRICE',
    priceProtect: 'TRUE'
  };

  try {
    console.log('[ALGO_PROTECTION_ORDER]', JSON.stringify({
      symbol: validation.symbol,
      type: validation.orderType,
      side: validation.side,
      algotype: validation.algoType,
      triggerPrice: validation.triggerPrice,
      closePosition: validation.closePosition,
      payload
    }));
    const order = await signedRequest(validation.endpoint, payload);
    return {
      placed: true,
      order,
      validation,
      payload
    };
  } catch (err) {
    const error = String(err?.message || err);
    const details = extractBinanceErrorDetails(error);
    console.warn('[ALGO_PROTECTION_ORDER_ERROR]', JSON.stringify({
      symbol: validation.symbol,
      type: validation.orderType,
      side: validation.side,
      algotype: validation.algoType,
      triggerPrice: validation.triggerPrice,
      payload,
      code: details.code,
      msg: details.msg,
      error
    }));
    return {
      placed: false,
      reason: 'protective_order_failed',
      error,
      validation,
      payload,
      error_code: details.code,
      error_msg: details.msg
    };
  }
}

async function placeExitOrders(intent, rules = null, options = {}) {
  if (!intent.enable_tp_sl) return { placed: false, reason: 'tp_sl_disabled' };
  if (!intent.take_profit || !intent.stop_loss) return { placed: false, reason: 'tp_sl_missing' };

  let tpTriggerPrice = Number(adjustExitPrice(intent.take_profit, intent.side, intent.tp_buffer_pct, 'tp').toFixed(8));
  let slTriggerPrice = Number(adjustExitPrice(intent.stop_loss, intent.side, intent.sl_buffer_pct, 'sl').toFixed(8));
  if (rules?.tickSize) {
    tpTriggerPrice = roundToTick(tpTriggerPrice, rules.tickSize);
    slTriggerPrice = roundToTick(slTriggerPrice, rules.tickSize);
  }
  if (Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0) {
    tpTriggerPrice = Number(tpTriggerPrice.toFixed(rules.pricePrecision));
    slTriggerPrice = Number(slTriggerPrice.toFixed(rules.pricePrecision));
  }

  const referencePrice = Number(options.referencePrice || intent.entry_price || 0);
  const [tpPlacement, slPlacement] = await Promise.all([
    placeProtectiveMarketOrder(intent, 'TAKE_PROFIT_MARKET', tpTriggerPrice, rules, { referencePrice }),
    placeProtectiveMarketOrder(intent, 'STOP_MARKET', slTriggerPrice, rules, { referencePrice })
  ]);

  return {
    placed: Boolean(tpPlacement.placed || slPlacement.placed),
    fully_protected: Boolean(tpPlacement.placed && slPlacement.placed),
    mode: 'algo_orders',
    tp: tpPlacement.order || tpPlacement.tp || null,
    sl: slPlacement.order || slPlacement.sl || null,
    tp_stop_price: tpTriggerPrice,
    sl_stop_price: slTriggerPrice,
    tp_validation: tpPlacement.validation || null,
    sl_validation: slPlacement.validation || null,
    tp_payload: tpPlacement.payload || null,
    sl_payload: slPlacement.payload || null,
    tp_reason: tpPlacement.reason || null,
    sl_reason: slPlacement.reason || null,
    tp_error: tpPlacement.error || null,
    sl_error: slPlacement.error || null,
    tp_error_code: tpPlacement.error_code || null,
    sl_error_code: slPlacement.error_code || null,
    tp_error_msg: tpPlacement.error_msg || null,
    sl_error_msg: slPlacement.error_msg || null
  };
}

function hasExchangeStopProtection(exitOrders) {
  return Boolean(
    exitOrders?.fully_protected ||
    exitOrders?.tp?.algoId ||
    exitOrders?.tp?.orderId ||
    exitOrders?.tp?.clientOrderId ||
    exitOrders?.sl?.orderId ||
    exitOrders?.sl?.algoId ||
    exitOrders?.sl?.clientOrderId
  );
}

function resolveProtectivePersistence(exitOrders, enableTpSl = true) {
  const tpOrderId =
    exitOrders?.tp?.algoId ||
    exitOrders?.tp?.orderId ||
    exitOrders?.tp?.clientOrderId ||
    null;
  const slOrderId =
    exitOrders?.sl?.algoId ||
    exitOrders?.sl?.orderId ||
    exitOrders?.sl?.clientOrderId ||
    null;
  const protectiveStopAvailable =
    Boolean(exitOrders?.fully_protected) ||
    Boolean(tpOrderId) ||
    Boolean(slOrderId);
  const protectiveOrderStatus =
    enableTpSl === false
      ? 'tp_sl_disabled'
      : protectiveStopAvailable
        ? 'exchange_stop_active'
        : 'manager_fallback';

  return {
    tpOrderId,
    slOrderId,
    protectiveStopAvailable,
    protectiveOrderStatus
  };
}

function enforceLiveNotionalFloor(intent, rules, sourceProfile) {
  if (sourceProfile !== 'high_conviction') return intent;
  const entryPrice = Number(intent?.entry_price || 0);
  if (!Number.isFinite(entryPrice) || entryPrice <= 0) return intent;
  const exchangeFloor = Number(rules?.minNotional || 0);
  const targetNotional = Math.max(BINANCE_HC_MIN_LIVE_NOTIONAL_USDT, exchangeFloor);
  const currentNotional = Number(intent?.notional_usdt || 0);
  if (currentNotional >= targetNotional) return intent;

  const bufferedTarget = Math.max(targetNotional * 1.02, targetNotional + 0.25);
  const adjustedQuantity = bufferedTarget / entryPrice;
  return {
    ...intent,
    quantity: adjustedQuantity,
    notional_usdt: bufferedTarget
  };
}

function resolveEntryQualitySizing(entryQualityScore, executionGuardConfig = {}) {
  const score = Number(entryQualityScore || 0);
  const highScore = Number(executionGuardConfig?.high_quality_score || 70);
  const mediumScore = Number(executionGuardConfig?.medium_quality_score || 40);
  const mediumHighScore = Number(executionGuardConfig?.medium_high_quality_score || 55);
  const highFactor = clamp(Number(executionGuardConfig?.high_quality_size_factor || 1), 0.2, 1);
  const mediumHighFactor = clamp(
    Number(executionGuardConfig?.medium_high_quality_size_factor || 0.7),
    0.2,
    1
  );
  const mediumLowFactor = clamp(
    Number(executionGuardConfig?.medium_low_quality_size_factor || 0.4),
    0.2,
    1
  );

  if (score >= highScore) {
    return { band: 'high', sizeFactor: highFactor };
  }
  if (score >= mediumHighScore) {
    return { band: 'medium_high', sizeFactor: mediumHighFactor };
  }
  if (score >= mediumScore) {
    return { band: 'medium_low', sizeFactor: mediumLowFactor };
  }
  return { band: 'low', sizeFactor: 0 };
}

function applyEntryQualitySizing(intent, executionGuardResult, rules, config, sourceProfile) {
  if (!intent || !executionGuardResult) {
    return {
      intent,
      sizing: null
    };
  }

  const score = Number(executionGuardResult.entryQualityScore || 0);
  const sizingDecision = resolveEntryQualitySizing(score, config?.execution_guard || {});
  const baseEntryPrice = Number(intent?.entry_price || 0);
  const baseQuantity = Number(intent?.quantity || 0);
  const derivedBaseNotional =
    Number(intent?.notional_usdt || 0) ||
    (Number.isFinite(baseEntryPrice) && Number.isFinite(baseQuantity) ? baseEntryPrice * baseQuantity : 0);

  if (!(Number.isFinite(baseEntryPrice) && baseEntryPrice > 0) || !(Number.isFinite(baseQuantity) && baseQuantity > 0)) {
    return {
      intent,
      sizing: {
        ...sizingDecision,
        score,
        applied: false,
        baseNotionalUsdt: Number.isFinite(derivedBaseNotional) ? Number(derivedBaseNotional.toFixed(4)) : null,
        adjustedNotionalUsdt: Number.isFinite(derivedBaseNotional) ? Number(derivedBaseNotional.toFixed(4)) : null,
        reason: 'invalid_base_intent'
      }
    };
  }

  const targetFactor = clamp(Number(sizingDecision.sizeFactor || 0), 0, 1);
  if (!(targetFactor > 0) || targetFactor >= 0.999) {
    return {
      intent: {
        ...intent,
        entry_quality_score: score,
        entry_quality_band: sizingDecision.band,
        entry_quality_size_factor: targetFactor > 0 ? targetFactor : 1,
        entry_quality_base_notional_usdt: Number(derivedBaseNotional.toFixed(4)),
        entry_quality_adjusted_notional_usdt: Number(derivedBaseNotional.toFixed(4))
      },
      sizing: {
        ...sizingDecision,
        score,
        applied: false,
        baseNotionalUsdt: Number(derivedBaseNotional.toFixed(4)),
        adjustedNotionalUsdt: Number(derivedBaseNotional.toFixed(4)),
        reason: targetFactor <= 0 ? 'blocked_band' : 'full_size'
      }
    };
  }

  const scaledIntent = {
    ...intent,
    quantity: baseQuantity * targetFactor,
    notional_usdt: derivedBaseNotional * targetFactor,
    entry_quality_score: score,
    entry_quality_band: sizingDecision.band,
    entry_quality_size_factor: targetFactor,
    entry_quality_base_notional_usdt: Number(derivedBaseNotional.toFixed(4))
  };
  const flooredIntent = enforceLiveNotionalFloor(scaledIntent, rules, sourceProfile);
  const adjustedIntent = applyIntentPrecision(flooredIntent, rules);
  const adjustedNotional =
    Number(adjustedIntent?.notional_usdt || 0) ||
    Number(adjustedIntent?.entry_price || 0) * Number(adjustedIntent?.quantity || 0);

  return {
    intent: {
      ...adjustedIntent,
      entry_quality_adjusted_notional_usdt: Number(adjustedNotional.toFixed(4))
    },
    sizing: {
      ...sizingDecision,
      score,
      applied: true,
      baseNotionalUsdt: Number(derivedBaseNotional.toFixed(4)),
      adjustedNotionalUsdt: Number(adjustedNotional.toFixed(4)),
      effectiveSizeFactor:
        derivedBaseNotional > 0 ? Number((adjustedNotional / derivedBaseNotional).toFixed(4)) : targetFactor
    }
  };
}

async function executeSignalTrade(db, signalData, options = {}) {
  const sourceProfile = resolveSourceProfileKey(options.source_profile || options.source || 'high_conviction');
  const receivedAtIso = new Date().toISOString();
  const signalDataForExecution = normalizeSignalDataForExecution(signalData, sourceProfile, receivedAtIso);
  const config = await getCachedBinanceBotConfig(db);
  const effectiveConfig = buildEffectiveConfig(config, sourceProfile);
  const intent = createExecutionIntent(signalDataForExecution, effectiveConfig, sourceProfile);
  const predictionId = signalDataForExecution?.prediction_id || signalDataForExecution?.id || null;
  const observationSymbol = intent.symbol;
  let executionTrace = buildInitialExecutionTrace({
    ...signalDataForExecution,
    source_profile: sourceProfile
  });
  const emittedSignalTimestamp = resolveSignalTimestamp(signalDataForExecution);
  console.info('[PREALERT_STAGE_TIMING]', {
    stage: 'signal_emit',
    duration_ms: emittedSignalTimestamp ? Math.max(0, Date.now() - emittedSignalTimestamp.getTime()) : null,
    symbol: intent.symbol,
    prediction_id: predictionId,
    source_profile: sourceProfile
  });
  try {
    await ensureSymbolObservation(observationSymbol, 'recent_signal', {
      db,
      config,
      key: `signal:${predictionId || executionTrace.trace_id}`,
      ttlMs: config?.market_stream?.recent_signal_ttl_ms,
      priority: sourceProfile === 'high_conviction' ? 5 : 3,
      metadata: {
        source_profile: sourceProfile,
        prediction_id: predictionId
      }
    });
  } catch (err) {
    console.warn('[MARKET_STREAM] ensure recent signal failed', err.message);
  }
  const intentRef = buildIntentDocRef(db, predictionId, sourceProfile);
  let existingIntentData = null;
  try {
    await intentRef.create({
      prediction_id: predictionId,
      source_profile: sourceProfile,
      source: options.source || sourceProfile,
      symbol: intent.symbol,
      signal_symbol: signalDataForExecution?.symbol || signalDataForExecution?.simbolo || null,
      status: 'processing',
      processing_stage: 'created',
      processing_started_at: new Date().toISOString(),
      trace_id: executionTrace.trace_id,
      execution_trace: executionTrace,
      created_at: FieldValue.serverTimestamp()
    });
    try {
      await ensureSymbolObservation(observationSymbol, 'processing_intent', {
        db,
        config,
        key: `intent:${intentRef.id}`,
        ttlMs: config?.market_stream?.intent_ttl_ms,
        priority: 4,
        metadata: {
          source_profile: sourceProfile,
          prediction_id: predictionId
        }
      });
    } catch (err) {
      console.warn('[MARKET_STREAM] ensure processing intent failed', err.message);
    }
  } catch (err) {
    const code = String(err?.code || '');
    if (code !== '6' && !String(err?.message || '').toLowerCase().includes('already exists')) {
      throw err;
    }
    const existingIntent = await intentRef.get();
    existingIntentData = existingIntent.exists ? (existingIntent.data() || {}) : null;
    if (existingIntentData?.status && existingIntentData.status !== 'processing') {
      return { executed: false, reason: 'already_processed', dry_run: false, skipped: true };
    }
  }

  const modeDryRun = effectiveConfig.mode === 'dry-run' || BINANCE_EXECUTION_DRY_RUN;
  const forcedObserveMode = Boolean(effectiveConfig.observe_mode_forced);
  const preExecutionAudit = buildExecutionAudit(signalDataForExecution);
  const signalTimestamp = resolveSignalTimestamp(signalDataForExecution);
  const signalExpirationMs = Number(effectiveConfig?.execution_guard?.signal_expiration_ms || 0) || null;
  const signalExpiresAt =
    signalTimestamp && signalExpirationMs != null
      ? new Date(signalTimestamp.getTime() + signalExpirationMs).toISOString()
      : null;
  let entryDiscipline = null;
  let executionGuardResult = null;
  let entrySnapshot = null;
  try {
    await updateIntentProcessingStage(intentRef, 'entry_discipline');
    entryDiscipline = await withTimeout(
      evaluateEntryDiscipline({
        db,
        signalData: signalDataForExecution,
        intent,
        sourceProfile
      }),
      INTENT_STAGE_TIMEOUT_MS,
      'entry_discipline'
    );
  } catch (err) {
    if (isTimeoutLikeError(err)) {
      entryDiscipline = buildEntryDisciplineTimeoutFallback(signalDataForExecution, err);
      executionTrace = advanceExecutionTrace(executionTrace, {
        intent_processed_at: Date.now()
      });
      console.warn('[ENTRY_DISCIPLINE_FALLBACK]', {
        symbol: intent.symbol,
        prediction_id: predictionId,
        reason: entryDiscipline.details.degraded_reason,
        signal_age_ms: entryDiscipline.details.execution_delay_ms
      });
      await writeIntentDoc(intentRef, {
        prediction_id: predictionId,
        source_profile: sourceProfile,
        source: options.source || sourceProfile,
        symbol: intent.symbol,
        processing_stage: 'entry_discipline_fallback',
        entry_discipline_fallback: entryDiscipline.details,
        execution_discipline: entryDiscipline.details,
        intent,
        execution_audit: preExecutionAudit
      });
    } else {
    executionTrace = advanceExecutionTrace(executionTrace, {
      intent_processed_at: Date.now()
    });
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: intent.symbol,
      signal_type: sourceProfile,
      state: 'failed',
      late_entry_blocked: false
    });
    await markIntentFailed(intentRef, {
      reason: resolveFailureReason(err, 'entry_discipline_failed'),
      failure_stage: 'entry_discipline',
      processing_stage: 'entry_discipline',
      error_message: String(err?.message || err)
    });
    await writeIntentDoc(intentRef, {
      prediction_id: predictionId,
      source_profile: sourceProfile,
      source: options.source || sourceProfile,
      symbol: intent.symbol,
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay,
      intent,
      execution_audit: preExecutionAudit
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'failed',
      reason: resolveFailureReason(err, 'entry_discipline_failed'),
      dryRun: false,
      tracePayload,
      symbol: intent.symbol,
      failureStage: 'entry_discipline',
      errorMessage: String(err?.message || err),
      pendingStateResolution: 'binance_terminal_sync'
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return {
      executed: false,
      reason: 'entry_discipline_failed',
      dry_run: false,
      failed: true
    };
    }
  }

  const baseLog = {
    source: options.source || sourceProfile,
    source_profile: sourceProfile,
    signal_origin_stage: sourceProfile,
    pipeline_type: signalDataForExecution?.pipeline_type || sourceProfile,
    prediction_id: predictionId,
    dry_run: modeDryRun,
    enabled: BINANCE_EXECUTION_ENABLED,
    config_mode: effectiveConfig.mode,
    config_snapshot: {
      use_funds_percent: effectiveConfig.use_funds_percent,
      account_capital_usdt: effectiveConfig.account_capital_usdt,
      default_leverage: effectiveConfig.default_leverage,
      max_daily_trades: effectiveConfig.max_daily_trades,
      symbols_allowlist: effectiveConfig.symbols_allowlist,
      allow_unlisted_symbols: Boolean(effectiveConfig.allow_unlisted_symbols),
      max_notional_usdt: Number(effectiveConfig.max_notional_usdt || 0),
      min_recent_valid_records: Number(effectiveConfig.min_recent_valid_records || 0),
      recent_records_window_minutes: Number(effectiveConfig.recent_records_window_minutes || 0),
      symbol_cooldown_minutes: Number(effectiveConfig.symbol_cooldown_minutes || 0),
      min_confidence: effectiveConfig.min_confidence,
      min_quantum: effectiveConfig.min_quantum,
      min_timing: effectiveConfig.min_timing,
      min_context_score: effectiveConfig.min_context_score,
      min_context_quality: effectiveConfig.min_context_quality,
      min_risk_reward: effectiveConfig.min_risk_reward,
      min_expected_move_pct: effectiveConfig.min_expected_move_pct,
      early_exit_enabled: effectiveConfig.early_exit_enabled,
      early_exit_drawdown_pct: effectiveConfig.early_exit_drawdown_pct,
      margin_type: effectiveConfig.margin_type,
      order_type: effectiveConfig.order_type,
      enable_tp_sl: effectiveConfig.enable_tp_sl,
      tp_order_type: effectiveConfig.tp_order_type,
      sl_order_type: effectiveConfig.sl_order_type,
      tp_buffer_pct: effectiveConfig.tp_buffer_pct,
      sl_buffer_pct: effectiveConfig.sl_buffer_pct,
      execution_guard: effectiveConfig.execution_guard || null
    },
    validation: null,
    execution_discipline: entryDiscipline.details,
    trace_id: executionTrace.trace_id,
    execution_trace: executionTrace,
    intent,
    execution_audit: {
      ...preExecutionAudit,
      signal_expires_at: signalExpiresAt
    }
  };
  if (entryDiscipline.blocked) {
    executionTrace = advanceExecutionTrace(executionTrace, {
      intent_processed_at: Date.now()
    });
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: intent.symbol,
      signal_type: sourceProfile,
      state: 'skipped',
      late_entry_blocked: entryDiscipline.reason === 'late_entry_blocked'
    });
    await writeIntentDoc(intentRef, {
      ...baseLog,
      status: 'skipped',
      reason: entryDiscipline.reason,
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'skipped',
      reason: entryDiscipline.reason,
      dryRun: modeDryRun,
      tracePayload,
      symbol: intent.symbol,
      pendingStateResolution: 'binance_terminal_sync'
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return { executed: false, reason: entryDiscipline.reason, dry_run: modeDryRun };
  }

  let rules = null;
  let validation = null;
  try {
    await updateIntentProcessingStage(intentRef, 'pre_validation');
    const preValidationStartedAtMs = Date.now();
    const exchangeInfoStartedAtMs = Date.now();
    rules = await withTimeout(
      getFuturesSymbolRules(intent.symbol),
      INTENT_STAGE_TIMEOUT_MS,
      `exchange_info:${intent.symbol || 'unknown'}`
    );
    logLiveStageTiming({
      stage: 'exchange_info',
      startedAtMs: exchangeInfoStartedAtMs,
      symbol: intent.symbol,
      predictionId,
      extra: {
        cache_source: rules?.cache_source || null
      }
    });
    validation = await withTimeout(
      validateExecutionIntent(db, intent, effectiveConfig, {
        source_profile: sourceProfile,
        rules
      }),
      INTENT_STAGE_TIMEOUT_MS,
      'intent_validation'
    );
    logLiveStageTiming({
      stage: 'pre_validation',
      startedAtMs: preValidationStartedAtMs,
      symbol: intent.symbol,
      predictionId,
      extra: {
        ok: Boolean(validation?.ok)
      }
    });
  } catch (err) {
    if (String(err?.failureStage || err?.message || '').includes('exchange_info:')) {
      console.warn('[EXCHANGE_INFO_TIMEOUT]', {
        symbol: intent.symbol,
        prediction_id: predictionId,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
    }
    executionTrace = advanceExecutionTrace(executionTrace, {
      intent_processed_at: Date.now()
    });
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: intent.symbol,
      signal_type: sourceProfile,
      state: 'failed',
      late_entry_blocked: false
    });
    await writeIntentDoc(intentRef, {
      ...baseLog,
      status: 'failed',
      failure_stage: 'pre_validation',
      error_message: String(err?.message || err),
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'failed',
      reason: resolveFailureReason(err, 'pre_validation_failed'),
      dryRun: false,
      tracePayload,
      symbol: intent.symbol,
      failureStage: 'pre_validation',
      errorMessage: String(err?.message || err),
      pendingStateResolution: 'binance_terminal_sync'
    });
    await markIntentFailed(intentRef, {
      reason: resolveFailureReason(err, 'pre_validation_failed'),
      failure_stage: 'pre_validation',
      processing_stage: 'pre_validation',
      error_message: String(err?.message || err)
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return {
      executed: false,
      reason: 'pre_validation_failed',
      dry_run: false,
      failed: true
    };
  }
  let preciseIntent = applyIntentPrecision(
    enforceLiveNotionalFloor(intent, rules, sourceProfile),
    rules
  );
  executionTrace = advanceExecutionTrace(executionTrace, {
    intent_processed_at: Date.now()
  });
  await updateIntentProcessingStage(intentRef, 'validated');
  await writeIntentDoc(intentRef, {
    ...baseLog,
    validation,
    execution_trace: executionTrace,
    intent: preciseIntent
  });

  if (!validation.ok) {
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: preciseIntent.symbol,
      signal_type: sourceProfile,
      state: 'skipped',
      late_entry_blocked: false
    });
    await writeIntentDoc(intentRef, {
      ...baseLog,
      status: 'skipped',
      reason: validation.reason,
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'skipped',
      reason: validation.reason,
      dryRun: modeDryRun,
      tracePayload,
      symbol: preciseIntent.symbol,
      pendingStateResolution: 'binance_terminal_sync'
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return { executed: false, reason: validation.reason, dry_run: modeDryRun };
  }

  if (!modeDryRun && effectiveConfig?.execution_guard?.enabled !== false) {
    await updateIntentProcessingStage(intentRef, 'execution_guard');
    entrySnapshot = await resolveExecutionSnapshot(db, preciseIntent.symbol, effectiveConfig);
    executionGuardResult = evaluateExecutionGuard(
      preciseIntent.symbol,
      {
        ...signalDataForExecution,
        side: preciseIntent.side,
        entry_price: preciseIntent.entry_price
      },
      entrySnapshot,
      {
        botConfig: effectiveConfig,
        side: preciseIntent.side
      }
    );
    const entrySnapshotPersistence = buildEntrySnapshotPersistence(
      executionGuardResult,
      preciseIntent.entry_price,
      preciseIntent.entry_price
    );
    console.info('[ENTRY_QUALITY_SCORE]', {
      symbol: preciseIntent.symbol,
      prediction_id: predictionId,
      score: executionGuardResult.entryQualityScore,
      thresholds: executionGuardResult.qualityThresholds || {
        high: executionGuardResult.qualityThreshold,
        medium: null
      },
      zone: executionGuardResult.qualityZone,
      lifecycle_state: executionGuardResult.entryLifecycleState,
      components: executionGuardResult.entryQualityComponents,
      penalties: executionGuardResult.entryQualityPenalties || []
    });
    if (executionGuardResult.signalExpired) {
      console.info('[SIGNAL_EXPIRED]', {
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        signal_age_ms: executionGuardResult.signalAgeMs,
        signal_expiration_ms: executionGuardResult.signalExpirationMs
      });
    }
    if (executionGuardResult.blocked) {
      console.info('[ENTRY_BLOCK_REASON]', {
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        reason: executionGuardResult.reason,
        decision_reason: executionGuardResult.decisionReason,
        zone: executionGuardResult.qualityZone,
        lifecycle_state: executionGuardResult.entryLifecycleState,
        invalidation_detected: executionGuardResult.invalidationDetected,
        deterioration_detected: executionGuardResult.deteriorationDetected,
        negative_signals: executionGuardResult.negativeSignals,
        positive_signals: executionGuardResult.positiveSignals
      });
      console.info('[EXECUTION_GUARD]', {
        blocked: true,
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        reason: executionGuardResult.reason,
        signal_age_ms: executionGuardResult.signalAgeMs,
        entry_quality_score: executionGuardResult.entryQualityScore,
        price_deviation_pct: executionGuardResult.priceDeviationPct,
        estimated_slippage_pct: executionGuardResult.estimatedSlippagePct,
        conditions: executionGuardResult.conditions
      });
      console.info('[ENTRY_DECISION]', {
        decision: 'blocked',
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        zone: executionGuardResult.qualityZone,
        lifecycle_state: executionGuardResult.entryLifecycleState,
        score: executionGuardResult.entryQualityScore,
        decision_reason: executionGuardResult.decisionReason
      });
      const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
        trace: executionTrace,
        symbol: preciseIntent.symbol,
        signal_type: sourceProfile,
        state: 'skipped',
        late_entry_blocked: false
      });
      await writeIntentDoc(intentRef, {
        ...baseLog,
        status: 'skipped',
        reason: executionGuardResult.reason,
        processing_stage: 'execution_guard_blocked',
        execution_guard: executionGuardResult,
        entry_execution_snapshot: entrySnapshotPersistence,
        trace_id: tracePayload.trace_id,
        execution_trace: tracePayload.execution_trace,
        execution_trace_metrics: tracePayload.execution_trace_metrics,
        dominant_delay_stage: tracePayload.dominant_delay_stage,
        critical_delay: tracePayload.critical_delay
      });
      await syncPredictionTerminalState(db, {
        predictionId,
        sourceProfile,
        status: 'skipped',
        reason: executionGuardResult.reason,
        dryRun: false,
        tracePayload,
        symbol: preciseIntent.symbol,
        pendingStateResolution: 'binance_terminal_sync'
      });
      await logExecutionDiscipline(db, {
        type: 'entry_control',
        event: 'execution_guard_blocked',
        blocked: true,
        source_profile: sourceProfile,
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        details: {
          reason: executionGuardResult.reason,
          signal_age_ms: executionGuardResult.signalAgeMs,
          signal_expiration_ms: executionGuardResult.signalExpirationMs,
          entry_quality_score: executionGuardResult.entryQualityScore,
          price_deviation_pct: executionGuardResult.priceDeviationPct,
          estimated_slippage_pct: executionGuardResult.estimatedSlippagePct,
          negative_signals: executionGuardResult.negativeSignals,
          snapshot_age_ms: executionGuardResult.snapshotAgeMs
        }
      });
      try {
        releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
      } catch (_) {
        // noop
      }
      return {
        executed: false,
        reason: executionGuardResult.reason,
        dry_run: false,
        skipped: true
      };
    }
    console.info('[EXECUTION_GUARD]', {
      blocked: false,
      symbol: preciseIntent.symbol,
      prediction_id: predictionId,
      signal_age_ms: executionGuardResult.signalAgeMs,
      entry_quality_score: executionGuardResult.entryQualityScore,
      price_deviation_pct: executionGuardResult.priceDeviationPct,
      estimated_slippage_pct: executionGuardResult.estimatedSlippagePct
    });
    console.info('[ENTRY_DECISION]', {
      decision: 'executed',
      symbol: preciseIntent.symbol,
      prediction_id: predictionId,
      zone: executionGuardResult.qualityZone,
      lifecycle_state: executionGuardResult.entryLifecycleState,
      score: executionGuardResult.entryQualityScore,
      decision_reason: executionGuardResult.decisionReason
    });
    const sizingApplied = applyEntryQualitySizing(
      preciseIntent,
      executionGuardResult,
      rules,
      effectiveConfig,
      sourceProfile
    );
    preciseIntent = sizingApplied.intent || preciseIntent;
    console.info('[ENTRY_SIZING_APPLIED]', {
      symbol: preciseIntent.symbol,
      prediction_id: predictionId,
      score: executionGuardResult.entryQualityScore,
      band: sizingApplied?.sizing?.band || null,
      requested_size_factor: sizingApplied?.sizing?.sizeFactor || null,
      effective_size_factor: sizingApplied?.sizing?.effectiveSizeFactor || sizingApplied?.sizing?.sizeFactor || 1,
      base_notional_usdt: sizingApplied?.sizing?.baseNotionalUsdt || null,
      adjusted_notional_usdt: sizingApplied?.sizing?.adjustedNotionalUsdt || null
    });
    await writeIntentDoc(intentRef, {
      processing_stage: 'execution_guard_passed',
      execution_guard: executionGuardResult,
      entry_execution_snapshot: entrySnapshotPersistence,
      intent: preciseIntent,
      entry_sizing: sizingApplied?.sizing || null
    });
  }

  if (modeDryRun) {
    const dryRunReason = forcedObserveMode ? 'observe_mode' : 'dry_run';
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: preciseIntent.symbol,
      signal_type: sourceProfile,
      state: 'dry_run',
      late_entry_blocked: false
    });
    await writeIntentDoc(intentRef, {
      ...baseLog,
      status: 'dry_run',
      reason: dryRunReason,
      observe_mode_forced: forcedObserveMode,
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'dry_run',
      reason: dryRunReason,
      dryRun: true,
      tracePayload,
      symbol: preciseIntent.symbol,
      pendingStateResolution: 'binance_terminal_sync'
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return {
      executed: false,
      reason: dryRunReason,
      dry_run: true,
      observe_mode: forcedObserveMode
    };
  }

  let marginRes = null;
  let leverageRes = null;
  let orderRes = null;
  let exitsRes = null;
  let liveIntent = preciseIntent;
  let executedAt = new Date();
  let adaptiveExecutionProfile = null;
  const qtyPrecision = Number.isFinite(preciseIntent?._quantity_precision)
    ? Number(preciseIntent._quantity_precision)
    : decimalsFromStep(rules?.marketStepSize || rules?.stepSize || 0);
  try {
    await updateIntentProcessingStage(intentRef, 'live_order');
    executionTrace = advanceExecutionTrace(executionTrace, {
      execution_attempt_at: Date.now()
    });
    const marginSetupStartedAtMs = Date.now();
    const marginSetup = await withTimeout(
      configureMarginAndLeverageWithFallback(
        preciseIntent.symbol,
        preciseIntent.margin_type,
        preciseIntent.leverage
      ),
      BINANCE_LIVE_ORDER_TIMEOUT_MS,
      'margin_leverage_setup'
    );
    marginRes = marginSetup.margin;
    leverageRes = marginSetup.leverage;
    logLiveStageTiming({
      stage: 'margin_setup',
      startedAtMs: marginSetupStartedAtMs,
      symbol: preciseIntent.symbol,
      predictionId,
      extra: {
        fallback_used: Boolean(marginSetup?.fallback_used),
        margin_timeout_fallback: Boolean(marginSetup?.fallback_detail?.margin),
        leverage_timeout_fallback: Boolean(marginSetup?.fallback_detail?.leverage)
      }
    });
    executionTrace = advanceExecutionTrace(executionTrace, {
      order_sent_at: Date.now()
    });
    const orderAttemptStartedAtMs = Date.now();
    orderRes = await withTimeout(
      signedRequest('/fapi/v1/order', {
        symbol: preciseIntent.symbol,
        side: preciseIntent.side,
        type: preciseIntent.order_type,
        quantity: toPlainFixed(preciseIntent.quantity, qtyPrecision),
        newOrderRespType: 'RESULT'
      }),
      BINANCE_LIVE_ORDER_TIMEOUT_MS,
      'entry_order'
    );
    logLiveStageTiming({
      stage: 'order_attempt',
      startedAtMs: orderAttemptStartedAtMs,
      symbol: preciseIntent.symbol,
      predictionId,
      extra: {
        order_id: orderRes?.orderId || null
      }
    });
    executionTrace = advanceExecutionTrace(executionTrace, {
      order_ack_at: Date.now()
    });

    const executedQuantity = resolveExecutedQuantity(orderRes, preciseIntent.quantity);
    const filledEntryPrice = resolveFilledEntryPrice(orderRes, preciseIntent.entry_price, executedQuantity);
    executedAt = resolveOrderExecutedAt(orderRes);
    liveIntent = applyIntentPrecision(
      {
        ...preciseIntent,
        quantity: executedQuantity,
        entry_price: filledEntryPrice,
        ...reanchorExitLevelsToFill(preciseIntent, filledEntryPrice)
      },
      rules
    );

    const slippageDiscipline = await withTimeout(
      evaluateFilledOrderDiscipline({
        db,
        signalData: signalDataForExecution,
        intent: liveIntent,
        orderResponse: orderRes,
        sourceProfile
      }),
      INTENT_STAGE_TIMEOUT_MS,
      'filled_order_discipline'
    );
    if (slippageDiscipline.blocked) {
      const emergencyClose = await closePositionMarket({
        symbol: liveIntent.symbol,
        side: liveIntent.side,
        quantity: liveIntent.quantity
      }).catch((err) => ({ error: String(err?.message || err) }));
      const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
        trace: executionTrace,
        symbol: liveIntent.symbol,
        signal_type: sourceProfile,
        state: 'blocked',
        late_entry_blocked: false
      });

      await writeIntentDoc(intentRef, {
        ...baseLog,
        status: 'blocked',
        reason: slippageDiscipline.reason,
        intent: liveIntent,
        execution_discipline: slippageDiscipline.details,
        trace_id: tracePayload.trace_id,
        execution_trace: tracePayload.execution_trace,
        execution_trace_metrics: tracePayload.execution_trace_metrics,
        dominant_delay_stage: tracePayload.dominant_delay_stage,
        critical_delay: tracePayload.critical_delay,
        exchange_response: {
          margin: marginRes,
          leverage: leverageRes,
          order: orderRes,
          emergency_close: emergencyClose
        }
      });
      await syncPredictionTerminalState(db, {
        predictionId,
        sourceProfile,
        status: 'blocked',
        reason: slippageDiscipline.reason,
        dryRun: false,
        tracePayload,
        symbol: liveIntent.symbol,
        orderId: orderRes?.orderId || null,
        pendingStateResolution: 'binance_terminal_sync'
      });
      try {
        releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
      } catch (_) {
        // noop
      }
      return {
        executed: false,
        reason: slippageDiscipline.reason,
        dry_run: false,
        blocked: true
      };
    }

    await updateIntentProcessingStage(intentRef, 'protective_orders');
    exitsRes = await withTimeout(
      placeExitOrders(liveIntent, rules, { referencePrice: liveIntent.entry_price }),
      BINANCE_PROTECTIVE_ORDER_TIMEOUT_MS,
      'protective_orders'
    );
  } catch (err) {
    if (String(err?.failureStage || err?.message || '').includes('margin_leverage_setup')) {
      console.warn('[MARGIN_SETUP_TIMEOUT]', {
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        message: sanitizeBinanceErrorMessage(err?.message || err)
      });
    }
    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
      trace: executionTrace,
      symbol: preciseIntent.symbol,
      signal_type: sourceProfile,
      state: 'failed',
      late_entry_blocked: false
    });
    await writeIntentDoc(intentRef, {
      ...baseLog,
      status: 'failed',
      failure_stage: 'live_order',
      error_message: String(err?.message || err),
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay,
      exchange_response: {
        margin: marginRes,
        leverage: leverageRes,
        order: orderRes,
        exits: exitsRes
      }
    });
    await syncPredictionTerminalState(db, {
      predictionId,
      sourceProfile,
      status: 'failed',
      reason: resolveFailureReason(err, 'live_order_failed'),
      dryRun: false,
      tracePayload,
      symbol: preciseIntent.symbol,
      failureStage: 'live_order',
      errorMessage: String(err?.message || err),
      pendingStateResolution: 'binance_terminal_sync'
    });
    await markIntentFailed(intentRef, {
      reason: resolveFailureReason(err, 'live_order_failed'),
      failure_stage: 'live_order',
      processing_stage: 'live_order',
      error_message: String(err?.message || err)
    });
    try {
      releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    } catch (_) {
      // noop
    }
    return {
      executed: false,
      reason: 'live_order_failed',
      dry_run: false,
      failed: true
    };
  }
  try {
    adaptiveExecutionProfile = await loadAdaptiveExecutionProfile();
  } catch (_) {
    adaptiveExecutionProfile = null;
  }
  const {
    tpOrderId,
    slOrderId,
    protectiveStopAvailable,
    protectiveOrderStatus
  } = resolveProtectivePersistence(exitsRes, liveIntent.enable_tp_sl);
  const executionAudit = buildExecutionAudit(signalDataForExecution, executedAt);
  const executedEntrySnapshot = buildEntrySnapshotPersistence(
    executionGuardResult,
    liveIntent.entry_price,
    preciseIntent.entry_price
  );
  const lifecycleDirection = String(liveIntent?.side || 'BUY').toUpperCase() === 'SELL' ? -1 : 1;
  const lifecycleEntryVelocity =
    Number(executedEntrySnapshot?.microstructure?.velocity || 0) * lifecycleDirection;
  const lifecycleEntryImbalance =
    Number(executedEntrySnapshot?.microstructure?.imbalance || 0) * lifecycleDirection;
  const lifecyclePositiveSignals =
    (executedEntrySnapshot?.momentum_aligned ? 1 : 0) +
    (lifecycleEntryVelocity > 0 ? 1 : 0) +
    (lifecycleEntryImbalance > 0 ? 1 : 0);
  const lifecycleNegativeSignals = Math.max(0, Number(executedEntrySnapshot?.negative_signals || 0));
  const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
    trace: executionTrace,
    symbol: preciseIntent.symbol,
    signal_type: sourceProfile,
    state: 'executed',
    late_entry_blocked: false
  });
  const expectedDurationWindow = resolveExpectedDurationWindow(signalData);
  const positionMaxHoldSeconds = resolvePositionMaxHoldSeconds({
    signalData: {
      ...signalData,
      entry_price: liveIntent.entry_price,
      trade_plan: {
        ...(signalData?.trade_plan || {}),
        entry_price: liveIntent.entry_price,
        take_profit: liveIntent.take_profit,
        stop_loss: liveIntent.stop_loss
      },
      source_profile: sourceProfile,
      source: options.source || sourceProfile
    },
    adaptiveProfile: adaptiveExecutionProfile
  });

  await writeIntentDoc(intentRef, {
    ...baseLog,
    status: 'executed',
    intent: liveIntent,
    trace_id: tracePayload.trace_id,
    execution_trace: tracePayload.execution_trace,
    execution_trace_metrics: tracePayload.execution_trace_metrics,
    dominant_delay_stage: tracePayload.dominant_delay_stage,
    critical_delay: tracePayload.critical_delay,
    processing_stage: 'executed',
    tp_order_id: tpOrderId,
    sl_order_id: slOrderId,
    protective_order_status: protectiveOrderStatus,
    protective_stop_available: protectiveStopAvailable,
    entry_sizing: {
      score: Number(liveIntent?.entry_quality_score || 0) || null,
      band: liveIntent?.entry_quality_band || null,
      size_factor: Number(liveIntent?.entry_quality_size_factor || 0) || 1,
      base_notional_usdt: Number(liveIntent?.entry_quality_base_notional_usdt || 0) || null,
      adjusted_notional_usdt: Number(liveIntent?.entry_quality_adjusted_notional_usdt || 0) || null
    },
    execution_guard: executionGuardResult,
    entry_execution_snapshot: executedEntrySnapshot,
    execution_audit: executionAudit,
    exchange_response: {
      margin: marginRes,
      leverage: leverageRes,
      order: orderRes,
      exits: exitsRes
    }
  });
  await syncPredictionTerminalState(db, {
    predictionId,
    sourceProfile,
    status: 'executed',
    reason: protectiveOrderStatus || 'executed',
    dryRun: false,
    executed: true,
    orderId: orderRes?.orderId || null,
    tracePayload,
    symbol: liveIntent.symbol
  });

  const openedAtIso = executedAt.toISOString();
  const openPositionRef = await db.collection('binance_open_positions').add({
    source: options.source || sourceProfile,
    source_profile: sourceProfile,
    signal_origin_stage: sourceProfile,
    pipeline_type: signalDataForExecution?.pipeline_type || sourceProfile,
    prediction_id: predictionId,
    symbol: liveIntent.symbol,
    side: liveIntent.side,
    quantity: liveIntent.quantity,
    quantity_precision: Number.isFinite(Number(liveIntent?._quantity_precision))
      ? Number(liveIntent._quantity_precision)
      : null,
    quantity_step: Number.isFinite(Number(liveIntent?._quantity_step))
      ? Number(liveIntent._quantity_step)
      : null,
    confidence: Number(liveIntent.confidence || 0) || null,
    quantum: Number(liveIntent.quantum || 0) || null,
    timing: Number(liveIntent.timing || 0) || null,
    risk_reward_ratio: Number(liveIntent.risk_reward_ratio || 0) || null,
    expected_move_percent: Number(liveIntent.expected_move_percent || 0) || null,
    entry_quality_score: Number(liveIntent.entry_quality_score || 0) || null,
    entry_quality_band: liveIntent.entry_quality_band || null,
    entry_quality_size_factor: Number(liveIntent.entry_quality_size_factor || 0) || 1,
    entry_quality_base_notional_usdt: Number(liveIntent.entry_quality_base_notional_usdt || 0) || null,
    entry_quality_adjusted_notional_usdt: Number(liveIntent.entry_quality_adjusted_notional_usdt || 0) || null,
    entry_price: liveIntent.entry_price,
    signal_entry_price: preciseIntent.entry_price,
    take_profit: liveIntent.take_profit,
    stop_loss: liveIntent.stop_loss,
    order_id: orderRes?.orderId || null,
    tp_order_id: tpOrderId,
    sl_order_id: slOrderId,
    protective_order_status: protectiveOrderStatus,
    protective_stop_available: protectiveStopAvailable,
    protective_order_reason: exitsRes?.sl_reason || exitsRes?.reason || null,
    protective_order_errors: {
      tp_error: exitsRes?.tp_error || null,
      sl_error: exitsRes?.sl_error || null
    },
    protective_order_validation: {
      tp: exitsRes?.tp_validation || null,
      sl: exitsRes?.sl_validation || null
    },
    opened_at: openedAtIso,
    status: 'open',
    mode: 'live',
    early_exit_enabled: Boolean(effectiveConfig.early_exit_enabled),
    early_exit_drawdown_pct: Number(effectiveConfig.early_exit_drawdown_pct || 0),
    expected_duration_min_seconds: expectedDurationWindow.min,
    expected_duration_max_seconds: expectedDurationWindow.max,
    adaptive_horizon_seconds:
      Number(adaptiveExecutionProfile?.adaptive_horizon_seconds ?? adaptiveExecutionProfile?.adaptive_horizon) || null,
    position_max_hold_seconds: positionMaxHoldSeconds,
    execution_audit: executionAudit,
    win_model: executionAudit.win_model,
    win_exchange: null,
    trace_id: tracePayload.trace_id,
    execution_trace: tracePayload.execution_trace,
    execution_trace_metrics: tracePayload.execution_trace_metrics,
    dominant_delay_stage: tracePayload.dominant_delay_stage,
    critical_delay: tracePayload.critical_delay,
    execution_guard: executionGuardResult,
    entry_execution_snapshot: executedEntrySnapshot,
    order_executed_at: openedAtIso,
    impulse_lifecycle: {
      mode: effectiveConfig?.impulse_lifecycle?.mode || 'off',
      enabled: Boolean(effectiveConfig?.impulse_lifecycle?.enabled),
      impulse_state: 'incubation',
      impulse_state_reason: 'minimum_observation_window',
      impulse_state_legacy: 'ignition',
      lifecycle_phase: 'incubation',
      incubation_completed: false,
      evaluation_elapsed_ms: 0,
      time_to_first_expansion_ms: null,
      ms_since_first_expansion: null,
      expansion_confirmed: false,
      expansion_guard_active: false,
      structural_improvement: Boolean(executedEntrySnapshot?.momentum_aligned),
      positive_signal_count: lifecyclePositiveSignals,
      negative_signal_count: lifecycleNegativeSignals,
      no_ignition_eligible: false,
      early_mfe_pct: 0,
      early_mae_pct: 0,
      max_pnl_pct: 0,
      min_pnl_pct: 0,
      peak_price_seen:
        Number(
          executedEntrySnapshot?.execution_price ||
            executedEntrySnapshot?.execution_reference_price ||
            liveIntent.entry_price ||
            0
        ) || null,
      trough_price_seen:
        Number(
          executedEntrySnapshot?.execution_price ||
            executedEntrySnapshot?.execution_reference_price ||
            liveIntent.entry_price ||
            0
        ) || null,
      pullback_from_peak_pct: 0,
      stall_duration_ms: 0,
      momentum_decay_score: 0,
      new_extreme_count: 0,
      last_micro_price:
        Number(
          executedEntrySnapshot?.execution_price ||
            executedEntrySnapshot?.execution_reference_price ||
            liveIntent.entry_price ||
            0
        ) || null,
      lifecycle_last_updated_at: openedAtIso,
      lifecycle_last_updated_at_ms: executedAt.getTime(),
      entry_context: executedEntrySnapshot,
      observation_snapshot: executedEntrySnapshot?.microstructure || null,
      impulse_state_timeline: [
        {
          state: 'incubation',
          reason: 'minimum_observation_window',
          at: openedAtIso,
          pnl_pct: 0,
          price: Number(liveIntent.entry_price || 0) || null
        }
      ]
    },
    adaptive_exit_shadow: {
      mode: effectiveConfig?.adaptive_exit?.mode || 'off',
      enabled: Boolean(effectiveConfig?.adaptive_exit?.enabled),
      should_exit: false,
      exit_reason: 'hold',
      exit_priority: 0,
      exit_confidence: 0,
      decision_count: 0,
      conflicts_count: 0,
      latest_decision_at: openedAtIso
    },
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  });

  try {
    await writeIntentDoc(intentRef, {
      linked_position_id: openPositionRef.id,
      tp_order_id: tpOrderId,
      sl_order_id: slOrderId,
      protective_order_status: protectiveOrderStatus,
      protective_stop_available: protectiveStopAvailable
    });
    releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
    await ensureSymbolObservation(observationSymbol, 'open_position', {
      db,
      config,
      key: `position:${openPositionRef.id}`,
      ttlMs: effectiveConfig?.market_stream?.position_ttl_ms,
      priority: 5,
      metadata: {
        source_profile: sourceProfile,
        prediction_id: predictionId
      }
    });
  } catch (err) {
    console.warn('[MARKET_STREAM] ensure open position failed', err.message);
  }

  await logExecutionDiscipline(db, {
    type: 'entry_control',
    event: 'entry_accepted',
      blocked: false,
      source_profile: sourceProfile,
      symbol: liveIntent.symbol,
      prediction_id: predictionId,
      details: {
        execution_delay_seconds: executionAudit?.delay_seconds ?? null,
        execution_delay_ms: entryDiscipline?.details?.execution_delay_ms ?? null,
        is_late_entry: executionAudit?.is_late_entry ?? null,
        quantity: liveIntent.quantity,
        filled_entry_price: liveIntent.entry_price,
        signal_entry_price: preciseIntent.entry_price,
        signal_price: executedEntrySnapshot?.signal_price ?? null,
        signal_age_ms: executedEntrySnapshot?.signal_age_ms ?? null,
        entry_quality_score: executedEntrySnapshot?.entry_quality_score ?? null,
        price_deviation_pct: executedEntrySnapshot?.price_deviation_pct ?? null,
        estimated_slippage_pct: executedEntrySnapshot?.estimated_slippage_pct ?? null,
        late_entry_type: entryDiscipline?.details?.late_entry_type || 'none',
        override_applied: Boolean(entryDiscipline?.details?.override_applied),
        override_reason: entryDiscipline?.details?.override_reason || 'normal_execution'
      }
    });

  return {
    executed: true,
    dry_run: false,
    symbol: liveIntent.symbol,
    side: liveIntent.side,
    quantity: liveIntent.quantity,
    order_id: orderRes?.orderId || null,
    open_position_id: openPositionRef.id,
    exits: exitsRes?.placed
      ? {
          tp_order_id: tpOrderId,
          sl_order_id: slOrderId,
          tp_stop_price: exitsRes?.tp_stop_price || null,
          sl_stop_price: exitsRes?.sl_stop_price || null
        }
      : null,
    protective_order_status: protectiveOrderStatus
  };
}

async function executeHighConvictionTrade(db, signalData) {
  return executeSignalTrade(db, signalData, { source: 'high_conviction', source_profile: 'high_conviction' });
}

module.exports = {
  executeSignalTrade,
  executeHighConvictionTrade,
  createExecutionIntent,
  toBinanceSymbol,
  getMarkPrice,
  getPositionRisk,
  getFuturesWalletBalance,
  getFuturesIncomeHistory,
  closePositionMarket,
  warmExchangeInfoCache,
  getExchangeInfoCacheStatus
};

