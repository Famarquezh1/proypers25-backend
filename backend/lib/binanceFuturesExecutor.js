const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const db = require('../firebase-admin-config');
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
const { STALE_PENDING_PREDICTION_TIMEOUT_MS } = require('../services/execution/pendingPredictionWatchdog');

const BINANCE_EXECUTION_ENABLED = true;
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
const BINANCE_MIN_CONFIDENCE = 0.65;
const BINANCE_MIN_QUANTUM = 0.6;
const BINANCE_MIN_TIMING = 0.6;
const BINANCE_EVENT_MIN_CONFIDENCE = 0.65;
const BINANCE_EVENT_MIN_QUANTUM = 0.6;
const BINANCE_EVENT_MIN_TIMING = 0.6;
const BINANCE_EVENT_MIN_EXPECTED_MOVE_PCT = Math.max(
    0,
    Number(process.env.BINANCE_EVENT_MIN_EXPECTED_MOVE_PCT || 0.15)
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
const ROUND_TRIP_FEE_PCT = Number(process.env.ROUND_TRIP_FEE_PCT || 0.10);
const EXECUTION_FRICTION_PCT = Number(process.env.EXECUTION_FRICTION_PCT || 0.05);
const MIN_NET_EDGE_PCT = Number(process.env.MIN_NET_EDGE_PCT || 0.15);
const TOTAL_COST_PCT = ROUND_TRIP_FEE_PCT + EXECUTION_FRICTION_PCT;
const MIN_EXPECTED_MOVE_PCT = TOTAL_COST_PCT + MIN_NET_EDGE_PCT;
const SAFE_POSITION_SIZE_PERCENT = Math.max(
    0.01,
    Math.min(1, Number(process.env.BINANCE_SAFE_POSITION_SIZE_PERCENT || 0.1))
);
const SAFE_MAX_CONCURRENT_TRADES = Math.max(
    1,
    Number(process.env.BINANCE_SAFE_MAX_CONCURRENT_TRADES || 1)
);
const HARD_STOP_DAILY_PNL_PCT = -1.0;
const HARD_STOP_CONSECUTIVE_LOSSES = 3;
const HARD_STOP_MIN_TRADES = 10;
const HARD_STOP_MIN_WIN_RATE_PCT = 40;
const PROTECTIVE_MAX_SL_PCT = 0.5;
const PROTECTIVE_MAX_TP_PCT = 0.8;
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
const BINANCE_EVENT_EMITTED_OBSERVE_MODE = false;
const BINANCE_MANUAL_PREALERT_OBSERVE_MODE = false;
const SOURCE_PROFILE_KEYS = new Set(['high_conviction', 'event_emitted', 'manual_prealert']);
const EXCHANGE_INFO_TTL_MS = 60 * 60 * 1000;
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
const TIME_ALIGNED_EXECUTION_ENABLED =
    String(process.env.TIME_ALIGNED_EXECUTION_ENABLED || 'true').toLowerCase() !== 'false';
const EXECUTION_CONFIRMATION_DELAY_MS = Math.max(
    15000,
    Math.min(30000, Number(process.env.EXECUTION_CONFIRMATION_DELAY_MS || 20000))
);
const EXECUTION_RETRY_DELAY_MS = [
    EXECUTION_CONFIRMATION_DELAY_MS,
    Math.max(
        EXECUTION_CONFIRMATION_DELAY_MS,
        Math.min(45000, Number(process.env.EXECUTION_SECOND_RETRY_DELAY_MS || 40000))
    )
];
const EXECUTION_MAX_ALIGNMENT_HORIZON_MS = Math.max(
    45000,
    Number(process.env.EXECUTION_MAX_ALIGNMENT_HORIZON_MS || 90000)
);
const EXECUTION_MAX_INTENT_LIFETIME_MS = Math.max(
    EXECUTION_CONFIRMATION_DELAY_MS,
    Number(process.env.EXECUTION_MAX_INTENT_LIFETIME_MS || 120000)
);
const BINANCE_LIVE_ORDER_TIMEOUT_MS = Math.max(
    INTENT_STAGE_TIMEOUT_MS,
    Number(process.env.BINANCE_LIVE_ORDER_TIMEOUT_MS || 20000)
);
const BINANCE_MARGIN_LEVERAGE_PREFLIGHT_TIMEOUT_MS = Math.max(
    2500,
    Math.min(8000, Number(process.env.BINANCE_MARGIN_LEVERAGE_PREFLIGHT_TIMEOUT_MS || 5000))
);
const BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS = Math.max(
    BINANCE_MARGIN_LEVERAGE_PREFLIGHT_TIMEOUT_MS,
    Number(process.env.BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS || 10000)
);
const BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_ATTEMPTS = Math.max(
    1,
    Math.min(2, Number(process.env.BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_ATTEMPTS || 2))
);
const BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_DELAY_MS = Math.max(
    0,
    Number(process.env.BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_DELAY_MS || 500)
);
const BINANCE_MARGIN_LEVERAGE_PREFLIGHT_RETRY_BACKOFF_MS = Math.max(
    BINANCE_MARGIN_LEVERAGE_PREFLIGHT_TIMEOUT_MS,
    Number(process.env.BINANCE_MARGIN_LEVERAGE_PREFLIGHT_RETRY_BACKOFF_MS || 60000)
);
const BINANCE_MARGIN_LEVERAGE_READINESS_TTL_MS = Math.max(
    60 * 60 * 1000,
    Number(process.env.BINANCE_MARGIN_LEVERAGE_READINESS_TTL_MS || 24 * 60 * 60 * 1000)
);
const BINANCE_MARGIN_LEVERAGE_FIRESTORE_HYDRATION_TIMEOUT_MS = Math.max(
    300,
    Math.min(1000, Number(process.env.BINANCE_MARGIN_LEVERAGE_FIRESTORE_HYDRATION_TIMEOUT_MS || 500))
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
const marginLeverageReadyCache = new Map();
let marginLeverageFirestoreHydrationPromise = null;
let marginLeverageFirestoreHydratedAt = 0;
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
        return Number.isFinite(d ?.getTime ?.()) ? d : null;
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
        signalData ?.signal_at ||
        signalData ?.created_at ||
        signalData ?.timestamp ||
        signalData ?.ahora ||
        signalData ?.entry_time ||
        signalData ?.entry_window_start_at
    );
}

function resolveWindowEndAt(signalData, signalAt) {
    const direct =
        parseDateLike(signalData ?.entry_window_end_at) ||
        parseDateLike(signalData ?.window_end_at) ||
        parseDateLike(signalData ?.entry_window_ends_at);
    if (direct) return direct;

    const hms =
        signalData ?.entry_window_utc ?.end ||
        signalData ?.entry_window ?.end ||
        signalData ?.window_utc ?.end;
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
    const resolvedSymbol = resolveExecutionSymbolContext(signalData);
    const rawSignalSymbol = resolveRawSignalSymbol(signalData);
    if (sourceProfile !== 'manual_prealert') {
        return {
            ...signalData,
            symbol: resolvedSymbol.symbol || signalData ?.symbol || null,
            signal_symbol: rawSignalSymbol,
            execution_symbol_source: resolvedSymbol.source,
            pipeline_type: sourceProfile,
            signal_emitted_at: signalData ?.signal_emitted_at || signalData ?.emitted_at || signalData ?.timestamp || fallbackIso,
            timestamp: signalData ?.timestamp || fallbackIso
        };
    }

    const receivedAt = parseDateLike(fallbackIso) || new Date();
    const prealertAnchor =
        parseDateLike(signalData ?.manual_prealert_generated_at) ||
        parseDateLike(signalData ?.prealert_generated_at) ||
        parseDateLike(signalData ?.generated_at) ||
        parseDateLike(signalData ?.signal_emitted_at) ||
        parseDateLike(signalData ?.emitted_at) ||
        parseDateLike(signalData ?.ahora) ||
        receivedAt;

    const rawSignalAt = resolveSignalAt(signalData);
    const normalizedSignalAt = !rawSignalAt || Math.abs(prealertAnchor.getTime() - rawSignalAt.getTime()) > MANUAL_PREALERT_TIMESTAMP_DRIFT_MS ?
        prealertAnchor :
        rawSignalAt;

    const normalizedWindowStart =
        parseDateLike(signalData ?.entry_window_start_at) ||
        parseDateLike(signalData ?.entry_window ?.start) ||
        normalizedSignalAt;
    let normalizedWindowEnd = resolveWindowEndAt(signalData, normalizedSignalAt);
    if (!normalizedWindowEnd || normalizedWindowEnd.getTime() < normalizedSignalAt.getTime()) {
        normalizedWindowEnd = addSeconds(normalizedSignalAt, Number(process.env.ENTRY_WINDOW_SECONDS || 30));
    }

    return {
        ...signalData,
        symbol: resolvedSymbol.symbol || signalData ?.symbol || null,
        signal_symbol: rawSignalSymbol,
        execution_symbol_source: resolvedSymbol.source,
        pipeline_type: 'manual_prealert',
        signal_created_at: toIsoOrNull(normalizedSignalAt),
        signal_emitted_at: toIsoOrNull(prealertAnchor),
        emitted_at: toIsoOrNull(prealertAnchor),
        timestamp: toIsoOrNull(normalizedSignalAt),
        created_at: signalData ?.created_at || toIsoOrNull(normalizedSignalAt),
        ahora: signalData ?.ahora || toIsoOrNull(prealertAnchor),
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
        win_model: normalizeModelOutcome(signalData ?.verification_outcome || signalData ?.status),
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

function logExecutionPipelineStage({ predictionId = null, symbol = null, stage = null, extra = {} } = {}) {
    console.info('[EXECUTION_PIPELINE_STAGE]', {
        prediction_id: predictionId || null,
        symbol: symbol || null,
        stage: stage || null,
        ...extra
    });
}

function recordLiveOrderStage(diagnostics, {
    stage = null,
    startedAtMs = null,
    result = 'success',
    errorMessage = null,
    extra = {}
} = {}) {
    if (!diagnostics || !stage) return null;
    const startedAt = Number(startedAtMs || Date.now());
    const durationMs = Math.max(0, Date.now() - startedAt);
    const entry = {
        stage,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: durationMs,
        result,
        error_message: errorMessage ? sanitizeBinanceErrorMessage(errorMessage) : null,
        ...extra
    };
    if (!Array.isArray(diagnostics.stages)) {
        diagnostics.stages = [];
    }
    diagnostics.stages.push(entry);
    diagnostics.last_stage = stage;
    diagnostics.last_stage_result = result;
    if (entry.error_message) {
        diagnostics.last_error_message = entry.error_message;
    }
    console.info('[LIVE_ORDER_STAGE]', {
        intent_id: diagnostics.intent_id || null,
        symbol: diagnostics.symbol || null,
        stage,
        started_at: entry.started_at,
        duration_ms: durationMs,
        result,
        error_message: entry.error_message,
        ...extra
    });
    return entry;
}

function logExecutionTimeoutPath({
    predictionId = null,
    symbol = null,
    stage = null,
    timeoutMs = null,
    reason = null
} = {}) {
    console.warn('[EXECUTION_TIMEOUT_PATH]', {
        prediction_id: predictionId || null,
        symbol: symbol || null,
        stage: stage || null,
        timeout_ms: Number.isFinite(Number(timeoutMs)) ? Number(timeoutMs) : null,
        reason: reason || null
    });
}

function launchDetached(task, label) {
    setImmediate(() => {
        Promise.resolve()
            .then(task)
            .catch((err) => {
                console.warn(label, err ?.message || err);
            });
    });
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
            code: Number(body ?.code),
            msg: String(body ?.msg || body ?.message || '')
        };
    } catch (_) {
        return {
            code: null,
            msg: String(bodyText || '')
        };
    }
}

function isBinanceAuthInvalidError(err) {
    const code = Number(err ?.binanceCode ?? err ?.code ?? NaN);
    const message = String(err ?.message || '');
    return code === -2014 || code === -2015 || message.includes('"code":-2014') || message.includes('"code":-2015');
}

function setBinanceAuthInvalid(err, path) {
    const message = sanitizeBinanceErrorMessage(err ?.message || err);
    binanceAuthState.invalid = true;
    binanceAuthState.code = Number(err ?.binanceCode ?? err ?.code ?? NaN) || null;
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
                message: sanitizeBinanceErrorMessage(err ?.message || err)
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
        const snapshot = data.snapshot && typeof data.snapshot === 'object' ?
            {...data.snapshot } :
            null;
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
            snapshot_at: persisted ?.snapshot_at || persisted ?.published_at || null
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
            snapshot_at: persisted ?.snapshot_at || persisted ?.published_at || null
        });
        return persisted;
    }

    if (snapshot || persisted) {
        console.warn('[STALE_SNAPSHOT_USED]', {
            symbol,
            source: snapshot ? 'stale_live_snapshot' : 'stale_persisted_snapshot',
            snapshot_at: snapshot ?.snapshot_at ||
                snapshot ?.published_at ||
                persisted ?.snapshot_at ||
                persisted ?.published_at ||
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
    const microstructure = guardResult ?.microstructure || {};
    const executionReferencePrice =
        Number(microstructure.execution_reference_price || liveEntryPrice || 0) || null;
    return {
        signal_timestamp: guardResult ?.signalTimestamp || null,
        signal_age_ms: Number.isFinite(Number(guardResult ?.signalAgeMs)) ? Number(guardResult.signalAgeMs) : null,
        signal_expiration_ms: Number.isFinite(Number(guardResult ?.signalExpirationMs)) ?
            Number(guardResult.signalExpirationMs) :
            null,
        signal_price: Number.isFinite(Number(guardResult ?.signalPrice)) ? Number(guardResult.signalPrice) : null,
        expected_entry_price: Number.isFinite(Number(expectedEntryPrice)) ? Number(expectedEntryPrice) : null,
        execution_reference_price: executionReferencePrice,
        execution_price: Number.isFinite(Number(liveEntryPrice)) ? Number(liveEntryPrice) : executionReferencePrice,
        price_deviation_pct: Number.isFinite(Number(guardResult ?.priceDeviationPct)) ?
            Number(guardResult.priceDeviationPct) :
            null,
        estimated_slippage_pct: Number.isFinite(Number(guardResult ?.estimatedSlippagePct)) ?
            Number(guardResult.estimatedSlippagePct) :
            null,
        entry_quality_score: Number.isFinite(Number(guardResult ?.entryQualityScore)) ?
            Number(guardResult.entryQualityScore) :
            null,
        entry_quality_threshold: Number.isFinite(Number(guardResult ?.qualityThreshold)) ?
            Number(guardResult.qualityThreshold) :
            null,
        entry_quality_components: guardResult ?.entryQualityComponents || null,
        negative_signals: Number.isFinite(Number(guardResult ?.negativeSignals)) ?
            Number(guardResult.negativeSignals) :
            null,
        momentum_aligned: Boolean(guardResult ?.momentumAligned),
        deterioration_detected: Boolean(guardResult ?.deteriorationDetected),
        strong_stall: Boolean(guardResult ?.strongStall),
        snapshot_age_ms: Number.isFinite(Number(guardResult ?.snapshotAgeMs)) ? Number(guardResult.snapshotAgeMs) : null,
        snapshot_available: Boolean(guardResult ?.snapshotAvailable),
        snapshot_fresh: Boolean(guardResult ?.snapshotFresh),
        microstructure: {
            last_price: Number.isFinite(Number(microstructure.last_price)) ? Number(microstructure.last_price) : null,
            bid: Number.isFinite(Number(microstructure.bid)) ? Number(microstructure.bid) : null,
            ask: Number.isFinite(Number(microstructure.ask)) ? Number(microstructure.ask) : null,
            spread_bps: Number.isFinite(Number(microstructure.spread_bps)) ? Number(microstructure.spread_bps) : null,
            recent_trades_window: Number.isFinite(Number(microstructure.recent_trades_window)) ?
                Number(microstructure.recent_trades_window) :
                0,
            velocity: Number.isFinite(Number(microstructure.velocity)) ? Number(microstructure.velocity) : null,
            acceleration: Number.isFinite(Number(microstructure.acceleration)) ?
                Number(microstructure.acceleration) :
                null,
            imbalance: Number.isFinite(Number(microstructure.imbalance)) ? Number(microstructure.imbalance) : null,
            micro_high: Number.isFinite(Number(microstructure.micro_high)) ? Number(microstructure.micro_high) : null,
            micro_low: Number.isFinite(Number(microstructure.micro_low)) ? Number(microstructure.micro_low) : null,
            snapshot_at: microstructure.snapshot_at || null,
            price_history_points: Number.isFinite(Number(microstructure.price_history_points)) ?
                Number(microstructure.price_history_points) :
                null,
            velocity_history_points: Number.isFinite(Number(microstructure.velocity_history_points)) ?
                Number(microstructure.velocity_history_points) :
                null
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
    await ref.set({
        ...payload,
        updated_at: FieldValue.serverTimestamp()
    }, { merge: true });
}

function isFirestoreIndexMissingError(err) {
    const message = String(err ?.message || err || '').toLowerCase();
    return (
        message.includes('requires an index') ||
        message.includes('failed_precondition') ||
        message.includes('create_composite')
    );
}

async function assertFreshIntentForEntry({ intentRef, symbol, side }) {
    if (!intentRef) {
        return { ok: false, reason: 'intent_ref_missing' };
    }

    const snap = await intentRef.get();
    if (!snap.exists) {
        return { ok: false, reason: 'intent_doc_missing' };
    }

    const data = snap.data() || {};
    const createdAtMs =
        (typeof data ?.created_at ?.toMillis === 'function' ? data.created_at.toMillis() : null) ??
        toNum(data ?.created_at_ms, null) ??
        toNum(data ?.execution_trace ?.intent_created_at, null) ??
        toNum(data ?.execution_trace ?.signal_emitted_at, null);
    const ageMs = Number.isFinite(createdAtMs) ? Math.max(0, Date.now() - createdAtMs) : null;
    const intentSymbol = String(data ?.symbol || data ?.intent ?.symbol || '').toUpperCase();
    const intentSide = String(data ?.intent ?.side || '').toUpperCase();

    if (!intentSymbol || intentSymbol !== String(symbol || '').toUpperCase()) {
        return { ok: false, reason: 'intent_symbol_mismatch', ageMs };
    }
    if (!intentSide || intentSide !== String(side || '').toUpperCase()) {
        return { ok: false, reason: 'intent_side_mismatch', ageMs };
    }
    if (!Number.isFinite(ageMs)) {
        return { ok: false, reason: 'intent_created_at_missing', ageMs };
    }
    if (ageMs > EXECUTION_MAX_INTENT_LIFETIME_MS) {
        return { ok: false, reason: 'intent_too_old', ageMs };
    }
    if (ageMs > 30 * 1000) {
        console.log('[ORPHAN_BYPASSED]', {
            intent_id: snap.id,
            symbol: intentSymbol,
            side: intentSide,
            age_ms: ageMs,
            max_intent_lifetime_ms: EXECUTION_MAX_INTENT_LIFETIME_MS,
            reason: 'within_execution_lifetime'
        });
    }

    return { ok: true, ageMs };
}

async function fetchRecentIntentDocs(db, limit = 400) {
    const safeLimit = Math.max(50, Math.min(Number(limit || 0) || 400, 1000));
    try {
        return await db
            .collection('binance_execution_intents')
            .orderBy('created_at', 'desc')
            .limit(safeLimit)
            .get();
    } catch (err) {
        console.warn('[INTENT_SCAN_FALLBACK]', {
            limit: safeLimit,
            message: sanitizeBinanceErrorMessage(err ?.message || err)
        });
        return db.collection('binance_execution_intents').limit(safeLimit).get();
    }
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
        traceId: tracePayload ?.trace_id || null,
        symbol,
        failureStage,
        errorMessage,
        pendingStateResolution
    });
}

async function syncPredictionHandoffLifecycle(db, predictionId, payload = {}) {
    if (!db || !predictionId || !payload || typeof payload !== 'object') return;
    try {
        await db.collection('velas_predicciones').doc(String(predictionId)).set({
            binance_execution: {
                lifecycle: payload
            },
            updated_at: new Date().toISOString()
        }, { merge: true });
    } catch (err) {
        console.warn('[SIGNAL_HANDOFF_LIFECYCLE] sync failed', {
            prediction_id: predictionId,
            message: sanitizeBinanceErrorMessage(err ?.message || err)
        });
    }
}

function clamp(value, min, max) {
    if (!Number.isFinite(value)) return min;
    if (max < min) return min;
    return Math.max(min, Math.min(max, value));
}

function resolveExpectedDurationWindow(signalData = {}) {
    const raw =
        signalData ?.expected_duration_seconds ??
        signalData ?.window_seconds ??
        signalData ?.trade_plan ?.expected_duration_seconds ??
        signalData ?.event_driven_info ?.impulseDurationSeconds ??
        signalData ?.max_duration_seconds ??
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
    const sourceProfile = String(signalData ?.source_profile || signalData ?.source || 'event_emitted').toLowerCase();
    const expectedWindow = resolveExpectedDurationWindow(signalData);
    const expectedMax = Number(expectedWindow ?.max || 0);
    const adaptiveHorizon = Number(
        adaptiveProfile ?.adaptive_horizon_seconds ?? adaptiveProfile ?.adaptive_horizon ?? 0
    );
    const globalMaxMinutes =
        sourceProfile === 'high_conviction' ?
        BINANCE_POSITION_MAX_HOLD_MINUTES_HIGH_CONVICTION :
        BINANCE_POSITION_MAX_HOLD_MINUTES;
    const globalMax = globalMaxMinutes * 60;
    const holdMultiplier =
        sourceProfile === 'high_conviction' ?
        POSITION_HOLD_MULTIPLIER_HIGH_CONVICTION :
        POSITION_HOLD_MULTIPLIER;

    if (expectedMax > 0) {
        const expectedWindowBased = expectedMax * holdMultiplier;
        return Math.round(clamp(expectedWindowBased, POSITION_HOLD_MIN_SECONDS, globalMax));
    }
    if (adaptiveHorizon > 0) {
        return Math.round(clamp(adaptiveHorizon, POSITION_HOLD_MIN_SECONDS, globalMax));
    }
    return globalMax;
}

function resolvePendingProtectivePersistence(enableTpSl = true) {
    return {
        tpOrderId: null,
        slOrderId: null,
        protectiveStopAvailable: false,
        protectiveOrderStatus: enableTpSl === false ? 'tp_sl_disabled' : 'pending_submission'
    };
}

function buildOpenPositionPayload({
    source = null,
    sourceProfile = null,
    signalDataForExecution = {},
    predictionId = null,
    liveIntent = {},
    preciseIntent = {},
    orderRes = null,
    persistence = null,
    exitsRes = null,
    effectiveConfig = {},
    expectedDurationWindow = { min: null, max: null },
    positionMaxHoldSeconds = null,
    executionAudit = null,
    tracePayload = null,
    executionTrace = null,
    executionGuardResult = null,
    executedEntrySnapshot = null,
    adaptiveExecutionProfile = null,
    openedAtIso = null,
    executedAt = null,
    includeTimestamps = false
} = {}) {
    const openedIso = openedAtIso || new Date().toISOString();
    const executedDate = parseDateLike(executedAt) || parseDateLike(openedIso) || new Date();
    const resolvedPersistence = persistence || resolvePendingProtectivePersistence(liveIntent ?.enable_tp_sl);
    const lifecycleDirection = String(liveIntent ?.side || 'BUY').toUpperCase() === 'SELL' ? -1 : 1;
    const lifecycleEntryVelocity =
        Number(executedEntrySnapshot ?.microstructure ?.velocity || 0) * lifecycleDirection;
    const lifecycleEntryImbalance =
        Number(executedEntrySnapshot ?.microstructure ?.imbalance || 0) * lifecycleDirection;
    const lifecyclePositiveSignals =
        (executedEntrySnapshot ?.momentum_aligned ? 1 : 0) +
        (lifecycleEntryVelocity > 0 ? 1 : 0) +
        (lifecycleEntryImbalance > 0 ? 1 : 0);
    const lifecycleNegativeSignals = Math.max(0, Number(executedEntrySnapshot ?.negative_signals || 0));
    const payload = {
        source: source || sourceProfile || null,
        source_profile: sourceProfile || null,
        signal_origin_stage: sourceProfile || null,
        pipeline_type: signalDataForExecution ?.pipeline_type || sourceProfile || null,
        prediction_id: predictionId || null,
        symbol: liveIntent.symbol || null,
        signal_symbol: signalDataForExecution ?.signal_symbol || null,
        side: liveIntent.side || null,
        quantity: liveIntent.quantity,
        quantity_precision: Number.isFinite(Number(liveIntent ?._quantity_precision)) ?
            Number(liveIntent._quantity_precision) :
            null,
        quantity_step: Number.isFinite(Number(liveIntent ?._quantity_step)) ?
            Number(liveIntent._quantity_step) :
            null,
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
        order_id: orderRes ?.orderId || null,
        tp_order_id: resolvedPersistence.tpOrderId,
        sl_order_id: resolvedPersistence.slOrderId,
        protective_order_status: resolvedPersistence.protectiveOrderStatus,
        protective_stop_available: resolvedPersistence.protectiveStopAvailable,
        protective_order_reason: exitsRes ?.sl_reason || exitsRes ?.reason || null,
        protective_order_errors: {
            tp_error: exitsRes ?.tp_error || null,
            sl_error: exitsRes ?.sl_error || null
        },
        protective_order_validation: {
            tp: exitsRes ?.tp_validation || null,
            sl: exitsRes ?.sl_validation || null
        },
        opened_at: openedIso,
        status: 'open',
        mode: 'live',
        early_exit_enabled: Boolean(effectiveConfig.early_exit_enabled),
        early_exit_drawdown_pct: Number(effectiveConfig.early_exit_drawdown_pct || 0),
        expected_duration_min_seconds: expectedDurationWindow.min,
        expected_duration_max_seconds: expectedDurationWindow.max,
        adaptive_horizon_seconds: Number(adaptiveExecutionProfile ?.adaptive_horizon_seconds ?? adaptiveExecutionProfile ?.adaptive_horizon) || null,
        position_max_hold_seconds: positionMaxHoldSeconds,
        execution_audit: executionAudit,
        win_model: executionAudit ?.win_model || null,
        win_exchange: null,
        trace_id: tracePayload ?.trace_id || executionTrace ?.trace_id || null,
        execution_trace: tracePayload ?.execution_trace || executionTrace || null,
        execution_trace_metrics: tracePayload ?.execution_trace_metrics || null,
        dominant_delay_stage: tracePayload ?.dominant_delay_stage || null,
        critical_delay: tracePayload ?.critical_delay || null,
        execution_guard: executionGuardResult,
        entry_execution_snapshot: executedEntrySnapshot,
        order_executed_at: openedIso,
        impulse_lifecycle: {
            mode: effectiveConfig ?.impulse_lifecycle ?.mode || 'off',
            enabled: Boolean(effectiveConfig ?.impulse_lifecycle ?.enabled),
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
            structural_improvement: Boolean(executedEntrySnapshot ?.momentum_aligned),
            positive_signal_count: lifecyclePositiveSignals,
            negative_signal_count: lifecycleNegativeSignals,
            no_ignition_eligible: false,
            early_mfe_pct: 0,
            early_mae_pct: 0,
            max_pnl_pct: 0,
            min_pnl_pct: 0,
            peak_price_seen: Number(
                executedEntrySnapshot ?.execution_price ||
                executedEntrySnapshot ?.execution_reference_price ||
                liveIntent.entry_price ||
                0
            ) || null,
            trough_price_seen: Number(
                executedEntrySnapshot ?.execution_price ||
                executedEntrySnapshot ?.execution_reference_price ||
                liveIntent.entry_price ||
                0
            ) || null,
            pullback_from_peak_pct: 0,
            stall_duration_ms: 0,
            momentum_decay_score: 0,
            new_extreme_count: 0,
            last_micro_price: Number(
                executedEntrySnapshot ?.execution_price ||
                executedEntrySnapshot ?.execution_reference_price ||
                liveIntent.entry_price ||
                0
            ) || null,
            lifecycle_last_updated_at: openedIso,
            lifecycle_last_updated_at_ms: executedDate.getTime(),
            entry_context: executedEntrySnapshot,
            observation_snapshot: executedEntrySnapshot ?.microstructure || null,
            impulse_state_timeline: [{
                state: 'incubation',
                reason: 'minimum_observation_window',
                at: openedIso,
                pnl_pct: 0,
                price: Number(liveIntent.entry_price || 0) || null
            }]
        },
        adaptive_exit_shadow: {
            mode: effectiveConfig ?.adaptive_exit ?.mode || 'off',
            enabled: Boolean(effectiveConfig ?.adaptive_exit ?.enabled),
            should_exit: false,
            exit_reason: 'hold',
            exit_priority: 0,
            exit_confidence: 0,
            decision_count: 0,
            conflicts_count: 0,
            latest_decision_at: openedIso
        }
    };
    payload.updated_at = FieldValue.serverTimestamp();
    if (includeTimestamps) {
        payload.created_at = FieldValue.serverTimestamp();
    }
    return payload;
}

async function finalizeLiveExecutionPostOrder({
    db,
    config,
    intentRef,
    openPositionRef,
    signalDataForExecution,
    signalData,
    sourceProfile,
    predictionId,
    source,
    observationSymbol,
    effectiveConfig,
    rules,
    preciseIntent,
    liveIntent,
    marginRes,
    leverageRes,
    orderRes,
    liveOrderDiagnostics,
    executionGuardResult,
    executionTrace,
    entryDiscipline
} = {}) {
    let exitsRes = null;
    let adaptiveExecutionProfile = null;
    const executedAt = resolveOrderExecutedAt(orderRes);
    const executionAudit = buildExecutionAudit(signalDataForExecution, executedAt);
    const executedEntrySnapshot = buildEntrySnapshotPersistence(
        executionGuardResult,
        liveIntent.entry_price,
        preciseIntent.entry_price
    );
    const expectedDurationWindow = resolveExpectedDurationWindow(signalData);

    logExecutionPipelineStage({
        predictionId,
        symbol: liveIntent.symbol,
        stage: 'post_order_finalize_started'
    });

    try {
        await updateIntentProcessingStage(intentRef, 'protective_orders');
        exitsRes = await withTimeout(
            placeExitOrders(liveIntent, rules, { referencePrice: liveIntent.entry_price }),
            BINANCE_PROTECTIVE_ORDER_TIMEOUT_MS,
            'protective_orders'
        );
    } catch (err) {
        if (isTimeoutLikeError(err)) {
            logExecutionTimeoutPath({
                predictionId,
                symbol: liveIntent.symbol,
                stage: 'protective_orders',
                timeoutMs: BINANCE_PROTECTIVE_ORDER_TIMEOUT_MS,
                reason: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        }
        console.warn('[PROTECTIVE_ORDERS_BACKGROUND_FAIL]', {
            prediction_id: predictionId,
            symbol: liveIntent.symbol,
            message: sanitizeBinanceErrorMessage(err ?.message || err)
        });
        exitsRes = {
            placed: false,
            fully_protected: false,
            reason: 'manager_fallback',
            tp_error: sanitizeBinanceErrorMessage(err ?.message || err),
            sl_error: sanitizeBinanceErrorMessage(err ?.message || err)
        };
    }

    try {
        adaptiveExecutionProfile = await loadAdaptiveExecutionProfile();
    } catch (_) {
        adaptiveExecutionProfile = null;
    }

    const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
        trace: executionTrace,
        symbol: preciseIntent.symbol,
        signal_type: sourceProfile,
        state: 'executed',
        late_entry_blocked: false
    }).catch((err) => {
        console.warn('[EXECUTION_TRACE_PERSIST_FAIL]', {
            prediction_id: predictionId,
            symbol: liveIntent.symbol,
            message: err ?.message || err
        });
        return {
            trace_id: executionTrace ?.trace_id || null,
            execution_trace: executionTrace || null,
            execution_trace_metrics: null,
            dominant_delay_stage: null,
            critical_delay: null
        };
    });

    const positionMaxHoldSeconds = resolvePositionMaxHoldSeconds({
        signalData: {
            ...signalData,
            entry_price: liveIntent.entry_price,
            trade_plan: {
                ...(signalData ?.trade_plan || {}),
                entry_price: liveIntent.entry_price,
                take_profit: liveIntent.take_profit,
                stop_loss: liveIntent.stop_loss
            },
            source_profile: sourceProfile,
            source
        },
        adaptiveProfile: adaptiveExecutionProfile
    });
    const protectivePersistence = resolveProtectivePersistence(exitsRes, liveIntent.enable_tp_sl);

    await writeIntentDoc(intentRef, {
        status: 'executed',
        processing_stage: 'executed',
        needs_reconciliation: false,
        protection_required_after_reconciliation: false,
        linked_position_id: openPositionRef.id,
        intent: liveIntent,
        trace_id: tracePayload.trace_id,
        execution_trace: tracePayload.execution_trace,
        execution_trace_metrics: tracePayload.execution_trace_metrics,
        dominant_delay_stage: tracePayload.dominant_delay_stage,
        critical_delay: tracePayload.critical_delay,
        tp_order_id: protectivePersistence.tpOrderId,
        sl_order_id: protectivePersistence.slOrderId,
        protective_order_status: protectivePersistence.protectiveOrderStatus,
        protective_stop_available: protectivePersistence.protectiveStopAvailable,
        execution_guard: executionGuardResult,
        entry_execution_snapshot: executedEntrySnapshot,
        execution_audit: executionAudit,
        entry_sizing: {
            score: Number(liveIntent ?.entry_quality_score || 0) || null,
            band: liveIntent ?.entry_quality_band || null,
            size_factor: Number(liveIntent ?.entry_quality_size_factor || 0) || 1,
            base_notional_usdt: Number(liveIntent ?.entry_quality_base_notional_usdt || 0) || null,
            adjusted_notional_usdt: Number(liveIntent ?.entry_quality_adjusted_notional_usdt || 0) || null
        },
        exchange_response: {
            margin: marginRes,
            leverage: leverageRes,
            order: orderRes,
            exits: exitsRes
        }
    });
    if (liveOrderDiagnostics ?.entry_order_diagnostics) {
        recordEntryOrderStage(liveOrderDiagnostics.entry_order_diagnostics, {
            stage: 'persist_order_result',
            startedAtMs: Date.now(),
            result: 'success',
            clientOrderId: liveOrderDiagnostics.entry_order_diagnostics.client_order_id
        });
    }
    await syncPredictionTerminalState(db, {
        predictionId,
        sourceProfile,
        status: 'executed',
        reason: protectivePersistence.protectiveOrderStatus || 'executed',
        dryRun: false,
        executed: true,
        orderId: orderRes ?.orderId || null,
        tracePayload,
        symbol: liveIntent.symbol
    });
    await openPositionRef.set(
        buildOpenPositionPayload({
            source,
            sourceProfile,
            signalDataForExecution,
            predictionId,
            liveIntent,
            preciseIntent,
            orderRes,
            persistence: protectivePersistence,
            exitsRes,
            effectiveConfig,
            expectedDurationWindow,
            positionMaxHoldSeconds,
            executionAudit,
            tracePayload,
            executionTrace,
            executionGuardResult,
            executedEntrySnapshot,
            adaptiveExecutionProfile,
            openedAtIso: executedAt.toISOString(),
            executedAt,
            includeTimestamps: false
        }), { merge: true }
    );
    try {
        await ensureSymbolObservation(observationSymbol, 'open_position', {
            db,
            config,
            key: `position:${openPositionRef.id}`,
            ttlMs: effectiveConfig ?.market_stream ?.position_ttl_ms,
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
            execution_delay_seconds: executionAudit ?.delay_seconds ?? null,
            execution_delay_ms: entryDiscipline ?.details ?.execution_delay_ms ?? null,
            is_late_entry: executionAudit ?.is_late_entry ?? null,
            quantity: liveIntent.quantity,
            filled_entry_price: liveIntent.entry_price,
            signal_entry_price: preciseIntent.entry_price,
            signal_price: executedEntrySnapshot ?.signal_price ?? null,
            signal_age_ms: executedEntrySnapshot ?.signal_age_ms ?? null,
            entry_quality_score: executedEntrySnapshot ?.entry_quality_score ?? null,
            price_deviation_pct: executedEntrySnapshot ?.price_deviation_pct ?? null,
            estimated_slippage_pct: executedEntrySnapshot ?.estimated_slippage_pct ?? null,
            late_entry_type: entryDiscipline ?.details ?.late_entry_type || 'none',
            override_applied: Boolean(entryDiscipline ?.details ?.override_applied),
            override_reason: entryDiscipline ?.details ?.override_reason || 'normal_execution'
        }
    });
}

async function reconcileFilledTimedOutEntryOrder({
    db,
    intentRef,
    intentRow = {},
    orderResponse = null,
    context = {}
} = {}) {
    if (!db || !intentRef || !orderResponse) return null;

    const sourceProfile = context.sourceProfile || intentRow.source_profile || intentRow.source || 'event_emitted';
    const source = context.source || intentRow.source || sourceProfile;
    const predictionId = context.predictionId || intentRow.prediction_id || null;
    const preciseIntentBase = (intentRow.intent && typeof intentRow.intent === 'object') ?
        {...intentRow.intent } :
        {};
    const rules = context.rules || await getFuturesSymbolRules(preciseIntentBase.symbol);
    const preciseIntent = applyIntentPrecision(preciseIntentBase, rules);
    const executedQuantity = resolveExecutedQuantity(orderResponse, preciseIntent.quantity);
    const filledEntryPrice = resolveFilledEntryPrice(orderResponse, preciseIntent.entry_price, executedQuantity);
    const executedAt = resolveOrderExecutedAt(orderResponse);
    const liveIntent = applyIntentPrecision({
            ...preciseIntent,
            quantity: executedQuantity,
            entry_price: filledEntryPrice,
            ...reanchorExitLevelsToFill(preciseIntent, filledEntryPrice)
        },
        rules
    );
    const effectiveConfig = context.effectiveConfig || intentRow.config_snapshot || {};
    const executionGuardResult = context.executionGuardResult || intentRow.execution_guard || null;
    const executionTrace = context.executionTrace || intentRow.execution_trace || null;
    const liveOrderDiagnostics = intentRow.live_order_diagnostics && typeof intentRow.live_order_diagnostics === 'object' ?
        JSON.parse(JSON.stringify(intentRow.live_order_diagnostics)) :
        {};
    const signalDataForExecution = context.signalDataForExecution || {
        pipeline_type: intentRow.pipeline_type || sourceProfile,
        signal_symbol: intentRow.signal_symbol || liveIntent.symbol || null,
        source_profile: sourceProfile,
        source,
        trade_plan: {
            entry_price: liveIntent.entry_price,
            take_profit: liveIntent.take_profit,
            stop_loss: liveIntent.stop_loss
        }
    };
    const signalData = context.signalData || {
        ...signalDataForExecution,
        source_profile: sourceProfile,
        source
    };
    const marginRes = context.marginRes || intentRow.exchange_response ?.margin || null;
    const leverageRes = context.leverageRes || intentRow.exchange_response ?.leverage || null;
    const observationSymbol = context.observationSymbol || liveIntent.symbol || null;
    const existingOpenPositionRef = await findOpenPositionRefByOrderId(db, {
        linkedPositionId: intentRow.linked_position_id,
        orderId: orderResponse ?.orderId || null
    });
    let openPositionRef = existingOpenPositionRef;
    if (!openPositionRef) {
        openPositionRef = db.collection('binance_open_positions').doc();
        const openedAtIso = executedAt.toISOString();
        const executionAudit = buildExecutionAudit(signalDataForExecution, executedAt);
        const executedEntrySnapshot = buildEntrySnapshotPersistence(
            executionGuardResult,
            liveIntent.entry_price,
            preciseIntent.entry_price
        );
        const expectedDurationWindow = resolveExpectedDurationWindow(signalData);
        const positionMaxHoldSeconds = resolvePositionMaxHoldSeconds({
            signalData: {
                ...signalData,
                entry_price: liveIntent.entry_price,
                trade_plan: {
                    ...(signalData ?.trade_plan || {}),
                    entry_price: liveIntent.entry_price,
                    take_profit: liveIntent.take_profit,
                    stop_loss: liveIntent.stop_loss
                },
                source_profile: sourceProfile,
                source
            },
            adaptiveProfile: null
        });
        await openPositionRef.set(
            buildOpenPositionPayload({
                source,
                sourceProfile,
                signalDataForExecution,
                predictionId,
                liveIntent,
                preciseIntent,
                orderRes: orderResponse,
                persistence: resolvePendingProtectivePersistence(liveIntent.enable_tp_sl),
                exitsRes: null,
                effectiveConfig,
                expectedDurationWindow,
                positionMaxHoldSeconds,
                executionAudit,
                tracePayload: null,
                executionTrace,
                executionGuardResult,
                executedEntrySnapshot,
                adaptiveExecutionProfile: null,
                openedAtIso,
                executedAt,
                includeTimestamps: true
            }), { merge: true }
        );
    }

    const positionRisk = await getPositionRisk(liveIntent.symbol).catch(() => null);
    const positionAmt = Number(positionRisk ?.positionAmt || 0);
    const positionExists = Number.isFinite(positionAmt) ? Math.abs(positionAmt) > 0 : false;
    const currentProtectiveStopAvailable = Boolean(
        intentRow.protective_stop_available ||
        intentRow.live_order_diagnostics ?.protective_stop_available ||
        intentRow.sl_order_id
    );
    const protectionRequiredAfterReconciliation = Boolean(
        liveIntent.enable_tp_sl !== false &&
        !currentProtectiveStopAvailable
    );
    const entryOrderDiagnostics = liveOrderDiagnostics.entry_order_diagnostics || null;
    if (entryOrderDiagnostics) {
        entryOrderDiagnostics.result = 'reconciled_filled';
        entryOrderDiagnostics.duration_ms = Math.max(
            0,
            Date.now() - Number(entryOrderDiagnostics.started_at_ms || Date.now())
        );
        entryOrderDiagnostics.http_status = entryOrderDiagnostics.http_status || 200;
        entryOrderDiagnostics.binance_code = null;
        entryOrderDiagnostics.binance_msg = normalizeBinanceOrderStatus(orderResponse ?.status);
    }
    const reconciliation = {
        requested_at: intentRow.entry_order_reconciliation ?.requested_at || new Date().toISOString(),
        requested_at_ms: Number(intentRow.entry_order_reconciliation ?.requested_at_ms || Date.now()) || Date.now(),
        reconciled_at: new Date().toISOString(),
        reconciled_at_ms: Date.now(),
        reconciliation_delay_ms: Math.max(
            0,
            Date.now() - Number(
                intentRow.entry_order_reconciliation ?.requested_at_ms ||
                liveOrderDiagnostics ?.entry_order_diagnostics ?.started_at_ms ||
                Date.now()
            )
        ),
        result: normalizeBinanceOrderStatus(orderResponse ?.status) === 'PARTIALLY_FILLED' ?
            'order_filled_after_timeout' :
            'order_filled_after_timeout',
        order_found: true,
        order_id: orderResponse ?.orderId || null,
        client_order_id: orderResponse ?.clientOrderId ||
            orderResponse ?.clientOrderID ||
            liveOrderDiagnostics ?.entry_order_diagnostics ?.client_order_id ||
            null,
        binance_order_status: normalizeBinanceOrderStatus(orderResponse ?.status),
        filled_qty: Number(orderResponse ?.executedQty || liveIntent.quantity || 0) || 0,
        avg_price: Number(orderResponse ?.avgPrice || orderResponse ?.price || liveIntent.entry_price || 0) || null,
        error_message: null,
        protection_required_after_reconciliation: protectionRequiredAfterReconciliation,
        position_exists: positionExists
    };
    await writeIntentDoc(intentRef, {
        status: 'executed',
        reason: 'order_found_after_timeout',
        processing_stage: 'reconciled_entry_order',
        needs_reconciliation: false,
        order_id: orderResponse ?.orderId || null,
        linked_position_id: openPositionRef.id,
        intent: liveIntent,
        live_order_diagnostics: {
            ...liveOrderDiagnostics,
            completed_at: new Date().toISOString(),
            result: 'reconciled_filled'
        },
        entry_order_reconciliation: reconciliation,
        protection_required_after_reconciliation: protectionRequiredAfterReconciliation,
        exchange_response: {
            ...(intentRow.exchange_response || {}),
            margin: marginRes,
            leverage: leverageRes,
            order: orderResponse
        }
    });
    console.info('[ENTRY_ORDER_RECONCILIATION]', {
        intent_id: intentRef.id,
        symbol: liveIntent.symbol,
        client_order_id: reconciliation.client_order_id,
        result: reconciliation.result,
        binance_order_status: reconciliation.binance_order_status,
        order_id: reconciliation.order_id,
        filled_qty: reconciliation.filled_qty,
        avg_price: reconciliation.avg_price,
        error_message: null
    });
    await syncPredictionTerminalState(db, {
        predictionId,
        sourceProfile,
        status: 'executed',
        reason: 'order_found_after_timeout',
        dryRun: false,
        executed: true,
        orderId: orderResponse ?.orderId || null,
        tracePayload: {
            trace_id: intentRow.trace_id || null,
            execution_trace: executionTrace || null
        },
        symbol: liveIntent.symbol,
        pendingStateResolution: 'entry_order_reconciliation'
    }).catch(() => null);

    if (protectionRequiredAfterReconciliation) {
        launchDetached(async() => {
            await finalizeLiveExecutionPostOrder({
                db,
                config: null,
                intentRef,
                openPositionRef,
                signalDataForExecution,
                signalData,
                sourceProfile,
                predictionId,
                source,
                observationSymbol,
                effectiveConfig,
                rules,
                preciseIntent,
                liveIntent,
                marginRes,
                leverageRes,
                orderRes: orderResponse,
                liveOrderDiagnostics,
                executionGuardResult,
                executionTrace,
                entryDiscipline: {
                    blocked: false,
                    details: intentRow.execution_discipline || null
                }
            });
        }, '[ENTRY_ORDER_RECONCILIATION_FINALIZE] failed');
    }

    return reconciliation;
}

async function reconcileTimedOutEntryOrders(db, options = {}) {
    if (!db) return {
        processed: 0,
        reconciled_found: 0,
        reconciled_not_found: 0,
        reconciled_filled: 0,
        still_unknown: 0
    };

    const maxDocs = Math.max(1, Math.min(200, Number(options.maxDocs || 50)));
    const contextMap = options.contextMap && typeof options.contextMap === 'object' ?
        options.contextMap :
        {};
    let targets = [];

    if (Array.isArray(options.intentIds) && options.intentIds.length) {
        const docs = await Promise.all(
            options.intentIds.map((id) => db.collection('binance_execution_intents').doc(String(id)).get().catch(() => null))
        );
        targets = docs
            .filter((snap) => snap ?.exists)
            .map((snap) => ({ ref: snap.ref, id: snap.id, ...(snap.data() || {}) }))
            .filter((row) => row.needs_reconciliation === true);
    } else {
        const snapshot = await fetchRecentIntentDocs(db, maxDocs);
        targets = snapshot.docs
            .map((doc) => ({ ref: doc.ref, id: doc.id, ...(doc.data() || {}) }))
            .filter((row) => row.needs_reconciliation === true);
    }

    const summary = {
        processed: 0,
        reconciled_found: 0,
        reconciled_not_found: 0,
        reconciled_filled: 0,
        reconciled_rejected: 0,
        still_unknown: 0
    };

    for (const row of targets) {
        summary.processed += 1;
        const intentRef = row.ref;
        const symbol = String(row.intent ?.symbol || row.symbol || '').toUpperCase();
        const clientOrderId =
            row.live_order_diagnostics ?.entry_order_diagnostics ?.client_order_id ||
            row.entry_order_reconciliation ?.client_order_id ||
            null;
        const context = contextMap[row.id] || {};
        if (!symbol || !clientOrderId) {
            summary.still_unknown += 1;
            await writeIntentDoc(intentRef, {
                entry_order_reconciliation: {
                    ...(row.entry_order_reconciliation || {}),
                    reconciled_at: new Date().toISOString(),
                    reconciled_at_ms: Date.now(),
                    result: 'still_unknown_after_lookup',
                    error_message: 'missing_symbol_or_client_order_id'
                }
            });
            continue;
        }
        try {
            const order = await getEntryOrderByClientOrderId(symbol, clientOrderId, {
                timeoutMs: Math.max(3000, Number(options.timeoutMs || 10000))
            });
            const reconciledAtMs = Date.now();
            const requestedAtMs = Number(
                row.entry_order_reconciliation ?.requested_at_ms ||
                row.live_order_diagnostics ?.entry_order_diagnostics ?.started_at_ms ||
                0
            ) || null;
            const reconciliationBase = {
                requested_at: row.entry_order_reconciliation ?.requested_at || null,
                requested_at_ms: requestedAtMs,
                reconciled_at: new Date(reconciledAtMs).toISOString(),
                reconciled_at_ms: reconciledAtMs,
                reconciliation_delay_ms: Number.isFinite(requestedAtMs) ? Math.max(0, reconciledAtMs - requestedAtMs) : null,
                client_order_id: clientOrderId
            };

            if (!order) {
                summary.reconciled_not_found += 1;
                const reconciliation = {
                    ...reconciliationBase,
                    result: 'order_not_found_after_timeout',
                    order_found: false,
                    order_id: null,
                    binance_order_status: null,
                    filled_qty: 0,
                    avg_price: null,
                    error_message: null
                };
                await writeIntentDoc(intentRef, {
                    status: 'order_not_found_after_timeout',
                    reason: 'order_not_found_after_timeout',
                    processing_stage: 'entry_order_reconciled',
                    needs_reconciliation: false,
                    entry_order_reconciliation: reconciliation,
                    live_order_diagnostics: {
                        ...(row.live_order_diagnostics || {}),
                        completed_at: new Date().toISOString(),
                        result: 'order_not_found_after_timeout'
                    }
                });
                console.info('[ENTRY_ORDER_RECONCILIATION]', {
                    intent_id: intentRef.id,
                    symbol,
                    client_order_id: clientOrderId,
                    result: reconciliation.result,
                    binance_order_status: null,
                    order_id: null,
                    filled_qty: 0,
                    avg_price: null,
                    error_message: null
                });
                continue;
            }

            const orderStatus = normalizeBinanceOrderStatus(order ?.status);
            if (orderStatus === 'FILLED' || orderStatus === 'PARTIALLY_FILLED') {
                summary.reconciled_found += 1;
                summary.reconciled_filled += 1;
                await reconcileFilledTimedOutEntryOrder({
                    db,
                    intentRef,
                    intentRow: row,
                    orderResponse: order,
                    context
                });
                continue;
            }

            const result =
                orderStatus === 'REJECTED' ?
                'order_rejected_after_timeout' :
                'order_found_after_timeout';
            if (orderStatus === 'REJECTED') {
                summary.reconciled_rejected += 1;
            } else {
                summary.reconciled_found += 1;
            }
            const reconciliation = {
                ...reconciliationBase,
                result,
                order_found: true,
                order_id: order ?.orderId || null,
                binance_order_status: orderStatus,
                filled_qty: Number(order ?.executedQty || 0) || 0,
                avg_price: Number(order ?.avgPrice || order ?.price || 0) || null,
                error_message: null
            };
            await writeIntentDoc(intentRef, {
                status: result,
                reason: result,
                processing_stage: 'entry_order_reconciled',
                needs_reconciliation: false,
                order_id: order ?.orderId || null,
                entry_order_reconciliation: reconciliation,
                live_order_diagnostics: {
                    ...(row.live_order_diagnostics || {}),
                    completed_at: new Date().toISOString(),
                    result
                },
                exchange_response: {
                    ...(row.exchange_response || {}),
                    order
                }
            });
            console.info('[ENTRY_ORDER_RECONCILIATION]', {
                intent_id: intentRef.id,
                symbol,
                client_order_id: clientOrderId,
                result,
                binance_order_status: orderStatus,
                order_id: order ?.orderId || null,
                filled_qty: Number(order ?.executedQty || 0) || 0,
                avg_price: Number(order ?.avgPrice || order ?.price || 0) || null,
                error_message: null
            });
        } catch (err) {
            summary.still_unknown += 1;
            const result = classifyReconciliationLookupError(err);
            await writeIntentDoc(intentRef, {
                entry_order_reconciliation: {
                    ...(row.entry_order_reconciliation || {}),
                    reconciled_at: new Date().toISOString(),
                    reconciled_at_ms: Date.now(),
                    result,
                    error_message: sanitizeBinanceErrorMessage(err ?.message || err)
                }
            });
            console.info('[ENTRY_ORDER_RECONCILIATION]', {
                intent_id: intentRef.id,
                symbol,
                client_order_id: clientOrderId,
                result,
                binance_order_status: null,
                order_id: null,
                filled_qty: 0,
                avg_price: null,
                error_message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        }
    }

    return summary;
}

function normalizePercent(value) {
    const n = Number(value ?? 0);
    if (!Number.isFinite(n)) return 0;
    return n > 1 ? n / 100 : n;
}

function logSymbolFlow({ symbol = null, source = null, stage = null, predictionId = null, traceId = null } = {}) {
    console.info('[SYMBOL_FLOW]', {
        symbol: symbol || null,
        source: source || null,
        stage: stage || null,
        prediction_id: predictionId || null,
        trace_id: traceId || null
    });
}

function logSymbolError(context = {}) {
    console.error('[SYMBOL_ERROR]', context);
}

function resolveRawSignalSymbol(signalData = {}) {
    const candidates = [
        signalData ?.signal_symbol,
        signalData ?.symbol,
        signalData ?.simbolo,
        signalData ?.simbolo_normalizado,
        signalData ?.symbol_normalized,
        signalData ?.trade_plan ?.symbol,
        signalData ?.trade_plan ?.simbolo,
        signalData ?.intent ?.symbol,
        signalData ?.execution ?.symbol,
        signalData ?.metadata ?.symbol
    ];
    for (const candidate of candidates) {
        if (candidate == null) continue;
        const trimmed = String(candidate).trim();
        if (trimmed) return trimmed;
    }
    return null;
}

function resolveExecutionSymbolContext(signalData = {}) {
    const candidates = [
        ['signal_symbol', signalData ?.signal_symbol],
        ['symbol', signalData ?.symbol],
        ['simbolo', signalData ?.simbolo],
        ['simbolo_normalizado', signalData ?.simbolo_normalizado],
        ['symbol_normalized', signalData ?.symbol_normalized],
        ['trade_plan.symbol', signalData ?.trade_plan ?.symbol],
        ['trade_plan.simbolo', signalData ?.trade_plan ?.simbolo],
        ['intent.symbol', signalData ?.intent ?.symbol],
        ['execution.symbol', signalData ?.execution ?.symbol],
        ['metadata.symbol', signalData ?.metadata ?.symbol]
    ];

    for (const [source, candidate] of candidates) {
        const normalized = normalizeToBinance(candidate);
        if (normalized) {
            return {
                symbol: normalized,
                source
            };
        }
    }

    return {
        symbol: null,
        source: null
    };
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
    const message = String(err ?.message || err || '');
    const name = String(err ?.name || '');
    return (
        name.includes('Timeout') ||
        message.includes('TimeoutError') ||
        message.toLowerCase().includes('aborted due to timeout')
    );
}

function isRetryableFetchError(err) {
    const code = String(err ?.code || '').toLowerCase();
    const message = String(err ?.message || err || '').toLowerCase();
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
            () => withTimeout(Promise.resolve().then(() => task()), timeoutMs, label || 'cached_task'), {
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
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
            return stale.value;
        }

        if (fallbackValue !== undefined) {
            const resolvedFallback = typeof fallbackValue === 'function' ? fallbackValue(err) : fallbackValue;
            console.warn('[FETCH_FALLBACK_USED]', {
                label: label || cacheKey || 'cached_task',
                source: 'default_fallback',
                message: sanitizeBinanceErrorMessage(err ?.message || err)
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
    const serverTime = Number(data ?.serverTime || 0);
    if (!Number.isFinite(serverTime) || serverTime <= 0) {
        throw new Error('invalid Binance server time');
    }

    binanceTimeOffsetMs = serverTime - now;
    binanceTimeOffsetFetchedAt = now;
    return binanceTimeOffsetMs;
}

async function signedRequest(path, params, method = 'POST', options = {}) {
    const {
        retryOnTimestamp = true,
            forceTimeSync = false,
            timeoutMs = null,
            diagnostics = null
    } = options;
    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) {
        const missingErr = new Error(`Binance API credentials missing for ${path}`);
        missingErr.binancePath = path;
        throw missingErr;
    }
    const signStartedAtMs = Date.now();
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
    if (diagnostics) {
        recordEntryOrderStage(diagnostics, {
            stage: 'sign_request',
            startedAtMs: signStartedAtMs,
            result: 'success'
        });
    }
    const responseStartedAtMs = Date.now();
    let response;
    try {
        response = await fetch(url, {
            method,
            headers: {
                'X-MBX-APIKEY': BINANCE_API_KEY
            },
            ...(Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0 ?
                { signal: AbortSignal.timeout(Number(timeoutMs)) } :
                {})
        });
    } catch (err) {
        if (diagnostics) {
            diagnostics.timeout_stage = 'wait_binance_response';
            diagnostics.error_message = sanitizeBinanceErrorMessage(err ?.message || err);
            recordEntryOrderStage(diagnostics, {
                stage: 'send_order_request',
                startedAtMs: responseStartedAtMs,
                result: 'failed',
                errorMessage: err ?.message || err
            });
            recordEntryOrderStage(diagnostics, {
                stage: 'wait_binance_response',
                startedAtMs: responseStartedAtMs,
                result: 'failed',
                errorMessage: err ?.message || err
            });
        }
        err.failureStage = err.failureStage || 'wait_binance_response';
        throw err;
    }
    if (diagnostics) {
        recordEntryOrderStage(diagnostics, {
            stage: 'send_order_request',
            startedAtMs: responseStartedAtMs,
            result: 'success',
            httpStatus: response.status
        });
    }
    let bodyText;
    try {
        bodyText = await response.text();
    } catch (err) {
        if (diagnostics) {
            diagnostics.timeout_stage = 'wait_binance_response';
            diagnostics.error_message = sanitizeBinanceErrorMessage(err ?.message || err);
            recordEntryOrderStage(diagnostics, {
                stage: 'wait_binance_response',
                startedAtMs: responseStartedAtMs,
                result: 'failed',
                httpStatus: response ?.status || null,
                errorMessage: err ?.message || err
            });
        }
        err.failureStage = err.failureStage || 'wait_binance_response';
        throw err;
    }
    if (diagnostics) {
        recordEntryOrderStage(diagnostics, {
            stage: 'wait_binance_response',
            startedAtMs: responseStartedAtMs,
            result: 'success',
            httpStatus: response.status
        });
    }
    let body;
    const parseStartedAtMs = Date.now();
    try {
        body = JSON.parse(bodyText);
        if (diagnostics) {
            recordEntryOrderStage(diagnostics, {
                stage: 'parse_order_response',
                startedAtMs: parseStartedAtMs,
                result: 'success',
                httpStatus: response.status
            });
        }
    } catch (_) {
        body = bodyText;
        if (diagnostics) {
            recordEntryOrderStage(diagnostics, {
                stage: 'parse_order_response',
                startedAtMs: parseStartedAtMs,
                result: 'success',
                httpStatus: response.status
            });
        }
    }
    if (!response.ok) {
        const parsedError = parseBinanceError(bodyText);
        if (diagnostics) {
            diagnostics.http_status = response.status;
            diagnostics.binance_code = Number.isFinite(parsedError.code) ? parsedError.code : null;
            diagnostics.binance_msg = parsedError.msg || null;
            diagnostics.error_message = sanitizeBinanceErrorMessage(parsedError.msg || bodyText);
        }
        if (
            retryOnTimestamp &&
            response.status === 400 &&
            typeof bodyText === 'string' &&
            bodyText.includes('"code":-1021')
        ) {
            await refreshBinanceServerTimeOffset(true);
            return signedRequest(path, params, method, {
                retryOnTimestamp: false,
                forceTimeSync: true,
                timeoutMs,
                diagnostics
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

function buildEntryOrderClientOrderId(intentId = null) {
    const raw = String(intentId || '').trim() || `entry-${Date.now()}`;
    const digest = crypto.createHash('sha1').update(raw).digest('hex').slice(0, 24);
    return `px25-${digest}`;
}

function normalizeBinanceOrderStatus(status) {
    return String(status || '').trim().toUpperCase() || null;
}

function classifyReconciliationLookupError(err) {
    if (isTimeoutLikeError(err)) return 'binance_lookup_timeout';
    return 'binance_lookup_error';
}

function recordEntryOrderStage(diagnostics, {
    stage = null,
    startedAtMs = null,
    result = 'success',
    httpStatus = null,
    binanceCode = null,
    binanceMsg = null,
    clientOrderId = null,
    errorMessage = null
} = {}) {
    if (!diagnostics || !stage) return null;
    const startedAt = Number(startedAtMs || Date.now());
    const durationMs = Math.max(0, Date.now() - startedAt);
    const entry = {
        stage,
        started_at: new Date(startedAt).toISOString(),
        duration_ms: durationMs,
        result,
        http_status: Number.isFinite(Number(httpStatus)) ? Number(httpStatus) : null,
        binance_code: Number.isFinite(Number(binanceCode)) ? Number(binanceCode) : null,
        binance_msg: binanceMsg ? sanitizeBinanceErrorMessage(binanceMsg) : null,
        client_order_id: clientOrderId || diagnostics.client_order_id || null,
        error_message: errorMessage ? sanitizeBinanceErrorMessage(errorMessage) : null
    };
    if (!Array.isArray(diagnostics.stages)) diagnostics.stages = [];
    diagnostics.stages.push(entry);
    diagnostics.last_stage = stage;
    diagnostics.duration_ms = Math.max(0, Date.now() - Number(diagnostics.started_at_ms || startedAt));
    if (entry.http_status != null) diagnostics.http_status = entry.http_status;
    if (entry.binance_code != null) diagnostics.binance_code = entry.binance_code;
    if (entry.binance_msg) diagnostics.binance_msg = entry.binance_msg;
    if (entry.error_message) diagnostics.error_message = entry.error_message;
    console.info('[ENTRY_ORDER_STAGE]', {
        intent_id: diagnostics.intent_id || null,
        symbol: diagnostics.symbol || null,
        side: diagnostics.side || null,
        order_type: diagnostics.order_type || null,
        quantity: diagnostics.quantity || null,
        notional: diagnostics.notional || null,
        price_reference: diagnostics.price_reference || null,
        reduce_only: diagnostics.reduce_only ?? null,
        position_side: diagnostics.position_side || null,
        margin_type: diagnostics.margin_type || null,
        leverage: diagnostics.leverage || null,
        started_at: entry.started_at,
        duration_ms: durationMs,
        result,
        http_status: entry.http_status,
        binance_code: entry.binance_code,
        binance_msg: entry.binance_msg,
        client_order_id: entry.client_order_id,
        error_message: entry.error_message,
        stage
    });
    return entry;
}

async function getEntryOrderByClientOrderId(symbol, clientOrderId, options = {}) {
    const normalizedSymbol = String(symbol || '').toUpperCase();
    const normalizedClientOrderId = String(clientOrderId || '').trim();
    if (!normalizedSymbol || !normalizedClientOrderId) return null;
    try {
        return await signedRequest('/fapi/v1/order', {
            symbol: normalizedSymbol,
            origClientOrderId: normalizedClientOrderId
        }, 'GET', {
            timeoutMs: Math.max(3000, Number(options.timeoutMs || 10000))
        });
    } catch (err) {
        const code = Number(err ?.binanceCode ?? err ?.code ?? NaN);
        const message = String(err ?.binanceMessage || err ?.message || '').toLowerCase();
        if (
            code === -2013 ||
            message.includes('order does not exist') ||
            message.includes('unknown order sent')
        ) {
            return null;
        }
        throw err;
    }
}

function recordLeveragePreflightStage(stages, {
    symbol = null,
    stage = null,
    startedAtMs = null,
    result = 'success',
    statusCode = null,
    binanceCode = null,
    errorMessage = null
} = {}) {
    if (!Array.isArray(stages) || !stage) return null;
    const durationMs = Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
    const entry = {
        symbol: buildMarginLeverageSymbolKey(symbol),
        stage,
        duration_ms: durationMs,
        result,
        status_code: Number.isFinite(Number(statusCode)) ? Number(statusCode) : null,
        binance_code: Number.isFinite(Number(binanceCode)) ? Number(binanceCode) : null,
        error_message: errorMessage ? sanitizeBinanceErrorMessage(errorMessage) : null
    };
    stages.push(entry);
    console.info('[LEVERAGE_PREFLIGHT_STAGE]', entry);
    return entry;
}

async function testBinancePrivateConnectivity(options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS));
    const startedAtMs = Date.now();
    try {
        await withFetchRetry(
            () => withTimeout(signedRequest('/fapi/v2/balance', {}, 'GET'), timeoutMs, 'private_connectivity'), {
                label: 'private_connectivity',
                attempts: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_ATTEMPTS,
                retryDelayMs: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_DELAY_MS,
                retryOn: isRetryableFetchError
            }
        );
        return {
            ok: true,
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            http_status: 200,
            binance_code: null,
            binance_msg: null,
            timeout: false
        };
    } catch (err) {
        return {
            ok: false,
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            http_status: Number(err ?.httpStatus || 0) || null,
            binance_code: Number.isFinite(Number(err ?.binanceCode)) ? Number(err.binanceCode) : null,
            binance_msg: sanitizeBinanceErrorMessage(err ?.binanceMessage || err ?.message || err),
            timeout: isTimeoutLikeError(err)
        };
    }
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

    const task = (async() => {
        try {
            const data = await signedRequest('/fapi/v1/leverageBracket', { symbol: requestedSymbol }, 'GET');
            const normalized = Array.isArray(data) ? data[0] : data;
            leverageBracketCache.set(requestedSymbol, { fetchedAt: Date.now(), data: normalized || null });
            return normalized || null;
        } catch (err) {
            if (cached ?.data) return cached.data;
            throw err;
        } finally {
            leverageBracketInflight.delete(requestedSymbol);
        }
    })();

    leverageBracketInflight.set(requestedSymbol, task);
    return task;
}

function resolveMaxAllowedLeverage(bracketData) {
    const brackets = Array.isArray(bracketData ?.brackets) ? bracketData.brackets : [];
    const maxFromBrackets = brackets.reduce((max, item) => {
        const current = Number(item ?.initialLeverage || 0);
        return Number.isFinite(current) && current > max ? current : max;
    }, 0);
    if (maxFromBrackets > 0) return Math.floor(maxFromBrackets);
    const direct = Number(bracketData ?.initialLeverage || 0);
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
        const message = String(err ?.message || '');
        if (!message.includes('"code":-4028')) {
            throw err;
        }
        for (const candidate of[20, 10, 5, 3, 2, 1]) {
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
    const markPrice = Number(data ?.markPrice || 0);
    if (!Number.isFinite(markPrice) || markPrice <= 0) {
        throw new Error('invalid mark price');
    }
    return markPrice;
}

function ceilToStep(value, step) {
    const v = Number(value || 0);
    const st = Number(step || 0);
    if (!Number.isFinite(v) || v <= 0) return 0;
    if (!Number.isFinite(st) || st <= 0) return v;
    const d = decimalsFromStep(step);
    const ceiled = Math.ceil((v - st * 1e-9) / st) * st;
    return Number(ceiled.toFixed(d));
}

function resolveMarkPriceFromSnapshot(snapshot = {}) {
    return (
        Number(snapshot ?.mark_price || 0) ||
        Number(snapshot ?.last_price || 0) ||
        Number(snapshot ?.mid_price || 0) ||
        Number(snapshot ?.ask || 0) ||
        Number(snapshot ?.bid || 0) ||
        null
    );
}

async function buildMinNotionalPrecheck({
    db,
    symbol,
    quantity,
    rules,
    intent,
    config,
    liveOrderDiagnostics
} = {}) {
    const snapshot = await resolveExecutionSnapshot(db, symbol, config).catch(() => null);
    const snapshotPrice = resolveMarkPriceFromSnapshot(snapshot);
    const markPrice = Number.isFinite(Number(snapshotPrice)) && Number(snapshotPrice) > 0 ?
        Number(snapshotPrice) :
        await getMarkPrice(symbol);
    const qty = Number(quantity || intent ?.quantity || 0);
    const notional = qty > 0 && markPrice > 0 ? qty * markPrice : 0;
    const minNotionalRequired = Number(rules ?.minNotional || 0) || 0;
    const quantityStep = Number(rules ?.marketStepSize || rules ?.stepSize || 0) || 0;
    const requiredQtyRaw = minNotionalRequired > 0 && markPrice > 0 ? minNotionalRequired / markPrice : 0;
    const requiredQty = ceilToStep(requiredQtyRaw, quantityStep);
    const requiredNotional = requiredQty > 0 && markPrice > 0 ? requiredQty * markPrice : minNotionalRequired;
    const shortfall = minNotionalRequired > notional ? minNotionalRequired - notional : 0;
    const shortfallPct = minNotionalRequired > 0 && shortfall > 0 ? (shortfall / minNotionalRequired) * 100 : 0;
    const payload = {
        symbol: buildMarginLeverageSymbolKey(symbol),
        mark_price: Number.isFinite(markPrice) ? Number(markPrice.toFixed(8)) : null,
        quantity: Number.isFinite(qty) ? Number(qty.toFixed(8)) : null,
        notional: Number.isFinite(notional) ? Number(notional.toFixed(8)) : null,
        min_notional_required: Number.isFinite(minNotionalRequired) ? Number(minNotionalRequired.toFixed(8)) : null,
        capital_allocated: Number(intent ?.notional_usdt || intent ?.entry_quality_adjusted_notional_usdt || 0) || null,
        leverage: Number(intent ?.leverage || 0) || null,
        risk_percent: Number(intent ?.position_size_percent || 0) || null,
        calculated_qty: Number.isFinite(qty) ? Number(qty.toFixed(8)) : null,
        required_qty: Number.isFinite(requiredQty) ? Number(requiredQty.toFixed(8)) : null,
        required_notional: Number.isFinite(requiredNotional) ? Number(requiredNotional.toFixed(8)) : null,
        quantity_step: Number.isFinite(quantityStep) && quantityStep > 0 ? Number(quantityStep) : null,
        shortfall_pct: Number.isFinite(shortfallPct) ? Number(shortfallPct.toFixed(4)) : 0,
        passed: !minNotionalRequired || notional + 1e-9 >= minNotionalRequired
    };

    if (liveOrderDiagnostics && typeof liveOrderDiagnostics === 'object') {
        liveOrderDiagnostics.min_notional_snapshot = payload;
    }
    return payload;
}

function validateStopLossForMinNotionalFloor(intent = {}) {
    const side = String(intent ?.side || '').toUpperCase();
    const entryPrice = Number(intent ?.entry_price || 0);
    const stopLoss = Number(intent ?.stop_loss || 0);
    if (!['BUY', 'SELL'].includes(side)) {
        return { valid: false, reason: 'side_invalid', distance_usdt: null, distance_pct: null };
    }
    if (!(Number.isFinite(entryPrice) && entryPrice > 0)) {
        return { valid: false, reason: 'entry_price_invalid', distance_usdt: null, distance_pct: null };
    }
    if (!(Number.isFinite(stopLoss) && stopLoss > 0)) {
        return { valid: false, reason: 'stop_loss_invalid', distance_usdt: null, distance_pct: null };
    }
    const directionalValid = side === 'BUY' ? stopLoss < entryPrice : stopLoss > entryPrice;
    if (!directionalValid) {
        return { valid: false, reason: 'stop_loss_side_mismatch', distance_usdt: null, distance_pct: null };
    }
    const distanceUsdt = Math.abs(entryPrice - stopLoss);
    const distancePct = entryPrice > 0 ? (distanceUsdt / entryPrice) * 100 : null;
    return {
        valid: distanceUsdt > 0,
        reason: distanceUsdt > 0 ? null : 'stop_loss_distance_zero',
        distance_usdt: Number.isFinite(distanceUsdt) ? Number(distanceUsdt.toFixed(8)) : null,
        distance_pct: Number.isFinite(distancePct) ? Number(distancePct.toFixed(6)) : null
    };
}

function buildMinNotionalFloorPolicy({
    intent,
    precheck,
    config
} = {}) {
    const normalizedMarginType = String(intent ?.margin_type || intent ?.requested_margin_type || '').toUpperCase();
    const leverage = Number(intent ?.leverage || precheck ?.leverage || 0) || 0;
    const capitalAllocated = Number(precheck ?.capital_allocated || intent ?.notional_usdt || 0) || 0;
    const accountCapital = Number(config ?.account_capital_usdt || 0) || 0;
    const riskPercentRatio = Number(intent ?.position_size_percent || config ?.position_size_percent || 0) || 0;
    const maxConcurrentTrades = Math.max(1, Math.floor(Number(config ?.max_concurrent_trades || 0) || 0));
    const stopLossValidation = validateStopLossForMinNotionalFloor(intent);
    const requiredQty = Number(precheck ?.required_qty || 0) || 0;
    const originalQty = Number(precheck ?.calculated_qty || precheck ?.quantity || intent ?.quantity || 0) || 0;
    const markPrice = Number(precheck ?.mark_price || 0) || 0;
    const originalNotional = Number(precheck ?.notional || 0) || 0;
    const adjustedNotional = Number(precheck ?.required_notional || 0) || 0;
    const requiredMargin = adjustedNotional > 0 && leverage > 0 ? adjustedNotional / leverage : 0;
    const currentRiskUsdt = stopLossValidation.valid ? originalQty * Number(stopLossValidation.distance_usdt || 0) : 0;
    const riskIfQtyRoundedToMin = stopLossValidation.valid ? requiredQty * Number(stopLossValidation.distance_usdt || 0) : 0;
    const maxAllowedRiskUsdt = accountCapital > 0 && riskPercentRatio > 0 ? accountCapital * riskPercentRatio : 0;
    const adjustmentSafe =
        precheck ?.passed !== true &&
        requiredQty > 0 &&
        requiredQty >= originalQty &&
        stopLossValidation.valid &&
        normalizedMarginType === 'ISOLATED' &&
        leverage > 0 &&
        leverage <= 3 &&
        maxConcurrentTrades === 1 &&
        requiredMargin > 0 &&
        capitalAllocated > 0 &&
        requiredMargin <= capitalAllocated + 1e-9 &&
        riskIfQtyRoundedToMin > 0 &&
        maxAllowedRiskUsdt > 0 &&
        riskIfQtyRoundedToMin <= maxAllowedRiskUsdt + 1e-9;

    let decisionReason = 'unknown';
    if (precheck ?.passed === true) decisionReason = 'not_needed';
    else if (!stopLossValidation.valid) decisionReason = stopLossValidation.reason || 'stop_loss_invalid';
    else if (normalizedMarginType !== 'ISOLATED') decisionReason = 'margin_type_not_isolated';
    else if (!(leverage > 0 && leverage <= 3)) decisionReason = 'leverage_above_policy';
    else if (maxConcurrentTrades !== 1) decisionReason = 'max_concurrent_trades_policy';
    else if (!(requiredMargin > 0 && capitalAllocated > 0 && requiredMargin <= capitalAllocated + 1e-9)) decisionReason = 'required_margin_exceeds_capital_allocated';
    else if (!(riskIfQtyRoundedToMin > 0 && maxAllowedRiskUsdt > 0 && riskIfQtyRoundedToMin <= maxAllowedRiskUsdt + 1e-9)) decisionReason = 'risk_after_exceeds_max_allowed';
    else if (requiredQty <= 0) decisionReason = 'required_qty_invalid';
    else decisionReason = adjustmentSafe ? 'min_notional_floor_applied' : 'min_notional_risk_blocked';

    return {
        original_qty: Number.isFinite(originalQty) ? Number(originalQty.toFixed(8)) : null,
        adjusted_qty: Number.isFinite(requiredQty) ? Number(requiredQty.toFixed(8)) : null,
        original_notional: Number.isFinite(originalNotional) ? Number(originalNotional.toFixed(8)) : null,
        adjusted_notional: Number.isFinite(adjustedNotional) ? Number(adjustedNotional.toFixed(8)) : null,
        min_notional_required: Number(precheck ?.min_notional_required || 0) || null,
        required_margin: Number.isFinite(requiredMargin) ? Number(requiredMargin.toFixed(8)) : null,
        current_risk_usdt: Number.isFinite(currentRiskUsdt) ? Number(currentRiskUsdt.toFixed(8)) : null,
        risk_before: Number.isFinite(currentRiskUsdt) ? Number(currentRiskUsdt.toFixed(8)) : null,
        risk_after: Number.isFinite(riskIfQtyRoundedToMin) ? Number(riskIfQtyRoundedToMin.toFixed(8)) : null,
        max_allowed_risk: Number.isFinite(maxAllowedRiskUsdt) ? Number(maxAllowedRiskUsdt.toFixed(8)) : null,
        required_notional: Number.isFinite(adjustedNotional) ? Number(adjustedNotional.toFixed(8)) : null,
        required_qty: Number.isFinite(requiredQty) ? Number(requiredQty.toFixed(8)) : null,
        shortfall_pct: Number(precheck ?.shortfall_pct || 0) || 0,
        leverage: leverage || null,
        margin_type: normalizedMarginType || null,
        capital_allocated_per_trade: Number.isFinite(capitalAllocated) ? Number(capitalAllocated.toFixed(8)) : null,
        risk_percent_used: Number.isFinite(riskPercentRatio) ? Number((riskPercentRatio * 100).toFixed(4)) : null,
        stop_loss_valid: stopLossValidation.valid,
        stop_loss_reason: stopLossValidation.reason,
        stop_loss_distance_pct: stopLossValidation.distance_pct,
        adjustment_safe: adjustmentSafe,
        applied: adjustmentSafe,
        blocked: !adjustmentSafe && precheck ?.passed !== true,
        reason: adjustmentSafe ? 'min_notional_floor_applied' : 'min_notional_risk_blocked',
        decision_reason: decisionReason
    };
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
            filters.find((f) => f.filterType === 'MIN_NOTIONAL') ?.notional ||
            filters.find((f) => f.filterType === 'NOTIONAL') ?.minNotional ||
            0
        )
    };
}

function buildDefaultSymbolRules(requestedSymbol) {
    return {
        symbol: requestedSymbol,
        quantityPrecision: 3,
        pricePrecision: 2,
        stepSize: 0.001,
        minQty: 0.001,
        marketStepSize: 0.001,
        marketMinQty: 0.001,
        tickSize: 0.01,
        minNotional: 5
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

    exchangeInfoSnapshotInflight = (async() => {
        try {
            let lastErr = null;
            const timeoutPlan = [BINANCE_PUBLIC_FETCH_TIMEOUT_MS, BINANCE_PUBLIC_FETCH_RETRY_TIMEOUT_MS];
            for (const timeoutMs of timeoutPlan) {
                try {
                    const response = await fetchWithTimeout(
                        `${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo`, {},
                        timeoutMs
                    );
                    if (!response.ok) {
                        throw new Error(`Binance exchangeInfo failed (${response.status})`);
                    }
                    const data = await response.json();
                    const symbolsByName = new Map();
                    for (const item of Array.isArray(data ?.symbols) ? data.symbols : []) {
                        const requestedSymbol = String(item ?.symbol || '').toUpperCase();
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
        fetched_at: exchangeInfoSnapshotCache.fetchedAt ?
            new Date(exchangeInfoSnapshotCache.fetchedAt).toISOString() :
            null,
        age_ms: exchangeInfoSnapshotCache.fetchedAt ? Math.max(0, Date.now() - exchangeInfoSnapshotCache.fetchedAt) : null
    };
}

function getExchangeInfoCacheStatus() {
    return {
        symbols_total: exchangeInfoSnapshotCache ?.symbolsByName instanceof Map ?
            exchangeInfoSnapshotCache.symbolsByName.size :
            0,
        fetched_at: exchangeInfoSnapshotCache.fetchedAt ?
            new Date(exchangeInfoSnapshotCache.fetchedAt).toISOString() :
            null,
        age_ms: exchangeInfoSnapshotCache.fetchedAt ?
            Math.max(0, Date.now() - exchangeInfoSnapshotCache.fetchedAt) :
            null
    };
}

function buildEntryDisciplineTimeoutFallback(signalData = {}, err = null) {
    const signalAt = resolveSignalAt(signalData);
    const now = new Date();
    const signalAgeMs =
        signalAt && Number.isFinite(signalAt.getTime()) ?
        Math.max(0, now.getTime() - signalAt.getTime()) :
        null;
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
    if (cached ?.rules) {
        const ageMs = Math.max(0, now - cached.fetchedAt);
        console.warn('[FETCH_FALLBACK_USED]', {
            label: `exchange_info:${requestedSymbol}`,
            source: 'stale_symbol_cache',
            age_ms: ageMs
        });
        return {
            ...cached.rules,
            cache_source: 'stale_symbol_cache'
        };
    }

    const snapshotRules = exchangeInfoSnapshotCache ?.symbolsByName ?.get ?.(requestedSymbol) || null;
    if (snapshotRules) {
        const snapshotAgeMs = exchangeInfoSnapshotCache.fetchedAt ?
            Math.max(0, now - exchangeInfoSnapshotCache.fetchedAt) :
            null;
        if (!exchangeInfoCache.has(requestedSymbol)) {
            exchangeInfoCache.set(requestedSymbol, {
                fetchedAt: exchangeInfoSnapshotCache.fetchedAt || Date.now(),
                rules: snapshotRules
            });
        }
        const cacheSource =
            exchangeInfoSnapshotCache.fetchedAt && now - exchangeInfoSnapshotCache.fetchedAt >= EXCHANGE_INFO_TTL_MS ?
            'stale_snapshot_cache' :
            'snapshot_cache';
        console.info('[EXCHANGE_INFO_CACHE_HIT]', {
            symbol: requestedSymbol,
            source: cacheSource,
            age_ms: snapshotAgeMs
        });
        if (cacheSource === 'stale_snapshot_cache') {
            console.warn('[FETCH_FALLBACK_USED]', {
                label: `exchange_info:${requestedSymbol}`,
                source: cacheSource,
                age_ms: snapshotAgeMs
            });
        }
        return {
            ...snapshotRules,
            cache_source: cacheSource
        };
    }

    console.warn('[EXCHANGE_INFO_MISS]', { symbol: requestedSymbol });
    return {
        ...buildDefaultSymbolRules(requestedSymbol),
        cache_source: 'default_symbol_rules'
    };
}

function resolveExecutedQuantity(orderResponse, fallbackQuantity) {
    const candidates = [
        Number(orderResponse ?.executedQty || 0),
        Number(orderResponse ?.origQty || 0),
        Number(fallbackQuantity || 0)
    ];
    return candidates.find((value) => Number.isFinite(value) && value > 0) || Number(fallbackQuantity || 0);
}

function resolveFilledEntryPrice(orderResponse, fallbackEntryPrice, executedQuantity) {
    const avgPrice = Number(orderResponse ?.avgPrice || 0);
    if (Number.isFinite(avgPrice) && avgPrice > 0) return avgPrice;

    const cumQuote = Number(orderResponse ?.cumQuote || orderResponse ?.cumQuoteQty || 0);
    if (Number.isFinite(cumQuote) && cumQuote > 0 && Number.isFinite(executedQuantity) && executedQuantity > 0) {
        return cumQuote / executedQuantity;
    }

    const fills = Array.isArray(orderResponse ?.fills) ? orderResponse.fills : [];
    if (fills.length > 0) {
        const fillStats = fills.reduce((acc, fill) => {
            const price = Number(fill ?.price || 0);
            const qty = Number(fill ?.qty || fill ?.quantity || 0);
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
    const raw = Number(orderResponse ?.updateTime || orderResponse ?.transactTime || orderResponse ?.time || 0);
    if (Number.isFinite(raw) && raw > 0) {
        return new Date(raw);
    }
    return new Date();
}

function reanchorExitLevelsToFill(intent, filledEntryPrice) {
    const entryPrice = Number(intent ?.entry_price || 0);
    const takeProfit = Number(intent ?.take_profit || 0);
    const stopLoss = Number(intent ?.stop_loss || 0);
    const side = String(intent ?.side || '').toUpperCase();
    if (!Number.isFinite(filledEntryPrice) || filledEntryPrice <= 0 || !Number.isFinite(entryPrice) || entryPrice <= 0) {
        return {
            take_profit: takeProfit,
            stop_loss: stopLoss
        };
    }

    const tpOffsetRatio =
        side === 'BUY' ?
        Math.max(0, (takeProfit - entryPrice) / entryPrice) :
        Math.max(0, (entryPrice - takeProfit) / entryPrice);
    const slOffsetRatio =
        side === 'BUY' ?
        Math.max(0, (entryPrice - stopLoss) / entryPrice) :
        Math.max(0, (stopLoss - entryPrice) / entryPrice);

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
    const adjusted = {...intent };

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
        const qtyPrecision = qtyStepDecimals > 0 ?
            Math.min(Number(rules.quantityPrecision), qtyStepDecimals) :
            Number(rules.quantityPrecision);
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

async function findOpenPositionRefByOrderId(db, {
    linkedPositionId = null,
    orderId = null
} = {}) {
    if (!db) return null;
    if (linkedPositionId) {
        const ref = db.collection('binance_open_positions').doc(String(linkedPositionId));
        const snap = await ref.get().catch(() => null);
        if (snap ?.exists) return ref;
    }
    if (orderId == null) return null;
    try {
        const snapshot = await db.collection('binance_open_positions')
            .where('order_id', '==', Number(orderId))
            .limit(1)
            .get();
        if (!snapshot.empty) {
            return snapshot.docs[0].ref;
        }
    } catch (_) {
        // noop
    }
    return null;
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
        const balance = list.find((item) => String(item ?.asset || '').toUpperCase() === upperAsset) || null;
        if (balance) {
            futuresBalanceCache.set(upperAsset, {
                value: balance,
                fetchedAt: Date.now()
            });
            console.info('[BINANCE_BALANCE_REFRESH]', {
                asset: upperAsset,
                balance: Number(balance ?.balance || 0),
                availableBalance: Number(balance ?.availableBalance || 0),
                crossWalletBalance: Number(balance ?.crossWalletBalance || 0)
            });
        }
        return balance ?
            {
                ...balance,
                _cache_fallback: false,
                _cache_age_ms: 0
            } :
            null;
    } catch (err) {
        if (cached ?.value) {
            console.warn('[FETCH_FALLBACK_USED]', {
                label: 'futures_balance',
                asset: upperAsset,
                source: 'last_valid_balance',
                age_ms: Date.now() - cached.fetchedAt,
                message: sanitizeBinanceErrorMessage(err ?.message || err)
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
        if (cached ?.value) {
            console.warn('[FETCH_FALLBACK_USED]', {
                label: 'futures_income',
                source: 'last_valid_income',
                age_ms: Date.now() - cached.fetchedAt,
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
            return cached.value;
        }
        throw err;
    }
}

async function closePositionMarket(intent) {
    const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';
    let quantity = Number(intent.quantity || 0);
    let quantityPrecision = Number.isFinite(Number(intent ?._quantity_precision)) ?
        Number(intent._quantity_precision) :
        null;
    let qtyStep = Number(intent ?._quantity_step || 0);

    if (!(Number.isFinite(quantityPrecision) && quantityPrecision >= 0) || !(qtyStep > 0)) {
        try {
            const rules = await getFuturesSymbolRules(intent.symbol);
            const marketStep = Number(rules ?.marketStepSize || 0);
            const lotStep = Number(rules ?.stepSize || 0);
            qtyStep = marketStep > 0 ? marketStep : lotStep;
            const qtyStepDecimals = decimalsFromStep(qtyStep);
            if (Number.isFinite(Number(rules ?.quantityPrecision)) && Number(rules.quantityPrecision) >= 0) {
                quantityPrecision = qtyStepDecimals > 0 ?
                    Math.min(Number(rules.quantityPrecision), qtyStepDecimals) :
                    Number(rules.quantityPrecision);
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
        quantity: Number.isFinite(quantityPrecision) && quantityPrecision >= 0 ?
            toPlainFixed(quantity, quantityPrecision) :
            String(quantity),
        reduceOnly: true,
        newOrderRespType: 'RESULT'
    });
}

function startOfUtcDay(date = new Date()) {
    const d = new Date(date);
    d.setUTCHours(0, 0, 0, 0);
    return d;
}

function toIsoDate(value) {
    const d = parseDateLike(value);
    return d ? d.toISOString() : null;
}

function resolvePositionSizePercent(config = {}) {
    const configured = Number(config ?.position_size_percent);
    if (!Number.isFinite(configured)) return SAFE_POSITION_SIZE_PERCENT;
    return Math.max(0.01, Math.min(1, configured));
}

function applyProtectivePriceCaps(intent = {}) {
    const entry = Number(intent.entry_price || 0);
    const side = String(intent.side || '').toUpperCase();
    if (!Number.isFinite(entry) || entry <= 0 || !['BUY', 'SELL'].includes(side)) {
        return intent;
    }

    const slLimitPrice =
        side === 'BUY' ? entry * (1 - PROTECTIVE_MAX_SL_PCT / 100) : entry * (1 + PROTECTIVE_MAX_SL_PCT / 100);
    const tpLimitPrice =
        side === 'BUY' ? entry * (1 + PROTECTIVE_MAX_TP_PCT / 100) : entry * (1 - PROTECTIVE_MAX_TP_PCT / 100);

    let stopLoss = Number(intent.stop_loss || 0);
    let takeProfit = Number(intent.take_profit || 0);

    if (!Number.isFinite(stopLoss) || stopLoss <= 0) {
        stopLoss = slLimitPrice;
    } else if (side === 'BUY' && stopLoss < slLimitPrice) {
        stopLoss = slLimitPrice;
    } else if (side === 'SELL' && stopLoss > slLimitPrice) {
        stopLoss = slLimitPrice;
    }

    if (!Number.isFinite(takeProfit) || takeProfit <= 0) {
        takeProfit = tpLimitPrice;
    } else if (side === 'BUY' && takeProfit > tpLimitPrice) {
        takeProfit = tpLimitPrice;
    } else if (side === 'SELL' && takeProfit < tpLimitPrice) {
        takeProfit = tpLimitPrice;
    }

    return {
        ...intent,
        enable_tp_sl: true,
        stop_loss: Number(stopLoss),
        take_profit: Number(takeProfit)
    };
}

async function getClosedTradeStats(db) {
    const dayStartIso = startOfUtcDay().toISOString();
    const closedSnap = await fetchRecentIntentDocs(db, 400);

    const closedTrades = closedSnap.docs
        .map((doc) => ({ id: doc.id, ...(doc.data() || {}) }))
        .filter((trade) => {
            if (String(trade.status || '').toLowerCase() !== 'executed') return false;
            const closedAt = String(trade.closed_at || '');
            if (!closedAt || closedAt < dayStartIso) return false;
            const pnl = Number(trade.close_pnl_pct ?? trade.execution_audit ?.close_pnl_pct);
            return Number.isFinite(pnl);
        })
        .sort((a, b) => String(b.closed_at || '').localeCompare(String(a.closed_at || '')));

    let wins = 0;
    let totalPnlPct = 0;
    let consecutiveLosses = 0;
    for (const trade of closedTrades) {
        const pnl = Number((trade.close_pnl_pct ?? trade.execution_audit ?.close_pnl_pct) || 0);
        totalPnlPct += pnl;
        if (pnl > 0) wins += 1;
        if (pnl < 0 && consecutiveLosses === closedTrades.indexOf(trade)) {
            consecutiveLosses += 1;
        } else if (pnl >= 0 && consecutiveLosses === closedTrades.indexOf(trade)) {
            break;
        }
    }

    const totalTrades = closedTrades.length;
    const winRatePct = totalTrades > 0 ? (wins / totalTrades) * 100 : 0;

    return {
        totalTrades,
        totalPnlPct,
        winRatePct,
        consecutiveLosses
    };
}

async function disableExecutionWithReason(db, reason, metrics = {}) {
    const payload = {
        execution_enabled: false,
        auto_trade_mode: false,
        status: 'HALTED',
        halted_reason: reason,
        halted_at: new Date().toISOString(),
        halted_metrics: metrics,
        updated_at: FieldValue.serverTimestamp()
    };

    await Promise.allSettled([
        db.collection('system_runtime_config').doc('bot_execution').set(payload, { merge: true }),
        db.collection('binance_bot_config').doc('global').set({ execution_enabled: false, updated_at: new Date().toISOString() }, { merge: true })
    ]);
}

async function evaluateGlobalHardStops(db) {
    let stats;
    try {
        stats = await getClosedTradeStats(db);
    } catch (err) {
        if (isFirestoreIndexMissingError(err)) {
            console.warn('[DEGRADED_VALIDATION]', {
                stage: 'global_hard_stops',
                reason: 'firestore_index_missing',
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
            return {
                halt: false,
                reason: null,
                metrics: {
                    degraded_validation: true,
                    degraded_reason: 'firestore_index_missing',
                    degraded_stage: 'global_hard_stops',
                    error_message: sanitizeBinanceErrorMessage(err ?.message || err)
                }
            };
        }
        throw err;
    }
    if (stats.totalPnlPct <= HARD_STOP_DAILY_PNL_PCT) {
        return {
            halt: true,
            reason: 'daily_pnl_limit',
            metrics: stats
        };
    }
    if (stats.consecutiveLosses >= HARD_STOP_CONSECUTIVE_LOSSES) {
        return {
            halt: true,
            reason: 'consecutive_losses_limit',
            metrics: stats
        };
    }
    if (stats.totalTrades >= HARD_STOP_MIN_TRADES && stats.winRatePct < HARD_STOP_MIN_WIN_RATE_PCT) {
        return {
            halt: true,
            reason: 'win_rate_below_threshold',
            metrics: stats
        };
    }
    return {
        halt: false,
        reason: null,
        metrics: stats
    };
}

function resolveNotional(config) {
    const accountCapital = Number(config ?.account_capital_usdt || 0);
    const fundsPct = Number(config ?.use_funds_percent || 0);
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

function buildTimeAlignedExecutionConfig(config = {}) {
    const executionGuard = {
        ...(config ?.execution_guard || {})
    };
    const currentExpirationMs = Number(executionGuard.signal_expiration_ms || 0);
    executionGuard.signal_expiration_ms = Math.max(
        currentExpirationMs || 0,
        EXECUTION_MAX_ALIGNMENT_HORIZON_MS
    );
    return {
        ...config,
        execution_guard: executionGuard
    };
}

void warmExchangeInfoCache().catch((err) => {
    console.warn('[EXCHANGE_INFO_WARM_BOOTSTRAP_FAIL]', sanitizeBinanceErrorMessage(err ?.message || err));
});

function shouldUseTimeAlignedExecution(sourceProfile, modeDryRun) {
    return (
        TIME_ALIGNED_EXECUTION_ENABLED &&
        !modeDryRun &&
        resolveSourceProfileKey(sourceProfile) === 'event_emitted'
    );
}

function resolveTimeAlignedRetryDelaysMs() {
    return [...new Set(EXECUTION_RETRY_DELAY_MS
            .map((value) => Math.max(0, Math.floor(Number(value || 0))))
            .filter((value) => value > 0 && value <= EXECUTION_MAX_ALIGNMENT_HORIZON_MS))]
        .sort((a, b) => a - b);
}

function resolveSnapshotExecutionPrice(snapshot = {}, fallback = null) {
    const bid = Number(snapshot ?.best_bid_price || snapshot ?.bid || 0);
    const ask = Number(snapshot ?.best_ask_price || snapshot ?.ask || 0);
    const last = Number(
        snapshot ?.mark_price ??
        snapshot ?.last_price ??
        snapshot ?.price ??
        snapshot ?.microstructure ?.last_price ??
        0
    );
    if (bid > 0 && ask > 0) {
        return Number((((bid + ask) / 2)).toFixed(8));
    }
    if (last > 0) return Number(last.toFixed(8));
    return Number.isFinite(Number(fallback)) && Number(fallback) > 0 ? Number(fallback) : null;
}

function refreshIntentForExecutionWindow(intent = {}, snapshot = null) {
    const liveEntryPrice = resolveSnapshotExecutionPrice(snapshot, intent.entry_price);
    if (!Number.isFinite(liveEntryPrice) || liveEntryPrice <= 0) {
        return {
            intent: {...intent },
            improvedExpectedMove: false,
            meetsFeeFloor: Number(intent.expected_move_percent || 0) >= ROUND_TRIP_FEE_PCT
        };
    }

    const side = String(intent ?.side || '').toUpperCase();
    const takeProfit = Number(intent ?.take_profit || 0);
    const stopLoss = Number(intent ?.stop_loss || 0);
    const notionalUsdt = Number(intent ?.notional_usdt || 0);
    const quantity = notionalUsdt > 0 ? Number((notionalUsdt / liveEntryPrice).toFixed(6)) : Number(intent ?.quantity || 0);
    const baselineExpectedMove = Number(intent ?.expected_move_percent || 0);

    let expectedMovePercent = baselineExpectedMove;
    let riskRewardRatio = Number(intent ?.risk_reward_ratio || 0);
    if (side === 'BUY' && takeProfit > 0 && stopLoss > 0) {
        const rewardPct = ((takeProfit - liveEntryPrice) / liveEntryPrice) * 100;
        const riskPct = ((liveEntryPrice - stopLoss) / liveEntryPrice) * 100;
        expectedMovePercent = Math.abs(rewardPct);
        riskRewardRatio = riskPct > 0 ? rewardPct / riskPct : riskRewardRatio;
    } else if (side === 'SELL' && takeProfit > 0 && stopLoss > 0) {
        const rewardPct = ((liveEntryPrice - takeProfit) / liveEntryPrice) * 100;
        const riskPct = ((stopLoss - liveEntryPrice) / liveEntryPrice) * 100;
        expectedMovePercent = Math.abs(rewardPct);
        riskRewardRatio = riskPct > 0 ? rewardPct / riskPct : riskRewardRatio;
    }

    const refreshedIntent = applyProtectivePriceCaps({
        ...intent,
        entry_price: liveEntryPrice,
        quantity,
        expected_move_percent: Number.isFinite(expectedMovePercent) ?
            Number(expectedMovePercent.toFixed(6)) :
            baselineExpectedMove,
        risk_reward_ratio: Number.isFinite(riskRewardRatio) ?
            Number(riskRewardRatio.toFixed(6)) :
            Number(intent ?.risk_reward_ratio || 0)
    });

    return {
        intent: refreshedIntent,
        improvedExpectedMove: Number(refreshedIntent.expected_move_percent || 0) > baselineExpectedMove,
        meetsFeeFloor: Number(refreshedIntent.expected_move_percent || 0) >= ROUND_TRIP_FEE_PCT
    };
}

async function resolveTimeAlignedValidation({
    db,
    baseIntent,
    config,
    sourceProfile,
    rules,
    signalTimestamp,
    intentCreatedAt,
    intentRef,
    predictionId,
    symbol
}) {
    const retryDelaysMs = resolveTimeAlignedRetryDelaysMs();
    const baselineExpectedMove = Number(baseIntent ?.expected_move_percent || 0);
    const startedAt = signalTimestamp instanceof Date && Number.isFinite(signalTimestamp.getTime()) ?
        signalTimestamp :
        new Date();
    const intentCreatedDate = intentCreatedAt instanceof Date && Number.isFinite(intentCreatedAt.getTime()) ?
        intentCreatedAt :
        new Date();
    const expiresAtMs = intentCreatedDate.getTime() + EXECUTION_MAX_INTENT_LIFETIME_MS;
    const continueReasons = new Set([
        'event_quality_gate',
        'expected_move_low',
        'time_aligned_no_execution_conditions'
    ]);
    let mutableIntent = {
        ...baseIntent,
        reason: null,
        _reasons: []
    };
    let lastValidation = {
        ok: false,
        reason: 'event_quality_gate'
    };
    let selectedIntent = {...mutableIntent };
    const attempts = [];

    const buildIntentExpiredResult = async() => {
        const expectedMove = Number(selectedIntent ?.expected_move_percent || 0);
        const threshold = Number(config.min_expected_move_pct ?? 0);
        const softThreshold = threshold * 0.9;
        const expirySnapshot = await resolveExecutionSnapshot(db, symbol, config).catch(() => null);
        const expiryGuard = evaluateExecutionGuard(
            selectedIntent.symbol, {
                ...baseIntent,
                side: selectedIntent.side,
                entry_price: selectedIntent.entry_price
            },
            expirySnapshot, {
                botConfig: config,
                side: selectedIntent.side
            }
        );
        const executionScore = Number(expiryGuard ?.entryQualityScore || 0);
        const minScore = Number(
            expiryGuard ?.qualityThreshold ??
            expiryGuard ?.qualityThresholds ?.high ??
            config ?.execution_guard ?.high_quality_score ??
            0
        );
        const stillValid =
            expectedMove >= softThreshold &&
            executionScore >= (minScore * 0.95) &&
            !expiryGuard ?.blocked;
        if (stillValid) {
            const finalEvaluation = {
                expected_move: expectedMove,
                threshold,
                soft_expiry_threshold: Number(softThreshold.toFixed(6)),
                execution_score: Number(executionScore.toFixed(2)),
                minimum_required_score: Number(minScore.toFixed(2)),
                result: 'allowed',
                reason: null,
                evaluated_at: Date.now()
            };
            selectedIntent.final_evaluation = finalEvaluation;
            selectedIntent.reason = finalEvaluation.reason;
            selectedIntent.attempt_history = attempts;
            console.info('[TIME_ALIGNED_EXECUTION]', {
                event: 'soft_expiry_execution',
                prediction_id: predictionId,
                symbol,
                expected_move_pct: expectedMove,
                threshold,
                soft_expiry_threshold: Number(softThreshold.toFixed(6)),
                execution_score: Number(executionScore.toFixed(2)),
                minimum_required_score: Number(minScore.toFixed(2))
            });
            return {
                validation: {
                    ok: true,
                    reason: null,
                    soft_expiry_execution: true
                },
                intent: selectedIntent,
                timeAligned: {
                    enabled: true,
                    t0_signal_at: startedAt.toISOString(),
                    attempts,
                    expired_at: new Date().toISOString(),
                    max_intent_lifetime_ms: EXECUTION_MAX_INTENT_LIFETIME_MS,
                    soft_expiry_execution: true
                },
                finalEvaluation
            };
        }

        const finalEvaluation = {
            expected_move: expectedMove,
            threshold,
            soft_expiry_threshold: Number(softThreshold.toFixed(6)),
            execution_score: Number(executionScore.toFixed(2)),
            minimum_required_score: Number(minScore.toFixed(2)),
            result: 'blocked',
            reason: 'intent_expired',
            evaluated_at: Date.now()
        };
        selectedIntent.final_evaluation = finalEvaluation;
        selectedIntent.reason = finalEvaluation.reason;
        selectedIntent.attempt_history = attempts;
        selectedIntent._reasons = [...new Set([...(selectedIntent._reasons || []), 'intent_expired'])];
        return {
            validation: {
                ok: false,
                reason: 'intent_expired'
            },
            intent: selectedIntent,
            timeAligned: {
                enabled: true,
                t0_signal_at: startedAt.toISOString(),
                attempts,
                expired_at: new Date().toISOString(),
                max_intent_lifetime_ms: EXECUTION_MAX_INTENT_LIFETIME_MS
            },
            finalEvaluation
        };
    };

    if (Date.now() >= expiresAtMs) {
        return await buildIntentExpiredResult();
    }

    console.info('[TIME_ALIGNED_EXECUTION]', {
        event: 't0_signal',
        prediction_id: predictionId,
        symbol,
        signal_at: startedAt.toISOString(),
        retry_delays_ms: retryDelaysMs,
        max_horizon_ms: EXECUTION_MAX_ALIGNMENT_HORIZON_MS,
        max_intent_lifetime_ms: EXECUTION_MAX_INTENT_LIFETIME_MS,
        baseline_expected_move_pct: baselineExpectedMove
    });
    await writeIntentDoc(intentRef, {
        processing_stage: 'time_aligned_confirmation',
        time_aligned_execution: {
            enabled: true,
            t0_signal_at: startedAt.toISOString(),
            retry_delays_ms: retryDelaysMs,
            max_horizon_ms: EXECUTION_MAX_ALIGNMENT_HORIZON_MS,
            max_intent_lifetime_ms: EXECUTION_MAX_INTENT_LIFETIME_MS,
            baseline_expected_move_pct: baselineExpectedMove
        }
    });

    {
        const snapshot = await resolveExecutionSnapshot(db, symbol, config).catch(() => null);
        const refreshed = refreshIntentForExecutionWindow(mutableIntent, snapshot);
        mutableIntent = {
            ...refreshed.intent,
            reason: null,
            _reasons: []
        };
        const attemptAt = new Date().toISOString();
        const expectedMovePct = Number(mutableIntent ?.expected_move_percent || 0);
        const shouldAttemptValidation =
            refreshed.meetsFeeFloor ||
            refreshed.improvedExpectedMove ||
            expectedMovePct >= Number(config.min_expected_move_pct ?? 0);
        attempts.push({
            attempt_number: 0,
            delay_ms: 0,
            attempted_at: attemptAt,
            expected_move_pct: expectedMovePct,
            improved_expected_move: refreshed.improvedExpectedMove,
            meets_fee_roundtrip: refreshed.meetsFeeFloor,
            validation_attempted: shouldAttemptValidation
        });

        if (shouldAttemptValidation) {
            const validation = await validateExecutionIntent(db, mutableIntent, config, {
                source_profile: sourceProfile,
                rules
            });
            lastValidation = validation;
            if (!validation ?.ok && validation ?.reason) {
                mutableIntent._reasons = [...new Set([...(mutableIntent._reasons || []), validation.reason])];
            }
            selectedIntent = {
                ...mutableIntent,
                reason: null
            };
            attempts[attempts.length - 1].validation_reason = validation ?.reason || null;
            attempts[attempts.length - 1].validation_result = validation ?.ok ? 'allowed' : 'blocked';
            if (validation ?.ok) {
                const finalEvaluation = {
                    expected_move: Number(selectedIntent ?.expected_move_percent || 0),
                    threshold: Number(config.min_expected_move_pct ?? 0),
                    result: 'allowed',
                    reason: null,
                    evaluated_at: Date.now()
                };
                selectedIntent.final_evaluation = finalEvaluation;
                selectedIntent.reason = finalEvaluation.reason;
                selectedIntent.attempt_history = attempts;
                return {
                    validation,
                    intent: selectedIntent,
                    timeAligned: {
                        enabled: true,
                        t0_signal_at: startedAt.toISOString(),
                        t_execution: attemptAt,
                        executed_attempt_number: 0,
                        executed_attempt_delay_ms: 0,
                        attempts
                    },
                    finalEvaluation
                };
            }
            if (!continueReasons.has(String(validation ?.reason || ''))) {
                const finalEvaluation = {
                    expected_move: Number(selectedIntent ?.expected_move_percent || 0),
                    threshold: Number(config.min_expected_move_pct ?? 0),
                    result: 'blocked',
                    reason: validation ?.reason ?? null,
                    evaluated_at: Date.now()
                };
                selectedIntent.final_evaluation = finalEvaluation;
                selectedIntent.reason = finalEvaluation.reason;
                selectedIntent.attempt_history = attempts;
                return {
                    validation,
                    intent: selectedIntent,
                    timeAligned: {
                        enabled: true,
                        t0_signal_at: startedAt.toISOString(),
                        attempts
                    },
                    finalEvaluation
                };
            }
        } else {
            lastValidation = {
                ok: false,
                reason: 'time_aligned_no_execution_conditions',
                details: {
                    expected_move_pct: expectedMovePct,
                    improved_expected_move: refreshed.improvedExpectedMove,
                    fee_roundtrip_pct: ROUND_TRIP_FEE_PCT
                }
            };
            mutableIntent._reasons = ['time_aligned_no_execution_conditions'];
            selectedIntent = {...mutableIntent };
            attempts[attempts.length - 1].validation_reason = lastValidation.reason;
            attempts[attempts.length - 1].validation_result = 'blocked';
        }
    }

    for (let index = 0; index < retryDelaysMs.length; index += 1) {
        if (Date.now() >= expiresAtMs) {
            return await buildIntentExpiredResult();
        }
        const delayMs = retryDelaysMs[index];
        const targetTs = startedAt.getTime() + delayMs;
        const horizonTs = startedAt.getTime() + EXECUTION_MAX_ALIGNMENT_HORIZON_MS;
        if (targetTs > horizonTs || targetTs > expiresAtMs) {
            break;
        }
        const waitMs = Math.max(0, targetTs - Date.now());
        if (waitMs > 0) {
            await sleep(waitMs);
        }
        if (Date.now() >= expiresAtMs) {
            return await buildIntentExpiredResult();
        }

        const snapshot = await resolveExecutionSnapshot(db, symbol, config).catch(() => null);
        const refreshed = refreshIntentForExecutionWindow(mutableIntent, snapshot);
        mutableIntent = {
            ...refreshed.intent,
            reason: null,
            _reasons: []
        };
        const attemptAt = new Date().toISOString();
        const expectedMovePct = Number(mutableIntent ?.expected_move_percent || 0);
        const shouldAttemptValidation = refreshed.meetsFeeFloor || refreshed.improvedExpectedMove;
        attempts.push({
            attempt_number: index + 1,
            delay_ms: delayMs,
            attempted_at: attemptAt,
            expected_move_pct: expectedMovePct,
            improved_expected_move: refreshed.improvedExpectedMove,
            meets_fee_roundtrip: refreshed.meetsFeeFloor,
            validation_attempted: shouldAttemptValidation
        });
        console.info('[TIME_ALIGNED_EXECUTION]', {
            event: 't_delay_attempt',
            prediction_id: predictionId,
            symbol,
            attempt_number: index + 1,
            delay_ms: delayMs,
            attempted_at: attemptAt,
            expected_move_pct: expectedMovePct,
            improved_expected_move: refreshed.improvedExpectedMove,
            meets_fee_roundtrip: refreshed.meetsFeeFloor
        });
        await writeIntentDoc(intentRef, {
            processing_stage: 'time_aligned_retry',
            time_aligned_execution: {
                enabled: true,
                t0_signal_at: startedAt.toISOString(),
                last_attempt_at: attemptAt,
                last_attempt_delay_ms: delayMs,
                last_attempt_number: index + 1,
                baseline_expected_move_pct: baselineExpectedMove,
                expected_move_pct: expectedMovePct,
                improved_expected_move: refreshed.improvedExpectedMove,
                meets_fee_roundtrip: refreshed.meetsFeeFloor,
                retry_delays_ms: retryDelaysMs,
                max_horizon_ms: EXECUTION_MAX_ALIGNMENT_HORIZON_MS,
                attempts
            }
        });

        if (!shouldAttemptValidation) {
            lastValidation = {
                ok: false,
                reason: 'time_aligned_no_execution_conditions',
                details: {
                    expected_move_pct: expectedMovePct,
                    improved_expected_move: refreshed.improvedExpectedMove,
                    fee_roundtrip_pct: ROUND_TRIP_FEE_PCT
                }
            };
            mutableIntent._reasons = ['time_aligned_no_execution_conditions'];
            selectedIntent = {...mutableIntent };
            attempts[attempts.length - 1].validation_reason = lastValidation.reason;
            attempts[attempts.length - 1].validation_result = 'blocked';
            continue;
        }

        const validation = await validateExecutionIntent(db, mutableIntent, config, {
            source_profile: sourceProfile,
            rules
        });
        lastValidation = validation;
        if (!validation ?.ok && validation ?.reason) {
            mutableIntent._reasons = [...new Set([...(mutableIntent._reasons || []), validation.reason])];
        }
        selectedIntent = {
            ...mutableIntent,
            reason: null
        };
        attempts[attempts.length - 1].validation_reason = validation ?.reason || null;
        attempts[attempts.length - 1].validation_result = validation ?.ok ? 'allowed' : 'blocked';
        if (validation ?.ok) {
            const finalEvaluation = {
                expected_move: Number(selectedIntent ?.expected_move_percent || 0),
                threshold: Number(config.min_expected_move_pct ?? 0),
                result: 'allowed',
                reason: null,
                evaluated_at: Date.now()
            };
            selectedIntent.final_evaluation = finalEvaluation;
            selectedIntent.reason = finalEvaluation.reason;
            selectedIntent.attempt_history = attempts;
            return {
                validation,
                intent: selectedIntent,
                timeAligned: {
                    enabled: true,
                    t0_signal_at: startedAt.toISOString(),
                    t_execution: attemptAt,
                    executed_attempt_number: index + 1,
                    executed_attempt_delay_ms: delayMs,
                    attempts
                },
                finalEvaluation
            };
        }
        if (!continueReasons.has(String(validation ?.reason || ''))) {
            break;
        }
    }

    if (Date.now() >= expiresAtMs) {
        return await buildIntentExpiredResult();
    }

    const finalCheck = await validateExecutionIntent(db, selectedIntent, config, {
        source_profile: sourceProfile,
        rules
    });
    const finalEvaluation = {
        expected_move: Number(selectedIntent ?.expected_move_percent || 0),
        threshold: Number(config.min_expected_move_pct ?? 0),
        result: finalCheck ?.ok ? 'allowed' : 'blocked',
        reason: finalCheck ?.reason ?? null,
        evaluated_at: Date.now()
    };
    selectedIntent.final_evaluation = finalEvaluation;
    selectedIntent.reason = finalEvaluation.reason;
    selectedIntent.attempt_history = attempts;
    if (!finalCheck ?.ok && finalCheck ?.reason) {
        selectedIntent._reasons = [...new Set([...(selectedIntent._reasons || []), finalCheck.reason])];
    }

    return {
        validation: finalCheck || lastValidation,
        intent: selectedIntent,
        timeAligned: {
            enabled: true,
            t0_signal_at: startedAt.toISOString(),
            attempts
        },
        finalEvaluation
    };
}

function resolveSizingFactor(signalData, config) {
    if (!config ?.dynamic_sizing_enabled) return 1;
    const contextScore = Number(signalData ?.context_score || 0);
    if (contextScore >= 4) return Number(config ?.sizing_high_context_factor || 1);
    if (contextScore <= 2) return Number(config ?.sizing_low_context_factor || 1);
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
        config ?.execution_profiles && typeof config.execution_profiles === 'object' ?
        (config.execution_profiles[profileKey] || {}) :
        {};
    const configuredMode = profile.mode && profile.mode !== 'inherit' ? profile.mode : config.mode;
    const forcedObserveMode = shouldForceObserveMode(profileKey);
    const profileAllowlist = Array.isArray(profile.symbols_allowlist) ? profile.symbols_allowlist : null;
    const allowUnlistedGlobal = Boolean(config.allow_unlisted_symbols);
    const allowUnlistedProfile = Boolean(profile.allow_unlisted_symbols);
    const mode = forcedObserveMode ? 'dry-run' : configuredMode === 'off' ? 'live' : configuredMode;
    return {
        ...config,
        ...profile,
        enabled: true,
        mode,
        allow_unlisted_symbols: profileKey === 'high_conviction' ?
            false :
            (allowUnlistedGlobal || allowUnlistedProfile),
        symbols_allowlist: profileAllowlist && profileAllowlist.length > 0 ? profileAllowlist : config.symbols_allowlist,
        source_profile: profileKey,
        observe_mode_forced: forcedObserveMode,
        min_confidence: profileKey === 'high_conviction' ?
            Math.max(Number(profile.min_confidence ?? config.min_confidence ?? 0), BINANCE_HC_MIN_CONFIDENCE) :
            Number(profile.min_confidence ?? config.min_confidence ?? 0),
        min_quantum: profileKey === 'high_conviction' ?
            Math.max(Number(profile.min_quantum ?? config.min_quantum ?? 0), BINANCE_HC_MIN_QUANTUM) :
            Number(profile.min_quantum ?? config.min_quantum ?? 0),
        min_timing: profileKey === 'high_conviction' ?
            Math.max(Number(profile.min_timing ?? config.min_timing ?? 0), BINANCE_HC_MIN_TIMING) :
            Number(profile.min_timing ?? config.min_timing ?? 0),
        min_risk_reward: profileKey === 'high_conviction' ?
            Math.max(Number(profile.min_risk_reward ?? config.min_risk_reward ?? 0), BINANCE_HC_MIN_RISK_REWARD) :
            Math.max(0.1, Number(profile.min_risk_reward ?? config.min_risk_reward ?? 0)),
        min_expected_move_pct: profileKey === 'high_conviction' ?
            Math.max(Number(profile.min_expected_move_pct ?? config.min_expected_move_pct ?? 0), BINANCE_HC_MIN_EXPECTED_MOVE_PCT) :
            Math.max(0, Number(profile.min_expected_move_pct ?? config.min_expected_move_pct ?? 0))
    };
}

function buildExecutionIntent(signalData, config) {
    const sourceProfile = resolveSourceProfileKey(signalData ?.source_profile || signalData ?.source);
    const symbolContext = resolveExecutionSymbolContext(signalData);
    const symbol = symbolContext.symbol;
    const direction = signalData ?.direction;
    const side = getOrderSide(direction);
    const confidence = normalizePercent(signalData ?.confidence ?? signalData ?.confianza);
    const quantum = normalizePercent(signalData ?.quantum_score);
    const timing = normalizePercent(signalData ?.timing_score);

    const sizingFactor = resolveSizingFactor(signalData, config);
    const sourceSizeFactor = sourceProfile === 'event_emitted' ? BINANCE_EVENT_POSITION_SIZE_FACTOR : 1;
    const positionSizePercent = resolvePositionSizePercent(config);
    const computedNotional = resolveNotional(config) * sizingFactor * sourceSizeFactor * positionSizePercent;
    const notionalCap =
        sourceProfile === 'event_emitted' ?
        Math.min(Number(config ?.max_notional_usdt || Number.MAX_SAFE_INTEGER), BINANCE_EVENT_MAX_NOTIONAL_USDT) :
        Number(config ?.max_notional_usdt || 0);
    const notionalUsdt =
        Number.isFinite(notionalCap) && notionalCap > 0 ?
        Math.max(5, Math.min(computedNotional, notionalCap)) :
        Math.max(5, computedNotional);
    const entry = Number(signalData ?.trade_plan ?.entry_price || signalData ?.spot_price || 0);
    const quantity = entry > 0 ? Number((notionalUsdt / entry).toFixed(6)) : 0;

    const requestedLeverage = Math.max(1, Number(config ?.default_leverage || BINANCE_DEFAULT_LEVERAGE));
    const requestedMarginType = String(config ?.margin_type || 'ISOLATED').toUpperCase();

    return applyProtectivePriceCaps({
        symbol,
        symbol_normalized: symbol,
        symbol_source: symbolContext.source,
        side,
        direction,
        confidence,
        quantum,
        timing,
        context_score: Number(signalData ?.context_score || 0),
        context_quality: Number(
            signalData ?.context_quality ??
            signalData ?.event_context_filter ?.context_quality ??
            NaN
        ),
        structural_context_score: Number(
            signalData ?.structural_context_score ??
            signalData ?.event_context_filter ?.structural_context_score ??
            NaN
        ),
        volatility_context_score: Number(
            signalData ?.volatility_context_score ??
            signalData ?.event_context_filter ?.volatility_context_score ??
            NaN
        ),
        volume_flow_context_score: Number(
            signalData ?.volume_flow_context_score ??
            signalData ?.event_context_filter ?.volume_flow_context_score ??
            NaN
        ),
        liquidity_context_score: Number(
            signalData ?.liquidity_context_score ??
            signalData ?.event_context_filter ?.liquidity_context_score ??
            NaN
        ),
        move1m: Number(signalData ?.move1m || 0),
        move3m: Number(signalData ?.move3m || 0),
        expected_move_percent: Number(signalData ?.expected_move_percent || signalData ?.expected_delta_pct || 0),
        risk_reward_ratio: Number(signalData ?.trade_plan ?.risk_reward_ratio || 0),
        entry_price: entry,
        stop_loss: Number(signalData ?.trade_plan ?.stop_loss || 0),
        take_profit: Number(signalData ?.trade_plan ?.take_profit || 0),
        quantity,
        notional_usdt: notionalUsdt,
        leverage: requestedLeverage,
        margin_type: requestedMarginType,
        requested_leverage: requestedLeverage,
        requested_margin_type: requestedMarginType,
        requested_target_key: `${symbol}:${requestedMarginType}:${requestedLeverage}`,
        config_source: String(config ?._config_source || 'binance_bot_config/defaults'),
        order_type: 'MARKET',
        enable_tp_sl: config ?.enable_tp_sl !== false,
        tp_order_type: 'TAKE_PROFIT_MARKET',
        sl_order_type: 'STOP_MARKET',
        tp_buffer_pct: Number(config ?.tp_buffer_pct || 0),
        sl_buffer_pct: Number(config ?.sl_buffer_pct || 0),
        source_profile: sourceProfile,
        position_size_percent: positionSizePercent
    });
}

function createExecutionIntent(signalData, config, sourceProfile) {
    return buildExecutionIntent({
            ...signalData,
            source_profile: resolveSourceProfileKey(sourceProfile || signalData ?.source_profile || signalData ?.source)
        },
        config
    );
}

function resolveExpectedMovePct(intent = {}) {
    const explicitExpectedMove = Number(intent ?.expected_move_percent || 0);
    if (Number.isFinite(explicitExpectedMove) && explicitExpectedMove > 0) {
        return explicitExpectedMove;
    }
    const move1m = Math.abs(Number(intent ?.move1m || 0));
    const move3m = Math.abs(Number(intent ?.move3m || 0));
    return Math.max(move1m, move3m, 0);
}

function resolveEntryWindowMsFromSignal(signalData = {}) {
    const startAt = resolveSignalTimestamp(signalData);
    const endAt =
        parseDateLike(signalData ?.entry_window_end_at) ||
        parseDateLike(signalData ?.window_end_at) ||
        parseDateLike(signalData ?.entry_window_ends_at);
    if (startAt && endAt) {
        return Math.max(0, endAt.getTime() - startAt.getTime());
    }
    const entryWindow = signalData ?.entry_window || signalData ?.entry_window_utc || null;
    if (entryWindow ?.start && entryWindow ?.end && startAt) {
        const maybeEnd = combineUtcDateAndHms(startAt, entryWindow.end);
        if (maybeEnd) {
            return Math.max(0, maybeEnd.getTime() - startAt.getTime());
        }
    }
    return null;
}

function validateTradePlanForIntent(intent = {}) {
    const side = String(intent ?.side || '').toUpperCase();
    const entryPrice = Number(intent ?.entry_price || 0);
    const stopLoss = Number(intent ?.stop_loss || 0);
    const sideValid = side === 'BUY' || side === 'SELL';
    const entryPriceValid = Number.isFinite(entryPrice) && entryPrice > 0;
    const stopLossValid = Number.isFinite(stopLoss) && stopLoss > 0;
    const reason = !sideValid ?
        'side_missing' :
        !entryPriceValid ?
        'entry_price_invalid' :
        !stopLossValid ?
        'stop_loss_invalid' :
        null;
    return {
        ok: sideValid && entryPriceValid && stopLossValid,
        side_valid: sideValid,
        entry_price_valid: entryPriceValid,
        stop_loss_valid: stopLossValid,
        reason
    };
}

function evaluateNetEdgeGate(intent = {}, config = {}) {
    const expectedMovePct = resolveExpectedMovePct(intent);
    const feeRoundtripPct = ROUND_TRIP_FEE_PCT;
    const minNetEdgeRequiredPct = Math.max(0, Number(config.min_net_edge_expected_pct ?? 0.50));
    const netEdgeGateEnabled = config.net_edge_gate_enabled !== false;
    const netEdgePct = expectedMovePct - feeRoundtripPct;

    if (!netEdgeGateEnabled) {
        return {
            enabled: false,
            expected_move_percent: Number(expectedMovePct.toFixed(6)),
            fee_roundtrip_pct: Number(feeRoundtripPct.toFixed(6)),
            min_required_pct: minNetEdgeRequiredPct,
            net_edge_pct: Number(netEdgePct.toFixed(6)),
            passed: true,
            reason: 'net_edge_gate_disabled'
        };
    }

    const passed = expectedMovePct >= minNetEdgeRequiredPct;

    return {
        enabled: true,
        expected_move_percent: Number(expectedMovePct.toFixed(6)),
        fee_roundtrip_pct: Number(feeRoundtripPct.toFixed(6)),
        min_required_pct: minNetEdgeRequiredPct,
        net_edge_pct: Number(netEdgePct.toFixed(6)),
        passed,
        reason: passed ? null : 'net_edge_too_low'
    };
}

async function hasEnoughRecentValidRecords(db, intent, config) {
    const minRequired = Math.max(0, Math.floor(Number(config ?.min_recent_valid_records || 0)));
    if (!minRequired) return true;

    const windowMinutes = Math.max(30, Math.floor(Number(config ?.recent_records_window_minutes || 180)));
    const fromTs = Date.now() - windowMinutes * 60 * 1000;
    const systemSymbol = toSystemUsdSymbol(intent.symbol);
    const cacheKey = `recent:${systemSymbol}:${minRequired}:${windowMinutes}`;
    const cached = getCacheValue(cacheKey, RECENT_RECORDS_CACHE_TTL_MS);
    if (cached != null) return cached;

    return runCachedTaskWithFallback({
        cacheKey,
        ttlMs: RECENT_RECORDS_CACHE_TTL_MS,
        label: `recent_records:${systemSymbol}`,
        task: async() => {
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
    const noContextFallback = !Number.isFinite(contextAverage) &&
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
    const netEdgeGate = evaluateNetEdgeGate(intent, config);
    let degradedValidation = null;
    console.log('[EXECUTION_STATUS]', {
        enabled: true,
        component: 'binance_futures_executor',
        source_profile: sourceProfile,
        mode: config ?.mode || 'live'
    });
    if (!intent.symbol) return { ok: false, reason: 'symbol_missing' };
    if (config ?.execution_enabled === false) return { ok: false, reason: 'execution_disabled' };
    if (intent.enable_tp_sl !== true) return { ok: false, reason: 'sl_tp_required' };
    if (!Number.isFinite(Number(intent.stop_loss)) || Number(intent.stop_loss) <= 0) return { ok: false, reason: 'stop_loss_required' };
    if (!Number.isFinite(Number(intent.take_profit)) || Number(intent.take_profit) <= 0) return { ok: false, reason: 'take_profit_required' };
    if (!intent.side) return { ok: false, reason: 'neutral_direction' };
    if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) return { ok: false, reason: 'invalid_quantity' };
    const maxConcurrentTrades = Math.max(
        1,
        Number(config ?.max_concurrent_trades || SAFE_MAX_CONCURRENT_TRADES)
    );
    const openPositions = await db
        .collection('binance_open_positions')
        .where('status', '==', 'open')
        .limit(maxConcurrentTrades)
        .get();
    if (openPositions.size >= maxConcurrentTrades) {
        return { ok: false, reason: 'max_concurrent_trades_reached' };
    }

    const hardStopStatus = await evaluateGlobalHardStops(db);
    if (hardStopStatus ?.metrics ?.degraded_validation) {
        degradedValidation = {
            degraded: true,
            stage: hardStopStatus.metrics.degraded_stage || 'global_hard_stops',
            reason: hardStopStatus.metrics.degraded_reason || 'firestore_index_missing',
            error_message: hardStopStatus.metrics.error_message || null
        };
    }
    if (hardStopStatus.halt) {
        await disableExecutionWithReason(db, hardStopStatus.reason, hardStopStatus.metrics);
        return { ok: false, reason: `hard_stop_${hardStopStatus.reason}` };
    }

    if (!config.allow_unlisted_symbols && Array.isArray(config.symbols_allowlist) && config.symbols_allowlist.length > 0) {
        const symbolListed = config.symbols_allowlist.includes(intent.symbol);
        const hcOperableOnBinance =
            sourceProfile === 'high_conviction' &&
            String(rules ?.symbol || '').toUpperCase() === String(intent.symbol || '').toUpperCase();
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
    const expectedMoveThresholdPct = Number(config.min_expected_move_pct ?? 0);
    const expectedMovePercent = Number(intent.expected_move_percent || 0);
    console.info('[EXPECTED_MOVE_CHECK_SOURCE]', {
        source: 'validateExecutionIntent',
        symbol: intent.symbol,
        source_profile: sourceProfile,
        expected_move: expectedMovePercent,
        threshold: expectedMoveThresholdPct,
        net_edge_min_required: intent.net_edge_min_required ?? MIN_EXPECTED_MOVE_PCT,
        fee_roundtrip: intent.fee_roundtrip ?? ROUND_TRIP_FEE_PCT,
        comparison: `${expectedMovePercent} < ${expectedMoveThresholdPct}`,
        result: expectedMovePercent < expectedMoveThresholdPct ? 'blocked' : 'allowed'
    });
    console.info('[EXPECTED_MOVE_CHECK]', {
        symbol: intent.symbol,
        source_profile: sourceProfile,
        expected_move: expectedMovePercent,
        fee_roundtrip: ROUND_TRIP_FEE_PCT,
        total_cost_floor: TOTAL_COST_PCT,
        configured_threshold: expectedMoveThresholdPct,
        net_edge_min_required: MIN_EXPECTED_MOVE_PCT,
        unit: 'percent',
        comparison: `${expectedMovePercent} < ${expectedMoveThresholdPct}`,
        result: expectedMovePercent < expectedMoveThresholdPct ? 'blocked' : 'allowed'
    });
    if (expectedMovePercent < expectedMoveThresholdPct) return { ok: false, reason: 'expected_move_low' };

    // NET EDGE GATE - Filtro conservador para edge alto
    if (netEdgeGate.enabled && !netEdgeGate.passed) {
        console.log('[NET_EDGE_GATE_BLOCKED]', {
            symbol: intent.symbol,
            source_profile: sourceProfile,
            expected_move_percent: netEdgeGate.expected_move_percent,
            fee_roundtrip_pct: netEdgeGate.fee_roundtrip_pct,
            net_edge_pct: netEdgeGate.net_edge_pct,
            min_required_pct: netEdgeGate.min_required_pct,
            reason: netEdgeGate.reason
        });
        return {
            ok: false,
            reason: 'net_edge_too_low',
            net_edge_gate: netEdgeGate
        };
    }

    if (netEdgeGate.enabled && netEdgeGate.passed) {
        console.log('[NET_EDGE_GATE_PASSED]', {
            symbol: intent.symbol,
            source_profile: sourceProfile,
            expected_move_percent: netEdgeGate.expected_move_percent,
            net_edge_pct: netEdgeGate.net_edge_pct,
            min_required_pct: netEdgeGate.min_required_pct
        });
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
            task: async() => {
                const daily = await fetchRecentIntentDocs(
                    db,
                    Math.max(50, Number(config.max_daily_trades || 1) * 20)
                );
                return daily.docs.filter((doc) => {
                    const data = doc.data() || {};
                    if (String(data.status || '').toLowerCase() !== 'executed') return false;
                    if (String(data.source_profile || '').toLowerCase() !== String(sourceProfile || '').toLowerCase()) return false;
                    const createdAt = parseDateLike(data.created_at);
                    return createdAt && createdAt.getTime() >= todayStart.getTime();
                }).length;
            },
            fallbackValue: 0
        }),
        symbolCooldownMinutes > 0 ?
        runCachedTaskWithFallback({
            cacheKey: cooldownCacheKey,
            ttlMs: EXECUTION_VALIDATION_CACHE_TTL_MS,
            label: `symbol_cooldown:${sourceProfile}`,
            task: async() => {
                const cooldownStart = new Date(Date.now() - symbolCooldownMinutes * 60 * 1000);
                const recentExecuted = await fetchRecentIntentDocs(db, 200);
                return new Set(
                    recentExecuted.docs
                    .map((doc) => doc.data() || {})
                    .filter((data) => {
                        if (String(data.status || '').toLowerCase() !== 'executed') return false;
                        if (String(data.source_profile || '').toLowerCase() !== String(sourceProfile || '').toLowerCase()) return false;
                        const createdAt = parseDateLike(data.created_at);
                        return createdAt && createdAt.getTime() >= cooldownStart.getTime();
                    })
                    .map((data) => data ?.intent ?.symbol || data ?.symbol || null)
                    .filter(Boolean)
                );
            },
            fallbackValue: () => new Set()
        }) :
        Promise.resolve(null)
    ];

    let hasRecentRecords;
    let dailySize;
    let recentSymbols;
    try {
        [hasRecentRecords, dailySize, recentSymbols] = await Promise.all(tasks);
    } catch (err) {
        if (isFirestoreIndexMissingError(err)) {
            degradedValidation = {
                degraded: true,
                stage: 'recent_intent_queries',
                reason: 'firestore_index_missing',
                error_message: sanitizeBinanceErrorMessage(err ?.message || err)
            };
            console.warn('[DEGRADED_VALIDATION]', {
                stage: 'recent_intent_queries',
                reason: 'firestore_index_missing',
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
            hasRecentRecords = true;
            dailySize = 0;
            recentSymbols = symbolCooldownMinutes > 0 ? new Set() : null;
        } else {
            throw err;
        }
    }
    if (!hasRecentRecords) return { ok: false, reason: 'insufficient_recent_records' };
    if (Number(dailySize || 0) >= Number(config.max_daily_trades || 1)) return { ok: false, reason: 'daily_trade_limit' };
    if (symbolCooldownMinutes > 0 && recentSymbols instanceof Set && recentSymbols.has(intent.symbol)) {
        return { ok: false, reason: 'symbol_cooldown_active' };
    }

    if (!BINANCE_API_KEY || !BINANCE_API_SECRET) return { ok: false, reason: 'missing_api_credentials' };
    return degradedValidation ?
        { ok: true, degraded_validation: degradedValidation, net_edge_gate: netEdgeGate } :
        { ok: true, net_edge_gate: netEdgeGate };
}

async function setMarginType(symbol, marginType) {
    try {
        return await signedRequest('/fapi/v1/marginType', {
            symbol,
            marginType
        });
    } catch (err) {
        const message = String(err ?.message || '');
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

function buildMarginLeverageSymbolKey(symbol) {
    return String(symbol || '').toUpperCase();
}

function buildMarginLeverageReadinessState(symbol, payload = {}) {
    const nowIso = payload.last_checked_at || new Date().toISOString();
    const marginReady = payload.margin_ready === true || payload.margin_type_ready === true;
    const leverageReady = payload.leverage_ready === true;
    return {
        symbol: buildMarginLeverageSymbolKey(symbol),
        margin_ready: marginReady,
        leverage_ready: leverageReady,
        ready: marginReady && leverageReady && payload.setup_status === 'ready',
        last_checked_at: nowIso,
        last_success_at: payload.last_success_at || null,
        last_error: payload.last_error || payload.error_message || null,
        retry_count: Math.max(0, Number(payload.retry_count || 0)),
        next_retry_after: payload.next_retry_after || null,
        setup_status: payload.setup_status || (marginReady && leverageReady ? 'ready' : 'pending'),
        margin_type: payload.margin_type || null,
        requested_leverage: Number(payload.requested_leverage || 0) || null,
        applied_leverage: Number(payload.applied_leverage || 0) || null,
        duration_ms: Number(payload.duration_ms || 0) || 0,
        margin_duration_ms: Number(payload.margin_duration_ms || 0) || 0,
        leverage_duration_ms: Number(payload.leverage_duration_ms || 0) || 0
    };
}

function getMarginLeverageRuntimeContext() {
    return {
        cloud_run_revision: String(process.env.K_REVISION || process.env.CLOUD_RUN_REVISION || '').trim() || null,
        instance_id: String(process.env.K_INSTANCE || process.env.HOSTNAME || '').trim() || null
    };
}

function buildMarginLeverageReadinessSnapshotForDecision({
    symbol,
    requestedMarginType,
    desiredLeverage,
    memoryState = null,
    firestoreState = null,
    readinessSourceUsed = null
} = {}) {
    const normalizedSymbol = buildMarginLeverageSymbolKey(symbol);
    const normalizedRequestedMarginType = String(requestedMarginType || 'ISOLATED').toUpperCase();
    const normalizedRequestedLeverage = Math.max(1, Math.floor(Number(desiredLeverage || 1)));
    const requestedTargetKey = `${normalizedSymbol}:${normalizedRequestedMarginType}:${normalizedRequestedLeverage}`;
    const ttlMs = BINANCE_MARGIN_LEVERAGE_READINESS_TTL_MS;
    const sourceState =
        readinessSourceUsed === 'firestore' ?
        (firestoreState || memoryState) :
        (memoryState || firestoreState);
    const lastCheckedAt = sourceState ?.last_checked_at || firestoreState ?.last_checked_at || memoryState ?.last_checked_at || null;
    const lastSuccessAt = sourceState ?.last_success_at || firestoreState ?.last_success_at || memoryState ?.last_success_at || null;
    const checkedAtMs = lastCheckedAt ? new Date(lastCheckedAt).getTime() : NaN;
    const ageMs = Number.isFinite(checkedAtMs) ? Math.max(0, Date.now() - checkedAtMs) : null;
    const expired = ageMs == null ? true : ageMs > ttlMs;
    const cachedMarginType = String(sourceState ?.margin_type || '').toUpperCase() || null;
    const cachedLeverage = Number(sourceState ?.applied_leverage || sourceState ?.requested_leverage || 0) || null;
    const cachedRequestedLeverage = Number(sourceState ?.requested_leverage || 0) || null;
    const cachedTargetKey = cachedMarginType && cachedLeverage ?
        `${normalizedSymbol}:${cachedMarginType}:${cachedLeverage}` :
        null;
    const symbolMatch = Boolean(sourceState ?.symbol) ? sourceState.symbol === normalizedSymbol : Boolean(sourceState);
    const marginTypeMatch = cachedMarginType === normalizedRequestedMarginType;
    const leverageMatch = cachedLeverage === normalizedRequestedLeverage;
    const targetMatch =
        symbolMatch &&
        marginTypeMatch &&
        leverageMatch &&
        sourceState ?.ready === true &&
        expired === false;
    const mismatchReason = !sourceState ?
        'readiness_missing' :
        !symbolMatch ?
        'symbol_mismatch' :
        expired ?
        'readiness_expired' :
        sourceState ?.ready !== true ?
        'readiness_not_ready' :
        !marginTypeMatch ?
        'margin_type_mismatch' :
        !leverageMatch ?
        'leverage_mismatch' :
        'unknown_target_mismatch';
    const ready = sourceState ?.ready === true && expired === false;
    const decisionReason = targetMatch ?
        'readiness_ok' :
        mismatchReason === 'readiness_missing' ?
        'readiness_entry_missing' :
        mismatchReason;
    return {
        symbol: normalizedSymbol,
        normalized_symbol: normalizedSymbol,
        requested_margin_type: normalizedRequestedMarginType,
        requested_leverage: normalizedRequestedLeverage,
        requested_target_key: requestedTargetKey,
        cached_margin_type: cachedMarginType,
        cached_leverage: cachedLeverage,
        cached_requested_leverage: cachedRequestedLeverage,
        cached_target_key: cachedTargetKey,
        readiness_source_used: readinessSourceUsed || (firestoreState ? 'firestore' : 'memory'),
        memory_entry_found: Boolean(memoryState),
        firestore_entry_found: Boolean(firestoreState),
        memory_ready: Boolean(memoryState ?.ready),
        firestore_ready: Boolean(firestoreState ?.ready),
        margin_ready: Boolean(sourceState ?.margin_ready),
        leverage_ready: Boolean(sourceState ?.leverage_ready),
        ready,
        target_match: targetMatch,
        mismatch_reason: targetMatch ? null : mismatchReason,
        desired_leverage: normalizedRequestedLeverage,
        persisted_leverage: Number(sourceState ?.applied_leverage || sourceState ?.requested_leverage || 0) || null,
        last_success_at: lastSuccessAt,
        last_checked_at: lastCheckedAt,
        ttl_ms: ttlMs,
        age_ms: ageMs,
        expired,
        last_error: sourceState ?.last_error || null,
        decision: ready ? 'ready' : 'not_ready',
        decision_reason: decisionReason
    };
}

function getMarginLeverageReadinessDocRef() {
    return db.collection('system_runtime_config').doc('margin_leverage_readiness');
}

function isMarginLeverageStateFresh(state, ttlMs = BINANCE_MARGIN_LEVERAGE_READINESS_TTL_MS) {
    const checkedAt = state ?.last_checked_at ? new Date(state.last_checked_at).getTime() : NaN;
    if (!Number.isFinite(checkedAt)) return false;
    return Date.now() - checkedAt <= ttlMs;
}

function getMarginLeverageSetupState(symbol) {
    return marginLeverageReadyCache.get(buildMarginLeverageSymbolKey(symbol)) || null;
}

function isMarginLeverageReadyForTarget(symbol, marginType, leverage) {
    const state = getMarginLeverageSetupState(symbol);
    if (!state) return false;
    const requestedMarginType = String(marginType || '').toUpperCase();
    const requestedLeverage = Math.max(1, Math.floor(Number(leverage || 1)));
    return (
        state.ready === true &&
        state.setup_status === 'ready' &&
        state.symbol === buildMarginLeverageSymbolKey(symbol) &&
        state.margin_type === requestedMarginType &&
        Number(state.requested_leverage || 0) === requestedLeverage &&
        state.margin_ready === true &&
        state.leverage_ready === true
    );
}

function updateMarginLeverageSetupState(symbol, payload = {}) {
    const key = buildMarginLeverageSymbolKey(symbol);
    const previous = marginLeverageReadyCache.get(key) || {};
    const next = buildMarginLeverageReadinessState(key, {
        ...previous,
        ...payload,
        last_checked_at: payload.last_checked_at ||
            payload.setup_checked_at ||
            previous.last_checked_at ||
            new Date().toISOString()
    });
    marginLeverageReadyCache.set(key, next);
    return next;
}

async function persistMarginLeverageReadinessState(symbol, state = {}) {
    const key = buildMarginLeverageSymbolKey(symbol);
    const runtimeContext = getMarginLeverageRuntimeContext();
    const payload = {
        symbols: {
            [key]: {
                symbol: key,
                margin_ready: state.margin_ready === true,
                leverage_ready: state.leverage_ready === true,
                ready: state.ready === true,
                last_success_at: state.last_success_at || null,
                last_checked_at: state.last_checked_at || new Date().toISOString(),
                updated_by_revision: runtimeContext.cloud_run_revision,
                updated_by_instance: runtimeContext.instance_id,
                last_error: state.last_error || null,
                retry_count: Math.max(0, Number(state.retry_count || 0)),
                next_retry_after: state.next_retry_after || null,
                setup_status: state.setup_status || null,
                margin_type: state.margin_type || null,
                requested_leverage: Number(state.requested_leverage || 0) || null,
                applied_leverage: Number(state.applied_leverage || 0) || null
            }
        },
        updated_at: FieldValue.serverTimestamp(),
        updated_by_revision: runtimeContext.cloud_run_revision,
        updated_by_instance: runtimeContext.instance_id
    };
    await getMarginLeverageReadinessDocRef().set(payload, { merge: true });
}

function normalizePersistedReadinessSymbols(rawSymbols = {}) {
    return Object.entries(rawSymbols || {}).map(([symbol, value]) =>
        buildMarginLeverageReadinessState(symbol, value || {})
    );
}

async function hydrateMarginLeverageReadinessFromFirestore(options = {}) {
    const requestedSymbols = Array.isArray(options.symbols) ?
        options.symbols.map((symbol) => buildMarginLeverageSymbolKey(symbol)).filter(Boolean) :
        [];
    const shouldUseCache = !options.force && marginLeverageFirestoreHydrationPromise;
    if (shouldUseCache) return marginLeverageFirestoreHydrationPromise;

    marginLeverageFirestoreHydrationPromise = (async() => {
        const snapshot = await getMarginLeverageReadinessDocRef().get();
        const data = snapshot.exists ? snapshot.data() || {} : {};
        const allStates = normalizePersistedReadinessSymbols(data.symbols || {});
        const filteredStates = requestedSymbols.length ?
            allStates.filter((state) => requestedSymbols.includes(state.symbol)) :
            allStates;
        const freshStates = filteredStates.filter((state) => isMarginLeverageStateFresh(state));

        for (const state of freshStates) {
            updateMarginLeverageSetupState(state.symbol, state);
        }

        marginLeverageFirestoreHydratedAt = Date.now();
        return {
            states: filteredStates,
            fresh_states: freshStates,
            updated_at: data.updated_at ?.toDate ?.() ?.toISOString ?.() || null,
            cloud_run_revision: data.updated_by_revision || null,
            instance_id: data.updated_by_instance || null
        };
    })();

    try {
        return await marginLeverageFirestoreHydrationPromise;
    } finally {
        marginLeverageFirestoreHydrationPromise = null;
    }
}

async function getCurrentLeverageForSymbol(symbol, options = {}) {
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS));
    const risk = await withFetchRetry(
        () => withTimeout(getPositionRisk(symbol), timeoutMs, `current_leverage_query:${symbol}`), {
            label: `current_leverage_query:${symbol}`,
            attempts: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_ATTEMPTS,
            retryDelayMs: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_DELAY_MS,
            retryOn: isRetryableFetchError
        }
    );
    const leverage = Number(risk ?.leverage || risk ?.initialLeverage || 0);
    return {
        leverage: Number.isFinite(leverage) && leverage > 0 ? Math.floor(leverage) : null,
        raw: risk || null
    };
}

function classifyLeveragePrefightDiagnosis(payload = {}) {
    const message = String(payload ?.last_error_message || payload ?.binance_msg || '').toLowerCase();
    const code = Number(payload ?.binance_code || 0);
    if (!payload ?.api_key_present || !payload ?.api_secret_present) return 'credentials_issue';
    if (code === -1021 || message.includes('recvwindow') || message.includes('timestamp')) {
        return 'timestamp_recvwindow_issue';
    }
    if (payload ?.binance_private_connectivity_ok === false && payload ?.timeout === true) {
        return 'private_api_timeout';
    }
    if (message.includes('already') && message.includes('leverage')) {
        return 'already_configured_but_not_detected';
    }
    if (message.includes('rejected') || message.includes('code":-')) return 'binance_rejection';
    if (payload ?.leverage_prefight_timeout > 0) return 'leverage_set_timeout';
    return 'unknown';
}

async function runLeveragePreflightForSymbol(symbol, desiredLeverage, options = {}) {
    const requestedSymbol = buildMarginLeverageSymbolKey(symbol);
    const requestedLeverage = Math.max(1, Math.floor(Number(desiredLeverage || BINANCE_DEFAULT_LEVERAGE || 1)));
    const timeoutMs = Math.max(1000, Number(options.timeoutMs || BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS));
    const stages = [];
    const startedAtMs = Date.now();

    const connectivityStartedAtMs = Date.now();
    const connectivity = await testBinancePrivateConnectivity({ timeoutMs });
    recordLeveragePreflightStage(stages, {
        symbol: requestedSymbol,
        stage: 'private_connectivity',
        startedAtMs: connectivityStartedAtMs,
        result: connectivity.ok ? 'success' : (connectivity.timeout ? 'timeout' : 'failed'),
        statusCode: connectivity.http_status,
        binanceCode: connectivity.binance_code,
        errorMessage: connectivity.binance_msg
    });
    if (!connectivity.ok) {
        return {
            ok: false,
            symbol: requestedSymbol,
            desired_leverage: requestedLeverage,
            current_leverage: null,
            leverage_ready: false,
            skipped: null,
            timeout: connectivity.timeout,
            http_status: connectivity.http_status,
            binance_code: connectivity.binance_code,
            last_error_message: connectivity.binance_msg,
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            stages,
            diagnosis: classifyLeveragePrefightDiagnosis({
                ...connectivity,
                api_key_present: Boolean(BINANCE_API_KEY),
                api_secret_present: Boolean(BINANCE_API_SECRET)
            })
        };
    }

    const serverTimeStartedAtMs = Date.now();
    let serverTimeOffsetMs = null;
    try {
        serverTimeOffsetMs = await refreshBinanceServerTimeOffset(true);
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'server_time',
            startedAtMs: serverTimeStartedAtMs,
            result: 'success'
        });
    } catch (err) {
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'server_time',
            startedAtMs: serverTimeStartedAtMs,
            result: isTimeoutLikeError(err) ? 'timeout' : 'failed',
            statusCode: err ?.httpStatus,
            binanceCode: err ?.binanceCode,
            errorMessage: err ?.binanceMessage || err ?.message || err
        });
        return {
            ok: false,
            symbol: requestedSymbol,
            desired_leverage: requestedLeverage,
            current_leverage: null,
            leverage_ready: false,
            skipped: null,
            timeout: isTimeoutLikeError(err),
            http_status: Number(err ?.httpStatus || 0) || null,
            binance_code: Number.isFinite(Number(err ?.binanceCode)) ? Number(err.binanceCode) : null,
            last_error_message: sanitizeBinanceErrorMessage(err ?.binanceMessage || err ?.message || err),
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            stages,
            server_time_offset_ms: serverTimeOffsetMs,
            diagnosis: classifyLeveragePrefightDiagnosis({
                timeout: isTimeoutLikeError(err),
                http_status: err ?.httpStatus,
                binance_code: err ?.binanceCode,
                binance_msg: err ?.binanceMessage || err ?.message || err,
                api_key_present: Boolean(BINANCE_API_KEY),
                api_secret_present: Boolean(BINANCE_API_SECRET)
            })
        };
    }

    const currentStartedAtMs = Date.now();
    try {
        const current = await getCurrentLeverageForSymbol(requestedSymbol, { timeoutMs });
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'current_leverage_query',
            startedAtMs: currentStartedAtMs,
            result: 'success'
        });
        if (Number(current.leverage || 0) === requestedLeverage) {
            return {
                ok: true,
                symbol: requestedSymbol,
                desired_leverage: requestedLeverage,
                current_leverage: current.leverage,
                leverage_ready: true,
                skipped: 'already_configured',
                timeout: false,
                http_status: 200,
                binance_code: null,
                last_error_message: null,
                duration_ms: Math.max(0, Date.now() - startedAtMs),
                stages,
                server_time_offset_ms: serverTimeOffsetMs,
                diagnosis: 'already_configured_but_not_detected'
            };
        }
    } catch (err) {
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'current_leverage_query',
            startedAtMs: currentStartedAtMs,
            result: isTimeoutLikeError(err) ? 'timeout' : 'failed',
            statusCode: err ?.httpStatus,
            binanceCode: err ?.binanceCode,
            errorMessage: err ?.binanceMessage || err ?.message || err
        });
        return {
            ok: false,
            symbol: requestedSymbol,
            desired_leverage: requestedLeverage,
            current_leverage: null,
            leverage_ready: false,
            skipped: null,
            timeout: isTimeoutLikeError(err),
            http_status: Number(err ?.httpStatus || 0) || null,
            binance_code: Number.isFinite(Number(err ?.binanceCode)) ? Number(err.binanceCode) : null,
            last_error_message: sanitizeBinanceErrorMessage(err ?.binanceMessage || err ?.message || err),
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            stages,
            server_time_offset_ms: serverTimeOffsetMs,
            diagnosis: classifyLeveragePrefightDiagnosis({
                timeout: isTimeoutLikeError(err),
                http_status: err ?.httpStatus,
                binance_code: err ?.binanceCode,
                binance_msg: err ?.binanceMessage || err ?.message || err,
                api_key_present: Boolean(BINANCE_API_KEY),
                api_secret_present: Boolean(BINANCE_API_SECRET)
            })
        };
    }

    const setStartedAtMs = Date.now();
    try {
        const response = await withFetchRetry(
            () => withTimeout(setLeverageSafely(requestedSymbol, requestedLeverage), timeoutMs, `leverage_prefight:${requestedSymbol}`), {
                label: `leverage_prefight:${requestedSymbol}`,
                attempts: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_ATTEMPTS,
                retryDelayMs: BINANCE_MARGIN_LEVERAGE_WARMUP_RETRY_DELAY_MS,
                retryOn: isRetryableFetchError
            }
        );
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'leverage_set',
            startedAtMs: setStartedAtMs,
            result: 'success'
        });
        return {
            ok: true,
            symbol: requestedSymbol,
            desired_leverage: requestedLeverage,
            current_leverage: Number(response ?.applied_leverage || requestedLeverage) || requestedLeverage,
            leverage_ready: true,
            skipped: null,
            timeout: false,
            http_status: 200,
            binance_code: null,
            last_error_message: null,
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            stages,
            server_time_offset_ms: serverTimeOffsetMs,
            diagnosis: 'leverage_set_timeout'
        };
    } catch (err) {
        recordLeveragePreflightStage(stages, {
            symbol: requestedSymbol,
            stage: 'leverage_set',
            startedAtMs: setStartedAtMs,
            result: isTimeoutLikeError(err) ? 'timeout' : 'failed',
            statusCode: err ?.httpStatus,
            binanceCode: err ?.binanceCode,
            errorMessage: err ?.binanceMessage || err ?.message || err
        });
        return {
            ok: false,
            symbol: requestedSymbol,
            desired_leverage: requestedLeverage,
            current_leverage: null,
            leverage_ready: false,
            skipped: null,
            timeout: isTimeoutLikeError(err),
            http_status: Number(err ?.httpStatus || 0) || null,
            binance_code: Number.isFinite(Number(err ?.binanceCode)) ? Number(err.binanceCode) : null,
            last_error_message: sanitizeBinanceErrorMessage(err ?.binanceMessage || err ?.message || err),
            duration_ms: Math.max(0, Date.now() - startedAtMs),
            stages,
            server_time_offset_ms: serverTimeOffsetMs,
            diagnosis: classifyLeveragePrefightDiagnosis({
                leverage_prefight_timeout: isTimeoutLikeError(err) ? 1 : 0,
                timeout: isTimeoutLikeError(err),
                http_status: err ?.httpStatus,
                binance_code: err ?.binanceCode,
                binance_msg: err ?.binanceMessage || err ?.message || err,
                api_key_present: Boolean(BINANCE_API_KEY),
                api_secret_present: Boolean(BINANCE_API_SECRET)
            })
        };
    }
}

async function setupMarginAndLeverageOnce(symbol, marginType, leverage, options = {}) {
    const requestedSymbol = buildMarginLeverageSymbolKey(symbol);
    const requestedMarginType = String(marginType || 'ISOLATED').toUpperCase();
    const requestedLeverage = Math.max(1, Math.floor(Number(leverage || BINANCE_DEFAULT_LEVERAGE || 1)));
    const startedAtMs = Date.now();
    const cachedState = getMarginLeverageSetupState(requestedSymbol);

    if (!options.force &&
        cachedState ?.next_retry_after &&
        Date.now() < new Date(cachedState.next_retry_after).getTime()
    ) {
        return {
            ok: false,
            ...cachedState,
            setup_status: cachedState.setup_status || 'retry_backoff',
            cache_hit: true
        };
    }

    if (!options.force && isMarginLeverageReadyForTarget(requestedSymbol, requestedMarginType, requestedLeverage)) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        console.info('[MARGIN_LEVERAGE_PREFLIGHT]', {
            symbol: requestedSymbol,
            margin_ready: true,
            leverage_ready: true,
            duration_ms: durationMs,
            result: 'cache_ready',
            error_message: null
        });
        return {
            ok: true,
            symbol: requestedSymbol,
            margin_type_ready: true,
            margin_ready: true,
            leverage_ready: true,
            ready: true,
            setup_status: 'ready',
            last_checked_at: cachedState ?.last_checked_at || new Date().toISOString(),
            duration_ms: durationMs,
            cache_hit: true
        };
    }

    updateMarginLeverageSetupState(requestedSymbol, {
        margin_type: requestedMarginType,
        requested_leverage: requestedLeverage,
        setup_status: 'checking',
        last_error: null
    });

    try {
        const marginStartedAtMs = Date.now();
        const marginResult = await withTimeout(
            setMarginType(requestedSymbol, requestedMarginType),
            BINANCE_MARGIN_LEVERAGE_PREFLIGHT_TIMEOUT_MS,
            `margin_type_prefight:${requestedSymbol}`
        );
        const leverageStartedAtMs = Date.now();
        const leverageResult = await runLeveragePreflightForSymbol(requestedSymbol, requestedLeverage, {
            timeoutMs: BINANCE_MARGIN_LEVERAGE_WARMUP_TIMEOUT_MS
        });
        if (!leverageResult ?.ok) {
            const leverageErr = new Error(leverageResult ?.last_error_message || `leverage_prefight:${requestedSymbol}`);
            leverageErr.httpStatus = leverageResult ?.http_status || null;
            leverageErr.binanceCode = leverageResult ?.binance_code || null;
            leverageErr.binanceMessage = leverageResult ?.last_error_message || null;
            leverageErr.preflightStages = leverageResult ?.stages || [];
            leverageErr.serverTimeOffsetMs = leverageResult ?.server_time_offset_ms ?? null;
            throw leverageErr;
        }
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const state = updateMarginLeverageSetupState(requestedSymbol, {
            margin_type: requestedMarginType,
            requested_leverage: requestedLeverage,
            applied_leverage: Number(leverageResult ?.current_leverage || requestedLeverage),
            margin_ready: true,
            leverage_ready: true,
            setup_status: 'ready',
            last_error: null,
            last_success_at: new Date().toISOString(),
            retry_count: 0,
            next_retry_after: null,
            duration_ms: durationMs,
            margin_duration_ms: Math.max(0, Date.now() - marginStartedAtMs),
            leverage_duration_ms: Math.max(0, Date.now() - leverageStartedAtMs),
            leverage_prefight_stages: leverageResult ?.stages || [],
            leverage_prefight_last_error: null,
            leverage_prefight_diagnosis: leverageResult ?.diagnosis || null,
            server_time_offset_ms: leverageResult ?.server_time_offset_ms ?? null
        });
        await persistMarginLeverageReadinessState(requestedSymbol, state).catch((err) => {
            console.warn('[MARGIN_LEVERAGE_PREFLIGHT_FIRESTORE_PERSIST_FAILED]', {
                symbol: requestedSymbol,
                error_message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        });
        console.info('[MARGIN_LEVERAGE_PREFLIGHT]', {
            symbol: requestedSymbol,
            margin_ready: true,
            leverage_ready: true,
            duration_ms: durationMs,
            result: 'ready',
            error_message: null
        });
        return {
            ok: true,
            ...state,
            margin_response: marginResult,
            leverage_response: leverageResult,
            cache_hit: false
        };
    } catch (err) {
        const durationMs = Math.max(0, Date.now() - startedAtMs);
        const errorMessage = sanitizeBinanceErrorMessage(err ?.message || err);
        const nextRetryAfter = new Date(Date.now() + BINANCE_MARGIN_LEVERAGE_PREFLIGHT_RETRY_BACKOFF_MS).toISOString();
        const state = updateMarginLeverageSetupState(requestedSymbol, {
            margin_type: requestedMarginType,
            requested_leverage: requestedLeverage,
            margin_ready: false,
            leverage_ready: false,
            setup_status: 'setup_failed',
            last_error: errorMessage,
            retry_count: Math.max(0, Number(cachedState ?.retry_count || 0)) + 1,
            next_retry_after: nextRetryAfter,
            duration_ms: durationMs,
            leverage_prefight_stages: err ?.preflightStages || [],
            leverage_prefight_last_error: errorMessage,
            leverage_prefight_diagnosis: classifyLeveragePrefightDiagnosis({
                leverage_prefight_timeout: isTimeoutLikeError(err) ? 1 : 0,
                timeout: isTimeoutLikeError(err),
                http_status: err ?.httpStatus,
                binance_code: err ?.binanceCode,
                binance_msg: err ?.binanceMessage || err ?.message || err,
                api_key_present: Boolean(BINANCE_API_KEY),
                api_secret_present: Boolean(BINANCE_API_SECRET)
            }),
            server_time_offset_ms: err ?.serverTimeOffsetMs ?? null
        });
        await persistMarginLeverageReadinessState(requestedSymbol, state).catch((err) => {
            console.warn('[MARGIN_LEVERAGE_PREFLIGHT_FIRESTORE_PERSIST_FAILED]', {
                symbol: requestedSymbol,
                error_message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        });
        console.warn('[MARGIN_LEVERAGE_PREFLIGHT]', {
            symbol: requestedSymbol,
            margin_ready: false,
            leverage_ready: false,
            duration_ms: durationMs,
            result: 'setup_failed',
            error_message: state.last_error
        });
        return {
            ok: false,
            ...state,
            error_message: state.last_error,
            cache_hit: false
        };
    }
}

async function warmMarginLeverageCache(symbols = [], options = {}) {
    const uniqueSymbols = Array.from(
        new Set((Array.isArray(symbols) ? symbols : []).map((symbol) => String(symbol || '').toUpperCase()).filter(Boolean))
    );
    const marginType = String(options.marginType || 'ISOLATED').toUpperCase();
    const leverage = Math.max(1, Math.floor(Number(options.leverage || BINANCE_DEFAULT_LEVERAGE || 1)));
    const startedAtMs = Date.now();
    const results = [];

    await hydrateMarginLeverageReadinessFromFirestore({ symbols: uniqueSymbols }).catch((err) => {
        console.warn('[MARGIN_LEVERAGE_PREFLIGHT_FIRESTORE_HYDRATE_FAILED]', sanitizeBinanceErrorMessage(err ?.message || err));
    });

    await Promise.allSettled(
        uniqueSymbols.map(async(symbol) => {
            updateMarginLeverageSetupState(symbol, {
                setup_status: getMarginLeverageSetupState(symbol) ?.setup_status || 'pending'
            });
            const result = await setupMarginAndLeverageOnce(symbol, marginType, leverage, {
                force: Boolean(options.force)
            });
            results.push({
                symbol,
                ok: Boolean(result ?.ok),
                setup_status: result ?.setup_status || null,
                duration_ms: Number(result ?.duration_ms || 0) || null
            });
        })
    );

    return {
        ok: true,
        symbols_total: uniqueSymbols.length,
        ready_count: results.filter((item) => item.ok).length,
        failed_count: results.filter((item) => !item.ok).length,
        duration_ms: Math.max(0, Date.now() - startedAtMs),
        results
    };
}

function getMarginLeverageReadinessSnapshot(symbols = []) {
    const requestedSymbols = Array.isArray(symbols) ?
        symbols.map((symbol) => buildMarginLeverageSymbolKey(symbol)).filter(Boolean) :
        [];
    const keys = requestedSymbols.length ?
        Array.from(new Set(requestedSymbols)) :
        Array.from(marginLeverageReadyCache.keys()).sort();
    const perSymbol = keys.map((symbol) => {
        const state = getMarginLeverageSetupState(symbol);
        if (state) return state;
        return buildMarginLeverageReadinessState(symbol, {
            setup_status: 'pending',
            last_checked_at: null
        });
    });
    return {
        symbols_total: perSymbol.length,
        ready_count: perSymbol.filter((item) => item.ready === true).length,
        not_ready_count: perSymbol.filter((item) => item.ready !== true).length,
        per_symbol: perSymbol
    };
}

setImmediate(() => {
    hydrateMarginLeverageReadinessFromFirestore().catch((err) => {
        console.warn('[MARGIN_LEVERAGE_PREFLIGHT_FIRESTORE_BOOTSTRAP_FAILED]', sanitizeBinanceErrorMessage(err ?.message || err));
    });
});

function getBinanceConnectionDebugState() {
    return {
        server_time_offset_ms: Number.isFinite(Number(binanceTimeOffsetMs)) ? Number(binanceTimeOffsetMs) : null,
        recv_window_used: BINANCE_SIGNED_RECV_WINDOW_MS,
        api_key_present: Boolean(BINANCE_API_KEY),
        api_secret_present: Boolean(BINANCE_API_SECRET)
    };
}

async function configureMarginAndLeverageWithFallback(symbol, marginType, leverage, diagnostics = null) {
    const cacheKey = buildMarginSetupCacheKey(symbol, marginType, leverage);
    const cached = marginSetupCache.get(cacheKey) || null;
    const timeoutMs = Math.max(5000, Math.min(BINANCE_LIVE_ORDER_TIMEOUT_MS, 8000));
    const marginStartedAtMs = Date.now();
    const leverageStartedAtMs = Date.now();

    if (diagnostics && typeof diagnostics === 'object') {
        diagnostics.margin_leverage_setup_attempted = true;
        diagnostics.margin_setup_cache_key = cacheKey;
        diagnostics.margin_setup_cache_hit = Boolean(cached);
        diagnostics.leverage_setup_cache_hit = Boolean(cached);
        diagnostics.repeated_margin_setup = Boolean(cached);
        diagnostics.repeated_leverage_setup = Boolean(cached);
        diagnostics.margin_setup_cacheable = true;
        diagnostics.leverage_setup_cacheable = true;
    }

    const marginTask = async() =>
        withFetchRetry(
            () => withTimeout(setMarginType(symbol, marginType), timeoutMs, `margin_type:${symbol}`), {
                label: `margin_type:${symbol}`,
                retryOn: isRetryableFetchError
            }
        );
    const leverageTask = async() =>
        withFetchRetry(
            () => withTimeout(setLeverageSafely(symbol, leverage), timeoutMs, `leverage:${symbol}`), {
                label: `leverage:${symbol}`,
                retryOn: isRetryableFetchError
            }
        );

    const [marginResult, leverageResult] = await Promise.allSettled([marginTask(), leverageTask()]);
    const fallbackUsed = {
        margin: false,
        leverage: false
    };

    const handleResult = (result, type, stage, startedAtMs) => {
        if (result.status === 'fulfilled') {
            recordLiveOrderStage(diagnostics, {
                stage,
                startedAtMs,
                result: result.value ?.skipped ? 'skipped' : 'success',
                extra: {
                    cache_hit_before: Boolean(cached),
                    skipped_reason: result.value ?.skipped || null,
                    timeout_fallback: false
                }
            });
            return result.value;
        }
        const err = result.reason;
        recordLiveOrderStage(diagnostics, {
            stage,
            startedAtMs,
            result: isRetryableFetchError(err) ? 'timeout_fallback' : 'failed',
            errorMessage: err ?.message || err,
            extra: {
                cache_hit_before: Boolean(cached),
                timeout_fallback: isRetryableFetchError(err)
            }
        });
        if (!isRetryableFetchError(err)) {
            throw err;
        }
        console.warn('[MARGIN_SETUP_TIMEOUT]', {
            symbol,
            type,
            message: sanitizeBinanceErrorMessage(err ?.message || err),
            cache_available: Boolean(cached)
        });
        fallbackUsed[type] = true;
        return cached ?.[type] || {
            ok: true,
            timeout_fallback: true,
            assumed_applied: false
        };
    };

    const margin = handleResult(marginResult, 'margin', 'margin_type_setup', marginStartedAtMs);
    const leverageResponse = handleResult(leverageResult, 'leverage', 'leverage_setup', leverageStartedAtMs);

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
    if (rules ?.tickSize) {
        normalized = roundToTick(normalized, rules.tickSize);
    }
    if (Number.isFinite(rules ?.pricePrecision) && rules.pricePrecision >= 0) {
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
        pricePrecision: Number.isFinite(rules ?.pricePrecision) ? Number(rules.pricePrecision) : 8,
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
        const error = String(err ?.message || err);
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
    if (rules ?.tickSize) {
        tpTriggerPrice = roundToTick(tpTriggerPrice, rules.tickSize);
        slTriggerPrice = roundToTick(slTriggerPrice, rules.tickSize);
    }
    if (Number.isFinite(rules ?.pricePrecision) && rules.pricePrecision >= 0) {
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
        exitOrders ?.fully_protected ||
        exitOrders ?.tp ?.algoId ||
        exitOrders ?.tp ?.orderId ||
        exitOrders ?.tp ?.clientOrderId ||
        exitOrders ?.sl ?.orderId ||
        exitOrders ?.sl ?.algoId ||
        exitOrders ?.sl ?.clientOrderId
    );
}

function resolveProtectivePersistence(exitOrders, enableTpSl = true) {
    const tpOrderId =
        exitOrders ?.tp ?.algoId ||
        exitOrders ?.tp ?.orderId ||
        exitOrders ?.tp ?.clientOrderId ||
        null;
    const slOrderId =
        exitOrders ?.sl ?.algoId ||
        exitOrders ?.sl ?.orderId ||
        exitOrders ?.sl ?.clientOrderId ||
        null;
    const protectiveStopAvailable =
        Boolean(exitOrders ?.fully_protected) ||
        Boolean(tpOrderId) ||
        Boolean(slOrderId);
    const protectiveOrderStatus =
        enableTpSl === false ?
        'tp_sl_disabled' :
        protectiveStopAvailable ?
        'exchange_stop_active' :
        'manager_fallback';

    return {
        tpOrderId,
        slOrderId,
        protectiveStopAvailable,
        protectiveOrderStatus
    };
}

function enforceLiveNotionalFloor(intent, rules, sourceProfile) {
    if (sourceProfile !== 'high_conviction') return intent;
    const entryPrice = Number(intent ?.entry_price || 0);
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return intent;
    const exchangeFloor = Number(rules ?.minNotional || 0);
    const targetNotional = Math.max(BINANCE_HC_MIN_LIVE_NOTIONAL_USDT, exchangeFloor);
    const currentNotional = Number(intent ?.notional_usdt || 0);
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
    const highScore = Number(executionGuardConfig ?.high_quality_score || 70);
    const mediumScore = Number(executionGuardConfig ?.medium_quality_score || 40);
    const mediumHighScore = Number(executionGuardConfig ?.medium_high_quality_score || 55);
    const highFactor = clamp(Number(executionGuardConfig ?.high_quality_size_factor || 1), 0.2, 1);
    const mediumHighFactor = clamp(
        Number(executionGuardConfig ?.medium_high_quality_size_factor || 0.7),
        0.2,
        1
    );
    const mediumLowFactor = clamp(
        Number(executionGuardConfig ?.medium_low_quality_size_factor || 0.4),
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
    const sizingDecision = resolveEntryQualitySizing(score, config ?.execution_guard || {});
    const baseEntryPrice = Number(intent ?.entry_price || 0);
    const baseQuantity = Number(intent ?.quantity || 0);
    const derivedBaseNotional =
        Number(intent ?.notional_usdt || 0) ||
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
        Number(adjustedIntent ?.notional_usdt || 0) ||
        Number(adjustedIntent ?.entry_price || 0) * Number(adjustedIntent ?.quantity || 0);

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
            effectiveSizeFactor: derivedBaseNotional > 0 ? Number((adjustedNotional / derivedBaseNotional).toFixed(4)) : targetFactor
        }
    };
}

async function executeSignalTrade(db, signalData, options = {}) {
    const sourceProfile = resolveSourceProfileKey(options.source_profile || options.source || 'high_conviction');
    const receivedAtIso = new Date().toISOString();
    const signalDataForExecution = normalizeSignalDataForExecution(signalData, sourceProfile, receivedAtIso);
    const predictionId = signalDataForExecution ?.prediction_id || signalDataForExecution ?.id || null;
    const emittedSignalTimestamp = resolveSignalTimestamp(signalDataForExecution);
    const highConvictionSignalCreatedAt =
        parseDateLike(signalDataForExecution ?.signal_created_at) || emittedSignalTimestamp;
    const handoffAttemptAt = new Date();
    const handoffAgeMs = emittedSignalTimestamp ? Math.max(0, handoffAttemptAt.getTime() - emittedSignalTimestamp.getTime()) : null;
    const maxAllowedAgeMs = STALE_PENDING_PREDICTION_TIMEOUT_MS;
    const entryWindowMs = resolveEntryWindowMsFromSignal(signalDataForExecution);
    const resolvedSymbol = resolveExecutionSymbolContext(signalDataForExecution);
    if (resolvedSymbol.symbol) {
        signalDataForExecution.symbol = resolvedSymbol.symbol;
        signalDataForExecution.execution_symbol_source =
            resolvedSymbol.source || signalDataForExecution.execution_symbol_source || null;
    }
    const config = await getCachedBinanceBotConfig(db);
    const effectiveConfig = buildEffectiveConfig(config, sourceProfile);
    const runtimeControl = await db.collection('system_runtime_config').doc('bot_execution').get().catch(() => null);
    const runtimeExecutionEnabled = runtimeControl ?.exists ?
        runtimeControl.data() ?.execution_enabled !== false :
        true;
    const runtimeData = runtimeControl ?.exists ? (runtimeControl.data() || {}) : {};
    console.info('[SIGNAL_HANDOFF_ATTEMPT]', {
        signal_id: predictionId,
        symbol: signalDataForExecution ?.symbol || signalDataForExecution ?.simbolo || null,
        origin: sourceProfile,
        signal_emitted_at: emittedSignalTimestamp ?.toISOString() || signalDataForExecution ?.signal_emitted_at || null,
        handoff_attempt_at: handoffAttemptAt.toISOString(),
        age_ms: handoffAgeMs,
        max_allowed_age_ms: maxAllowedAgeMs,
        result: runtimeExecutionEnabled ? 'started' : 'skipped',
        reason: runtimeExecutionEnabled ? null : 'execution_disabled_runtime'
    });
    await syncPredictionHandoffLifecycle(db, predictionId, {
        handoff_attempt_at: handoffAttemptAt.toISOString(),
        handoff_age_ms: handoffAgeMs,
        handoff_max_allowed_age_ms: maxAllowedAgeMs,
        handoff_attempted_within_5s: handoffAgeMs != null ? handoffAgeMs <= 5000 : null,
        handoff_attempted_within_30s: handoffAgeMs != null ? handoffAgeMs <= 30000 : null,
        handoff_status: handoffAgeMs != null && handoffAgeMs > 5000 ? 'attempted_late' : 'attempted_immediately',
        last_handoff_result: runtimeExecutionEnabled ? 'started' : 'skipped',
        last_handoff_reason: runtimeExecutionEnabled ? null : 'execution_disabled_runtime',
        execution_enabled: runtimeData.execution_enabled !== false,
        auto_trade_mode: runtimeData.auto_trade_mode !== false,
        runtime_status: runtimeData.runtime_status || runtimeData.status || null
    });
    if (!runtimeExecutionEnabled) {
        return { executed: false, reason: 'execution_disabled_runtime', dry_run: false, skipped: true };
    }
    const intent = createExecutionIntent(signalDataForExecution, effectiveConfig, sourceProfile);
    const observationSymbol = intent.symbol;
    let executionTrace = buildInitialExecutionTrace({
        ...signalDataForExecution,
        source_profile: sourceProfile
    });
    logExecutionPipelineStage({
        predictionId,
        symbol: intent.symbol,
        stage: 'signal_emitted',
        extra: {
            source_profile: sourceProfile,
            trace_id: executionTrace.trace_id
        }
    });
    console.info('[PREALERT_STAGE_TIMING]', {
        stage: 'signal_emit',
        duration_ms: emittedSignalTimestamp ? Math.max(0, Date.now() - emittedSignalTimestamp.getTime()) : null,
        symbol: intent.symbol,
        prediction_id: predictionId,
        source_profile: sourceProfile
    });
    logSymbolFlow({
        symbol: intent.symbol,
        source: signalDataForExecution.execution_symbol_source || options.source || sourceProfile,
        stage: 'execution_input',
        predictionId,
        traceId: executionTrace.trace_id
    });
    if (!intent.symbol) {
        logSymbolError({
            stage: 'execution_input',
            source: options.source || sourceProfile,
            prediction_id: predictionId,
            trace_id: executionTrace.trace_id,
            raw_symbol: signalDataForExecution.signal_symbol || null,
            symbol_source: signalDataForExecution.execution_symbol_source || null
        });
        await syncPredictionTerminalState(db, {
            predictionId,
            sourceProfile,
            status: 'failed',
            reason: 'symbol_missing',
            dryRun: false,
            executed: false,
            tracePayload: { trace_id: executionTrace.trace_id },
            symbol: null,
            failureStage: 'symbol_resolution',
            errorMessage: 'symbol missing from execution input',
            pendingStateResolution: 'symbol_resolution'
        });
        return {
            executed: false,
            reason: 'symbol_missing',
            dry_run: false,
            failed: true,
            aborted: true
        };
    }
    logSymbolFlow({
        symbol: intent.symbol,
        source: intent.symbol_source || signalDataForExecution.execution_symbol_source || options.source || sourceProfile,
        stage: 'execution_intent',
        predictionId,
        traceId: executionTrace.trace_id
    });
    try {
        await ensureSymbolObservation(observationSymbol, 'recent_signal', {
            db,
            config,
            key: `signal:${predictionId || executionTrace.trace_id}`,
            ttlMs: config ?.market_stream ?.recent_signal_ttl_ms,
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
    const highConvictionLifecycle = sourceProfile === 'high_conviction' ?
        {
            signal_created_at: highConvictionSignalCreatedAt ?.toISOString() || signalDataForExecution ?.signal_created_at || null,
            intent_attempt_at: handoffAttemptAt.toISOString(),
            age_ms: highConvictionSignalCreatedAt && handoffAttemptAt ?
                Math.max(0, handoffAttemptAt.getTime() - highConvictionSignalCreatedAt.getTime()) :
                handoffAgeMs,
            max_entry_window_ms: entryWindowMs,
            handoff_delay_ms: highConvictionSignalCreatedAt && handoffAttemptAt ?
                Math.max(0, handoffAttemptAt.getTime() - highConvictionSignalCreatedAt.getTime()) :
                null
        } :
        null;
    let existingIntentData = null;
    try {
        await intentRef.create({
            prediction_id: predictionId,
            source_profile: sourceProfile,
            source: options.source || sourceProfile,
            symbol: intent.symbol,
            symbol_normalized: intent.symbol_normalized || intent.symbol,
            signal_symbol: signalDataForExecution ?.signal_symbol || signalDataForExecution ?.symbol || signalDataForExecution ?.simbolo || null,
            requested_margin_type: intent.requested_margin_type || intent.margin_type || null,
            requested_leverage: Number(intent.requested_leverage || intent.leverage || 0) || null,
            requested_target_key: intent.requested_target_key ||
                `${String(intent.symbol || '').toUpperCase()}:${String(intent.requested_margin_type || intent.margin_type || '').toUpperCase()}:${Number(intent.requested_leverage || intent.leverage || 0) || null}`,
            config_source: intent.config_source || effectiveConfig ?._config_source || 'binance_bot_config/defaults',
            status: 'processing',
            processing_stage: 'created',
            processing_started_at: new Date().toISOString(),
            trace_id: executionTrace.trace_id,
            execution_trace: executionTrace,
            high_conviction_lifecycle: highConvictionLifecycle,
            created_at: FieldValue.serverTimestamp()
        });
        logExecutionPipelineStage({
            predictionId,
            symbol: intent.symbol,
            stage: 'intent_created'
        });
        try {
            await ensureSymbolObservation(observationSymbol, 'processing_intent', {
                db,
                config,
                key: `intent:${intentRef.id}`,
                ttlMs: config ?.market_stream ?.intent_ttl_ms,
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
        const code = String(err ?.code || '');
        if (code !== '6' && !String(err ?.message || '').toLowerCase().includes('already exists')) {
            throw err;
        }
        const existingIntent = await intentRef.get();
        existingIntentData = existingIntent.exists ? (existingIntent.data() || {}) : null;
        if (existingIntentData ?.status && existingIntentData.status !== 'processing') {
            return { executed: false, reason: 'already_processed', dry_run: false, skipped: true };
        }
        logExecutionPipelineStage({
            predictionId,
            symbol: intent.symbol,
            stage: 'intent_created',
            extra: { reused: true }
        });
    }

    if (sourceProfile === 'high_conviction') {
        console.info('[HIGH_CONVICTION_INTENT_ATTEMPT]', {
            signal_id: predictionId,
            intent_id: intentRef.id,
            symbol: intent.symbol,
            signal_created_at: highConvictionLifecycle ?.signal_created_at || null,
            intent_attempt_at: highConvictionLifecycle ?.intent_attempt_at || handoffAttemptAt.toISOString(),
            age_ms: highConvictionLifecycle ?.age_ms ?? null,
            max_entry_window_ms: highConvictionLifecycle ?.max_entry_window_ms ?? null,
            result: 'started',
            reason: null
        });
    }

    logExecutionPipelineStage({
        predictionId,
        symbol: intent.symbol,
        stage: 'processing_intent_started'
    });

    const modeDryRun = effectiveConfig.mode === 'dry-run' || BINANCE_EXECUTION_DRY_RUN;
    const timeAlignedExecutionEnabled = shouldUseTimeAlignedExecution(sourceProfile, modeDryRun);
    const executionConfig = timeAlignedExecutionEnabled ?
        buildTimeAlignedExecutionConfig(effectiveConfig) :
        effectiveConfig;
    const forcedObserveMode = Boolean(effectiveConfig.observe_mode_forced);
    const preExecutionAudit = buildExecutionAudit(signalDataForExecution);
    const tradePlanValidation = validateTradePlanForIntent(intent);
    if (!tradePlanValidation.ok) {
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
            prediction_id: predictionId,
            source_profile: sourceProfile,
            source: options.source || sourceProfile,
            symbol: intent.symbol,
            status: 'failed',
            reason: 'trade_plan_invalid',
            failure_stage: 'trade_plan_validation',
            processing_stage: 'trade_plan_validation',
            trace_id: tracePayload.trace_id,
            execution_trace: tracePayload.execution_trace,
            execution_trace_metrics: tracePayload.execution_trace_metrics,
            dominant_delay_stage: tracePayload.dominant_delay_stage,
            critical_delay: tracePayload.critical_delay,
            trade_plan_validation: tradePlanValidation,
            high_conviction_lifecycle: highConvictionLifecycle,
            intent,
            execution_audit: preExecutionAudit,
            error_message: tradePlanValidation.reason || 'trade_plan_invalid'
        });
        await syncPredictionTerminalState(db, {
            predictionId,
            sourceProfile,
            status: 'failed',
            reason: 'trade_plan_invalid',
            dryRun: false,
            tracePayload,
            symbol: intent.symbol,
            failureStage: 'trade_plan_validation',
            errorMessage: tradePlanValidation.reason || 'trade_plan_invalid',
            pendingStateResolution: 'binance_terminal_sync'
        });
        await markIntentFailed(intentRef, {
            reason: 'trade_plan_invalid',
            failure_stage: 'trade_plan_validation',
            processing_stage: 'trade_plan_validation',
            error_message: tradePlanValidation.reason || 'trade_plan_invalid'
        });
        if (sourceProfile === 'high_conviction') {
            console.info('[HIGH_CONVICTION_INTENT_ATTEMPT]', {
                signal_id: predictionId,
                intent_id: intentRef.id,
                symbol: intent.symbol,
                signal_created_at: highConvictionLifecycle ?.signal_created_at || null,
                intent_attempt_at: highConvictionLifecycle ?.intent_attempt_at || handoffAttemptAt.toISOString(),
                age_ms: highConvictionLifecycle ?.age_ms ?? null,
                max_entry_window_ms: highConvictionLifecycle ?.max_entry_window_ms ?? null,
                result: 'failed',
                reason: 'trade_plan_invalid'
            });
        }
        try {
            releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
        } catch (_) {
            // noop
        }
        return {
            executed: false,
            reason: 'trade_plan_invalid',
            dry_run: false,
            failed: true
        };
    }
    const signalTimestamp = resolveSignalTimestamp(signalDataForExecution);
    const signalExpirationMs = Number(executionConfig ?.execution_guard ?.signal_expiration_ms || 0) || null;
    const signalExpiresAt =
        signalTimestamp && signalExpirationMs != null ?
        new Date(signalTimestamp.getTime() + signalExpirationMs).toISOString() :
        null;
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
            logExecutionTimeoutPath({
                predictionId,
                symbol: intent.symbol,
                stage: 'processing_intent_started',
                timeoutMs: Number(err ?.timeoutMs || INTENT_STAGE_TIMEOUT_MS),
                reason: sanitizeBinanceErrorMessage(err ?.message || err)
            });
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
                error_message: String(err ?.message || err)
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
                errorMessage: String(err ?.message || err),
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
        pipeline_type: signalDataForExecution ?.pipeline_type || sourceProfile,
        prediction_id: predictionId,
        dry_run: modeDryRun,
        enabled: BINANCE_EXECUTION_ENABLED,
        config_mode: effectiveConfig.mode,
        config_snapshot: {
            use_funds_percent: executionConfig.use_funds_percent,
            account_capital_usdt: executionConfig.account_capital_usdt,
            default_leverage: executionConfig.default_leverage,
            max_daily_trades: executionConfig.max_daily_trades,
            symbols_allowlist: executionConfig.symbols_allowlist,
            allow_unlisted_symbols: Boolean(executionConfig.allow_unlisted_symbols),
            max_notional_usdt: Number(executionConfig.max_notional_usdt || 0),
            min_recent_valid_records: Number(executionConfig.min_recent_valid_records || 0),
            recent_records_window_minutes: Number(executionConfig.recent_records_window_minutes || 0),
            symbol_cooldown_minutes: Number(executionConfig.symbol_cooldown_minutes || 0),
            min_confidence: executionConfig.min_confidence,
            min_quantum: executionConfig.min_quantum,
            min_timing: executionConfig.min_timing,
            min_context_score: executionConfig.min_context_score,
            min_context_quality: executionConfig.min_context_quality,
            min_risk_reward: executionConfig.min_risk_reward,
            min_expected_move_pct: executionConfig.min_expected_move_pct,
            early_exit_enabled: executionConfig.early_exit_enabled,
            early_exit_drawdown_pct: executionConfig.early_exit_drawdown_pct,
            margin_type: executionConfig.margin_type,
            order_type: executionConfig.order_type,
            enable_tp_sl: executionConfig.enable_tp_sl,
            tp_order_type: executionConfig.tp_order_type,
            sl_order_type: executionConfig.sl_order_type,
            tp_buffer_pct: executionConfig.tp_buffer_pct,
            sl_buffer_pct: executionConfig.sl_buffer_pct,
            execution_guard: executionConfig.execution_guard || null
        },
        validation: null,
        trade_plan_validation: tradePlanValidation,
        execution_discipline: entryDiscipline.details,
        trace_id: executionTrace.trace_id,
        execution_trace: executionTrace,
        high_conviction_lifecycle: highConvictionLifecycle,
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
        if (sourceProfile === 'high_conviction') {
            console.info('[HIGH_CONVICTION_INTENT_ATTEMPT]', {
                signal_id: predictionId,
                intent_id: intentRef.id,
                symbol: intent.symbol,
                signal_created_at: highConvictionLifecycle ?.signal_created_at || null,
                intent_attempt_at: highConvictionLifecycle ?.intent_attempt_at || handoffAttemptAt.toISOString(),
                age_ms: highConvictionLifecycle ?.age_ms ?? null,
                max_entry_window_ms: highConvictionLifecycle ?.max_entry_window_ms ?? null,
                result: 'skipped',
                reason: entryDiscipline.reason
            });
        }
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
    let validationIntent = intent;
    let timeAlignedExecutionMeta = null;
    let finalEvaluation = null;
    try {
        logExecutionPipelineStage({
            predictionId,
            symbol: intent.symbol,
            stage: 'pre_order_validation'
        });
        await updateIntentProcessingStage(intentRef, 'pre_validation');
        const preValidationStartedAtMs = Date.now();
        const exchangeInfoStartedAtMs = Date.now();
        rules = await getFuturesSymbolRules(intent.symbol);
        logLiveStageTiming({
            stage: 'exchange_info',
            startedAtMs: exchangeInfoStartedAtMs,
            symbol: intent.symbol,
            predictionId,
            extra: {
                cache_source: rules ?.cache_source || null
            }
        });
        if (timeAlignedExecutionEnabled) {
            const timeAlignedValidation = await resolveTimeAlignedValidation({
                db,
                baseIntent: intent,
                config: executionConfig,
                sourceProfile,
                rules,
                signalTimestamp,
                intentCreatedAt: parseDateLike(executionTrace ?.intent_created_at) || new Date(),
                intentRef,
                predictionId,
                symbol: intent.symbol
            });
            validation = timeAlignedValidation.validation;
            validationIntent = timeAlignedValidation.intent || intent;
            timeAlignedExecutionMeta = timeAlignedValidation.timeAligned || null;
            finalEvaluation = timeAlignedValidation.finalEvaluation || null;
            if (validation ?.ok && timeAlignedExecutionMeta ?.t_execution) {
                console.info('[TIME_ALIGNED_EXECUTION]', {
                    event: 't_execution',
                    prediction_id: predictionId,
                    symbol: intent.symbol,
                    executed_at: timeAlignedExecutionMeta.t_execution,
                    executed_attempt_number: timeAlignedExecutionMeta.executed_attempt_number,
                    executed_attempt_delay_ms: timeAlignedExecutionMeta.executed_attempt_delay_ms
                });
            }
        } else {
            validation = await withTimeout(
                validateExecutionIntent(db, intent, executionConfig, {
                    source_profile: sourceProfile,
                    rules
                }),
                INTENT_STAGE_TIMEOUT_MS,
                'intent_validation'
            );
        }
        logLiveStageTiming({
            stage: 'pre_validation',
            startedAtMs: preValidationStartedAtMs,
            symbol: intent.symbol,
            predictionId,
            extra: {
                ok: Boolean(validation ?.ok)
            }
        });
    } catch (err) {
        if (isTimeoutLikeError(err)) {
            logExecutionTimeoutPath({
                predictionId,
                symbol: intent.symbol,
                stage: 'pre_order_validation',
                timeoutMs: Number(err ?.timeoutMs || INTENT_STAGE_TIMEOUT_MS),
                reason: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        }
        if (String(err ?.failureStage || err ?.message || '').includes('exchange_info:')) {
            console.warn('[EXCHANGE_INFO_TIMEOUT]', {
                symbol: intent.symbol,
                prediction_id: predictionId,
                message: sanitizeBinanceErrorMessage(err ?.message || err)
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
            error_message: String(err ?.message || err),
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
            errorMessage: String(err ?.message || err),
            pendingStateResolution: 'binance_terminal_sync'
        });
        await markIntentFailed(intentRef, {
            reason: resolveFailureReason(err, 'pre_validation_failed'),
            failure_stage: 'pre_validation',
            processing_stage: 'pre_validation',
            error_message: String(err ?.message || err)
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
        enforceLiveNotionalFloor(validationIntent, rules, sourceProfile),
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
        intent: preciseIntent,
        time_aligned_execution: timeAlignedExecutionMeta,
        final_evaluation: finalEvaluation,
        attempt_history: Array.isArray(timeAlignedExecutionMeta ?.attempts) ? timeAlignedExecutionMeta.attempts : null
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
            critical_delay: tracePayload.critical_delay,
            time_aligned_execution: timeAlignedExecutionMeta,
            final_evaluation: finalEvaluation,
            attempt_history: Array.isArray(timeAlignedExecutionMeta ?.attempts) ? timeAlignedExecutionMeta.attempts : null
        });
        if (sourceProfile === 'high_conviction') {
            console.info('[HIGH_CONVICTION_INTENT_ATTEMPT]', {
                signal_id: predictionId,
                intent_id: intentRef.id,
                symbol: preciseIntent.symbol,
                signal_created_at: highConvictionLifecycle ?.signal_created_at || null,
                intent_attempt_at: highConvictionLifecycle ?.intent_attempt_at || handoffAttemptAt.toISOString(),
                age_ms: highConvictionLifecycle ?.age_ms ?? null,
                max_entry_window_ms: highConvictionLifecycle ?.max_entry_window_ms ?? null,
                result: 'skipped',
                reason: validation.reason
            });
        }
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

    if (!modeDryRun && executionConfig ?.execution_guard ?.enabled !== false) {
        await updateIntentProcessingStage(intentRef, 'execution_guard');
        entrySnapshot = await resolveExecutionSnapshot(db, preciseIntent.symbol, executionConfig);
        executionGuardResult = evaluateExecutionGuard(
            preciseIntent.symbol, {
                ...signalDataForExecution,
                side: preciseIntent.side,
                entry_price: preciseIntent.entry_price
            },
            entrySnapshot, {
                botConfig: executionConfig,
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
            executionConfig,
            sourceProfile
        );
        preciseIntent = sizingApplied.intent || preciseIntent;
        console.info('[ENTRY_SIZING_APPLIED]', {
            symbol: preciseIntent.symbol,
            prediction_id: predictionId,
            score: executionGuardResult.entryQualityScore,
            band: sizingApplied ?.sizing ?.band || null,
            requested_size_factor: sizingApplied ?.sizing ?.sizeFactor || null,
            effective_size_factor: sizingApplied ?.sizing ?.effectiveSizeFactor || sizingApplied ?.sizing ?.sizeFactor || 1,
            base_notional_usdt: sizingApplied ?.sizing ?.baseNotionalUsdt || null,
            adjusted_notional_usdt: sizingApplied ?.sizing ?.adjustedNotionalUsdt || null
        });
        await writeIntentDoc(intentRef, {
            processing_stage: 'execution_guard_passed',
            execution_guard: executionGuardResult,
            entry_execution_snapshot: entrySnapshotPersistence,
            intent: preciseIntent,
            entry_sizing: sizingApplied ?.sizing || null
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
    let liveIntent = preciseIntent;
    let executedAt = new Date();
    let openPositionRef = null;
    let initialExecutionAudit = null;
    let initialEntrySnapshot = null;
    let marginSetupStartedAtMs = null;
    let orderAttemptStartedAtMs = null;
    const initialExpectedDurationWindow = resolveExpectedDurationWindow(signalData);
    const liveOrderDiagnostics = {
        attempted: true,
        intent_id: intentRef ?.id || null,
        symbol: preciseIntent.symbol,
        prediction_id: predictionId,
        stages: [],
        repeated_margin_setup: false,
        repeated_leverage_setup: false,
        margin_setup_cacheable: false,
        leverage_setup_cacheable: false,
        margin_leverage_hot_path_call: false,
        started_at: new Date().toISOString()
    };
    const qtyPrecision = Number.isFinite(preciseIntent ?._quantity_precision) ?
        Number(preciseIntent._quantity_precision) :
        decimalsFromStep(rules ?.marketStepSize || rules ?.stepSize || 0);
    try {
        const orphanGuard = await assertFreshIntentForEntry({
            intentRef,
            symbol: preciseIntent.symbol,
            side: preciseIntent.side
        });
        if (!orphanGuard.ok) {
            console.log('[ORPHAN_ORDER_BLOCKED]', {
                symbol: preciseIntent.symbol,
                side: preciseIntent.side,
                reason: orphanGuard.reason,
                age_ms: orphanGuard.ageMs ?? null
            });
            await updateIntentProcessingStage(intentRef, 'orphan_guard');
            await writeIntentDoc(intentRef, {
                status: 'blocked',
                reason: 'orphan_intent_blocked',
                error_message: orphanGuard.reason,
                execution_audit: {
                    win_exchange: 'BLOCKED_ORPHAN_INTENT'
                }
            });
            return {
                executed: false,
                reason: 'orphan_intent_blocked',
                dry_run: false,
                blocked: true
            };
        }
        await updateIntentProcessingStage(intentRef, 'live_order');
        executionTrace = advanceExecutionTrace(executionTrace, {
            execution_attempt_at: Date.now()
        });
        const cachedSetupState = getMarginLeverageSetupState(preciseIntent.symbol);
        liveOrderDiagnostics.margin_leverage_prefight_cache_before = cachedSetupState || null;
        if (isMarginLeverageReadyForTarget(preciseIntent.symbol, preciseIntent.margin_type, preciseIntent.leverage)) {
            const readyState = getMarginLeverageSetupState(preciseIntent.symbol);
            const readinessSnapshot = buildMarginLeverageReadinessSnapshotForDecision({
                symbol: preciseIntent.symbol,
                requestedMarginType: preciseIntent.margin_type,
                desiredLeverage: preciseIntent.leverage,
                memoryState: readyState,
                firestoreState: null,
                readinessSourceUsed: 'memory'
            });
            liveOrderDiagnostics.margin_leverage_setup_result = 'cache_ready';
            liveOrderDiagnostics.margin_setup_ready = true;
            liveOrderDiagnostics.leverage_setup_ready = true;
            liveOrderDiagnostics.margin_leverage_ready = true;
            liveOrderDiagnostics.readiness_source_used = 'memory';
            liveOrderDiagnostics.margin_leverage_readiness_snapshot = readinessSnapshot;
            liveOrderDiagnostics.repeated_margin_setup = Boolean(readyState ?.margin_ready);
            liveOrderDiagnostics.repeated_leverage_setup = Boolean(readyState ?.leverage_ready);
            console.info('[MARGIN_LEVERAGE_READINESS_DECISION]', {
                intent_id: intentRef ?.id || null,
                symbol: preciseIntent.symbol,
                normalized_symbol: readinessSnapshot.normalized_symbol,
                requested_margin_type: readinessSnapshot.requested_margin_type,
                requested_leverage: readinessSnapshot.requested_leverage,
                requested_target_key: readinessSnapshot.requested_target_key,
                cached_margin_type: readinessSnapshot.cached_margin_type,
                cached_leverage: readinessSnapshot.cached_leverage,
                cached_target_key: readinessSnapshot.cached_target_key,
                target_match: readinessSnapshot.target_match,
                mismatch_reason: readinessSnapshot.mismatch_reason,
                source_used: readinessSnapshot.readiness_source_used,
                memory_entry_found: readinessSnapshot.memory_entry_found,
                firestore_entry_found: readinessSnapshot.firestore_entry_found,
                ready: readinessSnapshot.ready,
                margin_ready: readinessSnapshot.margin_ready,
                leverage_ready: readinessSnapshot.leverage_ready,
                expired: readinessSnapshot.expired,
                decision_reason: readinessSnapshot.decision_reason
            });
        } else {
            let hydratedState = null;
            let firestoreState = null;
            try {
                const hydration = await withTimeout(
                    hydrateMarginLeverageReadinessFromFirestore({ symbols: [preciseIntent.symbol], force: true }),
                    BINANCE_MARGIN_LEVERAGE_FIRESTORE_HYDRATION_TIMEOUT_MS,
                    `margin_leverage_firestore_hydrate:${preciseIntent.symbol}`
                );
                firestoreState = hydration ?.states ?.find((state) =>
                    state.symbol === buildMarginLeverageSymbolKey(preciseIntent.symbol)
                ) || null;
                hydratedState = hydration ?.fresh_states ?.find((state) =>
                    state.symbol === buildMarginLeverageSymbolKey(preciseIntent.symbol)
                ) || null;
            } catch (err) {
                liveOrderDiagnostics.margin_leverage_firestore_hydration_error =
                    sanitizeBinanceErrorMessage(err ?.message || err);
            }

            if (hydratedState && isMarginLeverageReadyForTarget(preciseIntent.symbol, preciseIntent.margin_type, preciseIntent.leverage)) {
                const readyState = getMarginLeverageSetupState(preciseIntent.symbol);
                const readinessSnapshot = buildMarginLeverageReadinessSnapshotForDecision({
                    symbol: preciseIntent.symbol,
                    requestedMarginType: preciseIntent.margin_type,
                    desiredLeverage: preciseIntent.leverage,
                    memoryState: readyState,
                    firestoreState,
                    readinessSourceUsed: 'firestore'
                });
                liveOrderDiagnostics.margin_leverage_setup_result = 'cache_ready';
                liveOrderDiagnostics.margin_setup_ready = true;
                liveOrderDiagnostics.leverage_setup_ready = true;
                liveOrderDiagnostics.margin_leverage_ready = true;
                liveOrderDiagnostics.readiness_source_used = 'firestore';
                liveOrderDiagnostics.margin_leverage_readiness_snapshot = readinessSnapshot;
                liveOrderDiagnostics.repeated_margin_setup = Boolean(readyState ?.margin_ready);
                liveOrderDiagnostics.repeated_leverage_setup = Boolean(readyState ?.leverage_ready);
                console.info('[MARGIN_LEVERAGE_READINESS_DECISION]', {
                    intent_id: intentRef ?.id || null,
                    symbol: preciseIntent.symbol,
                    normalized_symbol: readinessSnapshot.normalized_symbol,
                    requested_margin_type: readinessSnapshot.requested_margin_type,
                    requested_leverage: readinessSnapshot.requested_leverage,
                    requested_target_key: readinessSnapshot.requested_target_key,
                    cached_margin_type: readinessSnapshot.cached_margin_type,
                    cached_leverage: readinessSnapshot.cached_leverage,
                    cached_target_key: readinessSnapshot.cached_target_key,
                    target_match: readinessSnapshot.target_match,
                    mismatch_reason: readinessSnapshot.mismatch_reason,
                    source_used: readinessSnapshot.readiness_source_used,
                    memory_entry_found: readinessSnapshot.memory_entry_found,
                    firestore_entry_found: readinessSnapshot.firestore_entry_found,
                    ready: readinessSnapshot.ready,
                    margin_ready: readinessSnapshot.margin_ready,
                    leverage_ready: readinessSnapshot.leverage_ready,
                    expired: readinessSnapshot.expired,
                    decision_reason: readinessSnapshot.decision_reason
                });
            } else {
                const notReadyState = getMarginLeverageSetupState(preciseIntent.symbol);
                const readinessSnapshot = buildMarginLeverageReadinessSnapshotForDecision({
                    symbol: preciseIntent.symbol,
                    requestedMarginType: preciseIntent.margin_type,
                    desiredLeverage: preciseIntent.leverage,
                    memoryState: notReadyState,
                    firestoreState,
                    readinessSourceUsed: hydratedState ? 'firestore' : 'memory'
                });
                liveOrderDiagnostics.margin_leverage_setup_result = 'not_ready';
                liveOrderDiagnostics.margin_setup_ready = Boolean(notReadyState ?.margin_ready);
                liveOrderDiagnostics.leverage_setup_ready = Boolean(notReadyState ?.leverage_ready);
                liveOrderDiagnostics.margin_leverage_ready = false;
                liveOrderDiagnostics.margin_leverage_not_ready = true;
                liveOrderDiagnostics.readiness_source_used = hydratedState ? 'firestore' : 'memory';
                liveOrderDiagnostics.margin_leverage_readiness_snapshot = readinessSnapshot;
                liveOrderDiagnostics.margin_leverage_prefight_cache_after = notReadyState || null;
                liveOrderDiagnostics.failure_stage = 'margin_leverage_preflight';
                liveOrderDiagnostics.last_error_message =
                    String(notReadyState ?.last_error || '').trim() || 'margin_leverage_not_ready';
                console.info('[MARGIN_LEVERAGE_READINESS_DECISION]', {
                    intent_id: intentRef ?.id || null,
                    symbol: preciseIntent.symbol,
                    normalized_symbol: readinessSnapshot.normalized_symbol,
                    requested_margin_type: readinessSnapshot.requested_margin_type,
                    requested_leverage: readinessSnapshot.requested_leverage,
                    requested_target_key: readinessSnapshot.requested_target_key,
                    cached_margin_type: readinessSnapshot.cached_margin_type,
                    cached_leverage: readinessSnapshot.cached_leverage,
                    cached_target_key: readinessSnapshot.cached_target_key,
                    target_match: readinessSnapshot.target_match,
                    mismatch_reason: readinessSnapshot.mismatch_reason,
                    source_used: readinessSnapshot.readiness_source_used,
                    memory_entry_found: readinessSnapshot.memory_entry_found,
                    firestore_entry_found: readinessSnapshot.firestore_entry_found,
                    ready: readinessSnapshot.ready,
                    margin_ready: readinessSnapshot.margin_ready,
                    leverage_ready: readinessSnapshot.leverage_ready,
                    expired: readinessSnapshot.expired,
                    decision_reason: readinessSnapshot.decision_reason
                });

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
                    reason: 'margin_leverage_not_ready',
                    failure_stage: 'margin_leverage_preflight',
                    processing_stage: 'margin_leverage_preflight',
                    error_message: liveOrderDiagnostics.last_error_message,
                    trace_id: tracePayload.trace_id,
                    execution_trace: tracePayload.execution_trace,
                    execution_trace_metrics: tracePayload.execution_trace_metrics,
                    dominant_delay_stage: tracePayload.dominant_delay_stage,
                    critical_delay: tracePayload.critical_delay,
                    live_order_diagnostics: {
                        ...liveOrderDiagnostics,
                        completed_at: new Date().toISOString(),
                        result: 'failed',
                        symbol: preciseIntent.symbol
                    }
                });
                await syncPredictionTerminalState(db, {
                    predictionId,
                    sourceProfile,
                    status: 'failed',
                    reason: 'margin_leverage_not_ready',
                    dryRun: false,
                    tracePayload,
                    symbol: preciseIntent.symbol,
                    failureStage: 'margin_leverage_preflight',
                    errorMessage: liveOrderDiagnostics.last_error_message,
                    pendingStateResolution: 'binance_terminal_sync'
                });
                await markIntentFailed(intentRef, {
                    reason: 'margin_leverage_not_ready',
                    failure_stage: 'margin_leverage_preflight',
                    processing_stage: 'margin_leverage_preflight',
                    error_message: liveOrderDiagnostics.last_error_message
                });
                try {
                    releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
                } catch (_) {
                    // noop
                }
                return {
                    executed: false,
                    reason: 'margin_leverage_not_ready',
                    dry_run: false,
                    failed: true
                };
            }
        }
        const quantityCalcStartedAtMs = Date.now();
        let submittedQuantity = toPlainFixed(preciseIntent.quantity, qtyPrecision);
        recordLiveOrderStage(liveOrderDiagnostics, {
            stage: 'quantity_calc',
            startedAtMs: quantityCalcStartedAtMs,
            result: 'success',
            extra: {
                quantity: submittedQuantity,
                quantity_precision: qtyPrecision
            }
        });
        const minNotionalStartedAtMs = Date.now();
        const minNotionalPrecheck = await buildMinNotionalPrecheck({
            db,
            symbol: preciseIntent.symbol,
            quantity: preciseIntent.quantity,
            rules,
            intent: preciseIntent,
            config: executionConfig,
            liveOrderDiagnostics
        });
        const minNotionalFloorPolicy = buildMinNotionalFloorPolicy({
            intent: preciseIntent,
            precheck: minNotionalPrecheck,
            config: executionConfig
        });
        liveOrderDiagnostics.min_notional_floor_policy = minNotionalFloorPolicy;
        recordLiveOrderStage(liveOrderDiagnostics, {
            stage: 'min_notional_check',
            startedAtMs: minNotionalStartedAtMs,
            result: minNotionalPrecheck.passed || minNotionalFloorPolicy.applied ?
                'success' :
                'failed',
            errorMessage: minNotionalPrecheck.passed || minNotionalFloorPolicy.applied ?
                null :
                'min_notional_risk_blocked',
            extra: {
                submitted_notional_usdt: minNotionalPrecheck.notional,
                min_notional_usdt: minNotionalPrecheck.min_notional_required,
                shortfall_pct: minNotionalPrecheck.shortfall_pct,
                floor_applied: Boolean(minNotionalFloorPolicy.applied),
                floor_blocked: Boolean(minNotionalFloorPolicy.blocked),
                adjusted_qty: minNotionalFloorPolicy.adjusted_qty,
                required_margin: minNotionalFloorPolicy.required_margin,
                risk_after: minNotionalFloorPolicy.risk_after,
                max_allowed_risk: minNotionalFloorPolicy.max_allowed_risk
            }
        });
        if (!minNotionalPrecheck.passed && minNotionalFloorPolicy.applied) {
            preciseIntent = applyIntentPrecision({
                    ...preciseIntent,
                    quantity: Number(minNotionalFloorPolicy.adjusted_qty || preciseIntent.quantity || 0),
                    notional_usdt: Number(minNotionalFloorPolicy.adjusted_notional || preciseIntent.notional_usdt || 0)
                },
                rules
            );
            liveOrderDiagnostics.min_notional_floor_applied = true;
            liveOrderDiagnostics.min_notional_floor_result = 'min_notional_floor_applied';
            submittedQuantity = toPlainFixed(preciseIntent.quantity, qtyPrecision);
            console.info('[MIN_NOTIONAL_FLOOR_APPLIED]', {
                symbol: preciseIntent.symbol,
                prediction_id: predictionId,
                original_qty: minNotionalFloorPolicy.original_qty,
                adjusted_qty: minNotionalFloorPolicy.adjusted_qty,
                required_margin: minNotionalFloorPolicy.required_margin,
                risk_before: minNotionalFloorPolicy.risk_before,
                risk_after: minNotionalFloorPolicy.risk_after,
                max_allowed_risk: minNotionalFloorPolicy.max_allowed_risk
            });
        }
        if (!minNotionalPrecheck.passed && !minNotionalFloorPolicy.applied) {
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
                reason: 'min_notional_risk_blocked',
                failure_stage: 'live_order',
                processing_stage: 'live_order',
                error_message: `min_notional_risk_blocked (${minNotionalPrecheck.notional} < ${minNotionalPrecheck.min_notional_required}; ${minNotionalFloorPolicy.decision_reason})`,
                trace_id: tracePayload.trace_id,
                execution_trace: tracePayload.execution_trace,
                execution_trace_metrics: tracePayload.execution_trace_metrics,
                dominant_delay_stage: tracePayload.dominant_delay_stage,
                critical_delay: tracePayload.critical_delay,
                live_order_diagnostics: {
                    ...liveOrderDiagnostics,
                    completed_at: new Date().toISOString(),
                    result: 'failed'
                }
            });
            await syncPredictionTerminalState(db, {
                predictionId,
                sourceProfile,
                status: 'failed',
                reason: 'min_notional_risk_blocked',
                dryRun: false,
                tracePayload,
                symbol: preciseIntent.symbol,
                failureStage: 'live_order',
                errorMessage: `min_notional_risk_blocked (${minNotionalPrecheck.notional} < ${minNotionalPrecheck.min_notional_required}; ${minNotionalFloorPolicy.decision_reason})`,
                pendingStateResolution: 'binance_terminal_sync'
            });
            await markIntentFailed(intentRef, {
                reason: 'min_notional_risk_blocked',
                failure_stage: 'live_order',
                processing_stage: 'live_order',
                error_message: `min_notional_risk_blocked (${minNotionalPrecheck.notional} < ${minNotionalPrecheck.min_notional_required}; ${minNotionalFloorPolicy.decision_reason})`
            });
            try {
                releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
            } catch (_) {
                // noop
            }
            return {
                executed: false,
                reason: 'min_notional_risk_blocked',
                dry_run: false,
                failed: true
            };
        }
        executionTrace = advanceExecutionTrace(executionTrace, {
            order_sent_at: Date.now()
        });
        logExecutionPipelineStage({
            predictionId,
            symbol: preciseIntent.symbol,
            stage: 'order_submit_start'
        });
        orderAttemptStartedAtMs = Date.now();
        const entryOrderDiagnostics = {
            intent_id: intentRef.id,
            symbol: preciseIntent.symbol,
            side: preciseIntent.side,
            order_type: preciseIntent.order_type,
            quantity: Number(preciseIntent.quantity || 0),
            notional: Number(preciseIntent.notional_usdt || 0) || (
                Number(preciseIntent.quantity || 0) * Number(preciseIntent.entry_price || 0)
            ),
            price_reference: Number(preciseIntent.entry_price || 0) || null,
            reduce_only: false,
            position_side: preciseIntent.position_side || null,
            margin_type: preciseIntent.margin_type || null,
            leverage: Number(preciseIntent.leverage || 0) || null,
            client_order_id: buildEntryOrderClientOrderId(intentRef.id),
            payload_summary: {
                symbol: preciseIntent.symbol,
                side: preciseIntent.side,
                type: preciseIntent.order_type,
                quantity: submittedQuantity,
                newOrderRespType: 'RESULT',
                reduceOnly: false,
                positionSide: preciseIntent.position_side || null,
                marginType: preciseIntent.margin_type || null,
                leverage: Number(preciseIntent.leverage || 0) || null
            },
            started_at: new Date(orderAttemptStartedAtMs).toISOString(),
            started_at_ms: orderAttemptStartedAtMs,
            duration_ms: 0,
            result: 'started',
            http_status: null,
            binance_code: null,
            binance_msg: null,
            error_message: null,
            timeout_stage: null,
            stages: []
        };
        liveOrderDiagnostics.entry_order_diagnostics = entryOrderDiagnostics;
        recordEntryOrderStage(entryOrderDiagnostics, {
            stage: 'build_order_payload',
            startedAtMs: orderAttemptStartedAtMs,
            result: 'success',
            clientOrderId: entryOrderDiagnostics.client_order_id
        });
        recordLiveOrderStage(liveOrderDiagnostics, {
            stage: 'order_submit',
            startedAtMs: orderAttemptStartedAtMs,
            result: 'started'
        });
        orderRes = await signedRequest('/fapi/v1/order', {
            symbol: preciseIntent.symbol,
            side: preciseIntent.side,
            type: preciseIntent.order_type,
            quantity: submittedQuantity,
            newOrderRespType: 'RESULT',
            newClientOrderId: entryOrderDiagnostics.client_order_id
        }, 'POST', {
            timeoutMs: BINANCE_LIVE_ORDER_TIMEOUT_MS,
            diagnostics: entryOrderDiagnostics
        });
        entryOrderDiagnostics.result = 'success';
        entryOrderDiagnostics.duration_ms = Math.max(0, Date.now() - orderAttemptStartedAtMs);
        entryOrderDiagnostics.client_order_id =
            orderRes ?.clientOrderId ||
            orderRes ?.clientOrderID ||
            entryOrderDiagnostics.client_order_id;
        entryOrderDiagnostics.binance_code = null;
        entryOrderDiagnostics.binance_msg = null;
        entryOrderDiagnostics.http_status = entryOrderDiagnostics.http_status || 200;
        recordLiveOrderStage(liveOrderDiagnostics, {
            stage: 'order_submit',
            startedAtMs: orderAttemptStartedAtMs,
            result: 'success',
            extra: {
                order_id: orderRes ?.orderId || orderRes ?.clientOrderId || null
            }
        });
        recordLiveOrderStage(liveOrderDiagnostics, {
            stage: 'order_response',
            startedAtMs: orderAttemptStartedAtMs,
            result: 'success',
            extra: {
                order_id: orderRes ?.orderId || orderRes ?.clientOrderId || null,
                status: orderRes ?.status || null
            }
        });
        recordEntryOrderStage(entryOrderDiagnostics, {
            stage: 'persist_order_result',
            startedAtMs: Date.now(),
            result: 'started'
        });
        console.log('[REAL_TRADE_EXECUTED]', {
            symbol: preciseIntent.symbol,
            side: preciseIntent.side,
            quantity: Number(preciseIntent.quantity || 0),
            entry_price: Number(preciseIntent.entry_price || 0),
            stop_loss: Number(preciseIntent.stop_loss || 0),
            take_profit: Number(preciseIntent.take_profit || 0),
            position_size_percent: Number(preciseIntent.position_size_percent || resolvePositionSizePercent(effectiveConfig)),
            max_concurrent_trades: Number(effectiveConfig.max_concurrent_trades || SAFE_MAX_CONCURRENT_TRADES),
            order_id: orderRes ?.orderId || orderRes ?.clientOrderId || null,
            source_profile: sourceProfile,
            executed_at: toIsoDate(resolveOrderExecutedAt(orderRes))
        });
        logExecutionPipelineStage({
            predictionId,
            symbol: preciseIntent.symbol,
            stage: 'order_submit_success',
            extra: {
                order_id: orderRes ?.orderId || null
            }
        });
        logLiveStageTiming({
            stage: 'order_attempt',
            startedAtMs: orderAttemptStartedAtMs,
            symbol: preciseIntent.symbol,
            predictionId,
            extra: {
                order_id: orderRes ?.orderId || null
            }
        });
        executionTrace = advanceExecutionTrace(executionTrace, {
            order_ack_at: Date.now()
        });

        const executedQuantity = resolveExecutedQuantity(orderRes, preciseIntent.quantity);
        const filledEntryPrice = resolveFilledEntryPrice(orderRes, preciseIntent.entry_price, executedQuantity);
        executedAt = resolveOrderExecutedAt(orderRes);
        liveIntent = applyIntentPrecision({
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
            }).catch((err) => ({ error: String(err ?.message || err) }));
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
                live_order_diagnostics: {
                    ...liveOrderDiagnostics,
                    completed_at: new Date().toISOString(),
                    result: 'blocked_after_fill'
                },
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
                orderId: orderRes ?.orderId || null,
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

        initialExecutionAudit = buildExecutionAudit(signalDataForExecution, executedAt);
        initialEntrySnapshot = buildEntrySnapshotPersistence(
            executionGuardResult,
            liveIntent.entry_price,
            preciseIntent.entry_price
        );
        const initialPositionMaxHoldSeconds = resolvePositionMaxHoldSeconds({
            signalData: {
                ...signalData,
                entry_price: liveIntent.entry_price,
                trade_plan: {
                    ...(signalData ?.trade_plan || {}),
                    entry_price: liveIntent.entry_price,
                    take_profit: liveIntent.take_profit,
                    stop_loss: liveIntent.stop_loss
                },
                source_profile: sourceProfile,
                source: options.source || sourceProfile
            },
            adaptiveProfile: null
        });
        const initialProtectivePersistence = resolvePendingProtectivePersistence(liveIntent.enable_tp_sl);
        const openedAtIso = executedAt.toISOString();
        openPositionRef = await db.collection('binance_open_positions').add(
            buildOpenPositionPayload({
                source: options.source || sourceProfile,
                sourceProfile,
                signalDataForExecution,
                predictionId,
                liveIntent,
                preciseIntent,
                orderRes,
                persistence: initialProtectivePersistence,
                exitsRes: null,
                effectiveConfig,
                expectedDurationWindow: initialExpectedDurationWindow,
                positionMaxHoldSeconds: initialPositionMaxHoldSeconds,
                executionAudit: initialExecutionAudit,
                tracePayload: null,
                executionTrace,
                executionGuardResult,
                executedEntrySnapshot: initialEntrySnapshot,
                adaptiveExecutionProfile: null,
                openedAtIso,
                executedAt,
                includeTimestamps: true
            })
        );
        logExecutionPipelineStage({
            predictionId,
            symbol: liveIntent.symbol,
            stage: 'execution_open_position',
            extra: {
                order_id: orderRes ?.orderId || null,
                open_position_id: openPositionRef.id
            }
        });
        logSymbolFlow({
            symbol: liveIntent.symbol,
            source: options.source || sourceProfile,
            stage: 'execution_open_position',
            predictionId,
            traceId: executionTrace.trace_id
        });
        await writeIntentDoc(intentRef, {
            status: 'executed',
            processing_stage: 'order_placed',
            linked_position_id: openPositionRef.id,
            order_id: orderRes ?.orderId || null,
            intent: liveIntent,
            live_order_diagnostics: {
                ...liveOrderDiagnostics,
                completed_at: new Date().toISOString(),
                result: 'executed'
            },
            execution_guard: executionGuardResult,
            entry_execution_snapshot: initialEntrySnapshot,
            execution_audit: initialExecutionAudit,
            protective_order_status: initialProtectivePersistence.protectiveOrderStatus,
            protective_stop_available: initialProtectivePersistence.protectiveStopAvailable,
            exchange_response: {
                margin: marginRes,
                leverage: leverageRes,
                order: orderRes
            }
        });
        try {
            releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
        } catch (_) {
            // noop
        }
    } catch (err) {
        logExecutionPipelineStage({
            predictionId,
            symbol: preciseIntent.symbol,
            stage: 'order_submit_fail',
            extra: {
                failure_stage: err ?.failureStage || 'live_order',
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            }
        });
        if (isTimeoutLikeError(err)) {
            logExecutionTimeoutPath({
                predictionId,
                symbol: preciseIntent.symbol,
                stage: orderRes ? 'execution_open_position' : 'order_submit_start',
                timeoutMs: Number(err ?.timeoutMs || BINANCE_LIVE_ORDER_TIMEOUT_MS),
                reason: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        }
        if (
            ['entry_order', 'send_order_request', 'wait_binance_response', 'parse_order_response']
            .some((stage) => String(err ?.failureStage || '').includes(stage))
        ) {
            if (liveOrderDiagnostics.entry_order_diagnostics) {
                liveOrderDiagnostics.entry_order_diagnostics.result = 'failed';
                liveOrderDiagnostics.entry_order_diagnostics.duration_ms = Math.max(
                    0,
                    Date.now() - Number(liveOrderDiagnostics.entry_order_diagnostics.started_at_ms || orderAttemptStartedAtMs || Date.now())
                );
                liveOrderDiagnostics.entry_order_diagnostics.timeout_stage =
                    liveOrderDiagnostics.entry_order_diagnostics.timeout_stage ||
                    String(err ?.failureStage || 'wait_binance_response');
                liveOrderDiagnostics.entry_order_diagnostics.error_message =
                    sanitizeBinanceErrorMessage(err ?.message || err);
            }
            recordLiveOrderStage(liveOrderDiagnostics, {
                stage: 'order_submit',
                startedAtMs: orderAttemptStartedAtMs || Date.now(),
                result: 'failed',
                errorMessage: err ?.message || err
            });
            recordLiveOrderStage(liveOrderDiagnostics, {
                stage: 'order_response',
                startedAtMs: orderAttemptStartedAtMs || Date.now(),
                result: 'failed',
                errorMessage: err ?.message || err
            });
            if (liveOrderDiagnostics.entry_order_diagnostics) {
                recordEntryOrderStage(liveOrderDiagnostics.entry_order_diagnostics, {
                    stage: 'persist_order_result',
                    startedAtMs: Date.now(),
                    result: 'started'
                });
            }
            liveOrderDiagnostics.completed_at = new Date().toISOString();
            liveOrderDiagnostics.result = 'order_status_unknown';
            liveOrderDiagnostics.failure_stage = err ?.failureStage || 'entry_order';
            liveOrderDiagnostics.last_error_message = sanitizeBinanceErrorMessage(err ?.message || err);
            const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
                trace: executionTrace,
                symbol: preciseIntent.symbol,
                signal_type: sourceProfile,
                state: 'pending_reconciliation',
                late_entry_blocked: false
            });
            const reconciliationRequestedAtMs = Date.now();
            const reconciliationPayload = {
                requested_at: new Date(reconciliationRequestedAtMs).toISOString(),
                requested_at_ms: reconciliationRequestedAtMs,
                result: 'pending_reconciliation',
                client_order_id: liveOrderDiagnostics.entry_order_diagnostics ?.client_order_id || null,
                timeout_stage: String(err ?.failureStage || 'wait_binance_response'),
                error_message: sanitizeBinanceErrorMessage(err ?.message || err)
            };
            await writeIntentDoc(intentRef, {
                ...baseLog,
                status: 'order_status_unknown',
                reason: 'entry_order_response_timeout',
                processing_stage: 'entry_order_reconciliation_pending',
                needs_reconciliation: true,
                failure_stage: 'entry_order',
                error_message: String(err ?.message || err),
                trace_id: tracePayload.trace_id,
                execution_trace: tracePayload.execution_trace,
                execution_trace_metrics: tracePayload.execution_trace_metrics,
                dominant_delay_stage: tracePayload.dominant_delay_stage,
                critical_delay: tracePayload.critical_delay,
                live_order_diagnostics: liveOrderDiagnostics,
                entry_order_reconciliation: reconciliationPayload,
                exchange_response: {
                    margin: marginRes,
                    leverage: leverageRes,
                    order: orderRes
                }
            });
            await syncPredictionTerminalState(db, {
                predictionId,
                sourceProfile,
                status: 'failed',
                reason: 'entry_order_response_timeout',
                dryRun: false,
                tracePayload,
                symbol: preciseIntent.symbol,
                failureStage: 'entry_order_reconciliation_pending',
                errorMessage: String(err ?.message || err),
                pendingStateResolution: 'entry_order_reconciliation'
            });
            launchDetached(async() => {
                await reconcileTimedOutEntryOrders(db, {
                    intentIds: [intentRef.id],
                    contextMap: {
                        [intentRef.id]: {
                            sourceProfile,
                            source: options.source || sourceProfile,
                            predictionId,
                            observationSymbol,
                            effectiveConfig,
                            rules,
                            signalDataForExecution,
                            signalData,
                            marginRes,
                            leverageRes,
                            executionGuardResult,
                            executionTrace
                        }
                    }
                });
            }, '[ENTRY_ORDER_RECONCILIATION_WORKER] failed');
            try {
                releaseSymbolObservation(observationSymbol, 'processing_intent', { key: `intent:${intentRef.id}` });
            } catch (_) {
                // noop
            }
            return {
                executed: false,
                reason: 'entry_order_response_timeout',
                dry_run: false,
                pending_reconciliation: true
            };
        }
        if (String(err ?.failureStage || err ?.message || '').includes('margin_leverage_setup')) {
            liveOrderDiagnostics.margin_leverage_setup_result = isTimeoutLikeError(err) ? 'timeout' : 'failed';
            liveOrderDiagnostics.margin_leverage_setup_duration_ms = Number.isFinite(marginSetupStartedAtMs) ?
                Math.max(0, Date.now() - marginSetupStartedAtMs) :
                liveOrderDiagnostics.margin_leverage_setup_duration_ms || null;
            console.warn('[MARGIN_SETUP_TIMEOUT]', {
                symbol: preciseIntent.symbol,
                prediction_id: predictionId,
                message: sanitizeBinanceErrorMessage(err ?.message || err)
            });
        }
        liveOrderDiagnostics.completed_at = new Date().toISOString();
        liveOrderDiagnostics.result = 'failed';
        liveOrderDiagnostics.failure_stage = err ?.failureStage || 'live_order';
        liveOrderDiagnostics.last_error_message = sanitizeBinanceErrorMessage(err ?.message || err);
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
            error_message: String(err ?.message || err),
            trace_id: tracePayload.trace_id,
            execution_trace: tracePayload.execution_trace,
            execution_trace_metrics: tracePayload.execution_trace_metrics,
            dominant_delay_stage: tracePayload.dominant_delay_stage,
            critical_delay: tracePayload.critical_delay,
            live_order_diagnostics: liveOrderDiagnostics,
            exchange_response: {
                margin: marginRes,
                leverage: leverageRes,
                order: orderRes
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
            errorMessage: String(err ?.message || err),
            pendingStateResolution: 'binance_terminal_sync'
        });
        await markIntentFailed(intentRef, {
            reason: resolveFailureReason(err, 'live_order_failed'),
            failure_stage: 'live_order',
            processing_stage: 'live_order',
            error_message: String(err ?.message || err)
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

    launchDetached(async() => {
        await finalizeLiveExecutionPostOrder({
            db,
            config,
            intentRef,
            openPositionRef,
            signalDataForExecution,
            signalData,
            sourceProfile,
            predictionId,
            source: options.source || sourceProfile,
            observationSymbol,
            effectiveConfig,
            rules,
            preciseIntent,
            liveIntent,
            marginRes,
            leverageRes,
            orderRes,
            liveOrderDiagnostics,
            executionGuardResult,
            executionTrace,
            entryDiscipline
        });
    }, '[POST_ORDER_FINALIZE] failed');

    return {
        executed: true,
        dry_run: false,
        symbol: liveIntent.symbol,
        side: liveIntent.side,
        quantity: liveIntent.quantity,
        order_id: orderRes ?.orderId || null,
        open_position_id: openPositionRef ?.id || null,
        exits: null,
        protective_order_status: liveIntent.enable_tp_sl === false ? 'tp_sl_disabled' : 'pending_submission'
    };
}

async function executeHighConvictionTrade(db, signalData) {
    return executeSignalTrade(db, signalData, { source: 'high_conviction', source_profile: 'high_conviction' });
}

module.exports = {
    executeSignalTrade,
    executeHighConvictionTrade,
    reconcileTimedOutEntryOrders,
    createExecutionIntent,
    validateExecutionIntent,
    toBinanceSymbol,
    getMarkPrice,
    getPositionRisk,
    getFuturesWalletBalance,
    getFuturesIncomeHistory,
    closePositionMarket,
    warmExchangeInfoCache,
    warmMarginLeverageCache,
    getMarginLeverageReadinessSnapshot,
    hydrateMarginLeverageReadinessFromFirestore,
    testBinancePrivateConnectivity,
    getBinanceConnectionDebugState,
    getExchangeInfoCacheStatus
};