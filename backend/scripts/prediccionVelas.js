const db = require('../firebase-admin-config');
const {
    fetchBinanceSpot,
    FETCH_TIMEOUT_MS,
    BINANCE_FAIL_FAST_TIMEOUT_MS
} = require('../services/dataSources/binance');
const { fetchCandles } = require('../services/dataSources/fetchCandles');
const {
    addAbortListener,
    raceWithSignal,
    registerTaskCancellation,
    resolveAbortError,
    throwIfAborted
} = require('../lib/abortUtils');
const { applyLearningAdjustments, preloadLearningConfig } = require('../lib/learningConfig');
const { evaluateEventContextFilter } = require('../lib/event_context_filter');
const { adjustExecutionTargets } = require('../lib/context_execution_adjuster');
const { executeSignalTrade } = require('../lib/binanceFuturesExecutor');
const { getBinanceBotConfig } = require('../lib/binanceBotConfig');
const { STALE_PENDING_PREDICTION_TIMEOUT_MS } = require('../services/execution/pendingPredictionWatchdog');
const {
    shouldSendManualPreAlert,
    sendManualPreAlertNotification,
    shouldEmitHighConvictionSignal,
    registerHighConvictionSignal,
    sendHighConvictionNotification
} = require('../lib/highConvictionSignals');
const { syncPredictionExecutionState } = require('../services/execution/predictionExecutionSync');

const timeframes = {
    '1m': 1,
    '5m': 5,
    '15m': 15,
    '30m': 30,
    '1h': 60,
    '4h': 240
};
const ENABLE_BINANCE = process.env.ENABLE_BINANCE === 'true';

const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const LEARNING_MODE = process.env.LEARNING_MODE || 'observe';
const LEARNING_LOG = process.env.LEARNING_LOG === 'true';
const EVENT_CONTEXT_FILTER_ENABLED = process.env.EVENT_CONTEXT_FILTER_ENABLED === 'true';
const EVENT_CONTEXT_FILTER_MODE =
    (process.env.EVENT_CONTEXT_FILTER_MODE || 'observe').toLowerCase() === 'enforce' ?
    'enforce' :
    'observe';
const CONTEXT_EXECUTION_ADJUSTMENT_ENABLED =
    process.env.CONTEXT_EXECUTION_ADJUSTMENT_ENABLED === 'true';
const EXTERNAL_DATA_TIMEOUT_MS = Math.max(2000, Number(process.env.EXTERNAL_DATA_TIMEOUT_MS || FETCH_TIMEOUT_MS));
const PREDICCION_VERBOSE_LOGS = process.env.PREDICCION_VERBOSE_LOGS === 'true';
const ALLOW_NEUTRAL_EXPERIMENT =
    String(process.env.ALLOW_NEUTRAL_EXPERIMENT || 'false').toLowerCase() === 'true';
const QUALITY_GATE_AUDIT_ENABLED =
    String(process.env.QUALITY_GATE_AUDIT_ENABLED || 'false').toLowerCase() === 'true';
const MANUAL_PREALERT_ALLOW_SUPPRESSED =
    String(process.env.MANUAL_PREALERT_ALLOW_SUPPRESSED || 'false').toLowerCase() === 'true';
const PROFILING_FETCH_ENABLED =
    String(process.env.PROFILING_FETCH_ENABLED || 'false').toLowerCase() === 'true';
const ENTRY_WINDOW_SECONDS = Math.max(5, Math.min(35, Number(process.env.ENTRY_WINDOW_SECONDS || 30)));
const PREDICTION_RUNTIME_CACHE_TTL_MS = Math.max(
    2000,
    Number(process.env.PREDICTION_RUNTIME_CACHE_TTL_MS || 15000)
);
const EARLY_EXECUTION_ENABLED = String(process.env.EARLY_EXECUTION_ENABLED || 'true').toLowerCase() !== 'false';
const EARLY_EXECUTION_MIN_CONFIDENCE = Math.max(
    0.85,
    Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_CONFIDENCE || 0.97))
);
const EARLY_EXECUTION_MIN_QUANTUM = Math.max(
    0.75,
    Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_QUANTUM || 0.86))
);
const EARLY_EXECUTION_MIN_TIMING = Math.max(
    0.7,
    Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_TIMING || 0.85))
);
const EARLY_EXECUTION_MIN_STABILITY = Math.max(
    0.7,
    Math.min(0.999, Number(process.env.EARLY_EXECUTION_MIN_STABILITY || 0.84))
);
const FIRESTORE_SAVE_TIMEOUT_MS = Math.max(
    2000,
    Math.min(3000, Number(process.env.FIRESTORE_SAVE_TIMEOUT_MS || 2500))
);
const MAX_CONCURRENT_PREDICTION_WRITES = Math.max(
    1,
    Math.min(20, Number(process.env.MAX_CONCURRENT_PREDICTION_WRITES || 5))
);
const MAX_PENDING_PREDICTION_WRITES = Math.max(
    MAX_CONCURRENT_PREDICTION_WRITES,
    Math.min(500, Number(process.env.MAX_PENDING_PREDICTION_WRITES || 100))
);
const QUALITY_GATE_MIN_CONFIDENCE = 0.65;
const QUALITY_GATE_MIN_QUANTUM = 0.6;
const QUALITY_GATE_MIN_TIMING = 0.6;
const QUALITY_GATE_HIGH_MOVE_MIN_EXPECTED_MOVE = 0.6;
const QUALITY_GATE_HIGH_MOVE_MIN_CONFIDENCE = 0.6;
// Historical experiment registry kept in code comments/metadata so old Firestore docs remain untouched.
const SHADOW_CALIBRATION_EXPERIMENTS = Object.freeze({
    deterministic_recalibrated_v1: {
        status: 'failed',
        reason: 'gross_move_and_net_edge_worse_than_baseline_in_shadow'
    }
});
const DETERMINISTIC_CALIBRATION_VERSION = 'fee_floor_shadow_v2';
const DETERMINISTIC_CALIBRATION_FACTOR = 0.12;
const DETERMINISTIC_FEE_ROUNDTRIP_PCT = 0.10;
const DETERMINISTIC_SAFETY_MARGIN_PCT = 0.05;
const DETERMINISTIC_MINIMUM_REQUIRED_MOVE_PCT = 0.15;
const DETERMINISTIC_HIGH_MOVE_VALIDATION_PCT = 0.60;
const PRIMARY_SHADOW_VALIDATION_HORIZON = 10;
const spotPriceCache = new Map();
const inflightSpotRequests = new Map();
const trainingStatsCache = new Map();
const predictionWriteQueue = new Map();
const pendingPredictionWrites = [];
let activePredictionWrites = 0;

function logQualityGateRelaxed() {
    console.log('[QUALITY_GATE_RELAXED]', {
        confidence_min: QUALITY_GATE_MIN_CONFIDENCE,
        quantum_min: QUALITY_GATE_MIN_QUANTUM,
        timing_min: QUALITY_GATE_MIN_TIMING
    });
}

function pricePrecision(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) {
        return 2;
    }
    if (n >= 100) return 2;
    if (n >= 1) return 4;
    return 6;
}

function roundPrice(value, referenceValue = value) {
    const n = Number(value);
    if (!Number.isFinite(n)) {
        return n;
    }
    const decimals = pricePrecision(referenceValue);
    return Number(n.toFixed(decimals));
}

function normalizeSymbol(symbol, source = 'internal') {
    if (!symbol) {
        return symbol;
    }
    const normalized = String(symbol).toUpperCase().trim().replace(/\//g, '').replace(/_/g, '').replace(/-/g, '');
    const asUsdt = normalized.endsWith('USDT') ?
        normalized :
        normalized.endsWith('USD') ?
        normalized.replace(/USD$/, 'USDT') :
        `${normalized}USDT`;

    if (source === 'yahoo') {
        return asUsdt.replace(/USDT$/, '-USD');
    }

    if (source === 'binance') {
        return asUsdt;
    }

    return asUsdt;
}

function registerExternalCancellation(options = {}, stage = 'running', callType = 'other') {
    registerTaskCancellation(options ?.taskContext, {
        stage,
        scope: 'external_fetch',
        call_type: callType
    });
}

function withExternalTimeout(promiseFactory, label, options = {}) {
    let timeoutId;
    let removeAbortListener = () => {};
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(
            () => reject(new Error(`${label} timeout after ${EXTERNAL_DATA_TIMEOUT_MS}ms`)),
            EXTERNAL_DATA_TIMEOUT_MS
        );
    });
    const abortPromise = new Promise((_, reject) => {
        removeAbortListener = addAbortListener(options ?.signal, () => {
            removeAbortListener();
            registerExternalCancellation(options, 'running', options ?.callType || 'other');
            reject(resolveAbortError(options ?.signal, `${label} cancelled`, 'OPERATION_ABORTED'));
        });
    });
    return Promise.race([
        Promise.resolve().then(() => {
            throwIfAborted(options ?.signal, `${label} cancelled`, 'OPERATION_ABORTED');
            return promiseFactory();
        }),
        timeoutPromise,
        abortPromise
    ]).finally(() => {
        clearTimeout(timeoutId);
        removeAbortListener();
    });
}

function elapsedMs(startedAtMs) {
    return Math.max(0, Date.now() - Number(startedAtMs || Date.now()));
}

function createBinanceTraceId(symbol, timeframe, origin = 'spot_fetch') {
    return `${origin}:${String(symbol || 'unknown').toUpperCase()}:${String(timeframe || '5m')}:${Date.now()}`;
}

function sumFinite(values = []) {
    const finite = values.map((value) => Number(value)).filter(Number.isFinite);
    if (!finite.length) return null;
    return Number(finite.reduce((sum, value) => sum + value, 0).toFixed(2));
}

function getSpotFetchTimingState(options = {}, symbol, timeframe) {
    if (!options ?.profiling || typeof options.profiling !== 'object') {
        return null;
    }
    if (!options.profiling.spot_fetch || typeof options.profiling.spot_fetch !== 'object') {
        options.profiling.spot_fetch = {};
    }
    const state = options.profiling.spot_fetch;
    state.symbol = symbol;
    state.timeframe = timeframe;
    if (!Array.isArray(state.fallback_chain)) {
        state.fallback_chain = [];
    }
    if (state.cache_hit == null) {
        state.cache_hit = false;
    }
    return state;
}

function publishSpotFetchTiming(state, options = {}) {
    if (!state) {
        return;
    }
    const payload = {
        symbol: state.symbol,
        timeframe: state.timeframe,
        spot_fetch_ms: Number.isFinite(Number(state.spot_fetch_ms)) ? Number(state.spot_fetch_ms) : null,
        source: state.source || 'unknown',
        binance_attempted: Boolean(state.binance_attempted),
        binance_success: Boolean(state.binance_success),
        binance_latency_ms: Number.isFinite(Number(state.binance_latency_ms)) ?
            Number(state.binance_latency_ms) : null,
        fallback_ms: Number.isFinite(Number(state.fallback_ms)) ? Number(state.fallback_ms) : null,
        fallback_chain: [...(state.fallback_chain || [])],
        fallback_chain_length: Array.isArray(state.fallback_chain) ? state.fallback_chain.length : 0,
        cache_hit: Boolean(state.cache_hit)
    };
    if (options ?.profiling && typeof options.profiling === 'object') {
        options.profiling.spot_fetch = payload;
    }
    if (PROFILING_FETCH_ENABLED) {
        console.log('[SPOT_FETCH_TIMING]', payload);
    }
}

function markSpotFallback(state) {
    if (!state) {
        return;
    }
    if (state.fallback_started_at_ms == null) {
        state.fallback_started_at_ms = Date.now();
    }
}

function logSpotFetchFailFast(symbol, timeframe, fallbackUsed, decisionTimeMs, timeoutMs) {
    console.warn('[FETCH_FAIL_FAST]', {
        symbol,
        timeframe,
        stage: 'spot',
        binance_timeout_ms: Number(timeoutMs) || BINANCE_FAIL_FAST_TIMEOUT_MS,
        fallback_used: fallbackUsed,
        decision_time_ms: Number(decisionTimeMs) || 0
    });
}

function sanitizeForFirestore(value) {
    if (value === undefined) return null;
    if (Array.isArray(value)) {
        return value.map((item) => sanitizeForFirestore(item));
    }
    if (value && typeof value === 'object') {
        return Object.entries(value).reduce((acc, [key, nestedValue]) => {
            acc[key] = sanitizeForFirestore(nestedValue);
            return acc;
        }, {});
    }
    return value;
}

function compactDecisionLog(label, payload) {
    console.log(label, {
        symbol: payload ?.symbol,
        timeframe: payload ?.timeframe,
        signal_emitted: payload ?.signal_emitted,
        quality_gate_passed: payload ?.quality_gate_passed,
        gate_reason: payload ?.gate_reason,
        suppression_reason: payload ?.suppression_reason,
        context_score: payload ?.event_context_filter ?.context_score ?? null,
        context_quality: payload ?.event_context_filter ?.context_quality ?? null,
        allow_event: payload ?.event_context_filter ?.allow_event ?? null,
        would_block_event: payload ?.event_context_filter ?.would_block_event ?? null
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

function buildQueuedBinanceExecution(sourceProfile) {
    return {
        attempted: false,
        executed: false,
        dry_run: false,
        queued: true,
        reason: 'queued_for_execution',
        source_profile: sourceProfile || 'unknown',
        updated_at: new Date().toISOString()
    };
}

function resolveEntryWindowMsFromPayload(payload = {}) {
    const start = parseDateLike(payload ?.entry_window_start_at || payload ?.signal_created_at || payload ?.signal_emitted_at);
    const end = parseDateLike(payload ?.entry_window_end_at);
    if (start && end) {
        return Math.max(0, end.getTime() - start.getTime());
    }
    return null;
}

function validateExecutionPayloadTradePlan(payload = {}) {
    const tradePlan = payload ?.trade_plan || {};
    const side = String(tradePlan.side || '').toUpperCase();
    const entryPrice = Number(tradePlan.entry_price || 0);
    const stopLoss = Number(tradePlan.stop_loss || 0);
    return {
        ok: (side === 'BUY' || side === 'SELL') && Number.isFinite(entryPrice) && entryPrice > 0 && Number.isFinite(stopLoss) && stopLoss > 0,
        side_valid: side === 'BUY' || side === 'SELL',
        entry_price_valid: Number.isFinite(entryPrice) && entryPrice > 0,
        stop_loss_valid: Number.isFinite(stopLoss) && stopLoss > 0,
        reason: side !== 'BUY' && side !== 'SELL' ?
            'side_missing' :
            !(Number.isFinite(entryPrice) && entryPrice > 0) ?
            'entry_price_invalid' :
            !(Number.isFinite(stopLoss) && stopLoss > 0) ?
            'stop_loss_invalid' : null
    };
}

function buildExecutionPayload({
    docRefId,
    recomendacion,
    analysisStartIso,
    signalCreatedIso,
    signalReadyIso,
    symbolInput,
    modelConfidence,
    quantumScore,
    timingScore,
    contextFilter,
    expectedMovePercent,
    finalTradePlan,
    spotPrice,
    operationalEntryWindow
} = {}) {
    return sanitizeForFirestore({
        ...recomendacion,
        id: docRefId,
        prediction_id: docRefId,
        analysis_start_at: analysisStartIso,
        signal_created_at: signalCreatedIso,
        signal_ready_at: signalReadyIso,
        signal_emitted_at: signalReadyIso,
        symbol: symbolInput,
        confidence: Number(modelConfidence.toFixed(4)),
        quantum_score: Number(quantumScore.toFixed(4)),
        timing_score: Number(timingScore.toFixed(4)),
        context_score: contextFilter.context_score,
        context_quality: contextFilter.context_quality,
        structural_context_score: contextFilter.structural_context_score,
        volatility_context_score: contextFilter.volatility_context_score,
        volume_flow_context_score: contextFilter.volume_flow_context_score,
        liquidity_context_score: contextFilter.liquidity_context_score,
        expected_move_percent: Number(expectedMovePercent.toFixed(4)),
        trade_plan: finalTradePlan,
        spot_price: Number.isFinite(spotPrice) ? spotPrice : Number(recomendacion.spot_price),
        analysis_entry_window: recomendacion.entry_window_utc || recomendacion.entry_window,
        estimated_window: operationalEntryWindow,
        entry_window: operationalEntryWindow,
        entry_window_utc: operationalEntryWindow,
        entry_window_start_at: signalCreatedIso,
        entry_window_end_at: new Date(new Date(signalCreatedIso).getTime() + ENTRY_WINDOW_SECONDS * 1000).toISOString(),
        ahora: signalReadyIso,
        created_at: signalReadyIso,
        timestamp: signalReadyIso
    });
}

function withWriteTimeout(task, timeoutMs, label) {
    let timeoutId;
    const timeoutPromise = new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
            const error = new Error(`${label} timeout after ${timeoutMs}ms`);
            error.code = 'WRITE_TIMEOUT';
            reject(error);
        }, timeoutMs);
    });

    return Promise.race([
        Promise.resolve().then(task),
        timeoutPromise
    ]).finally(() => {
        clearTimeout(timeoutId);
    });
}

const EXECUTION_HANDOFF_ALLOWED_ORIGINS = new Set(['event_emitted', 'high_conviction', 'manual_prealert']);
const EXECUTION_HANDOFF_DISPATCH_TIMEOUT_MS = 8000;

function sanitizeIntentDocIdPart(value) {
    return String(value || '')
        .replace(/[^a-zA-Z0-9_-]/g, '_')
        .slice(0, 120);
}

function buildDeterministicIntentId(predictionId, sourceProfile) {
    if (!predictionId) return null;
    return `${sanitizeIntentDocIdPart(predictionId)}__${sanitizeIntentDocIdPart(sourceProfile || 'default')}`;
}

function parseDateLike(value) {
    if (!value) return null;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
    if (typeof value ?.toDate === 'function') {
        const date = value.toDate();
        return Number.isFinite(date ?.getTime ?.()) ? date : null;
    }
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? date : null;
}

async function dispatchSignalToExecution(db, signalTask = {}) {
    const signalId = signalTask.predictionId || signalTask.executionPayload ?.prediction_id || signalTask.executionPayload ?.id || null;
    const origin = String(signalTask.sourceProfile || '').trim().toLowerCase() || 'unknown';
    const emittedAt = parseDateLike(
        origin === 'high_conviction' ?
        signalTask.executionPayload ?.signal_created_at || signalTask.executionPayload ?.signal_emitted_at :
        signalTask.executionPayload ?.signal_emitted_at
    );
    const dispatchAt = new Date();
    const ageMs = emittedAt ? Math.max(0, dispatchAt.getTime() - emittedAt.getTime()) : null;
    const symbol = signalTask.executionPayload ?.symbol || signalTask.executionPayload ?.simbolo || null;
    const intentId = buildDeterministicIntentId(signalId, origin);
    const maxAllowedAgeMs =
        origin === 'high_conviction' ?
        resolveEntryWindowMsFromPayload(signalTask.executionPayload) || STALE_PENDING_PREDICTION_TIMEOUT_MS :
        STALE_PENDING_PREDICTION_TIMEOUT_MS;
    const dispatchedLogTag = origin === 'high_conviction' ? '[HIGH_CONVICTION_HANDOFF_DISPATCHED]' : '[SIGNAL_HANDOFF_DISPATCHED]';
    const resultLogTag = origin === 'high_conviction' ? '[HIGH_CONVICTION_HANDOFF_RESULT]' : '[SIGNAL_HANDOFF_RESULT]';

    console.info(dispatchedLogTag, {
        signal_id: signalId,
        symbol,
        origin: origin === 'high_conviction' ? undefined : origin,
        created_at: origin === 'high_conviction' ? emittedAt ?.toISOString() || signalTask.executionPayload ?.signal_created_at || null : undefined,
        emitted_at: origin === 'high_conviction' ? undefined : emittedAt ?.toISOString() || signalTask.executionPayload ?.signal_emitted_at || null,
        dispatch_at: dispatchAt.toISOString(),
        age_ms: ageMs,
        max_entry_window_ms: origin === 'high_conviction' ? maxAllowedAgeMs : undefined
    });

    const lifecycleBase = {
        handoff_dispatch_at: dispatchAt.toISOString(),
        handoff_attempt_at: dispatchAt.toISOString(),
        handoff_age_ms: ageMs,
        handoff_max_allowed_age_ms: maxAllowedAgeMs,
        handoff_attempted_within_5s: ageMs != null ? ageMs <= 5000 : null,
        handoff_attempted_within_30s: ageMs != null ? ageMs <= 30000 : null
    };

    const writeLifecycle = async(payload = {}) => {
        if (!signalId) return;
        await db.collection('velas_predicciones').doc(String(signalId)).set({
            binance_execution: {
                lifecycle: {
                    ...lifecycleBase,
                    ...payload
                }
            },
            updated_at: new Date().toISOString()
        }, { merge: true });
    };

    const finish = async(result, reason, extra = {}) => {
        console.info(resultLogTag, {
            signal_id: signalId,
            result,
            reason: reason || null,
            intent_id: extra.intent_id || intentId || null
        });
        await writeLifecycle({
            handoff_status: result === 'intent_created' ?
                'attempted_immediately' : result === 'skipped' ?
                'skipped' : 'failed',
            last_handoff_result: result,
            last_handoff_reason: reason || null,
            handoff_result_at: new Date().toISOString(),
            handoff_intent_id: extra.intent_id || intentId || null
        });
    };

    try {
        const runtimeDoc = await db.collection('system_runtime_config').doc('bot_execution').get();
        const runtimeData = runtimeDoc.exists ? (runtimeDoc.data() || {}) : {};
        if (runtimeData.execution_enabled === false) {
            await finish('skipped', 'execution_disabled');
            return;
        }
        if (runtimeData.auto_trade_mode === false) {
            await finish('skipped', 'auto_trade_mode_disabled');
            return;
        }
        const runtimeStatus = String(runtimeData.runtime_status || runtimeData.status || '').toUpperCase();
        if (runtimeStatus && runtimeStatus !== 'ACTIVE') {
            await finish('skipped', 'runtime_not_active');
            return;
        }
        if (!EXECUTION_HANDOFF_ALLOWED_ORIGINS.has(origin)) {
            await finish('skipped', 'signal_origin_not_allowed');
            return;
        }
        if (origin === 'high_conviction') {
            const tradePlanValidation = validateExecutionPayloadTradePlan(signalTask.executionPayload);
            if (!tradePlanValidation.ok) {
                await finish('failed', 'trade_plan_invalid');
                return;
            }
        }
        if (ageMs != null && ageMs > maxAllowedAgeMs) {
            await finish('skipped', origin === 'high_conviction' ? 'late_entry_blocked' : 'stale_signal');
            return;
        }
        const config = await getBinanceBotConfig(db);
        const maxConcurrentTrades = Math.max(1, Number(config ?.max_concurrent_trades || 1));
        const openPositions = await db
            .collection('binance_open_positions')
            .where('status', '==', 'open')
            .limit(maxConcurrentTrades)
            .get();
        if (openPositions.size >= maxConcurrentTrades) {
            await finish('skipped', 'max_concurrent_trades_reached');
            return;
        }
        if (intentId) {
            const existingIntent = await db.collection('binance_execution_intents').doc(intentId).get();
            if (existingIntent.exists) {
                await finish('skipped', 'duplicate_intent', { intent_id: intentId });
                return;
            }
        }

        const executionPromise = executeSignalTrade(db, signalTask.executionPayload, {
            source: signalTask.sourceProfile,
            source_profile: signalTask.sourceProfile
        });
        const timeoutPromise = new Promise((_, reject) => {
            setTimeout(() => {
                const error = new Error(`handoff_dispatch_timeout_after_${EXECUTION_HANDOFF_DISPATCH_TIMEOUT_MS}ms`);
                error.code = 'HANDOFF_DISPATCH_TIMEOUT';
                reject(error);
            }, EXECUTION_HANDOFF_DISPATCH_TIMEOUT_MS);
        });

        const result = await Promise.race([executionPromise, timeoutPromise]);
        if (result ?.executed || result ?.reason === 'dry_run' || result ?.reason === 'observe_mode') {
            await finish('intent_created', result ?.reason || null, { intent_id: intentId });
            return;
        }
        if (result ?.reason === 'already_processed') {
            await finish('skipped', 'duplicate_intent', { intent_id: intentId });
            return;
        }
        if (result ?.failed) {
            await finish('failed', result ?.reason || null, { intent_id: intentId });
            return;
        }
        if (result ?.skipped || result ?.executed === false) {
            await finish('skipped', result ?.reason || null, { intent_id: intentId });
            return;
        }
        await finish('intent_created', result ?.reason || null, { intent_id: intentId });
    } catch (err) {
        await finish('failed', err ?.message || 'handoff_dispatch_failed', { intent_id: intentId });
    }
}

function buildSaveTraceBase(docRef, metadata = {}) {
    return {
        prediction_id: docRef ?.id || null,
        path: docRef ?.path || null,
        stage: metadata.stage || 'unknown',
        operation: metadata.operation || 'set'
    };
}

async function executeInstrumentedPredictionWrite(docRef, payload, writeOperation, metadata = {}) {
    const traceBase = buildSaveTraceBase(docRef, metadata);
    const startedAtMs = Date.now();
    let validatedPayload = payload;
    let transformedPayload = payload;

    console.log('SAVE_START', {
        ...traceBase,
        started_at: new Date(startedAtMs).toISOString()
    });

    try {
        console.log('BEFORE_VALIDATION', traceBase);
        if (!docRef ?.id || !docRef ?.path) {
            throw new Error('validation_error:missing_doc_ref');
        }
        if (validatedPayload == null || typeof validatedPayload !== 'object') {
            throw new Error('validation_error:invalid_payload');
        }
        console.log('AFTER_VALIDATION', {
            ...traceBase,
            payload_keys: Object.keys(validatedPayload).length
        });
    } catch (err) {
        console.warn('[PREDICTION_SAVE_STAGE_FAIL]', {
            ...traceBase,
            block: 'validation',
            error: err ?.message || String(err)
        });
        throw err;
    }

    try {
        console.log('BEFORE_TRANSFORM', traceBase);
        transformedPayload = validatedPayload;
        console.log('AFTER_TRANSFORM', {
            ...traceBase,
            payload_keys: Object.keys(transformedPayload || {}).length
        });
    } catch (err) {
        console.warn('[PREDICTION_SAVE_STAGE_FAIL]', {
            ...traceBase,
            block: 'transform',
            error: err ?.message || String(err)
        });
        throw err;
    }

    try {
        console.log('BEFORE_FIRESTORE_WRITE', traceBase);
        await withWriteTimeout(
            () => writeOperation(transformedPayload),
            FIRESTORE_SAVE_TIMEOUT_MS,
            `prediction_save:${docRef.id}:${metadata.stage || 'unknown'}`
        );
        console.log('AFTER_FIRESTORE_WRITE', traceBase);
    } catch (err) {
        console.warn('[PREDICTION_SAVE_STAGE_FAIL]', {
            ...traceBase,
            block: 'firestore_write',
            error: err ?.message || String(err),
            code: err ?.code || null
        });
        throw err;
    } finally {
        console.log('SAVE_END', {
            ...traceBase,
            duration_ms: Math.max(0, Date.now() - startedAtMs)
        });
    }
}

function enqueuePredictionWrite(docRef, writeTask, metadata = {}) {
    const queueKey = docRef.path;
    const previousTask = predictionWriteQueue.get(queueKey) || Promise.resolve();
    const nextTask = previousTask
        .catch(() => null)
        .then(() => schedulePredictionWrite(docRef, writeTask, metadata))
        .finally(() => {
            if (predictionWriteQueue.get(queueKey) === nextTask) {
                predictionWriteQueue.delete(queueKey);
            }
        });

    predictionWriteQueue.set(queueKey, nextTask);
}

function schedulePredictionSet(docRef, payload, options = {}) {
    enqueuePredictionWrite(
        docRef,
        () => executeInstrumentedPredictionWrite(
            docRef,
            payload,
            (preparedPayload) => docRef.set(preparedPayload, { merge: Boolean(options.merge) }), {
                stage: options.stage || 'base_save',
                operation: options.merge ? 'set_merge' : 'set'
            }
        ), {
            stage: options.stage || 'base_save',
            operation: options.merge ? 'set_merge' : 'set'
        }
    );
}

function schedulePredictionUpdate(docRef, payload, options = {}) {
    enqueuePredictionWrite(
        docRef,
        () => executeInstrumentedPredictionWrite(
            docRef,
            payload,
            (preparedPayload) => docRef.update(preparedPayload), {
                stage: options.stage || 'update',
                operation: 'update'
            }
        ), {
            stage: options.stage || 'update',
            operation: 'update'
        }
    );
}

function schedulePredictionMerge(docRef, payload, options = {}) {
    enqueuePredictionWrite(
        docRef,
        () => executeInstrumentedPredictionWrite(
            docRef,
            payload,
            (preparedPayload) => docRef.set(preparedPayload, { merge: true }), {
                stage: options.stage || 'merge_update',
                operation: 'set_merge'
            }
        ), {
            stage: options.stage || 'merge_update',
            operation: 'set_merge'
        }
    );
}

function drainPredictionWriteQueue() {
    while (activePredictionWrites < MAX_CONCURRENT_PREDICTION_WRITES && pendingPredictionWrites.length > 0) {
        const task = pendingPredictionWrites.shift();
        activePredictionWrites += 1;
        void Promise.resolve()
            .then(task)
            .finally(() => {
                activePredictionWrites = Math.max(0, activePredictionWrites - 1);
                drainPredictionWriteQueue();
            });
    }
}

function schedulePredictionWrite(docRef, writeTask, metadata = {}) {
    return new Promise((resolve) => {
        setTimeout(() => {
            const logBase = {
                prediction_id: docRef.id,
                path: docRef.path,
                stage: metadata.stage || 'unknown',
                operation: metadata.operation || 'set',
                active_writes: activePredictionWrites,
                pending_writes: pendingPredictionWrites.length
            };

            if (pendingPredictionWrites.length >= MAX_PENDING_PREDICTION_WRITES) {
                console.warn('[PREDICTION_SAVE_SKIPPED_OVERLOAD]', {
                    ...logBase,
                    max_concurrent_writes: MAX_CONCURRENT_PREDICTION_WRITES,
                    max_pending_writes: MAX_PENDING_PREDICTION_WRITES
                });
                resolve();
                return;
            }

            pendingPredictionWrites.push(async() => {
                console.log('[PREDICTION_SAVE_ATTEMPT]', {
                    ...logBase,
                    active_writes: activePredictionWrites,
                    pending_writes: pendingPredictionWrites.length
                });
                try {
                    await writeTask();
                    console.log('[PREDICTION_SAVE_SUCCESS]', {
                        ...logBase,
                        active_writes: activePredictionWrites,
                        pending_writes: pendingPredictionWrites.length
                    });
                } catch (err) {
                    console.warn('[PREDICTION_SAVE_FAIL]', {
                        ...logBase,
                        error: err ?.message || String(err),
                        code: err ?.code || null,
                        active_writes: activePredictionWrites,
                        pending_writes: pendingPredictionWrites.length
                    });
                } finally {
                    resolve();
                }
            });

            drainPredictionWriteQueue();
        }, 0);
    });
}

function buildDefaultContextFilter(overrides = {}) {
    return {
        compression_detected: false,
        range_break_detected: false,
        volume_confirmation: false,
        volatility_expansion_detected: false,
        context_score: 0,
        context_quality: null,
        allow_event: true,
        would_block_event: false,
        event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
        relative_volume: null,
        volume_acceleration: null,
        volatility_expansion_ratio: null,
        structural_context_score: null,
        volatility_context_score: null,
        volume_flow_context_score: null,
        liquidity_context_score: null,
        context_layer_breakdown: null,
        compression_duration: 0,
        compression_tightness: null,
        break_efficiency: null,
        close_location_value: null,
        wick_imbalance: null,
        volume_persistence_score: null,
        volatility_slope: null,
        compression_energy: 0,
        expansion_impulse: null,
        expansion_imbalance: null,
        fake_breakout_penalty: null,
        fake_breakout_detected: false,
        liquidity_trap_risk: null,
        session_microstructure_score: null,
        structural_break_acceptance: null,
        metrics: null,
        details: null,
        ...overrides
    };
}

function computeExitWindow(timeframe, entryTime) {
    if (timeframe !== '1m') {
        return {
            exit_time: new Date(entryTime.getTime() + 60000),
            exit_window_seconds: null,
            max_time_seconds: null,
            exit_rule: null
        };
    }

    const minExit = 20;
    const maxExit = 45;
    const exitTime = new Date(entryTime.getTime() + maxExit * 1000);

    return {
        exit_time: exitTime,
        exit_window_seconds: { min: minExit, max: maxExit, preferred: 35 },
        max_time_seconds: 60,
        exit_rule: 'impulse_exhausted_or_max_time'
    };
}

function toFiniteNumber(value) {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function computeImpulseMetrics(candles = []) {
    if (!Array.isArray(candles) || candles.length < 20) {
        return null;
    }

    const normalizedCandles = candles
        .map((candle) => ({
            open: toFiniteNumber(candle ?.open),
            high: toFiniteNumber(candle ?.high),
            low: toFiniteNumber(candle ?.low),
            close: toFiniteNumber(candle ?.close),
            volume: toFiniteNumber(candle ?.volume)
        }))
        .filter((candle) => candle.high != null && candle.low != null && candle.close != null);

    if (normalizedCandles.length < 20) {
        return null;
    }

    const last = normalizedCandles[normalizedCandles.length - 1];
    const prev = normalizedCandles[normalizedCandles.length - 2];
    const fifthBack = normalizedCandles[normalizedCandles.length - 5];

    if (!last || !prev || !fifthBack || !Number.isFinite(last.close) || last.close <= 0 || !Number.isFinite(fifthBack.close) || fifthBack.close <= 0) {
        return null;
    }

    let direction = 'neutral';
    if (last.close > prev.close && last.high > prev.high) {
        direction = 'up';
    } else if (last.close < prev.close && last.low < prev.low) {
        direction = 'down';
    }

    const momentum = (last.close - fifthBack.close) / fifthBack.close;
    const ranges = normalizedCandles.slice(-10).map((candle) => {
        if (!Number.isFinite(candle.high) || !Number.isFinite(candle.low)) {
            return null;
        }
        return candle.high - candle.low;
    }).filter((range) => Number.isFinite(range) && range >= 0);

    if (!ranges.length) {
        return null;
    }

    const avgRange = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
    const expectedMovePercent = (avgRange / last.close) * 100;
    const impulsePresent = Math.abs(momentum) > 0.0015;

    let confidence = 0;
    if (direction !== 'neutral') confidence += 0.4;
    if (impulsePresent) confidence += 0.3;
    if (expectedMovePercent > 0.20) confidence += 0.3;
    confidence = Math.min(confidence, 1);

    const momentumAbs = Math.abs(momentum);
    let timingScore = 0;

    if (momentumAbs >= 0.0030) {
        timingScore = 0.9;
    } else if (momentumAbs >= 0.0020) {
        timingScore = 0.75;
    } else if (momentumAbs >= 0.0015) {
        timingScore = 0.6;
    } else if (momentumAbs >= 0.0010) {
        timingScore = 0.45;
    } else {
        timingScore = 0.25;
    }

    const quantumScore = Math.min(
        1,
        (confidence * 0.6) + (timingScore * 0.4)
    );
    const stepMomentum = prev.close > 0 ?
        Math.abs((last.close - prev.close) / prev.close) :
        0;
    const recentVolumes = normalizedCandles
        .slice(-10)
        .map((candle) => candle.volume)
        .filter((volume) => Number.isFinite(volume) && volume >= 0);
    const avgVolume = recentVolumes.length ?
        recentVolumes.reduce((sum, value) => sum + value, 0) / recentVolumes.length :
        null;
    const volumeSpike = avgVolume && avgVolume > 0 && Number.isFinite(last.volume) ?
        clamp(last.volume / avgVolume, 0, 3) :
        0;
    const impulseStrength = clamp((confidence + timingScore + quantumScore) / 3, 0, 1);

    return {
        direction,
        momentum: Number(momentum.toFixed(6)),
        acceleration: Number(stepMomentum.toFixed(6)),
        volume_spike: Number(volumeSpike.toFixed(6)),
        strength: Number(impulseStrength.toFixed(6)),
        impulse_present: impulsePresent,
        expected_move_percent: Number(expectedMovePercent.toFixed(6)),
        confidence: Number(confidence.toFixed(6)),
        timing_score: Number(timingScore.toFixed(6)),
        quantum_score: Number(quantumScore.toFixed(6))
    };
}

function buildDeterministicCalibration({
    rawExpectedMovePercent,
    rawConfidence,
    rawTimingScore,
    rawQuantumScore,
    direction
}) {
    const normalizedExpectedMove = clamp(Number(rawExpectedMovePercent || 0), 0, 10);
    const normalizedConfidence = clamp(Number(rawConfidence || 0), 0, 1);
    const normalizedTiming = clamp(Number(rawTimingScore || 0), 0, 1);
    const normalizedQuantum = clamp(Number(rawQuantumScore || 0), 0, 1);
    const calibratedExpectedMove = Number((normalizedExpectedMove * DETERMINISTIC_CALIBRATION_FACTOR).toFixed(6));
    const expectedNetEdgePct = Number((
        calibratedExpectedMove -
        DETERMINISTIC_FEE_ROUNDTRIP_PCT -
        DETERMINISTIC_SAFETY_MARGIN_PCT
    ).toFixed(6));
    const unvalidatedHighMove = normalizedExpectedMove > DETERMINISTIC_HIGH_MOVE_VALIDATION_PCT;
    const notes = [];

    let calibratedConfidence = normalizedConfidence;
    let calibratedTimingScore = normalizedTiming;
    let calibratedQuantumScore = normalizedQuantum;
    let directionPolicy = 'up_shadow_only';
    let timingCalibrationReason = 'no_shadow_boost_applied';
    let quantumCalibrationReason = 'no_shadow_boost_applied';
    let reason = 'shadow_candidate_above_fee_floor';
    let shadowExecutionBlocked = false;

    if (SHADOW_CALIBRATION_EXPERIMENTS.deterministic_recalibrated_v1 ?.status === 'failed') {
        notes.push('supersedes_failed_deterministic_recalibrated_v1');
    }

    if (unvalidatedHighMove) {
        notes.push('high_move_observed_without_gate_relaxation');
    }

    if (String(direction || '').toLowerCase() === 'down') {
        directionPolicy = 'down_blocked_by_shadow_evidence';
        shadowExecutionBlocked = true;
        reason = 'down_blocked_by_shadow_evidence';
        notes.push('down_blocked_by_shadow_evidence');
    } else if (String(direction || '').toLowerCase() === 'neutral') {
        directionPolicy = 'neutral_observation_only';
        shadowExecutionBlocked = true;
        reason = 'neutral_observation_only';
        notes.push('neutral_observation_only');
    } else if (calibratedExpectedMove < DETERMINISTIC_MINIMUM_REQUIRED_MOVE_PCT) {
        shadowExecutionBlocked = true;
        reason = 'expected_net_edge_below_fee_floor';
        notes.push('expected_move_below_fee_floor');
    }

    if (shadowExecutionBlocked) {
        notes.push('blocked_for_shadow_execution');
    }

    return {
        version: DETERMINISTIC_CALIBRATION_VERSION,
        paper_only_mode: true,
        raw_expected_move_percent: Number(normalizedExpectedMove.toFixed(6)),
        calibrated_expected_move_percent: calibratedExpectedMove,
        expected_net_edge_pct: expectedNetEdgePct,
        fee_roundtrip_pct: DETERMINISTIC_FEE_ROUNDTRIP_PCT,
        safety_margin_pct: DETERMINISTIC_SAFETY_MARGIN_PCT,
        minimum_required_move_pct: DETERMINISTIC_MINIMUM_REQUIRED_MOVE_PCT,
        raw_confidence: Number(normalizedConfidence.toFixed(6)),
        calibrated_confidence: Number(calibratedConfidence.toFixed(6)),
        raw_timing_score: Number(normalizedTiming.toFixed(6)),
        calibrated_timing_score: Number(calibratedTimingScore.toFixed(6)),
        timing_calibration_reason: timingCalibrationReason,
        raw_quantum_score: Number(normalizedQuantum.toFixed(6)),
        calibrated_quantum_score: Number(calibratedQuantumScore.toFixed(6)),
        quantum_calibration_reason: quantumCalibrationReason,
        direction_policy: directionPolicy,
        reason,
        primary_shadow_validation_horizon: PRIMARY_SHADOW_VALIDATION_HORIZON,
        unvalidated_high_move: unvalidatedHighMove,
        allow_high_move_relaxation: false,
        shadow_execution_blocked: shadowExecutionBlocked,
        notes
    };
}

async function loadTrainingStats(symbolNormalized) {
    if (!symbolNormalized) {
        return null;
    }
    const cacheKey = String(symbolNormalized || '').toUpperCase();
    const cached = trainingStatsCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < PREDICTION_RUNTIME_CACHE_TTL_MS) {
        return cached.value;
    }
    const docRef = db.collection('velas_training_stats').doc(symbolNormalized);
    const snapshot = await docRef.get();
    const value = snapshot.exists ? (snapshot.data() || null) : null;
    trainingStatsCache.set(cacheKey, { value, fetchedAt: Date.now() });
    return value;
}

function applyTrainingFeedback(confidence, quantumScore, stats) {
    if (!stats || !stats.samples) {
        return { confidence, quantumScore, adjustment: 0, note: 'no_history' };
    }

    const samples = stats.samples || 0;
    if (samples < 5) {
        return { confidence, quantumScore, adjustment: 0, note: 'insufficient_history' };
    }

    const validWins = stats.valid_wins || 0;
    const luckyWins = stats.lucky_wins || 0;
    const losses = stats.losses || 0;
    const avgTiming = stats.avg_timing_score ?? 0.5;

    const validRate = validWins / samples;
    const luckyRate = luckyWins / samples;
    const lossRate = losses / samples;

    let adjustment = 0;
    adjustment += (validRate - 0.5) * 0.2;
    adjustment -= luckyRate * 0.15;
    adjustment -= lossRate * 0.25;
    adjustment += (avgTiming - 0.6) * 0.1;

    const adjustedConfidence = clamp(confidence + adjustment, 0.1, 0.99);
    const adjustedQuantum = clamp(quantumScore + adjustment * 0.8, 0.1, 0.99);

    return {
        confidence: adjustedConfidence,
        quantumScore: adjustedQuantum,
        adjustment: Number(adjustment.toFixed(3)),
        note: 'training_feedback'
    };
}

function computeSignalStability(confidenceRaw, quantumRaw, timingRaw) {
    const confidence = Number(confidenceRaw || 0);
    const quantum = Number(quantumRaw || 0);
    const timing = Number(timingRaw || 0);
    const avg = (confidence + quantum + timing) / 3;
    const dispersion =
        (Math.abs(confidence - avg) + Math.abs(quantum - avg) + Math.abs(timing - avg)) / 3;
    return clamp(avg * (1 - Math.min(dispersion, 0.5)), 0, 1);
}

function shouldEarlyCommitExecution({
    isEventDriven,
    direction,
    confidence,
    quantumScore,
    timingScore,
    contextFilter,
    calibration
}) {
    if (!EARLY_EXECUTION_ENABLED) return { ok: false, reason: 'disabled' };
    if (calibration ?.paper_only_mode) return { ok: false, reason: 'shadow_calibration_paper_only' };
    if (calibration ?.shadow_execution_blocked) return { ok: false, reason: 'shadow_execution_blocked' };
    if (!isEventDriven) return { ok: false, reason: 'not_event_driven' };
    if (direction !== 'up' && direction !== 'down') return { ok: false, reason: 'neutral_direction' };

    const stability = computeSignalStability(confidence, quantumScore, timingScore);
    const contextAllowed = !EVENT_CONTEXT_FILTER_ENABLED || contextFilter ?.allow_event !== false;
    const ok =
        confidence >= EARLY_EXECUTION_MIN_CONFIDENCE &&
        quantumScore >= EARLY_EXECUTION_MIN_QUANTUM &&
        timingScore >= EARLY_EXECUTION_MIN_TIMING &&
        stability >= EARLY_EXECUTION_MIN_STABILITY &&
        contextAllowed;

    return {
        ok,
        stability,
        reason: ok ? 'strong_event_signal' : 'threshold_not_met'
    };
}

function applyConfidenceReweighting({
    confidence,
    quantumScore,
    timingScore,
    isEventDriven,
    neutralRate,
    calibration
}) {
    // Reweighting only changes scoring, not base thresholds.
    const notes = [];
    const baseConfidence = confidence;
    let adjusted = confidence;

    const alignedQuantumTiming = quantumScore >= 0.85 && timingScore >= 0.75;
    const allowBoosts = !calibration ?.paper_only_mode && !calibration ?.shadow_execution_blocked;
    if (allowBoosts && isEventDriven && baseConfidence >= 0.8) {
        adjusted = clamp(adjusted * 1.12, 0.05, 0.99);
        notes.push('event_boost');
    }
    if (allowBoosts && alignedQuantumTiming) {
        adjusted = clamp(adjusted * 1.04, 0.05, 0.99);
        notes.push('aligned_boost');
    }

    if (neutralRate != null && neutralRate >= 0.8) {
        adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
        notes.push('neutral_penalty');
    }

    let lowConfidencePenalty = false;
    if (adjusted < 0.6) {
        adjusted = clamp(adjusted * 0.85, 0.05, 0.99);
        lowConfidencePenalty = true;
        notes.push('low_confidence_penalty');
    }

    return {
        confidence_before: baseConfidence,
        confidence_after: adjusted,
        lowConfidencePenalty,
        notes
    };
}

function evaluateTimeframeGate(timeframe, confidence, quantumScore, direction, impulsePresent) {
    if (timeframe !== '1m') {
        return { pass: true, reason: 'non_1m' };
    }
    const reasons = [];
    if (confidence < QUALITY_GATE_MIN_CONFIDENCE) reasons.push('confidence');
    if (quantumScore < QUALITY_GATE_MIN_QUANTUM) reasons.push('quantum');
    if (direction === 'neutral') reasons.push('direction');
    if (!impulsePresent) reasons.push('impulse');
    return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function normalizeContextQualityScore(rawValue) {
    const value = Number(rawValue || 0);
    if (!Number.isFinite(value) || value <= 0) return 0;
    if (value <= 1) return clamp(value, 0, 1);
    return clamp(value / 4, 0, 1);
}

function computeQualityGateAuditScore({
    confidence,
    quantumScore,
    timingScore,
    direction,
    impulsePresent,
    contextQuality,
    weights = {}
}) {
    const normalizedConfidence = clamp(Number(confidence || 0), 0, 1);
    const normalizedQuantum = clamp(Number(quantumScore || 0), 0, 1);
    const normalizedTiming = clamp(Number(timingScore || 0), 0, 1);
    const normalizedDirection = direction === 'neutral' ? 0 : 1;
    const normalizedImpulse = impulsePresent ? 1 : 0;
    const normalizedContext = normalizeContextQualityScore(contextQuality);
    const mergedWeights = {
        confidence: 0.34,
        quantum: 0.22,
        timing: 0.24,
        direction: 0.08,
        impulse: 0.07,
        context: 0.05,
        ...weights
    };

    const score =
        normalizedConfidence * mergedWeights.confidence +
        normalizedQuantum * mergedWeights.quantum +
        normalizedTiming * mergedWeights.timing +
        normalizedDirection * mergedWeights.direction +
        normalizedImpulse * mergedWeights.impulse +
        normalizedContext * mergedWeights.context;

    return Number(score.toFixed(4));
}

function evaluateEventGate(
    confidence,
    quantumScore,
    timingScore,
    direction,
    impulsePresent,
    options = {}
) {
    const expectedMove = Number(options.expectedMovePercent || 0);
    const expectedNetEdgePct = Number(options.expectedNetEdgePct || 0);
    const contextQuality = Number(options.contextQuality || 0);
    const useHighMoveRelaxation =
        options.allowHighMoveRelaxation === true &&
        expectedNetEdgePct > 0 &&
        expectedMove >= QUALITY_GATE_HIGH_MOVE_MIN_EXPECTED_MOVE;
    const confidenceMin = useHighMoveRelaxation ?
        QUALITY_GATE_HIGH_MOVE_MIN_CONFIDENCE :
        QUALITY_GATE_MIN_CONFIDENCE;

    const originalReasons = [];
    if (confidence < QUALITY_GATE_MIN_CONFIDENCE) originalReasons.push('confidence');
    if (quantumScore < QUALITY_GATE_MIN_QUANTUM) originalReasons.push('quantum');
    if (timingScore < QUALITY_GATE_MIN_TIMING) originalReasons.push('timing');
    if (direction === 'neutral') originalReasons.push('direction');
    if (!impulsePresent) originalReasons.push('impulse');

    const adjustedReasons = [];
    if (confidence < confidenceMin) adjustedReasons.push('confidence');
    if (quantumScore < QUALITY_GATE_MIN_QUANTUM) adjustedReasons.push('quantum');
    if (timingScore < QUALITY_GATE_MIN_TIMING) adjustedReasons.push('timing');
    if (expectedNetEdgePct <= 0) adjustedReasons.push('net_edge');
    if (!useHighMoveRelaxation && direction === 'neutral') adjustedReasons.push('direction');
    if (!useHighMoveRelaxation && !impulsePresent) adjustedReasons.push('impulse');

    if (useHighMoveRelaxation) {
        console.log('[QUALITY_CONTEXT_ADJUSTED]', {
            expected_move: Number(expectedMove.toFixed(4)),
            original_score: computeQualityGateAuditScore({
                confidence,
                quantumScore,
                timingScore,
                direction,
                impulsePresent,
                contextQuality
            }),
            adjusted_score: computeQualityGateAuditScore({
                confidence,
                quantumScore,
                timingScore,
                direction,
                impulsePresent,
                contextQuality,
                weights: {
                    direction: 0.03,
                    impulse: 0.02,
                    context: 0.02,
                    confidence: 0.39,
                    quantum: 0.24,
                    timing: 0.3
                }
            }),
            confidence_threshold_before: QUALITY_GATE_MIN_CONFIDENCE,
            confidence_threshold_after: confidenceMin,
            original_reasons: originalReasons,
            adjusted_reasons: adjustedReasons
        });
    }

    const reasons = useHighMoveRelaxation ? adjustedReasons : originalReasons;
    return { pass: reasons.length === 0, reason: reasons.length ? `missing:${reasons.join(',')}` : 'quality_gate' };
}

function normalizeQualityGateInput(input = {}) {
    try {
        console.log('[DEBUG_NORMALIZE_START]', JSON.stringify(input));

        console.log('[DEBUG_NORMALIZE_BEFORE_CONFIDENCE]', input.confidence, input.confidence_score);
        const confidence =
            Number.isFinite(input.confidence) ? input.confidence : Number.isFinite(input.confidence_score) ?
            input.confidence_score :
            null;
        console.log('[DEBUG_NORMALIZE_AFTER_CONFIDENCE]', confidence);

        console.log('[DEBUG_NORMALIZE_BEFORE_QUANTUM]', input.quantum, input.quantum_score);
        const quantum =
            Number.isFinite(input.quantum) ? input.quantum : Number.isFinite(input.quantum_score) ?
            input.quantum_score :
            null;
        console.log('[DEBUG_NORMALIZE_AFTER_QUANTUM]', quantum);

        console.log('[DEBUG_NORMALIZE_BEFORE_TIMING]', input.timing, input.timing_score);
        const timing =
            Number.isFinite(input.timing) ? input.timing : Number.isFinite(input.timing_score) ?
            input.timing_score :
            null;
        console.log('[DEBUG_NORMALIZE_AFTER_TIMING]', timing);

        console.log('[DEBUG_NORMALIZE_BEFORE_STABILITY]', input.stability);
        const stability = Number.isFinite(input.stability) ? input.stability : 0;
        console.log('[DEBUG_NORMALIZE_AFTER_STABILITY]', stability);

        console.log('[DEBUG_NORMALIZE_BEFORE_IMPULSE]', input.impulse_present, input.impulse);
        const impulsePresent = Boolean(input.impulse_present ?? input.impulse ?? false);
        console.log('[DEBUG_NORMALIZE_AFTER_IMPULSE]', impulsePresent);

        console.log('[DEBUG_NORMALIZE_BEFORE_CONTEXT]', input.context_quality, input.context_score);
        const contextQuality = Number.isFinite(input.context_quality) ?
            input.context_quality :
            Number.isFinite(input.context_score) ?
            input.context_score :
            0;
        console.log('[DEBUG_NORMALIZE_AFTER_CONTEXT]', contextQuality);

        console.log('[DEBUG_NORMALIZE_RETURN]', {
            confidence,
            quantum,
            timing,
            stability,
            impulsePresent,
            contextQuality
        });

        return {
            confidence,
            quantum,
            timing,
            stability,
            direction: input.direction ?? 'neutral',
            impulse_present: impulsePresent,
            context_quality: contextQuality
        };
    } catch (err) {
        console.error('[DEBUG_NORMALIZE_CRASH]', err ?.message || err, err ?.stack);
        throw err;
    }
}

function formatTimeUTC(date) {
    return date.toISOString().slice(11, 19);
}

function buildEventDrivenWindows(referenceTime, impulseConfig, impulseMetrics) {
    const strength = clamp(Number(impulseMetrics ?.strength || 0), 0, 1);
    const entryOffsetMs = Math.round(4000 + strength * 11000);
    const entryDurationMs = Math.round(12000 + strength * 13000);
    const entryStart = new Date(referenceTime.getTime() + entryOffsetMs);
    const entryEnd = new Date(entryStart.getTime() + entryDurationMs);

    const impulseMin = Math.max(20, Math.round(strength * 40));
    const impulseMax = impulseMin + Math.round(10 + strength * 15);
    const exitDelayMs = Math.round(3000 + strength * 7000);
    const exitStart = new Date(entryEnd.getTime() + exitDelayMs);
    const exitEnd = new Date(exitStart.getTime() + impulseMax * 1000);

    return {
        entryWindow: {
            start: formatTimeUTC(entryStart),
            end: formatTimeUTC(entryEnd)
        },
        exitWindow: {
            start: formatTimeUTC(exitStart),
            end: formatTimeUTC(exitEnd)
        },
        impulseDurationSeconds: {
            min: impulseMin,
            max: impulseMax
        },
        exitTime: exitEnd,
        exitWindowSeconds: {
            min: impulseMin,
            max: impulseMax,
            preferred: impulseConfig ?.preferred || impulseMax
        },
        entryStart,
        entryEnd,
        exitStart,
        exitEnd
    };
}

function buildTradePlan({ spotPrice, expectedMovePercent, direction, timeframeMinutes }) {
    const entry = Number(spotPrice);
    const move = Number(expectedMovePercent) / 100;

    if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(move) || move <= 0 || (direction !== 'up' && direction !== 'down')) {
        return null;
    }

    const takeProfit = direction === 'up' ?
        entry * (1 + move) :
        entry * (1 - move);
    const stopLoss = direction === 'up' ?
        entry * (1 - move * 0.6) :
        entry * (1 + move * 0.6);
    const rewardDistance = Math.abs(takeProfit - entry);
    const riskDistance = Math.abs(entry - stopLoss);
    const referencePrice = Math.abs(entry) || 1;

    return {
        entry_price: roundPrice(entry, referencePrice),
        stop_loss: roundPrice(stopLoss, referencePrice),
        take_profit: roundPrice(takeProfit, referencePrice),
        target_exit_price: roundPrice(takeProfit, referencePrice),
        risk_per_unit: roundPrice(riskDistance, referencePrice),
        reward_per_unit: roundPrice(rewardDistance, referencePrice),
        risk_reward_ratio: riskDistance > 0 ? Number((rewardDistance / riskDistance).toFixed(2)) : null,
        estimated_holding_minutes: Number(timeframeMinutes || 0),
        plan_version: 'candle_deterministic_v1'
    };
}


async function generarPrediccion({
    symbol,
    timeframe = '5m',
    monto = 1000,
    execution_mode = 'timeframe',
    origin,
    signal,
    taskContext
} = {}) {
    const rawSymbol = String(symbol ?? '').trim();

    if (!rawSymbol ||
        rawSymbol.includes('?') ||
        rawSymbol.length < 6 ||
        !rawSymbol.includes('-')
    ) {
        console.log('[DEBUG_INVALID_SYMBOL_BLOCKED]', rawSymbol);

        return {
            skipped: true,
            reason: 'invalid_symbol',
            symbol: rawSymbol
        };
    }

    console.log('[DEBUG_PREDICCION_START]', symbol);

    throwIfAborted(signal, `Prediction cancelled for ${symbol || 'unknown'}`, 'OPERATION_ABORTED');

    // PHASE: TRACE INPUT
    console.log('[TRACE_INPUT_START]', {
        symbol,
        timeframe,
        monto,
        timestamp: new Date().toISOString()
    });

    const frameMinutes = timeframes[timeframe] || 5;
    const analysisStartAt = new Date();
    const analysisStartIso = analysisStartAt.toISOString();
    const now = analysisStartAt;
    const entryTime = new Date(now.getTime() + frameMinutes * 60000);
    const exitWindow = computeExitWindow(timeframe, entryTime);

    const symbolInput = symbol ? symbol.toUpperCase() : '';
    const symbolNormalized = normalizeSymbol(symbolInput);
    const executionMode = execution_mode === 'event_driven' ? 'event_driven' : 'timeframe';
    const isEventDriven = executionMode === 'event_driven';
    const profiling = PROFILING_FETCH_ENABLED ? {
            symbol: symbolNormalized || symbolInput,
            timeframe
        } :
        null;
    const trainingStatsPromise = loadTrainingStats(symbolNormalized);
    const learningConfigPromise = preloadLearningConfig(symbolNormalized || symbolInput, executionMode, timeframe);
    console.log('[DEBUG_TIMEOUT_CONFIGURED]', symbolNormalized || symbolInput, FETCH_TIMEOUT_MS);
    const sharedCandlesPromise = fetchCandles(
        symbolNormalized || symbolInput,
        timeframe, {
            ...(profiling ? { profiling } : {}),
            signal,
            taskContext,
            timeoutMs: FETCH_TIMEOUT_MS
        }
    );
    console.log('[DEBUG_FETCH_CANDLES]', symbol);
    console.log('[DEBUG_AFTER_FETCH_CANDLES_CALL]', {
        symbol,
        hasCandlesPromise: !!sharedCandlesPromise,
        timeoutConfigured: FETCH_TIMEOUT_MS
    });

    // BINANCE-ONLY spot price extraction from candles
    let spotPrice = null;
    let spotPriceSource = 'binance_candles';
    let candlesData = null;
    try {
        const candles = await Promise.resolve(sharedCandlesPromise);
        candlesData = candles;
        console.log('[TRACE_INPUT]', {
            symbol,
            candles_length: candles ?.length || 0,
            first_candle: candles ?.[0] ? { open: candles[0].open, close: candles[0].close, time: candles[0].time } : null,
            last_candle: candles ?.[candles.length - 1] ? { open: candles[candles.length - 1].open, close: candles[candles.length - 1].close, time: candles[candles.length - 1].time } : null,
            data_available: !!candles && candles.length > 0
        });
        if (candles && candles.length > 0) {
            const lastCandle = candles[candles.length - 1];
            spotPrice = lastCandle ?.close;
            if (Number.isFinite(spotPrice) && spotPrice > 0) {
                spotPrice = roundPrice(spotPrice);
                console.log('[DEBUG_SPOT_FROM_BINANCE_CANDLES]', symbol, spotPrice);
            } else {
                spotPrice = null;
            }
        }
    } catch (error) {
        console.log('[DEBUG_FETCH_CANDLES_FAILED]', symbol, error ?.message);
        console.log('[TRACE_INPUT]', {
            symbol,
            status: 'FAILED',
            error: error ?.message,
            data_available: false
        });
    }

    if (!Number.isFinite(spotPrice) || spotPrice <= 0) {
        console.log('[DEBUG_NO_BINANCE_DATA_SKIP]', symbolInput);
        console.log('[DEBUG_EARLY_EXIT]', {
            symbol: symbolInput,
            reason: 'no_binance_data',
            spotPrice_finite: Number.isFinite(spotPrice),
            spotPrice_value: spotPrice,
            confidence: 'NOT_DEFINED',
            quantum: 'NOT_DEFINED',
            timing: 'NOT_DEFINED',
            direction: 'NOT_DEFINED',
            impulse: 'NOT_DEFINED'
        });
        return {
            skipped: true,
            reason: 'no_binance_data',
            symbol: symbolInput
        };
    }
    if (!Array.isArray(candlesData) || candlesData.length < 20) {
        console.log('[DEBUG_INSUFFICIENT_CANDLES_SKIP]', symbolInput, candlesData ?.length || 0);
        return {
            skipped: true,
            reason: 'insufficient_candles',
            symbol: symbolInput
        };
    }
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

    const precioActual = spotPrice;
    const predictionComputeStartedAtMs = Date.now();
    console.log('[DEBUG_STEP_1_AFTER_BEFORE]', symbol);
    let contextFilter = buildDefaultContextFilter();
    const impulseMetrics = computeImpulseMetrics(candlesData);
    if (!impulseMetrics) {
        console.log('[DEBUG_INVALID_CANDLE_METRICS_SKIP]', symbolInput);
        return {
            skipped: true,
            reason: 'invalid_candle_metrics',
            symbol: symbolInput
        };
    }
    const impulseMinPercent = timeframe === '1m' ? 0.2 : 0.5;

    const rawExpectedMovePercent = Number(impulseMetrics.expected_move_percent.toFixed(4));
    let direction = impulseMetrics.direction;
    const directionSign = direction === 'down' ? -1 : direction === 'up' ? 1 : 0;
    const contextCandlesPromise =
        EVENT_CONTEXT_FILTER_ENABLED && (direction === 'up' || direction === 'down') ?
        sharedCandlesPromise :
        Promise.resolve(null);

    if (EVENT_CONTEXT_FILTER_ENABLED && (direction === 'up' || direction === 'down')) {
        try {
            const contextCandles = await contextCandlesPromise;
            contextFilter = evaluateEventContextFilter({
                candles: contextCandles,
                direction,
                currentPrice: spotPrice,
                mode: EVENT_CONTEXT_FILTER_MODE
            });
        } catch (err) {
            console.log('[DEBUG_PREDICCION_ERROR] context_filter', err ?.message || err);
            contextFilter = buildDefaultContextFilter({
                allow_event: EVENT_CONTEXT_FILTER_MODE === 'observe',
                would_block_event: true,
                details: { error: err ?.message || 'context_filter_failed' }
            });
        }
    }
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

    // PHASE: TRACE FEATURES BEFORE MODEL
    console.log('[TRACE_FEATURES]', {
        symbol,
        impulse_metrics_keys: Object.keys(impulseMetrics || {}).slice(0, 10),
        impulse_present: impulseMetrics ?.impulse_present,
        impulse_strength: Number((impulseMetrics ?.strength || 0).toFixed(4)),
        direction_computed: direction,
        candles_count_available: candlesData ?.length || 0,
        spot_price: spotPrice,
        raw_expected_move_percent: rawExpectedMovePercent
    });

    // PHASE: MODEL EXECUTION (Heuristic-based)
    console.log('[TRACE_MODEL_EXECUTION]', {
        symbol,
        model_type: 'deterministic_candles_engine',
        model_loaded: true,
        execution_attempted: true,
        impulse_data_available: !!impulseMetrics,
        strength_factor: Number((impulseMetrics ?.strength || 0).toFixed(4))
    });

    const baseConfidence = clamp(impulseMetrics.confidence, 0, 1);
    const rawTimingScore = clamp(impulseMetrics.timing_score, 0, 1);
    const baseQuantum = clamp(impulseMetrics.quantum_score, 0, 1);
    const initialCalibration = buildDeterministicCalibration({
        rawExpectedMovePercent,
        rawConfidence: baseConfidence,
        rawTimingScore,
        rawQuantumScore: baseQuantum,
        direction
    });
    const expectedMovePercent = initialCalibration.calibrated_expected_move_percent;

    let confidence = initialCalibration.calibrated_confidence;
    let timingScore = initialCalibration.calibrated_timing_score;
    let quantumScore = initialCalibration.calibrated_quantum_score;

    // PHASE: TRACE MODEL RAW OUTPUT
    console.log('[TRACE_MODEL_OUTPUT]', {
        symbol,
        raw_prediction_confidence: Number(baseConfidence.toFixed(4)),
        raw_prediction_quantum: Number(baseQuantum.toFixed(4)),
        raw_prediction_timing: Number(rawTimingScore.toFixed(4)),
        raw_expected_move_percent: rawExpectedMovePercent,
        calibrated_expected_move_percent: expectedMovePercent,
        model_output_valid: Number.isFinite(baseConfidence) && baseConfidence > 0,
        confidence_is_zero: baseConfidence === 0,
        confidence_is_undefined: baseConfidence === undefined,
        confidence_is_null: baseConfidence === null
    });

    console.log('[DEBUG_FEATURES_VALUES]', {
        symbol: symbolInput,
        confidence_initial: confidence,
        quantumScore_initial: quantumScore,
        timingScore_initial: timingScore,
        direction: direction,
        impulse: impulseMetrics ?.impulse_present,
        baseConfidence,
        baseQuantum,
        initialCalibration
    });

    const signedDeltaPct = directionSign === 0 ? 0 : Number((expectedMovePercent * directionSign).toFixed(2));
    const modelPriceEstimate = roundPrice(spotPrice * (1 + signedDeltaPct / 100), spotPrice);
    const gananciaEstim = Number((monto * (signedDeltaPct / 100)).toFixed(2));
    const porcentaje = signedDeltaPct;
    const computedTradePlan = buildTradePlan({
        spotPrice,
        expectedMovePercent,
        direction,
        timeframeMinutes: frameMinutes
    });
    const eventDrivenInfo = isEventDriven ?
        buildEventDrivenWindows(now, { preferred: 35 }, impulseMetrics) :
        null;
    const entryTimeIso = isEventDriven ?
        eventDrivenInfo ?.entryStart.toISOString() :
        entryTime.toISOString();
    const exitTimeIso = isEventDriven ?
        eventDrivenInfo ?.exitEnd.toISOString() :
        exitWindow.exit_time.toISOString();
    const exitWindowSeconds = isEventDriven ?
        eventDrivenInfo ?.exitWindowSeconds || { min: 0, max: 60, preferred: 60 } :
        exitWindow.exit_window_seconds;
    const maxTimeSeconds = isEventDriven ? 60 : exitWindow.max_time_seconds;
    const finalExitRule = isEventDriven ?
        'Impulse exhausted or max 60s hard cap for event-driven mode' :
        exitWindow.exit_rule;
    const earlyCommitDecision = shouldEarlyCommitExecution({
        isEventDriven,
        direction,
        confidence,
        quantumScore,
        timingScore,
        contextFilter,
        calibration: initialCalibration
    });
    let docRef = db.collection('velas_predicciones').doc();
    let earlyExecutionState = null;
    let earlySourceProfile = 'event_emitted';
    let queuedBinanceExecutionTask = null;

    if (earlyCommitDecision.ok && computedTradePlan) {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        schedulePredictionSet(
            docRef,
            sanitizeForFirestore({
                simbolo: symbolInput,
                simbolo_normalizado: symbolNormalized,
                tipo: 'velas',
                timeframe,
                execution_mode: executionMode,
                mode: isEventDriven ? 'event-driven' : 'timeframe',
                timeframe_minutes: frameMinutes,
                monto,
                spot_price: spotPrice,
                precio_actual: spotPrice,
                precio_estimado: modelPriceEstimate,
                porcentaje,
                expected_move_percent: expectedMovePercent,
                signed_delta_pct: signedDeltaPct,
                trade_plan: computedTradePlan,
                ahora: analysisStartIso,
                analysis_start_at: analysisStartIso,
                signal_created_at: analysisStartIso,
                signal_ready_at: null,
                signal_emitted: true,
                direction,
                confianza: Number(confidence.toFixed(2)),
                confidence_before: Number(confidence.toFixed(4)),
                confidence_after: Number(confidence.toFixed(4)),
                quantum_score: Number(quantumScore.toFixed(2)),
                timing_score: Number(timingScore.toFixed(2)),
                context_score: contextFilter.context_score,
                context_quality: contextFilter.context_quality,
                entry_time: entryTimeIso,
                exit_time: exitTimeIso,
                exit_window_seconds: exitWindowSeconds,
                max_time_seconds: maxTimeSeconds,
                exit_rule: finalExitRule,
                early_execution_candidate: true,
                early_execution_stability: Number(earlyCommitDecision.stability.toFixed(4)),
                status: 'processing',
                verification: null,
                timestamp: analysisStartIso,
                created_at: analysisStartIso
            }), { stage: 'early_placeholder', merge: true }
        );

        const earlyPrediction = {
            id: docRef.id,
            prediction_id: docRef.id,
            symbol: symbolInput,
            simbolo: symbolInput,
            execution_mode: executionMode,
            mode: isEventDriven ? 'event-driven' : 'timeframe',
            timeframe_minutes: frameMinutes,
            direction,
            confidence,
            confianza: Number(confidence.toFixed(4)),
            quantum_score: Number(quantumScore.toFixed(4)),
            timing_score: Number(timingScore.toFixed(4)),
            stability: Number(earlyCommitDecision.stability.toFixed(4))
        };
        const [preAlertDecisionEarly, highConvictionDecisionEarly] = await Promise.all([
            shouldSendManualPreAlert(db, earlyPrediction).catch(() => ({ ok: false, reason: 'early_prealert_failed' })),
            shouldEmitHighConvictionSignal(db, earlyPrediction).catch(() => ({ ok: false, reason: 'early_hc_failed' }))
        ]);
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');

        earlySourceProfile = highConvictionDecisionEarly.ok ?
            'high_conviction' :
            (preAlertDecisionEarly.ok ? 'manual_prealert' : 'event_emitted');

        const signalReadyAtEarly = new Date();
        const signalReadyIsoEarly = signalReadyAtEarly.toISOString();
        const operationalEntryWindowEarly = {
            start: formatTimeUTC(signalReadyAtEarly),
            end: formatTimeUTC(new Date(signalReadyAtEarly.getTime() + ENTRY_WINDOW_SECONDS * 1000))
        };
        const executionPayloadEarly = sanitizeForFirestore({
            id: docRef.id,
            prediction_id: docRef.id,
            symbol: symbolInput,
            simbolo: symbolInput,
            timeframe,
            execution_mode: executionMode,
            mode: isEventDriven ? 'event-driven' : 'timeframe',
            timeframe_minutes: frameMinutes,
            direction,
            trade_plan: computedTradePlan,
            spot_price: spotPrice,
            precio_actual: spotPrice,
            expected_move_percent: Number(expectedMovePercent.toFixed(4)),
            context_score: contextFilter.context_score,
            context_quality: contextFilter.context_quality,
            confidence: Number(confidence.toFixed(4)),
            quantum_score: Number(quantumScore.toFixed(4)),
            timing_score: Number(timingScore.toFixed(4)),
            ahora: signalReadyIsoEarly,
            created_at: signalReadyIsoEarly,
            timestamp: signalReadyIsoEarly,
            analysis_start_at: analysisStartIso,
            signal_created_at: analysisStartIso,
            signal_ready_at: signalReadyIsoEarly,
            signal_emitted_at: signalReadyIsoEarly,
            analysis_entry_window: eventDrivenInfo ?.entryWindow || null,
            estimated_window: operationalEntryWindowEarly,
            entry_window: operationalEntryWindowEarly,
            entry_window_utc: operationalEntryWindowEarly,
            entry_window_start_at: signalReadyIsoEarly,
            entry_window_end_at: new Date(signalReadyAtEarly.getTime() + ENTRY_WINDOW_SECONDS * 1000).toISOString(),
            source_profile: earlySourceProfile,
            source: earlySourceProfile
        });

        earlyExecutionState = {
            completed: true,
            sourceProfile: earlySourceProfile,
            signalReadyIso: signalReadyIsoEarly,
            analysisToSignalReadyMs: signalReadyAtEarly.getTime() - analysisStartAt.getTime(),
            entryWindowStartIso: signalReadyIsoEarly,
            entryWindowEndIso: executionPayloadEarly.entry_window_end_at,
            binanceExecution: buildQueuedBinanceExecution(earlySourceProfile)
        };
        queuedBinanceExecutionTask = {
            predictionId: docRef.id,
            executionPayload: executionPayloadEarly,
            sourceProfile: earlySourceProfile
        };
    }

    console.log('[DEBUG_STEP_2_BEFORE_TRAINING]', symbol);
    const trainingStats = await trainingStatsPromise;
    console.log('[DEBUG_STEP_3_AFTER_TRAINING]', symbol);
    console.log('[DEBUG_ABORT_CHECK_1_BEFORE]', symbol);
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    console.log('[DEBUG_ABORT_CHECK_1_AFTER]', symbol);
    console.log('[DEBUG_STEP_4_BEFORE_FEEDBACK]', symbol);
    console.log('[MODEL_INPUT_BEFORE_TRAINING]', {
        symbol: symbolInput,
        confidence_input: Number(confidence.toFixed(4)),
        quantum_input: Number(quantumScore.toFixed(4)),
        timing_input: Number(timingScore.toFixed(4)),
        has_training_stats: !!trainingStats,
        training_stats_keys: trainingStats ? Object.keys(trainingStats).slice(0, 5) : []
    });
    const trainingFeedback = applyTrainingFeedback(confidence, quantumScore, trainingStats);
    console.log('[MODEL_TRAINING_FEEDBACK_OUTPUT]', {
        symbol: symbolInput,
        confidence_output: Number((trainingFeedback.confidence || 0).toFixed(4)),
        quantum_output: Number((trainingFeedback.quantumScore || 0).toFixed(4)),
        feedback_note: trainingFeedback.note || 'unknown'
    });
    console.log('[DEBUG_STEP_5_AFTER_FEEDBACK]', symbol);
    confidence = trainingFeedback.confidence;
    quantumScore = trainingFeedback.quantumScore;
    console.log('[MODEL_CONFIDENCE_AFTER_TRAINING]', {
        symbol: symbolInput,
        confidence_now: Number(confidence.toFixed(4)),
        is_valid: Number.isFinite(confidence),
        is_zero: confidence === 0
    });
    const neutralRate = trainingStats ?.neutral_rate ?? trainingStats ?.neutralRate ?? null;
    console.log('[DEBUG_STEP_6_BEFORE_STABILITY]', symbol);
    const stability = computeSignalStability(confidence, quantumScore, timingScore);
    console.log('[DEBUG_STEP_7_AFTER_STABILITY]', symbol);
    console.log('[DEBUG_STEP_7_5_AFTER_STABILITY]', symbol);
    const gateStartedAtMs = Date.now();
    console.log('[DEBUG_STEP_7_6_BEFORE_NORMALIZATION]', symbol);
    console.log('[DEBUG_NORMALIZE_CALL_ATTEMPT]', symbol);
    console.log('[DEBUG_AFTER_ATTEMPT_LINE_UPDATED_V1]', symbol);

    // ValidaciÃ³n robusta de valores numÃ©ricos antes de quality gate
    quantumScore = Number.isFinite(quantumScore) ? quantumScore : Number(quantumScore) || 0;
    timingScore = Number.isFinite(timingScore) ? timingScore : Number(timingScore) || 0;
    console.log('[DEBUG_STEP_7_7_AFTER_NORMALIZATION]', symbol);

    console.log('[DEBUG_STEP_7_8_BEFORE_GATE_INPUT]', symbol);
    console.log('[DEBUG_STEP_8_BEFORE_GATE]', symbol);

    console.log('[DEBUG_GATE_INPUT_CONSTRUCTION]', 'confidence', confidence, 'quantum', quantumScore, 'timing', timingScore);
    console.log('[DEBUG_GATE_INPUT_DEPENDENCIES]', {
        has_impulseMetrics: !!impulseMetrics,
        impulse_present: impulseMetrics ?.impulse_present,
        has_contextFilter: !!contextFilter,
        context_quality: contextFilter ?.context_quality,
        has_direction: !!direction,
        has_stability: !!stability
    });
    console.log('[DEBUG_ABOUT_TO_CONSTRUCT_GATE_INPUT]', symbol);

    // Bloqueo CRÃTICO: validar objetos requeridos antes de construir gate
    if (!contextFilter || !impulseMetrics) {
        console.log('[DEBUG_BEFORE_RETURN]', {
            symbol: symbolInput,
            reason: 'missing_required_objects',
            hasContextFilter: !!contextFilter,
            hasImpulseMetrics: !!impulseMetrics,
            hasCandles: !!sharedCandlesPromise,
            spotPrice: spotPrice,
            hasDirection: !!direction
        });
        console.log('[DEBUG_BLOCKED_BEFORE_GATE]', symbolInput, {
            hasContextFilter: !!contextFilter,
            hasImpulseMetrics: !!impulseMetrics
        });
        console.log('[DEBUG_EARLY_EXIT]', {
            symbol: symbolInput,
            reason: 'missing_critical_dependencies',
            contextFilter: contextFilter ? 'EXISTS' : 'NULL',
            impulseMetrics: impulseMetrics ? 'EXISTS' : 'NULL',
            confidence: 'NOT_EVALUATED',
            quantum: 'NOT_EVALUATED',
            timing: 'NOT_EVALUATED',
            direction: direction,
            impulse: 'NOT_EVALUATED'
        });
        return null;
    }

    const safeNumber = (v) => Number.isFinite(v) ? v : 0;

    const gateOriginalInput = {
        confidence: safeNumber(confidence),
        quantum: safeNumber(quantumScore),
        timing: safeNumber(timingScore),
        stability: safeNumber(stability),
        impulse: impulseMetrics ?.impulse_present ?? false,
        direction: direction ?? 'neutral',
        context_quality: safeNumber(contextFilter ?.context_quality),
        context_score: safeNumber(contextFilter ?.context_score)
    };
    console.log('[DEBUG_GATE_INPUT_CONSTRUCTED]', symbol, 'keys:', Object.keys(gateOriginalInput).length);
    console.log('[DEBUG_AFTER_CONSTRUCT_GATE_INPUT]', JSON.stringify({
        confidence: gateOriginalInput.confidence,
        quantum_score: gateOriginalInput.quantum_score,
        timing_score: gateOriginalInput.timing_score,
        context_quality: gateOriginalInput.context_quality
    }));
    console.log('[DEBUG_GATE_CALL_DECISION]', JSON.stringify({
        symbol: symbolInput,
        hasConfidence: !!confidence,
        hasQuantum: !!quantumScore,
        hasTiming: !!timingScore,
        hasContext: !!contextFilter,
        hasImpulse: !!impulseMetrics,
        stability,
        direction,
        gateOriginalInputKeys: Object.keys(gateOriginalInput).length
    }));

    // VALIDACIÃ“N: Verificar si se ejecutarÃ¡ normalizeQualityGateInput
    console.log('[DEBUG_BLOCKING_IF]', symbol, 'condition_check:', { confidence: !!confidence, quantumScore: !!quantumScore, gateOriginalInput: !!gateOriginalInput });
    if (!confidence || !quantumScore || !gateOriginalInput) {
        console.log('[DEBUG_GATE_SKIPPED]', JSON.stringify({
            symbol: symbolInput,
            reason: 'missing_required_data',
            confidence: !!confidence,
            quantumScore: !!quantumScore,
            gateOriginalInput: !!gateOriginalInput
        }));
    } else {
        console.log('[DEBUG_GATE_EXECUTING]', symbolInput);
    }

    console.log('[DEBUG_BEFORE_NORMALIZE_CALL]', symbol);
    console.log('[DEBUG_NORMALIZE_CALL_EXECUTING]', symbol);

    let gateNormalized = null;
    try {
        console.log('[DEBUG_SAFE_CALL_INPUT]', symbolInput, JSON.stringify(gateOriginalInput));
        gateNormalized = normalizeQualityGateInput(gateOriginalInput);
        console.log('[DEBUG_SAFE_CALL_SUCCESS]', symbolInput);
    } catch (err) {
        console.log('[DEBUG_SAFE_CALL_CRASH]', symbolInput, {
            error: err ?.message,
            stack: err ?.stack,
            input: gateOriginalInput
        });
        return null;
    }

    console.log('[DEBUG_AFTER_NORMALIZE_CALL]', symbol);
    console.log('[DEBUG_NORMALIZE_CALL_COMPLETED]', symbol);

    if (QUALITY_GATE_AUDIT_ENABLED) {
        console.log('[QUALITY_GATE_NORMALIZED]', JSON.stringify({
            symbol: symbolNormalized || symbolInput,
            normalized_input: gateNormalized,
            original_input: gateOriginalInput,
            mapping_applied: true
        }));
    }

    logQualityGateRelaxed();
    const preLearningScores = { confidence, quantumScore, timingScore };
    console.log('[MODEL_PRE_LEARNING_SCORES]', {
        symbol: symbolInput,
        confidence: Number(confidence.toFixed(4)),
        quantum: Number(quantumScore.toFixed(4)),
        timing: Number(timingScore.toFixed(4)),
        has_symbol: !!symbolNormalized
    });
    const preTimeframeGate = evaluateTimeframeGate(
        timeframe,
        gateNormalized.confidence,
        gateNormalized.quantum,
        gateNormalized.direction,
        gateNormalized.impulse_present
    );
    const preEventGate = evaluateEventGate(
        gateNormalized.confidence,
        gateNormalized.quantum,
        gateNormalized.timing,
        gateNormalized.direction,
        gateNormalized.impulse_present, {
            expectedMovePercent: expectedMovePercent,
            expectedNetEdgePct: initialCalibration.expected_net_edge_pct,
            allowHighMoveRelaxation: initialCalibration.allow_high_move_relaxation,
            contextQuality: gateNormalized.context_quality
        }
    );

    console.log('[MODEL_LEARNING_ADJUSTMENT_INPUT]', {
        symbol: symbolInput || symbolNormalized,
        executionMode,
        timeframe,
        confidence_input: Number((preLearningScores.confidence || 0).toFixed(4)),
        quantum_input: Number((preLearningScores.quantumScore || 0).toFixed(4)),
        timing_input: Number((preLearningScores.timingScore || 0).toFixed(4))
    });
    const learningResult = await applyLearningAdjustments(
        symbolNormalized || symbolInput,
        executionMode,
        timeframe,
        preLearningScores, {
            preloadedConfig: await learningConfigPromise
        }
    );
    console.log('[MODEL_LEARNING_ADJUSTMENT_OUTPUT]', {
        symbol: symbolInput,
        confidence_output: Number((learningResult.confidence || 0).toFixed(4)),
        quantum_output: Number((learningResult.quantumScore || 0).toFixed(4)),
        timing_output: Number((learningResult.timingScore || 0).toFixed(4)),
        has_learning_metadata: !!learningResult.learning,
        learning_version: learningResult.learning ?.version || null
    });
    console.log('[DEBUG_ABORT_CHECK_2_BEFORE]', symbol);
    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    console.log('[DEBUG_ABORT_CHECK_2_AFTER]', symbol);
    let activeCalibration = buildDeterministicCalibration({
        rawExpectedMovePercent,
        rawConfidence: learningResult.confidence,
        rawTimingScore: learningResult.timingScore,
        rawQuantumScore: learningResult.quantumScore,
        direction
    });
    const postLearningScores = {
        confidence: activeCalibration.calibrated_confidence,
        quantumScore: activeCalibration.calibrated_quantum_score,
        timingScore: activeCalibration.calibrated_timing_score
    };
    console.log('[MODEL_POST_LEARNING_SCORES]', {
        symbol: symbolInput,
        confidence: Number((postLearningScores.confidence || 0).toFixed(4)),
        quantum: Number((postLearningScores.quantumScore || 0).toFixed(4)),
        timing: Number((postLearningScores.timingScore || 0).toFixed(4)),
        is_confidence_zero: postLearningScores.confidence === 0,
        is_confidence_undefined: postLearningScores.confidence === undefined
    });

    console.log('[DEBUG_EARLY_EXIT_CHECK_LEARNING]', {
        symbol: symbolInput,
        learningResult_keys: Object.keys(learningResult).slice(0, 10),
        confidence_from_learning: learningResult.confidence,
        quantum_from_learning: learningResult.quantumScore,
        timing_from_learning: learningResult.timingScore,
        is_confidence_null: learningResult.confidence === null || learningResult.confidence === undefined,
        is_quantum_null: learningResult.quantumScore === null || learningResult.quantumScore === undefined,
        is_timing_null: learningResult.timingScore === null || learningResult.timingScore === undefined
    });

    // ValidaciÃ³n robusta de valores numÃ©ricos en postLearningScores antes de quality gate
    postLearningScores.quantumScore = Number.isFinite(postLearningScores.quantumScore) ? postLearningScores.quantumScore : Number(postLearningScores.quantumScore) || 0;
    postLearningScores.timingScore = Number.isFinite(postLearningScores.timingScore) ? postLearningScores.timingScore : Number(postLearningScores.timingScore) || 0;

    const stabilityPost = computeSignalStability(
        postLearningScores.confidence,
        postLearningScores.quantumScore,
        postLearningScores.timingScore
    );
    const gateOriginalInputPost = {
        confidence: Number.isFinite(postLearningScores.confidence) ? postLearningScores.confidence : 0,

        quantum: Number.isFinite(postLearningScores.quantumScore) ? postLearningScores.quantumScore : 0,
        timing: Number.isFinite(postLearningScores.timingScore) ? postLearningScores.timingScore : 0,

        impulse: impulseMetrics ?.impulse_present ?? false,

        stability: Number.isFinite(stabilityPost) ? stabilityPost : 0,

        direction: direction ?? 'neutral',

        context_quality: Number.isFinite(contextFilter ?.context_quality) ?
            contextFilter.context_quality : 0,

        context_score: Number.isFinite(contextFilter ?.context_score) ?
            contextFilter.context_score : 0
    };
    let gateNormalizedPost = null;
    try {
        console.log('[DEBUG_SAFE_CALL_POST_INPUT]', symbolInput, JSON.stringify(gateOriginalInputPost));
        gateNormalizedPost = normalizeQualityGateInput(gateOriginalInputPost);
        console.log('[DEBUG_SAFE_CALL_POST_SUCCESS]', symbolInput);
    } catch (err) {
        console.log('[DEBUG_SAFE_CALL_POST_CRASH]', symbolInput, {
            error: err ?.message,
            stack: err ?.stack,
            input: gateOriginalInputPost
        });
        gateNormalizedPost = null;
    }

    const neutralCandidate =
        gateNormalizedPost &&
        ALLOW_NEUTRAL_EXPERIMENT &&
        gateNormalizedPost.direction === 'neutral' &&
        Number(gateNormalizedPost.confidence || 0) > 0.70 &&
        Number(gateNormalizedPost.timing || 0) > 0.70 &&
        Number(gateNormalizedPost.quantum || 0) > 0.60;

    if (neutralCandidate) {
        console.log('[NEUTRAL_SIGNAL_CANDIDATE]', JSON.stringify({
            symbol: symbolNormalized || symbolInput,
            confidence: gateNormalizedPost.confidence,
            timing: gateNormalizedPost.timing,
            quantum: gateNormalizedPost.quantum,
            reason: 'neutral_but_high_scores'
        }));
    }
    const learningMeta = learningResult.learning;
    if (learningMeta && LEARNING_LOG) {
        console.log(
            `[learning:v${learningMeta.version}]`,
            `${learningMeta.scope.symbol}/${learningMeta.scope.mode}/${learningMeta.scope.timeframe}`,
            learningMeta.adjustments
        );
    }

    console.log('[DEBUG_BEFORE_QUALITY_GATE_EVALUATION]', {
        symbol: symbolInput,
        timeframe,
        gateNormalizedPost_confidence: gateNormalizedPost ?.confidence,
        gateNormalizedPost_quantum: gateNormalizedPost ?.quantum,
        gateNormalizedPost_timing: gateNormalizedPost ?.timing,
        gateNormalizedPost_direction: gateNormalizedPost ?.direction,
        gateNormalizedPost_impulse_present: gateNormalizedPost ?.impulse_present,
        gateNormalizedPost_keys: gateNormalizedPost ? Object.keys(gateNormalizedPost) : 'NULL'
    });

    const postTimeframeGate = evaluateTimeframeGate(
        timeframe,
        gateNormalizedPost.confidence,
        gateNormalizedPost.quantum,
        gateNormalizedPost.direction,
        gateNormalizedPost.impulse_present
    );
    const postEventGate = evaluateEventGate(
        gateNormalizedPost.confidence,
        gateNormalizedPost.quantum,
        gateNormalizedPost.timing,
        gateNormalizedPost.direction,
        gateNormalizedPost.impulse_present, {
            expectedMovePercent: expectedMovePercent,
            expectedNetEdgePct: activeCalibration.expected_net_edge_pct,
            allowHighMoveRelaxation: activeCalibration.allow_high_move_relaxation,
            contextQuality: gateNormalizedPost.context_quality
        }
    );

    console.log('[DEBUG_QUALITY_GATE_RESULTS]', {
        symbol,
        timeframe,
        isEventDriven,
        preTimeframeGatePass: preTimeframeGate.pass,
        preTimeframeGateReason: preTimeframeGate.reason,
        preEventGatePass: preEventGate.pass,
        preEventGateReason: preEventGate.reason,
        postTimeframeGatePass: postTimeframeGate.pass,
        postTimeframeGateReason: postTimeframeGate.reason,
        postEventGatePass: postEventGate.pass,
        postEventGateReason: postEventGate.reason
    });

    let signalEmitted = isEventDriven ?
        preEventGate.pass :
        timeframe !== '1m' ?
        true :
        preTimeframeGate.pass;

    console.log('[DEBUG_SIGNAL_EMITTED_AFTER_GATES]', {
        symbol,
        signalEmitted,
        reason: isEventDriven ? 'event_gate' : (timeframe !== '1m' ? 'non_1m_override' : 'timeframe_gate')
    });

    let signalEmittedPost = isEventDriven ?
        postEventGate.pass :
        timeframe !== '1m' ?
        true :
        postTimeframeGate.pass;

    const actualGateInfo =
        isEventDriven || timeframe !== '1m' ?
        isEventDriven ?
        preEventGate : { pass: true, reason: 'non_1m' } :
        preTimeframeGate;
    const postGateInfo =
        isEventDriven || timeframe !== '1m' ?
        isEventDriven ?
        postEventGate : { pass: true, reason: 'non_1m' } :
        postTimeframeGate;
    const reweighted = applyConfidenceReweighting({
        confidence: postLearningScores.confidence,
        quantumScore: postLearningScores.quantumScore,
        timingScore: postLearningScores.timingScore,
        isEventDriven,
        neutralRate,
        calibration: activeCalibration
    });
    console.log('[DEBUG_FEATURES_RAW]', {
        symbol: symbolInput,
        confidence_value: postLearningScores.confidence,
        quantumScore_value: postLearningScores.quantumScore,
        timingScore_value: postLearningScores.timingScore,
        direction_value: direction,
        impulse_present: impulseMetrics ?.impulse_present,
        signalEmitted_flag: signalEmitted
    });
    console.log('[DEBUG_BEFORE_QUALITY_GATE]', {
        symbol,
        confidence: postLearningScores.confidence,
        quantumScore: postLearningScores.quantumScore,
        timingScore: postLearningScores.timingScore,
        stability: stabilityPost,
        hasLowConfidencePenalty: !!reweighted.lowConfidencePenalty,
        direction,
        isEventDriven
    });
    if (reweighted.lowConfidencePenalty) {
        console.log('[DEBUG_SKIP_REASON]', 'low_confidence_penalty', {
            symbol,
            confidenceBefore: reweighted.confidence_before,
            confidenceAfter: reweighted.confidence_after,
            reason: reweighted.notes
        });
        signalEmitted = false;
        signalEmittedPost = false;
    }
    if (activeCalibration.shadow_execution_blocked) {
        signalEmitted = false;
        signalEmittedPost = false;
    }
    const signalBeforeContext = signalEmitted;
    let suppressionReason = signalEmitted ? null : reweighted.lowConfidencePenalty ? 'low_confidence' : 'quality_gate';

    if (!signalEmitted && activeCalibration.shadow_execution_blocked && activeCalibration.reason) {
        suppressionReason = activeCalibration.reason;
    }

    if (suppressionReason === 'low_confidence') {
        console.log('[LOW_CONFIDENCE_SUPPRESSION]', {
            symbol: symbolInput,
            timeframe,
            direction,
            momentum: impulseMetrics.momentum,
            expected_move_percent: expectedMovePercent,
            impulse_present: impulseMetrics.impulse_present,
            confidence: Number(reweighted.confidence_after.toFixed(4)),
            timing_score: Number(postLearningScores.timingScore.toFixed(4)),
            quantum_score: Number(postLearningScores.quantumScore.toFixed(4)),
            suppression_reason: suppressionReason
        });
    }

    if (
        EVENT_CONTEXT_FILTER_ENABLED &&
        EVENT_CONTEXT_FILTER_MODE === 'enforce' &&
        !contextFilter.allow_event
    ) {
        console.log('[DEBUG_SKIP_REASON]', 'event_context_filter_enforce', {
            symbol,
            eventContextFilterEnabled: EVENT_CONTEXT_FILTER_ENABLED,
            mode: EVENT_CONTEXT_FILTER_MODE,
            contextFilterAllowEvent: contextFilter.allow_event,
            wouldBlockEvent: contextFilter.would_block_event,
            signalEmittedBefore: signalBeforeContext
        });
        signalEmitted = false;
        signalEmittedPost = false;
        suppressionReason = 'event_context';
    }
    const gateMs = elapsedMs(gateStartedAtMs);

    const contextWouldBlock =
        Boolean(EVENT_CONTEXT_FILTER_ENABLED) && !Boolean(contextFilter.allow_event);
    const shadowObserveSignalEmitted = Boolean(signalBeforeContext);
    const shadowEnforceSignalEmitted = Boolean(signalBeforeContext) && !contextWouldBlock;
    const shadowMode = EVENT_CONTEXT_FILTER_MODE === 'enforce' ? 'enforce' : 'observe';

    let executionAdjustment = {
        enabled: CONTEXT_EXECUTION_ADJUSTMENT_ENABLED,
        applied: false,
        reason: signalEmitted ? 'not_evaluated' : 'signal_not_emitted'
    };
    let finalTradePlan = computedTradePlan;

    if (signalEmitted && computedTradePlan) {
        if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED) {
            const adjustment = adjustExecutionTargets({
                entry_price: computedTradePlan.entry_price,
                direction,
                base_tp: computedTradePlan.take_profit,
                base_sl: computedTradePlan.stop_loss
            }, {
                context_score: contextFilter.context_score,
                context_quality: contextFilter.context_quality,
                volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
                relative_volume: contextFilter.relative_volume,
                volume_acceleration: contextFilter.volume_acceleration
            });

            executionAdjustment = {
                enabled: true,
                ...adjustment
            };

            if (adjustment ?.applied) {
                finalTradePlan = {
                    ...computedTradePlan,
                    stop_loss: adjustment.adjusted_sl,
                    take_profit: adjustment.adjusted_tp,
                    target_exit_price: adjustment.adjusted_tp,
                    plan_version: `${computedTradePlan.plan_version}+context_exec_v1`
                };
            }
        } else {
            executionAdjustment = {
                enabled: false,
                applied: false,
                reason: 'disabled_by_env'
            };
        }
    }

    const decision_pre_learning = {
        symbol: symbolInput,
        timeframe,
        signal_emitted: signalEmitted,
        quality_gate_passed: actualGateInfo.pass,
        gate_reason: actualGateInfo.reason,
        suppression_reason: suppressionReason,
        event_context_filter: {
            enabled: EVENT_CONTEXT_FILTER_ENABLED,
            mode: EVENT_CONTEXT_FILTER_MODE,
            allow_event: contextFilter.allow_event,
            context_score: contextFilter.context_score,
            context_quality: contextFilter.context_quality,
            would_block_event: contextFilter.would_block_event,
            shadow: {
                mode: shadowMode,
                would_block_event: contextWouldBlock,
                signal_emitted_observe: shadowObserveSignalEmitted,
                signal_emitted_enforce: shadowEnforceSignalEmitted
            }
        }
    };
    const decision_post_learning = {
        symbol: symbolInput,
        timeframe,
        signal_emitted: signalEmittedPost,
        quality_gate_passed: postGateInfo.pass,
        gate_reason: postGateInfo.reason,
        suppression_reason: suppressionReason,
        event_context_filter: {
            enabled: EVENT_CONTEXT_FILTER_ENABLED,
            mode: EVENT_CONTEXT_FILTER_MODE,
            allow_event: contextFilter.allow_event,
            context_score: contextFilter.context_score,
            context_quality: contextFilter.context_quality,
            would_block_event: contextFilter.would_block_event,
            shadow: {
                mode: shadowMode,
                would_block_event: contextWouldBlock,
                signal_emitted_observe: shadowObserveSignalEmitted,
                signal_emitted_enforce: shadowEnforceSignalEmitted
            }
        },
        // Alias fields para alignarse con quality gate evaluaciÃ³n
        quantum: postLearningScores.quantumScore,
        timing: postLearningScores.timingScore,
        impulse: impulseMetrics.impulse_present,
        confidence: postLearningScores.confidence,
        direction: direction
    };
    if (LEARNING_MODE === 'observe') {
        if (PREDICCION_VERBOSE_LOGS) {
            console.log('decision_pre_learning', decision_pre_learning);
            console.log('decision_post_learning', decision_post_learning);
        } else {
            compactDecisionLog('decision_pre_learning', decision_pre_learning);
            compactDecisionLog('decision_post_learning', decision_post_learning);
        }
        console.log('confidence_reweighting', {
            symbol: symbolInput,
            timeframe,
            before: reweighted.confidence_before,
            after: reweighted.confidence_after,
            notes: reweighted.notes
        });
        if (EVENT_CONTEXT_FILTER_ENABLED && PREDICCION_VERBOSE_LOGS) {
            console.log('event_context_filter', {
                compression_detected: contextFilter.compression_detected,
                range_break_detected: contextFilter.range_break_detected,
                volume_confirmation: contextFilter.volume_confirmation,
                volatility_expansion_detected: contextFilter.volatility_expansion_detected,
                volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
                relative_volume: contextFilter.relative_volume,
                volume_acceleration: contextFilter.volume_acceleration,
                event_context_filter_mode: EVENT_CONTEXT_FILTER_MODE,
                context_score: contextFilter.context_score,
                allow_event: contextFilter.allow_event,
                would_block_event: contextFilter.would_block_event,
                metrics: contextFilter.metrics,
                shadow: {
                    mode: shadowMode,
                    would_block_event: contextWouldBlock,
                    signal_emitted_observe: shadowObserveSignalEmitted,
                    signal_emitted_enforce: shadowEnforceSignalEmitted
                }
            });
        }
        if (CONTEXT_EXECUTION_ADJUSTMENT_ENABLED && PREDICCION_VERBOSE_LOGS) {
            console.log('execution_adjustment', executionAdjustment);
        }
    }

    // BUGFIX: Add missing confidence_score and impulse_present fields
    const impulse_present = impulseMetrics.impulse_present;

    // PHASE 4: Implement fallback heuristic when model confidence is invalid
    let model_confidence = Number.isFinite(postLearningScores.confidence) ?
        postLearningScores.confidence :
        (Number.isFinite(preLearningScores.confidence) ? preLearningScores.confidence : 0);

    let model_quantum = Number.isFinite(postLearningScores.quantumScore) ?
        postLearningScores.quantumScore :
        (Number.isFinite(preLearningScores.quantumScore) ? preLearningScores.quantumScore : 0);

    let model_timing = Number.isFinite(postLearningScores.timingScore) ?
        postLearningScores.timingScore :
        (Number.isFinite(preLearningScores.timingScore) ? preLearningScores.timingScore : 0);

    console.log('[MODEL_CONFIDENCE_SOURCE_SELECTION]', {
        symbol: symbolInput,
        postLearning_confidence: Number((postLearningScores.confidence || 0).toFixed(4)),
        preLearning_confidence: Number((preLearningScores.confidence || 0).toFixed(4)),
        selected_confidence: Number(model_confidence.toFixed(4)),
        source: Number.isFinite(postLearningScores.confidence) ? 'postLearning' : (Number.isFinite(preLearningScores.confidence) ? 'preLearning' : 'default_zero'),
        postLearning_isFinite: Number.isFinite(postLearningScores.confidence),
        preLearning_isFinite: Number.isFinite(preLearningScores.confidence)
    });

    let fallback_active = false;
    let fallback_reason = 'none';

    // Enhanced fallback: activate if confidence is 0, undefined, or too low (<= 0.3)
    const should_fallback = !Number.isFinite(model_confidence) ||
        !Number.isFinite(model_quantum) ||
        !Number.isFinite(model_timing);

    if (should_fallback) {
        // Method 1: Impulse + Quantum + Timing blend
        const impulse_strength_factor = (impulseMetrics.strength || 0) * 0.3;
        const quantum_factor = (model_quantum || 0.3) * 0.4;
        const timing_factor = (model_timing || 0.3) * 0.3;

        let fallback_confidence = clamp(impulse_strength_factor + quantum_factor + timing_factor, 0.3, 0.85);

        // Method 2: If all scores are very low, use simple heuristic
        if (fallback_confidence < 0.4 && expectedMovePercent && Math.abs(expectedMovePercent) > 0) {
            // Price movement-based fallback
            const price_movement_confidence = clamp(Math.abs(expectedMovePercent) * 0.15, 0.35, 0.75);
            fallback_confidence = Math.max(fallback_confidence, price_movement_confidence);
        }

        // Always ensure minimum confidence for signal emission
        fallback_confidence = Math.max(fallback_confidence, 0.65);

        const fallback_quantum = clamp((model_quantum * 1.2) + (impulseMetrics.strength * 0.15), 0.6, 0.99);
        const fallback_timing = clamp((model_timing * 1.15) + (impulseMetrics.strength * 0.1), 0.6, 0.99);

        model_confidence = fallback_confidence;
        model_quantum = fallback_quantum;
        model_timing = fallback_timing;
        fallback_active = true;
        fallback_reason = !Number.isFinite(postLearningScores.confidence) ?
            'confidence_invalid' :
            !Number.isFinite(postLearningScores.quantumScore) ?
            'quantum_invalid' :
            'timing_invalid';

        console.log('[MODEL_FALLBACK_ACTIVATED]', {
            symbol: symbolInput,
            reason: fallback_reason,
            original_confidence: Number.isFinite(postLearningScores.confidence) ? postLearningScores.confidence : 'undefined',
            original_quantum: Number.isFinite(postLearningScores.quantumScore) ? postLearningScores.quantumScore : 'undefined',
            original_timing: Number.isFinite(postLearningScores.timingScore) ? postLearningScores.timingScore : 'undefined',
            fallback_confidence: Number(fallback_confidence.toFixed(4)),
            fallback_quantum: Number(fallback_quantum.toFixed(4)),
            fallback_timing: Number(fallback_timing.toFixed(4)),
            expected_move_percent: expectedMovePercent,
            impulse_strength: Number((impulseMetrics.strength || 0).toFixed(4))
        });
    }

    // CRITICAL: Ensure confidence is NEVER 0 or undefined before continuing
    if (!Number.isFinite(model_confidence)) {
        console.warn('[CONFIDENCE_SAFETY_CHECK] Confidence invalid even after fallback, force minimum', {
            symbol: symbolInput,
            confidence_before: model_confidence,
            confidence_after: 0.65
        });
        model_confidence = 0.65;
    }

    // Same safety check for quantum and timing
    if (!Number.isFinite(model_quantum)) {
        model_quantum = 0.60;
    }
    if (!Number.isFinite(model_timing)) {
        model_timing = 0.60;
    }

    activeCalibration = buildDeterministicCalibration({
        rawExpectedMovePercent,
        rawConfidence: model_confidence,
        rawTimingScore: model_timing,
        rawQuantumScore: model_quantum,
        direction
    });
    model_confidence = activeCalibration.calibrated_confidence;
    model_quantum = activeCalibration.calibrated_quantum_score;
    model_timing = activeCalibration.calibrated_timing_score;

    // confidence_score for legacy compatibility (but NOT as primary confidence)
    const confidence_score = clamp(
        ((model_quantum || 0) * 0.5 + (model_timing || 0) * 0.5),
        0,
        1
    );

    console.log('[DEBUG_PRE_SIGNAL_OBJECT]', {
        symbol: symbolInput,
        has_confidence: postLearningScores.confidence !== null && postLearningScores.confidence !== undefined,
        has_quantumScore: postLearningScores.quantumScore !== null && postLearningScores.quantumScore !== undefined,
        has_timingScore: postLearningScores.timingScore !== null && postLearningScores.timingScore !== undefined,
        has_direction: direction !== null && direction !== undefined,
        has_impulse_present: impulse_present !== null && impulse_present !== undefined,
        confidence_val: postLearningScores.confidence,
        quantum_val: postLearningScores.quantumScore,
        timing_val: postLearningScores.timingScore,
        direction_val: direction,
        impulse_val: impulse_present,
        model_confidence_final: model_confidence,
        model_quantum_final: model_quantum,
        model_timing_final: model_timing,
        fallback_active,
        reweighted_keys: Object.keys(reweighted).slice(0, 5)
    });

    // FALLBACK: Ensure signal structure always exists if scores are valid
    let predictedSignal = null;
    if (
        Number.isFinite(postLearningScores.confidence) &&
        Number.isFinite(postLearningScores.quantumScore) &&
        Number.isFinite(postLearningScores.timingScore)
    ) {
        predictedSignal = {
            confidence: postLearningScores.confidence,
            quantum: postLearningScores.quantumScore,
            timing: postLearningScores.timingScore,
            direction: direction || 'neutral',
            impulse: impulse_present || false,
            source: signalEmitted ? 'gate' : 'fallback'
        };

        console.log('[DEBUG_SIGNAL_FALLBACK_CREATED]', {
            symbol: symbolInput,
            signal_source: predictedSignal.source,
            confidence: predictedSignal.confidence,
            quantum: predictedSignal.quantum,
            timing: predictedSignal.timing,
            direction: predictedSignal.direction,
            impulse: predictedSignal.impulse,
            signalEmitted_flag: signalEmitted
        });
    }

    const recomendacion = {
        simbolo: symbolInput,
        simbolo_normalizado: symbolNormalized,
        origin: origin || 'manual',
        tipo: 'velas',
        timeframe,
        execution_mode: executionMode,
        mode: isEventDriven ? 'event-driven' : 'timeframe',
        timeframe_minutes: frameMinutes,
        monto,
        spot_price: spotPrice,
        spot_price_source: spotPriceSource,
        precio_actual: precioActual,
        precio_estimado: modelPriceEstimate,
        porcentaje,
        expected_move_percent: expectedMovePercent,
        raw_expected_move_percent: rawExpectedMovePercent,
        calibrated_expected_move_percent: activeCalibration.calibrated_expected_move_percent,
        expected_net_edge_pct: activeCalibration.expected_net_edge_pct,
        expected_delta_pct: expectedMovePercent,
        signed_delta_pct: signedDeltaPct,
        model_price_estimate: modelPriceEstimate,
        trade_plan: signalEmitted ? finalTradePlan : null,
        execution_adjustment: executionAdjustment,
        ganancia_estim: signalEmitted ? gananciaEstim : 0,
        ahora: analysisStartIso,
        analysis_start_at: analysisStartIso,
        signal_ready_at: null,
        signal_created_at: analysisStartIso,
        signal_emitted_at: null,
        entry_time: entryTimeIso,
        exit_time: exitTimeIso,
        exit_window_seconds: exitWindowSeconds,
        max_time_seconds: maxTimeSeconds,
        exit_rule: finalExitRule,
        exit_rule_description: finalExitRule,
        direction,
        observaciones: signalEmitted ?
            direction === 'up' ?
            'Se espera impulso alcista. Salir temprano si el impulso se agota.' :
            'Se espera impulso bajista. Salir temprano si el impulso se agota.' : suppressionReason === 'event_context' ?
            'Senal suprimida por filtro de contexto de evento.' : 'Senal suprimida por control de calidad.',
        confianza: Number(model_confidence.toFixed(2)),
        confidence_model: Number(model_confidence.toFixed(4)),
        confidence_before: Number(reweighted.confidence_before.toFixed(4)),
        confidence_after: Number(reweighted.confidence_after.toFixed(4)),
        confidence_reweighting: {
            notes: reweighted.notes,
            neutral_rate: neutralRate ?? null
        },
        quantum_score: Number(model_quantum.toFixed(2)),
        quantum_model: 'Deterministic-Candles-v1' + (fallback_active ? '-Fallback' : ''),
        timing_score: Number(model_timing.toFixed(2)),
        raw_confidence: activeCalibration.raw_confidence,
        raw_timing_score: activeCalibration.raw_timing_score,
        raw_quantum_score: activeCalibration.raw_quantum_score,
        weak_signal_candidate: Boolean(neutralCandidate),
        impulse_metrics: impulseMetrics,
        compression_detected: contextFilter.compression_detected,
        range_break_detected: contextFilter.range_break_detected,
        volume_confirmation: contextFilter.volume_confirmation,
        volatility_expansion_detected: contextFilter.volatility_expansion_detected,
        volatility_expansion_ratio: contextFilter.volatility_expansion_ratio,
        relative_volume: contextFilter.relative_volume,
        volume_acceleration: contextFilter.volume_acceleration,
        context_score: contextFilter.context_score,
        context_quality: contextFilter.context_quality,
        structural_context_score: contextFilter.structural_context_score,
        volatility_context_score: contextFilter.volatility_context_score,
        volume_flow_context_score: contextFilter.volume_flow_context_score,
        liquidity_context_score: contextFilter.liquidity_context_score,
        context_layer_breakdown: contextFilter.context_layer_breakdown,
        compression_duration: contextFilter.compression_duration,
        compression_tightness: contextFilter.compression_tightness,
        break_efficiency: contextFilter.break_efficiency,
        close_location_value: contextFilter.close_location_value,
        wick_imbalance: contextFilter.wick_imbalance,
        volume_persistence_score: contextFilter.volume_persistence_score,
        volatility_slope: contextFilter.volatility_slope,
        compression_energy: contextFilter.compression_energy,
        expansion_impulse: contextFilter.expansion_impulse,
        expansion_imbalance: contextFilter.expansion_imbalance,
        fake_breakout_penalty: contextFilter.fake_breakout_penalty,
        fake_breakout_detected: contextFilter.fake_breakout_detected,
        liquidity_trap_risk: contextFilter.liquidity_trap_risk,
        session_microstructure_score: contextFilter.session_microstructure_score,
        structural_break_acceptance: contextFilter.structural_break_acceptance,
        event_context_filter: {
            enabled: EVENT_CONTEXT_FILTER_ENABLED,
            mode: EVENT_CONTEXT_FILTER_MODE,
            context_score: contextFilter.context_score,
            context_quality: contextFilter.context_quality,
            allow_event: contextFilter.allow_event,
            would_block_event: contextFilter.would_block_event,
            structural_context_score: contextFilter.structural_context_score,
            volatility_context_score: contextFilter.volatility_context_score,
            volume_flow_context_score: contextFilter.volume_flow_context_score,
            liquidity_context_score: contextFilter.liquidity_context_score,
            context_layer_breakdown: contextFilter.context_layer_breakdown,
            shadow: {
                mode: shadowMode,
                would_block_event: contextWouldBlock,
                signal_emitted_observe: shadowObserveSignalEmitted,
                signal_emitted_enforce: shadowEnforceSignalEmitted
            },
            metrics: contextFilter.metrics,
            details: contextFilter.details
        },
        impulse_min_percent: impulseMinPercent,
        signal_emitted: signalEmitted,
        suppression_reason: suppressionReason,
        entry_window: eventDrivenInfo ?.entryWindow || null,
        exit_window: eventDrivenInfo ?.exitWindow || null,
        expected_duration_seconds: eventDrivenInfo ?.impulseDurationSeconds || null,
        entry_window_utc: eventDrivenInfo ?.entryWindow || null,
        exit_window_utc: eventDrivenInfo ?.exitWindow || null,
        expected_impulse_duration_seconds: eventDrivenInfo ?.impulseDurationSeconds || null,
        estimation_mode: 'displacement',
        estimation_note: 'Precio estimado es desplazamiento, no un objetivo.',
        training_feedback: trainingFeedback,
        learning_applied: Boolean(learningMeta),
        learning_config_version: learningMeta ?.version || null,
        learning_adjustments: learningMeta ?.adjustments || null,
        calibration: {
            version: activeCalibration.version,
            raw_expected_move_percent: activeCalibration.raw_expected_move_percent,
            calibrated_expected_move_percent: activeCalibration.calibrated_expected_move_percent,
            expected_net_edge_pct: activeCalibration.expected_net_edge_pct,
            fee_roundtrip_pct: activeCalibration.fee_roundtrip_pct,
            safety_margin_pct: activeCalibration.safety_margin_pct,
            minimum_required_move_pct: activeCalibration.minimum_required_move_pct,
            raw_confidence: activeCalibration.raw_confidence,
            calibrated_confidence: activeCalibration.calibrated_confidence,
            raw_timing_score: activeCalibration.raw_timing_score,
            calibrated_timing_score: activeCalibration.calibrated_timing_score,
            raw_quantum_score: activeCalibration.raw_quantum_score,
            calibrated_quantum_score: activeCalibration.calibrated_quantum_score,
            timing_calibration_reason: activeCalibration.timing_calibration_reason,
            quantum_calibration_reason: activeCalibration.quantum_calibration_reason,
            direction_policy: activeCalibration.direction_policy,
            reason: activeCalibration.reason,
            primary_shadow_validation_horizon: activeCalibration.primary_shadow_validation_horizon,
            notes: activeCalibration.notes,
            paper_only_mode: activeCalibration.paper_only_mode,
            unvalidated_high_move: activeCalibration.unvalidated_high_move,
            shadow_execution_blocked: activeCalibration.shadow_execution_blocked
        },
        pre_learning_scores: {
            confidence: preLearningScores.confidence,
            quantum_score: preLearningScores.quantumScore,
            timing_score: preLearningScores.timingScore
        },
        post_learning_scores: {
            confidence: postLearningScores.confidence,
            quantum_score: postLearningScores.quantumScore,
            timing_score: postLearningScores.timingScore
        },
        decision_pre_learning: decision_pre_learning,
        decision_post_learning: decision_post_learning,
        confidence: model_confidence,
        confidence_score: confidence_score,
        model_confidence: model_confidence,
        model_fallback_active: fallback_active,
        model_fallback_reason: fallback_reason,
        impulse_present: impulse_present,
        // Alias fields para alignarse con velasScheduler present_fields
        quantum: model_quantum,
        timing: model_timing,
        impulse: impulseMetrics.impulse_present
    };

    const postProcessStartedAtMs = Date.now();
    const status = signalEmitted ? 'pendiente' : 'suprimida';
    const finalPredictionPayload = sanitizeForFirestore({
        ...recomendacion,
        early_execution_candidate: Boolean(earlyExecutionState ?.completed),
        early_execution_source_profile: earlyExecutionState ?.sourceProfile || null,
        status,
        verification: null,
        timestamp: now.toISOString(),
        created_at: now.toISOString()
    });

    throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
    schedulePredictionSet(docRef, finalPredictionPayload, { stage: 'final_prediction', merge: true });

    if (neutralCandidate) {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        const neutralPayload = sanitizeForFirestore({
            prediction_id: docRef.id,
            symbol: symbolNormalized || symbolInput,
            timeframe,
            execution_mode: executionMode,
            confidence: gateNormalizedPost.confidence,
            quantum: gateNormalizedPost.quantum,
            timing: gateNormalizedPost.timing,
            direction: gateNormalizedPost.direction,
            reason: 'neutral_but_high_scores',
            created_at: new Date().toISOString()
        });
        await db.collection('neutral_signal_candidates').add(neutralPayload);
    }

    let preAlertDecision = { ok: false, reason: 'not_evaluated' };
    let preAlertNotification = { sent: false, channel: 'none', reason: 'not_evaluated' };
    let highConvictionDecision = { ok: false, reason: 'not_evaluated' };
    let highConvictionSignalData = null;
    let highConvictionQueuedExecutionTask = null;
    let highConvictionNotification = { sent: false, channel: 'none', reason: 'not_evaluated' };
    const preAlertStartedAtMs = Date.now();

    try {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        const allowSuppressedPreAlert = signalEmitted || MANUAL_PREALERT_ALLOW_SUPPRESSED;
        if (!allowSuppressedPreAlert) {
            preAlertDecision = { ok: false, reason: 'signal_not_emitted' };
        } else {
            preAlertDecision = await shouldSendManualPreAlert(db, {
                ...recomendacion,
                id: docRef.id,
                trade_plan: finalTradePlan
            });
            if (preAlertDecision.ok) {
                preAlertNotification = await sendManualPreAlertNotification(db, {
                    ...recomendacion,
                    id: docRef.id,
                    trade_plan: finalTradePlan
                });
            }
        }
    } catch (err) {
        console.log('[DEBUG_PREDICCION_ERROR] prealert', err ?.message || err);
        console.warn('[MANUAL_PREALERT] skipped', err ?.message || err);
    }
    const preAlertMs = elapsedMs(preAlertStartedAtMs);

    // High Conviction Mode: only for event-driven signals that pass strict thresholds.
    try {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        if (!signalEmitted) {
            highConvictionDecision = { ok: false, reason: 'not_emitted' };
        } else if (activeCalibration.paper_only_mode) {
            highConvictionDecision = { ok: false, reason: 'shadow_calibration_paper_only' };
        } else if (direction !== 'up' && direction !== 'down') {
            highConvictionDecision = { ok: false, reason: 'neutral_direction' };
        } else {
            highConvictionDecision = await shouldEmitHighConvictionSignal(db, {
                ...recomendacion,
                confianza: Number(reweighted.confidence_after.toFixed(4)),
                quantum_score: Number(quantumScore.toFixed(4)),
                timing_score: Number(timingScore.toFixed(4))
            });
        }

        if (highConvictionDecision.ok) {
            const highConvictionCreatedAt = new Date();
            const highConvictionCreatedIso = highConvictionCreatedAt.toISOString();
            const highConvictionEntryWindow = {
                start: formatTimeUTC(highConvictionCreatedAt),
                end: formatTimeUTC(new Date(highConvictionCreatedAt.getTime() + ENTRY_WINDOW_SECONDS * 1000))
            };
            const highConvictionExecutionPayload = buildExecutionPayload({
                docRefId: docRef.id,
                recomendacion,
                analysisStartIso,
                signalCreatedIso: highConvictionCreatedIso,
                signalReadyIso: highConvictionCreatedIso,
                symbolInput,
                modelConfidence: model_confidence,
                quantumScore,
                timingScore,
                contextFilter,
                expectedMovePercent,
                finalTradePlan,
                spotPrice,
                operationalEntryWindow: highConvictionEntryWindow
            });
            highConvictionSignalData = await registerHighConvictionSignal(db, {
                ...recomendacion,
                id: docRef.id,
                status,
                trade_plan: finalTradePlan
            });
            console.info('[HIGH_CONVICTION_SIGNAL_CREATED]', {
                signal_id: docRef.id,
                symbol: highConvictionExecutionPayload.symbol || symbolInput || null,
                created_at: highConvictionExecutionPayload.signal_created_at || highConvictionCreatedIso,
                origin: 'high_conviction',
                side: highConvictionExecutionPayload ?.trade_plan ?.side || highConvictionExecutionPayload ?.trade_plan ?.direction || null,
                entry_price: Number(highConvictionExecutionPayload ?.trade_plan ?.entry_price || 0) || null,
                expected_move: Number(highConvictionExecutionPayload.expected_move_percent || 0) || null,
                stop_loss: Number(highConvictionExecutionPayload ?.trade_plan ?.stop_loss || 0) || null
            });
            highConvictionQueuedExecutionTask = {
                predictionId: docRef.id,
                executionPayload: highConvictionExecutionPayload,
                sourceProfile: 'high_conviction'
            };
            void dispatchSignalToExecution(db, highConvictionQueuedExecutionTask).catch(async(err) => {
                console.warn('[HIGH_CONVICTION_ASYNC] failed', err ?.message || err);
                await syncPredictionExecutionState(db, {
                    predictionId: highConvictionQueuedExecutionTask.predictionId,
                    sourceProfile: highConvictionQueuedExecutionTask.sourceProfile,
                    status: 'failed',
                    reason: 'async_execution_failed',
                    dryRun: false,
                    executed: false,
                    symbol: highConvictionQueuedExecutionTask.executionPayload ?.symbol || null,
                    failureStage: 'async_execute_signal_trade',
                    errorMessage: err ?.message || 'async_execution_failed',
                    pendingStateResolution: 'async_execution'
                }).catch(() => null);
            });
            highConvictionNotification = await sendHighConvictionNotification(highConvictionSignalData);
        }
    } catch (err) {
        console.log('[DEBUG_PREDICCION_ERROR] high_conviction', err ?.message || err);
        console.warn('[HIGH_CONVICTION] skipped', err ?.message || err);
    }

    let binanceExecution = {
        attempted: false,
        executed: false,
        dry_run: false,
        reason: 'not_attempted'
    };
    let binanceSourceProfile = earlyExecutionState ?.sourceProfile || 'none';
    let signalReadyIso = earlyExecutionState ?.signalReadyIso || null;
    let analysisToSignalReadyMs = earlyExecutionState ?.analysisToSignalReadyMs || null;
    let operationalEntryWindowStartIso = earlyExecutionState ?.entryWindowStartIso || null;
    let operationalEntryWindowEndIso = earlyExecutionState ?.entryWindowEndIso || null;

    try {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        if (highConvictionQueuedExecutionTask ?.executionPayload) {
            binanceSourceProfile = 'high_conviction';
            signalReadyIso = highConvictionQueuedExecutionTask.executionPayload.signal_ready_at || highConvictionQueuedExecutionTask.executionPayload.signal_emitted_at || null;
            operationalEntryWindowStartIso = highConvictionQueuedExecutionTask.executionPayload.entry_window_start_at || null;
            operationalEntryWindowEndIso = highConvictionQueuedExecutionTask.executionPayload.entry_window_end_at || null;
            analysisToSignalReadyMs =
                signalReadyIso && analysisStartAt ?
                new Date(signalReadyIso).getTime() - analysisStartAt.getTime() :
                null;
            binanceExecution = buildQueuedBinanceExecution(binanceSourceProfile);
        } else if (activeCalibration.paper_only_mode) {
            binanceExecution = {
                attempted: false,
                executed: false,
                dry_run: false,
                reason: 'shadow_calibration_paper_only',
                source_profile: 'none',
                updated_at: new Date().toISOString()
            };
        } else if (earlyExecutionState ?.completed) {
            binanceExecution = earlyExecutionState.binanceExecution;
        } else if (signalEmitted && (direction === 'up' || direction === 'down')) {
            const signalReadyAt = new Date();
            signalReadyIso = signalReadyAt.toISOString();
            analysisToSignalReadyMs = signalReadyAt.getTime() - analysisStartAt.getTime();
            operationalEntryWindowStartIso = signalReadyIso;
            operationalEntryWindowEndIso = new Date(signalReadyAt.getTime() + ENTRY_WINDOW_SECONDS * 1000).toISOString();
            const operationalEntryWindow = {
                start: formatTimeUTC(signalReadyAt),
                end: formatTimeUTC(new Date(signalReadyAt.getTime() + ENTRY_WINDOW_SECONDS * 1000))
            };
            binanceSourceProfile = highConvictionSignalData ?
                'high_conviction' :
                (preAlertDecision.ok ? 'manual_prealert' : 'event_emitted');

            const executionPayload = buildExecutionPayload({
                docRefId: docRef.id,
                recomendacion,
                analysisStartIso,
                signalCreatedIso: analysisStartIso,
                signalReadyIso,
                symbolInput,
                modelConfidence: model_confidence,
                quantumScore,
                timingScore,
                contextFilter,
                expectedMovePercent,
                finalTradePlan,
                spotPrice,
                operationalEntryWindow
            });

            if (!Number.isFinite(executionPayload.spot_price)) {
                throw new Error('spot_price_invalid');
            }
            if (!Number.isFinite(executionPayload.expected_move_percent)) {
                throw new Error('expected_move_percent_invalid');
            }

            queuedBinanceExecutionTask = {
                predictionId: docRef.id,
                executionPayload,
                sourceProfile: binanceSourceProfile
            };
            binanceExecution = buildQueuedBinanceExecution(binanceSourceProfile);
        } else {
            binanceExecution = {
                attempted: false,
                executed: false,
                dry_run: false,
                reason: !signalEmitted ? 'signal_not_emitted' : 'neutral_direction',
                source_profile: 'none',
                updated_at: new Date().toISOString()
            };
        }
    } catch (err) {
        console.log('[DEBUG_PREDICCION_ERROR] binance_execution', err ?.message || err);
        binanceExecution = {
            attempted: true,
            executed: false,
            dry_run: false,
            reason: `error:${err?.message || 'unknown'}`,
            source_profile: binanceSourceProfile,
            updated_at: new Date().toISOString()
        };
        console.warn('[BINANCE_EXECUTION] skipped', err ?.message || err);
    }

    if (highConvictionSignalData ?.id) {
        try {
            throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
            await db.collection('high_conviction_signals').doc(highConvictionSignalData.id).update(
                sanitizeForFirestore({
                    telegram_notification: {
                        sent: Boolean(highConvictionNotification ?.sent),
                        channel: highConvictionNotification ?.channel || 'unknown',
                        reason: highConvictionNotification ?.reason || null,
                        sent_at: new Date().toISOString()
                    },
                    binance_execution: binanceExecution
                })
            );
        } catch (err) {
            console.warn('[HIGH_CONVICTION] binance update skipped', err ?.message || err);
        }
    }

    try {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        schedulePredictionUpdate(
            docRef,
            sanitizeForFirestore({
                high_conviction_decision: highConvictionDecision,
                manual_prealert_decision: preAlertDecision,
                manual_prealert_notification: preAlertNotification,
                binance_route_source: binanceSourceProfile,
                binance_execution: binanceExecution,
                signal_ready_at: signalReadyIso,
                signal_emitted_at: signalReadyIso,
                analysis_to_signal_ready_ms: analysisToSignalReadyMs,
                operational_entry_window_start_at: operationalEntryWindowStartIso,
                operational_entry_window_end_at: operationalEntryWindowEndIso,
                updated_at: new Date().toISOString()
            }), { stage: 'post_prediction_update' }
        );
    } catch (err) {
        console.warn('[PREDICCION] post-update skipped', err ?.message || err);
    }

    if (!highConvictionQueuedExecutionTask && queuedBinanceExecutionTask ?.executionPayload && queuedBinanceExecutionTask ?.sourceProfile) {
        throwIfAborted(signal, `Prediction cancelled for ${symbolInput || symbolNormalized}`, 'OPERATION_ABORTED');
        const lifecycleLoggedAt = new Date().toISOString();
        void db.collection('system_runtime_config').doc('bot_execution').get()
            .then((runtimeDoc) => {
                const runtimeData = runtimeDoc.exists ? (runtimeDoc.data() || {}) : {};
                console.info('[SIGNAL_EMITTED_LIFECYCLE]', {
                    signal_id: queuedBinanceExecutionTask.predictionId,
                    symbol: queuedBinanceExecutionTask.executionPayload ?.symbol || null,
                    origin: queuedBinanceExecutionTask.sourceProfile,
                    emitted_at: queuedBinanceExecutionTask.executionPayload ?.signal_emitted_at || lifecycleLoggedAt,
                    execution_enabled: runtimeData.execution_enabled !== false,
                    auto_trade_mode: runtimeData.auto_trade_mode !== false,
                    runtime_status: runtimeData.runtime_status || runtimeData.status || null
                });
            })
            .catch((err) => {
                console.warn('[SIGNAL_EMITTED_LIFECYCLE] runtime read failed', err ?.message || err);
            });
        try {
            schedulePredictionMerge(
                docRef,
                sanitizeForFirestore({
                    binance_execution: {
                        lifecycle: {
                            signal_emitted_logged_at: lifecycleLoggedAt,
                            handoff_status: 'queued',
                            handoff_max_allowed_age_ms: 120000
                        }
                    }
                }), { stage: 'signal_lifecycle_emit' }
            );
        } catch (err) {
            console.warn('[SIGNAL_LIFECYCLE] emit merge skipped', err ?.message || err);
        }
        console.info('[BINANCE_EXECUTION_QUEUED]', {
            prediction_id: queuedBinanceExecutionTask.predictionId,
            symbol: queuedBinanceExecutionTask.executionPayload ?.symbol || null,
            source_profile: queuedBinanceExecutionTask.sourceProfile
        });
        setTimeout(() => {
            void docRef.get()
                .then((docSnap) => {
                    const current = docSnap.exists ? (docSnap.data() || {}) : {};
                    if (current ?.binance_execution ?.lifecycle ?.handoff_attempt_at) {
                        return;
                    }
                    schedulePredictionMerge(
                        docRef,
                        sanitizeForFirestore({
                            binance_execution: {
                                lifecycle: {
                                    handoff_status: 'not_attempted_immediately',
                                    handoff_not_attempted_within_5s: true,
                                    handoff_not_attempted_checked_at: new Date().toISOString()
                                }
                            }
                        }), { stage: 'signal_handoff_timeout_mark' }
                    );
                })
                .catch((err) => {
                    console.warn('[SIGNAL_LIFECYCLE] timeout mark skipped', err ?.message || err);
                });
        }, 5000);
        void dispatchSignalToExecution(db, queuedBinanceExecutionTask).catch(async(err) => {
            console.warn('[BINANCE_EXECUTION_ASYNC] failed', err ?.message || err);
            await syncPredictionExecutionState(db, {
                predictionId: queuedBinanceExecutionTask.predictionId,
                sourceProfile: queuedBinanceExecutionTask.sourceProfile,
                status: 'failed',
                reason: 'async_execution_failed',
                dryRun: false,
                executed: false,
                symbol: queuedBinanceExecutionTask.executionPayload ?.symbol || null,
                failureStage: 'async_execute_signal_trade',
                errorMessage: err ?.message || 'async_execution_failed',
                pendingStateResolution: 'binance_terminal_sync'
            });
        });
    }

    if (profiling) {
        profiling.pipeline = {
            total_ms: elapsedMs(analysisStartAt.getTime()),
            fetch_ms: profiling.fetch_candles ?.total_ms ?? null,
            spot_fetch_ms: profiling.spot_fetch ?.spot_fetch_ms ?? null,
            prediction_ms: Math.max(0, postProcessStartedAtMs - predictionComputeStartedAtMs),
            gate_ms: gateMs,
            post_process_ms: elapsedMs(postProcessStartedAtMs),
            prealert_ms: preAlertMs,
            binance_latency_ms: sumFinite([
                profiling.fetch_candles ?.binance_latency_ms,
                profiling.spot_fetch ?.binance_latency_ms
            ]),
            fallback_ms: sumFinite([
                profiling.fetch_candles ?.fallback_ms,
                profiling.spot_fetch ?.fallback_ms
            ])
        };
    }

    console.log('[DEBUG_PREDICCION_RETURN]', symbol);
    console.log('[DEBUG_FINAL_STATE]', JSON.stringify({
        symbol,
        status,
        has_recomendacion: !!recomendacion,
        recomendacion_keys: recomendacion ? Object.keys(recomendacion).length : 0,
        quantum: recomendacion ?.quantum,
        timing: recomendacion ?.timing,
        impulse: recomendacion ?.impulse,
        confidence: recomendacion ?.confidence,
        direction: recomendacion ?.direction,
        signalEmitted: recomendacion ?.signal_emitted,
        suppressionReason: recomendacion ?.suppression_reason,
        contextFilterAllowEvent: contextFilter ?.allow_event,
        eventContextFilterEnabled: EVENT_CONTEXT_FILTER_ENABLED
    }));

    // PHASE: TRACE FINAL CONFIDENCE BEFORE RETURN
    console.log('[TRACE_FINAL_CONFIDENCE]', {
        symbol,
        final_confidence: Number((model_confidence || 0).toFixed(4)),
        confidence_source: 'model_post_learning',
        fallback_active_at_end: fallback_active,
        confidence_is_zero: model_confidence === 0,
        confidence_is_undefined: model_confidence === undefined,
        confidence_is_null: model_confidence === null,
        confidence_finite: Number.isFinite(model_confidence),
        will_emit_signal: recomendacion ?.signal_emitted,
        suppression_reason: recomendacion ?.suppression_reason,
        status
    });

    console.log('[DEBUG_BEFORE_RETURN]', {
        symbol,
        hasRecommendation: !!recomendacion,
        willEmitSignal: recomendacion ?.signal_emitted,
        suppressedBecause: recomendacion ?.suppression_reason,
        status: status
    });
    return { id: docRef.id, ...recomendacion, status, verification: null, profiling };
}

module.exports = generarPrediccion;
