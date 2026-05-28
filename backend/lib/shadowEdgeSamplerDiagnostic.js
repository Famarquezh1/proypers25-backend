const { FieldValue } = require('firebase-admin/firestore');
const { getBinanceBotConfig } = require('./binanceBotConfig');
const {
    createExecutionIntent,
    getExchangeInfoCacheStatus
} = require('./binanceFuturesExecutor');
const { fetchCandles } = require('../services/dataSources/fetchCandles');

const SHADOW_TRADE_CANDIDATES_COLLECTION = 'shadow_trade_candidates';
const SHADOW_TRADE_RESULTS_COLLECTION = 'shadow_trade_results';
const DEFAULT_WINDOW_HOURS = 12;
const DEFAULT_MAX_DOCS = 300;
const SHADOW_BREAK_EVEN_FEE_PCT = 0.10;
const SHADOW_MAX_HOLD_MINUTES = Math.max(1, Number(process.env.BINANCE_POSITION_MAX_HOLD_MINUTES || 10));
const SHADOW_EVENT_TIMEOUT_RATIO = Math.min(
    0.95,
    Math.max(0.5, Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_TIMEOUT_RATIO || 0.8))
);
const SHADOW_EVENT_TIMEOUT_NEGATIVE_PNL_PCT = Number(
    process.env.BINANCE_EVENT_PRE_MAX_HOLD_NEGATIVE_PNL_PCT || -0.03
);
const SHADOW_EVENT_TIMEOUT_MAX_MFE_PCT = Math.max(
    0,
    Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_MAX_MFE_PCT || 0.03)
);
const SHADOW_EVENT_TIMEOUT_DISTANCE_TO_TP_PCT = Math.max(
    0,
    Number(process.env.BINANCE_EVENT_PRE_MAX_HOLD_DISTANCE_TO_TP_PCT || 0.8)
);
const DEFAULT_ENTRY_DELAY_MS = 90000;
const SUPPORTED_ORIGINS = new Set(['event_emitted', 'high_conviction', 'manual_prealert']);

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

function sum(values = []) {
    return values
        .map((value) => Number(value))
        .filter(Number.isFinite)
        .reduce((acc, value) => acc + value, 0);
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

function normalizeSymbol(value) {
    return String(value || '').trim().toUpperCase() || null;
}

function normalizeOrigin(value) {
    return String(value || '').trim().toLowerCase() || 'unknown';
}

function normalizeSide(signal = {}) {
    const explicit = String(signal.side || signal.trade_plan ?.side || '').toUpperCase();
    if (explicit === 'BUY' || explicit === 'SELL') return explicit;
    const direction = String(signal.direction || signal.direccion || '').toLowerCase();
    if (direction === 'up' || direction === 'long' || direction === 'buy') return 'BUY';
    if (direction === 'down' || direction === 'short' || direction === 'sell') return 'SELL';
    return null;
}

function increment(bucket, key, amount = 1) {
    const normalized = String(key || 'unknown');
    bucket[normalized] = (bucket[normalized] || 0) + amount;
}

function unique(values = []) {
    return Array.from(new Set(values.filter(Boolean)));
}

function getWindowBounds(options = {}) {
    const until = parseDateLike(options.until) || new Date();
    const sinceExplicit = parseDateLike(options.since);
    const hours = Math.max(1, Number(options.hours || DEFAULT_WINDOW_HOURS));
    const since = sinceExplicit || new Date(until.getTime() - hours * 60 * 60 * 1000);
    return { since, until };
}

function buildShadowDocId(signalId, origin) {
    return `${String(signalId || 'unknown')}__${String(origin || 'unknown')}`;
}

function buildEffectiveShadowConfig(config = {}, origin = 'event_emitted') {
    const profile = config ?.execution_profiles ?.[origin] || {};
    return {
        ...config,
        ...profile,
        execution_profiles: config ?.execution_profiles || {},
        _config_source: `shadow:${origin}`
    };
}

async function loadMarginLeverageReadinessSnapshot(db, symbols = []) {
    const normalized = unique(symbols.map((symbol) => normalizeSymbol(symbol)));
    const doc = await db.collection('system_runtime_config').doc('margin_leverage_readiness').get().catch(() => null);
    const payload = doc ?.exists ? (doc.data() || {}) : {};
    const sourceSymbols = payload ?.symbols && typeof payload.symbols === 'object' ? payload.symbols : {};
    const perSymbol = normalized.map((symbol) => {
        const row = sourceSymbols ?.[symbol] || {};
        return {
            symbol,
            ready: row.ready === true,
            margin_type: row.margin_type || null,
            applied_leverage: toNumber(row.leverage ?? row.applied_leverage ?? row.requested_leverage, null),
            last_error: row.last_error || null
        };
    });
    return {
        symbols_total: perSymbol.length,
        ready_count: perSymbol.filter((row) => row.ready === true).length,
        per_symbol: perSymbol
    };
}

function resolveSignalTimestamp(row = {}) {
    return (
        parseDateLike(row.signal_emitted_at) ||
        parseDateLike(row.signal_ready_at) ||
        parseDateLike(row.created_at) ||
        parseDateLike(row.timestamp) ||
        null
    );
}

function resolveSignalTimestampField(row = {}) {
    if (parseDateLike(row.signal_emitted_at)) return 'signal_emitted_at';
    if (parseDateLike(row.signal_ready_at)) return 'signal_ready_at';
    if (parseDateLike(row.created_at)) return 'created_at';
    if (parseDateLike(row.timestamp)) return 'timestamp';
    return null;
}

function resolveSignalPrice(row = {}) {
    return toNumber(
        row.spot_price ??
        row.precio_actual ??
        row.trade_plan ?.entry_price ??
        row.entry_price,
        null
    );
}

function resolveExpectedMove(row = {}) {
    return toNumber(
        row.expected_move_percent ??
        row.expected_move ??
        row.trade_plan ?.expected_move_percent,
        null
    );
}

function resolveTradePlan(row = {}) {
    return row.trade_plan && typeof row.trade_plan === 'object' ?
        row.trade_plan : {
            side: normalizeSide(row),
            entry_price: resolveSignalPrice(row),
            stop_loss: toNumber(row.stop_loss ?? row.sl, null),
            take_profit: toNumber(row.take_profit ?? row.tp, null)
        };
}

function resolveSignalPayload(row = {}) {
    const signalAt = resolveSignalTimestamp(row);
    const tradePlan = resolveTradePlan(row);
    return {
        ...row,
        id: row.id,
        prediction_id: row.id,
        symbol: normalizeSymbol(row.symbol || row.simbolo),
        source_profile: normalizeOrigin(row.binance_route_source || row.origin || row.source_profile || 'event_emitted'),
        signal_created_at: signalAt ?.toISOString() || row.created_at || row.timestamp || null,
        signal_emitted_at: signalAt ?.toISOString() || row.signal_emitted_at || null,
        signal_ready_at: signalAt ?.toISOString() || row.signal_ready_at || row.signal_emitted_at || null,
        confidence: toNumber(row.confidence ?? row.model_confidence, 0) || 0,
        quantum_score: toNumber(row.quantum_score, 0) || 0,
        timing_score: toNumber(row.timing_score, 0) || 0,
        context_score: toNumber(row.context_score, 0) || 0,
        context_quality: toNumber(row.context_quality, 0) || 0,
        structural_context_score: toNumber(row.structural_context_score, 0) || 0,
        volatility_context_score: toNumber(row.volatility_context_score, 0) || 0,
        volume_flow_context_score: toNumber(row.volume_flow_context_score, 0) || 0,
        liquidity_context_score: toNumber(row.liquidity_context_score, 0) || 0,
        expected_move_percent: resolveExpectedMove(row),
        trade_plan: tradePlan,
        side: normalizeSide({...row, trade_plan: tradePlan }),
        spot_price: resolveSignalPrice(row),
        entry_window_end_at: row.operational_entry_window_end_at || row.entry_window_end_at || null,
        entry_window_start_at: row.operational_entry_window_start_at || row.entry_window_start_at || null
    };
}

async function loadRecentSignals(db, options = {}) {
    const maxDocs = Math.max(50, Math.min(Number(options.maxDocs || DEFAULT_MAX_DOCS), 3000));
    const { since, until } = getWindowBounds(options);
    const snapshot = await db.collection('velas_predicciones').orderBy('updated_at', 'desc').limit(maxDocs).get();
    const rows = snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
    return {
        rows,
        signals: rows
            .filter((row) => row.signal_emitted === true)
            .filter((row) => {
                const ts = resolveSignalTimestamp(row);
                return ts && ts >= since && ts <= until;
            })
    };
}

function resolveHistoricalDelayFromPosition(row = {}) {
    const signalAt =
        parseDateLike(row.execution_trace ?.signal_emitted_at) ||
        parseDateLike(row.execution_audit ?.signal_at) ||
        parseDateLike(row.entry_execution_snapshot ?.signal_timestamp);
    const entryAt =
        parseDateLike(row.execution_trace ?.order_ack_at) ||
        parseDateLike(row.execution_trace ?.order_sent_at) ||
        parseDateLike(row.execution_trace ?.execution_attempt_at) ||
        parseDateLike(row.execution_audit ?.executed_at) ||
        parseDateLike(row.opened_at);
    if (!signalAt || !entryAt) return null;
    return Math.max(0, entryAt.getTime() - signalAt.getTime());
}

async function buildHistoricalDelayBySymbol(db) {
    const snapshot = await db
        .collection('binance_open_positions')
        .orderBy('updated_at', 'desc')
        .limit(300)
        .get()
        .catch(() => null);
    const rows = snapshot ?.docs ?.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })) || [];
    const trades = rows
        .filter((row) => parseDateLike(row.closed_at))
        .map((row) => ({
            symbol: normalizeSymbol(row.symbol),
            entry_delay_ms: resolveHistoricalDelayFromPosition(row)
        }))
        .filter((row) => row.symbol && Number.isFinite(row.entry_delay_ms));
    const map = new Map();
    for (const symbol of unique(trades.map((trade) => normalizeSymbol(trade.symbol)))) {
        const items = trades.filter((trade) => normalizeSymbol(trade.symbol) === symbol);
        const avgDelay = average(items.map((trade) => trade.entry_delay_ms));
        map.set(symbol, Number.isFinite(avgDelay) ? Math.max(0, avgDelay) : DEFAULT_ENTRY_DELAY_MS);
    }
    return map;
}

function buildQualityAssessment(intent = {}, config = {}, origin = 'event_emitted') {
    const minConfidence = Number(config.min_confidence ?? 0);
    const minQuantum = Number(config.min_quantum ?? 0);
    const minTiming = Number(config.min_timing ?? 0);
    const minRiskReward = Number(config.min_risk_reward ?? 0);
    const minExpectedMovePct = Number(config.min_expected_move_pct ?? 0);
    const minContextScore = Number(config.min_context_score ?? 0);
    const minContextQuality = Number(config.min_context_quality ?? 0);

    const checks = {
        confidence: Number(intent.confidence || 0) >= minConfidence,
        quantum: Number(intent.quantum || 0) >= minQuantum,
        timing: Number(intent.timing || 0) >= minTiming,
        risk_reward: Number(intent.risk_reward_ratio || 0) >= minRiskReward,
        expected_move: Number(intent.expected_move_percent || 0) >= minExpectedMovePct,
        context_score: Number(intent.context_score || 0) >= minContextScore,
        context_quality: minContextQuality <= 0 || Number(intent.context_quality || 0) >= minContextQuality
    };
    const ok = Object.values(checks).every(Boolean);
    const failed = Object.entries(checks).find(([, passed]) => !passed);
    return {
        ok,
        checks,
        reason: ok ? null : `${origin}_quality_${failed?.[0] || 'blocked'}`
    };
}

function findCandleAtOrBefore(candles = [], targetTs) {
    let candidate = null;
    for (const candle of candles) {
        const ts = Number(candle ?.timestamp || 0);
        if (!Number.isFinite(ts) || ts > targetTs) break;
        candidate = candle;
    }
    return candidate;
}

function directionalMovePct(side, fromPrice, toPrice) {
    const from = toNumber(fromPrice, null);
    const to = toNumber(toPrice, null);
    if (!Number.isFinite(from) || from <= 0 || !Number.isFinite(to) || to <= 0) return null;
    if (String(side || '').toUpperCase() === 'SELL') {
        return ((from - to) / from) * 100;
    }
    return ((to - from) / from) * 100;
}

function resolveDistanceToTpPct(side, entryPrice, tpPrice, markPrice) {
    const entry = toNumber(entryPrice, null);
    const tp = toNumber(tpPrice, null);
    const mark = toNumber(markPrice, null);
    if (!(entry > 0) || !(tp > 0) || !(mark > 0)) return null;
    if (String(side || '').toUpperCase() === 'BUY') {
        return Math.max(0, ((tp - mark) / entry) * 100);
    }
    return Math.max(0, ((mark - tp) / entry) * 100);
}

function candleHitsStopOrTp(candle = {}, side, stopLoss, takeProfit) {
    const high = toNumber(candle.high, null);
    const low = toNumber(candle.low, null);
    const tp = toNumber(takeProfit, null);
    const sl = toNumber(stopLoss, null);
    const normalizedSide = String(side || '').toUpperCase();
    if (!(high > 0) || !(low > 0)) return { hit: false };
    if (normalizedSide === 'BUY') {
        if (Number.isFinite(sl) && low <= sl) return { hit: true, reason: 'stop_loss', price: sl };
        if (Number.isFinite(tp) && high >= tp) return { hit: true, reason: 'take_profit', price: tp };
    } else if (normalizedSide === 'SELL') {
        if (Number.isFinite(sl) && high >= sl) return { hit: true, reason: 'stop_loss', price: sl };
        if (Number.isFinite(tp) && low <= tp) return { hit: true, reason: 'take_profit', price: tp };
    }
    return { hit: false };
}

function classifyDelayBucket(delayMs) {
    const delay = Number(delayMs || 0);
    if (delay <= 30000) return '0-30s';
    if (delay <= 60000) return '30-60s';
    if (delay <= 90000) return '60-90s';
    if (delay <= 120000) return '90-120s';
    return '>120s';
}

async function loadCandlesForSymbol(symbol, cache) {
    const normalized = normalizeSymbol(symbol);
    if (!normalized) return [];
    if (!cache.has(normalized)) {
        const candles = await fetchCandles(normalized, '1m').catch(() => []);
        cache.set(normalized, Array.isArray(candles) ? candles : []);
    }
    return cache.get(normalized) || [];
}

async function buildShadowCandidate(db, signalRow, delayBySymbol, readinessSnapshot, candleCache) {
    const payload = resolveSignalPayload(signalRow);
    const origin = normalizeOrigin(payload.source_profile);
    const config = await getBinanceBotConfig(db);
    const effectiveConfig = buildEffectiveShadowConfig(config, origin);
    const intent = createExecutionIntent(payload, effectiveConfig, origin);
    const symbol = normalizeSymbol(intent.symbol || payload.symbol);
    const delayMs = Math.round(delayBySymbol.get(symbol) || DEFAULT_ENTRY_DELAY_MS);
    const signalAt = resolveSignalTimestamp(payload);
    const simulatedEntryAt = signalAt ? new Date(signalAt.getTime() + delayMs) : null;
    const quality = buildQualityAssessment(intent, effectiveConfig, origin);
    const readinessState = (readinessSnapshot ?.per_symbol || []).find((row) => normalizeSymbol(row.symbol) === symbol) || null;
    const wouldHavePassedReadiness = readinessState ?.ready === true;
    const candles = await loadCandlesForSymbol(symbol, candleCache);
    const signalCandle = signalAt ? findCandleAtOrBefore(candles, signalAt.getTime()) : null;
    const entryCandle = simulatedEntryAt ? findCandleAtOrBefore(candles, simulatedEntryAt.getTime()) : null;
    const priceAtSignal = toNumber(payload.spot_price ?? signalCandle ?.close, null);
    const simulatedEntryPrice = toNumber(entryCandle ?.close ?? payload.trade_plan ?.entry_price, null);
    const intentQuantity = toNumber(intent.quantity, 0) || 0;
    const notional = intentQuantity > 0 && simulatedEntryPrice > 0 ? intentQuantity * simulatedEntryPrice : 0;
    const minNotionalRequired = 5;
    const wouldHavePassedMinNotional = notional + 1e-9 >= minNotionalRequired;
    const wouldHaveCreatedIntent = Boolean(symbol && payload.signal_emitted_at && intent.side);

    let reasonIfBlocked = null;
    if (!wouldHaveCreatedIntent) reasonIfBlocked = 'intent_not_creatable';
    else if (!quality.ok) reasonIfBlocked = quality.reason;
    else if (!wouldHavePassedReadiness) reasonIfBlocked = 'readiness_not_ready';
    else if (!wouldHavePassedMinNotional) reasonIfBlocked = 'min_notional_blocked';

    return {
        id: buildShadowDocId(signalRow.id, origin),
        signal_id: signalRow.id,
        symbol,
        origin,
        side: intent.side || payload.side || null,
        signal_created_at: signalAt ?.toISOString() || payload.signal_created_at || null,
        simulated_entry_at: simulatedEntryAt ?.toISOString() || null,
        entry_delay_ms: delayMs,
        expected_move: toNumber(payload.expected_move_percent, null),
        confidence: toNumber(payload.confidence, null),
        price_at_signal: round(priceAtSignal, 8),
        simulated_entry_price: round(simulatedEntryPrice, 8),
        would_have_created_intent: wouldHaveCreatedIntent,
        would_have_passed_quality: quality.ok,
        would_have_passed_readiness: wouldHavePassedReadiness,
        would_have_passed_min_notional: wouldHavePassedMinNotional,
        reason_if_blocked: reasonIfBlocked,
        trade_plan: payload.trade_plan || {},
        intent_snapshot: {
            requested_margin_type: intent.margin_type || effectiveConfig.margin_type,
            requested_leverage: intent.leverage || effectiveConfig.default_leverage,
            notional_usdt: toNumber(intent.notional_usdt, null),
            quantity: toNumber(intent.quantity, null),
            risk_reward_ratio: toNumber(intent.risk_reward_ratio, null)
        },
        readiness_snapshot: readinessState ? {
            ready: readinessState.ready === true,
            margin_type: readinessState.margin_type || null,
            leverage: toNumber(readinessState.applied_leverage ?? readinessState.requested_leverage, null),
            last_error: readinessState.last_error || null
        } : null,
        metadata: {
            delay_bucket: classifyDelayBucket(delayMs),
            exchange_info_status: getExchangeInfoCacheStatus()
        }
    };
}

async function persistShadowCandidate(db, candidate) {
    await db.collection(SHADOW_TRADE_CANDIDATES_COLLECTION).doc(candidate.id).set({
        ...candidate,
        updated_at: new Date().toISOString(),
        created_at: FieldValue.serverTimestamp()
    }, { merge: true });
}

async function loadExistingShadowDocMap(db, collectionName, options = {}) {
    const maxDocs = Math.max(50, Math.min(Number(options.maxDocs || DEFAULT_MAX_DOCS), 3000));
    const { since, until } = getWindowBounds(options);
    const snapshot = await db.collection(collectionName).orderBy('updated_at', 'desc').limit(maxDocs).get().catch(() => null);
    const rows = snapshot ?.docs ?.map((doc) => ({ id: doc.id, ...(doc.data() || {}) })) || [];
    const filtered = rows.filter((row) => {
        const ts = parseDateLike(row.updated_at) || parseDateLike(row.created_at);
        return ts && ts >= since && ts <= until;
    });
    return {
        rows: filtered,
        byId: new Map(filtered.map((row) => [row.id, row]))
    };
}

function classifySignalSkipReason(row = {}, window, existingShadowIds = new Set()) {
    const timestamp = resolveSignalTimestamp(row);
    if (!timestamp) return 'timestamp_field_missing';
    if (timestamp < window.since || timestamp > window.until) return 'timestamp_out_of_window';
    if (row.signal_emitted !== true) return 'no_signals_in_window';
    const symbol = normalizeSymbol(row.symbol || row.simbolo);
    if (!symbol) return 'symbol_not_supported';
    const origin = normalizeOrigin(row.binance_route_source || row.origin || row.source_profile || 'event_emitted');
    if (!SUPPORTED_ORIGINS.has(origin)) return 'origin_not_supported';
    if (!normalizeSide(row)) return 'missing_side';
    if (!(resolveSignalPrice(row) > 0)) return 'missing_price';
    if (!(resolveExpectedMove(row) > 0)) return 'missing_expected_move';
    if (existingShadowIds.has(buildShadowDocId(row.id, origin))) return 'already_shadowed';
    return null;
}

function buildUpstreamSection(rows = [], window, existingShadowIds = new Set()) {
    const predictionsInWindow = [];
    const signalsInWindow = [];
    const signalsBySymbol = {};
    const signalsByOrigin = {};
    const signalsByStatus = {};
    const skipReasonsBreakdown = {};
    const sampleSkippedSignals = [];
    let latestSignalAt = null;
    let sourceTimeFieldUsed = null;

    for (const row of rows) {
        const ts = resolveSignalTimestamp(row);
        if (ts && ts >= window.since && ts <= window.until) {
            predictionsInWindow.push(row);
            increment(signalsByStatus, row.status || 'unknown');
        }

        if (row.signal_emitted === true && ts && ts >= window.since && ts <= window.until) {
            signalsInWindow.push(row);
            increment(signalsBySymbol, normalizeSymbol(row.symbol || row.simbolo) || 'UNKNOWN');
            increment(signalsByOrigin, normalizeOrigin(row.binance_route_source || row.origin || row.source_profile || 'event_emitted'));
            if (!latestSignalAt || ts > latestSignalAt) latestSignalAt = ts;
            sourceTimeFieldUsed = sourceTimeFieldUsed || resolveSignalTimestampField(row);
        }
    }

    const eligibleSignals = [];
    for (const row of signalsInWindow) {
        const reason = classifySignalSkipReason(row, window, existingShadowIds);
        if (reason) {
            increment(skipReasonsBreakdown, reason);
            if (sampleSkippedSignals.length < 5) {
                sampleSkippedSignals.push({
                    signal_id: row.id,
                    symbol: normalizeSymbol(row.symbol || row.simbolo),
                    origin: normalizeOrigin(row.binance_route_source || row.origin || row.source_profile || 'event_emitted'),
                    reason
                });
            }
            continue;
        }
        eligibleSignals.push(row);
    }

    let diagnosisHint = 'insufficient_sample';
    if (rows.length === 0) diagnosisHint = 'source_collection_empty';
    else if (signalsInWindow.length === 0) diagnosisHint = 'no_upstream_signals';
    else if (eligibleSignals.length === 0) diagnosisHint = 'sampler_filter_too_strict';

    return {
        predictions_saved: predictionsInWindow.length,
        signals_emitted: signalsInWindow.length,
        signals_by_symbol: signalsBySymbol,
        signals_by_origin: signalsByOrigin,
        signals_by_status: signalsByStatus,
        latest_signal_created_at: latestSignalAt ?.toISOString() || null,
        upstream_signals_emitted: signalsInWindow.length,
        upstream_latest_signal_at: latestSignalAt ?.toISOString() || null,
        source_collection_used: 'velas_predicciones',
        source_time_field_used: sourceTimeFieldUsed,
        eligible_signals_count: eligibleSignals.length,
        skipped_signals_count: Math.max(0, signalsInWindow.length - eligibleSignals.length),
        skip_reasons_breakdown: skipReasonsBreakdown,
        sample_skipped_signals: sampleSkippedSignals,
        diagnosis_hint: diagnosisHint
    };
}

function buildShadowSimulationResult(candidate, candles = []) {
    if (!candidate ?.would_have_created_intent || !candidate ?.would_have_passed_quality || !candidate ?.would_have_passed_readiness) {
        return null;
    }
    if (!candidate ?.would_have_passed_min_notional) {
        return {
            id: candidate.id,
            signal_id: candidate.signal_id,
            symbol: candidate.symbol,
            origin: candidate.origin,
            simulated_entry_price: candidate.simulated_entry_price,
            simulated_exit_price: null,
            simulated_close_reason: 'min_notional_blocked',
            simulated_duration_ms: null,
            pnl_bruto: null,
            fees: SHADOW_BREAK_EVEN_FEE_PCT,
            pnl_neto: null,
            gross_win: false,
            net_win: false,
            blocked: true,
            reason_if_blocked: 'min_notional_blocked'
        };
    }

    const entryAt = parseDateLike(candidate.simulated_entry_at);
    const entryPrice = toNumber(candidate.simulated_entry_price, null);
    const side = String(candidate.side || '').toUpperCase();
    const stopLoss = toNumber(candidate.trade_plan ?.stop_loss, null);
    const takeProfit = toNumber(candidate.trade_plan ?.take_profit, null);
    if (!entryAt || !(entryPrice > 0) || !['BUY', 'SELL'].includes(side)) return null;

    const startIndex = candles.findIndex((candle) => Number(candle ?.timestamp || 0) >= entryAt.getTime());
    if (startIndex < 0) return null;
    const maxHoldMs = SHADOW_MAX_HOLD_MINUTES * 60 * 1000;
    const timeoutMs = Math.round(maxHoldMs * SHADOW_EVENT_TIMEOUT_RATIO);
    let maxSeenPct = -Infinity;

    for (let index = startIndex; index < candles.length; index += 1) {
        const candle = candles[index];
        const ts = Number(candle ?.timestamp || 0);
        if (!Number.isFinite(ts) || ts < entryAt.getTime()) continue;
        const elapsedMs = ts - entryAt.getTime();
        const closePrice = toNumber(candle.close, null);
        if (!(closePrice > 0)) continue;
        const grossPnlPct = directionalMovePct(side, entryPrice, closePrice);
        if (Number.isFinite(grossPnlPct)) {
            maxSeenPct = Math.max(maxSeenPct, grossPnlPct);
        }
        const stopTpHit = candleHitsStopOrTp(candle, side, stopLoss, takeProfit);
        if (stopTpHit.hit) {
            const exitGross = directionalMovePct(side, entryPrice, stopTpHit.price);
            const exitNet = Number.isFinite(exitGross) ? exitGross - SHADOW_BREAK_EVEN_FEE_PCT : null;
            return {
                id: candidate.id,
                signal_id: candidate.signal_id,
                symbol: candidate.symbol,
                origin: candidate.origin,
                simulated_entry_price: round(entryPrice, 8),
                simulated_exit_price: round(stopTpHit.price, 8),
                simulated_close_reason: stopTpHit.reason,
                simulated_duration_ms: elapsedMs,
                pnl_bruto: round(exitGross, 6),
                fees: SHADOW_BREAK_EVEN_FEE_PCT,
                pnl_neto: round(exitNet, 6),
                gross_win: Number(exitGross || 0) > 0,
                net_win: Number(exitNet || 0) > 0,
                blocked: false,
                break_even_pass: Number(exitNet || 0) > 0
            };
        }

        if (candidate.origin === 'event_emitted' && elapsedMs >= timeoutMs) {
            const distanceToTpPct = resolveDistanceToTpPct(side, entryPrice, takeProfit, closePrice);
            const weakProgress =
                Number.isFinite(maxSeenPct) &&
                maxSeenPct <= SHADOW_EVENT_TIMEOUT_MAX_MFE_PCT &&
                Number(grossPnlPct || 0) <= SHADOW_EVENT_TIMEOUT_NEGATIVE_PNL_PCT;
            const farFromTarget = !Number.isFinite(distanceToTpPct) || distanceToTpPct >= SHADOW_EVENT_TIMEOUT_DISTANCE_TO_TP_PCT;
            if (weakProgress && farFromTarget) {
                const net = Number.isFinite(grossPnlPct) ? grossPnlPct - SHADOW_BREAK_EVEN_FEE_PCT : null;
                return {
                    id: candidate.id,
                    signal_id: candidate.signal_id,
                    symbol: candidate.symbol,
                    origin: candidate.origin,
                    simulated_entry_price: round(entryPrice, 8),
                    simulated_exit_price: round(closePrice, 8),
                    simulated_close_reason: 'event_timeout_exit',
                    simulated_duration_ms: elapsedMs,
                    pnl_bruto: round(grossPnlPct, 6),
                    fees: SHADOW_BREAK_EVEN_FEE_PCT,
                    pnl_neto: round(net, 6),
                    gross_win: Number(grossPnlPct || 0) > 0,
                    net_win: Number(net || 0) > 0,
                    blocked: false,
                    break_even_pass: Number(net || 0) > 0
                };
            }
        }

        if (elapsedMs >= maxHoldMs) {
            const net = Number.isFinite(grossPnlPct) ? grossPnlPct - SHADOW_BREAK_EVEN_FEE_PCT : null;
            return {
                id: candidate.id,
                signal_id: candidate.signal_id,
                symbol: candidate.symbol,
                origin: candidate.origin,
                simulated_entry_price: round(entryPrice, 8),
                simulated_exit_price: round(closePrice, 8),
                simulated_close_reason: 'max_hold_reached',
                simulated_duration_ms: elapsedMs,
                pnl_bruto: round(grossPnlPct, 6),
                fees: SHADOW_BREAK_EVEN_FEE_PCT,
                pnl_neto: round(net, 6),
                gross_win: Number(grossPnlPct || 0) > 0,
                net_win: Number(net || 0) > 0,
                blocked: false,
                break_even_pass: Number(net || 0) > 0
            };
        }
    }

    return null;
}

async function persistShadowResult(db, result) {
    await db.collection(SHADOW_TRADE_RESULTS_COLLECTION).doc(result.id).set({
        ...result,
        updated_at: new Date().toISOString(),
        created_at: FieldValue.serverTimestamp()
    }, { merge: true });
}

function summarizeResultSet(results = []) {
    const closed = results.filter((row) => row.blocked !== true && Number.isFinite(Number(row.pnl_neto)));
    const bySymbol = (symbol) => closed.filter((row) => normalizeSymbol(row.symbol) === symbol);
    const btc = bySymbol('BTCUSDT');
    const sol = bySymbol('SOLUSDT');
    const closeReasonBreakdown = unique(closed.map((row) => row.simulated_close_reason)).map((reason) => {
        const items = closed.filter((row) => row.simulated_close_reason === reason);
        return {
            close_reason: reason,
            count: items.length,
            pnl_bruto_total: round(sum(items.map((row) => row.pnl_bruto)), 6),
            fees_total: round(sum(items.map((row) => row.fees)), 6),
            pnl_neto_total: round(sum(items.map((row) => row.pnl_neto)), 6)
        };
    }).sort((a, b) => Number(a.pnl_neto_total || 0) - Number(b.pnl_neto_total || 0));

    const delayBucketBreakdown = ['0-30s', '30-60s', '60-90s', '90-120s', '>120s'].map((bucket) => {
        const items = results.filter((row) => row.delay_bucket === bucket && row.blocked !== true);
        return {
            delay_bucket: bucket,
            count: items.length,
            pnl_neto_total: round(sum(items.map((row) => row.pnl_neto)), 6),
            symbols: unique(items.map((row) => row.symbol)),
            close_reasons: unique(items.map((row) => row.simulated_close_reason))
        };
    });

    const btcWinRate = btc.length ? (btc.filter((row) => Number(row.pnl_neto || 0) > 0).length / btc.length) * 100 : 0;
    const solWinRate = sol.length ? (sol.filter((row) => Number(row.pnl_neto || 0) > 0).length / sol.length) * 100 : 0;

    let diagnosis = 'insufficient_sample';
    let recommendation = 'seguir_shadow';
    if (btc.length >= 10 && sol.length >= 5) {
        if (sum(btc.map((row) => row.pnl_bruto)) <= 0 && sum(btc.map((row) => row.pnl_neto)) < sum(sol.map((row) => row.pnl_neto))) {
            diagnosis = 'btc_pause_candidate_confirmed';
            recommendation = 'proponer_pausa_temporal_btcusdt';
        } else if (sum(btc.map((row) => row.pnl_neto)) < 0 && average(btc.map((row) => row.entry_delay_ms)) > 60000) {
            diagnosis = 'btc_delay_filter_candidate';
            recommendation = 'proponer_filtro_btcusdt_delay_lte_60s';
        } else if (sum(closed.map((row) => row.pnl_bruto)) <= sum(closed.map((row) => row.fees))) {
            diagnosis = 'fees_dominate';
            recommendation = 'mantener_halted_y_seguir_shadow';
        } else {
            diagnosis = 'broad_no_edge';
            recommendation = 'mantener_halted';
        }
    }

    return {
        shadow_candidates_total: results.length,
        shadow_trades_closed: closed.length,
        btc_shadow_count: btc.length,
        sol_shadow_count: sol.length,
        btc_pnl_bruto: round(sum(btc.map((row) => row.pnl_bruto)), 6),
        btc_pnl_neto: round(sum(btc.map((row) => row.pnl_neto)), 6),
        sol_pnl_bruto: round(sum(sol.map((row) => row.pnl_bruto)), 6),
        sol_pnl_neto: round(sum(sol.map((row) => row.pnl_neto)), 6),
        btc_win_rate_neto: round(btcWinRate, 2),
        sol_win_rate_neto: round(solWinRate, 2),
        close_reason_breakdown: closeReasonBreakdown,
        delay_bucket_breakdown: delayBucketBreakdown,
        diagnosis,
        recommendation
    };
}

function buildCounterfactualPolicyResults(results = [], symbol, scenarios = []) {
    const base = results.filter((row) => normalizeSymbol(row.symbol) === symbol && row.blocked !== true);
    return scenarios.map((scenario) => {
        const kept = base.filter((row) => scenario.filter(row));
        return {
            scenario_name: scenario.name,
            trades_kept: kept.length,
            pnl_neto_simulado: round(sum(kept.map((row) => row.pnl_neto)), 6),
            pnl_bruto_simulado: round(sum(kept.map((row) => row.pnl_bruto)), 6),
            avg_entry_delay_ms: round(average(kept.map((row) => row.entry_delay_ms)), 2)
        };
    }).sort((a, b) => {
        const pnlDiff = Number(b.pnl_neto_simulado || 0) - Number(a.pnl_neto_simulado || 0);
        if (Math.abs(pnlDiff) > 0.000001) return pnlDiff;
        return Number(b.trades_kept || 0) - Number(a.trades_kept || 0);
    });
}

async function getShadowEdgeSamplerDiagnostic(db, options = {}) {
    const window = getWindowBounds(options);
    const loaded = await loadRecentSignals(db, options);
    const allRows = loaded.rows || [];
    const signals = loaded.signals || [];
    const existingCandidates = await loadExistingShadowDocMap(db, SHADOW_TRADE_CANDIDATES_COLLECTION, options);
    const existingResults = await loadExistingShadowDocMap(db, SHADOW_TRADE_RESULTS_COLLECTION, options);
    const upstream = buildUpstreamSection(allRows, window, new Set(existingCandidates.byId.keys()));
    const readinessSnapshot = await loadMarginLeverageReadinessSnapshot(
        db,
        unique(signals.map((row) => normalizeSymbol(row.symbol || row.simbolo)))
    );
    const delayBySymbol = await buildHistoricalDelayBySymbol(db, options);
    const candleCache = new Map();
    const candidates = [];

    // NOTE: Results are now only existing results, not newly simulated ones
    const results = existingResults.rows || [];

    // Analyze existing results by type
    const strategyResults = results.filter(r => r.shadow_result_type !== 'live_only');
    const liveEligibleResults = results.filter(r => r.live_eligibility ?.would_have_reached_live_order === true);
    const liveIneligibleButSimulatedResults = results.filter(r =>
        r.live_eligibility ?.would_have_reached_live_order === false && r.shadow_result_type === 'strategy_shadow'
    );

    // Shadow candidate analysis counters
    // NOTE: Exit simulation counters are now handled by processPendingShadowCandidates()
    const exitSimulationAttempts = 0;
    const exitSimulationSuccess = 0;
    const exitSimulationFail = 0;
    const resultWriteSuccess = 0;
    const resultWriteFail = 0;

    for (const signalRow of signals) {
        const preSkipReason = classifySignalSkipReason(signalRow, window, new Set(existingCandidates.byId.keys()));
        if (preSkipReason) {
            continue;
        }
        const candidate = await buildShadowCandidate(db, signalRow, delayBySymbol, readinessSnapshot, candleCache);
        try {
            await persistShadowCandidate(db, candidate);
            console.log('[SHADOW_CANDIDATE_CREATED]', {
                candidate_id: candidate.id,
                symbol: candidate.symbol,
                simulated_entry_at: candidate.simulated_entry_at,
                would_have_passed_quality: candidate.would_have_passed_quality,
                reason_if_blocked: candidate.reason_if_blocked
            });
        } catch (error) {
            increment(upstream.skip_reasons_breakdown, 'shadow_write_failed');
            if (upstream.sample_skipped_signals.length < 5) {
                upstream.sample_skipped_signals.push({
                    signal_id: signalRow.id,
                    symbol: candidate.symbol,
                    origin: candidate.origin,
                    reason: 'shadow_write_failed'
                });
            }
            continue;
        }
        candidates.push(candidate);

        // NOTE: Shadow exit simulation is now handled separately by processPendingShadowCandidates()
        // This allows for real-time observation instead of immediate backtesting
    }

    const summary = summarizeResultSet(results);
    const btcCounterfactuals = buildCounterfactualPolicyResults(results, 'BTCUSDT', [
        { name: 'btcusdt_no_filter', filter: () => true },
        { name: 'btcusdt_delay_lte_60s', filter: (row) => Number(row.entry_delay_ms || 0) <= 60000 },
        { name: 'btcusdt_delay_lte_90s', filter: (row) => Number(row.entry_delay_ms || 0) <= 90000 },
        { name: 'btcusdt_expected_move_gte_0_20', filter: (row) => Number(row.expected_move || 0) >= 0.20 },
        { name: 'btcusdt_expected_move_gte_0_25', filter: (row) => Number(row.expected_move || 0) >= 0.25 }
    ]);
    const solCounterfactuals = buildCounterfactualPolicyResults(results, 'SOLUSDT', [
        { name: 'solusdt_no_filter', filter: () => true },
        { name: 'solusdt_delay_lte_60s', filter: (row) => Number(row.entry_delay_ms || 0) <= 60000 },
        { name: 'solusdt_delay_lte_90s', filter: (row) => Number(row.entry_delay_ms || 0) <= 90000 },
        { name: 'solusdt_expected_move_gte_0_15', filter: (row) => Number(row.expected_move || 0) >= 0.15 },
        { name: 'solusdt_expected_move_gte_0_20', filter: (row) => Number(row.expected_move || 0) >= 0.20 }
    ]);

    // Analyze existing candidates for pending status
    const allCandidates = [...existingCandidates.rows, ...candidates];
    const existingResultIds = new Set(existingResults.rows.map(r => r.id));
    const pendingCandidates = allCandidates.filter(candidate => !existingResultIds.has(candidate.id));

    const now = Date.now();
    const MIN_HOLD_MS = 30000; // 30 seconds minimum hold before eligible for exit

    // Separate simulation blockers from live eligibility issues
    const SIMULATION_BLOCKING_REASONS = new Set([
        'missing_side',
        'missing_entry_price',
        'missing_timestamp',
        'invalid_symbol',
        'simulation_error',
        'intent_not_creatable'
    ]);

    const LIVE_READINESS_REASONS = new Set([
        'readiness_not_ready',
        'min_notional_blocked',
        'event_emitted_quality_confidence',
        'event_emitted_quality_quantum',
        'event_emitted_quality_timing'
    ]);

    let readyForExitSimulationCount = 0;
    let blockedBySimulationIssueCount = 0;
    let blockedByLiveReadinessOnlyCount = 0;
    let candidatesMissingPriceCount = 0;
    let candidatesMissingSideCount = 0;
    let candidatesMissingFutureCandlesCount = 0;
    let oldestPendingCandidateAgeMs = null;
    const pendingCandidatesSample = [];

    for (const candidate of pendingCandidates) {
        if (pendingCandidatesSample.length < 5) {
            pendingCandidatesSample.push({
                id: candidate.id,
                symbol: candidate.symbol,
                simulated_entry_at: candidate.simulated_entry_at,
                reason_if_blocked: candidate.reason_if_blocked,
                would_have_passed_quality: candidate.would_have_passed_quality,
                side: candidate.side,
                simulated_entry_price: candidate.simulated_entry_price
            });
        }

        const entryAt = parseDateLike(candidate.simulated_entry_at);
        if (entryAt) {
            const ageMs = now - entryAt.getTime();
            if (oldestPendingCandidateAgeMs === null || ageMs > oldestPendingCandidateAgeMs) {
                oldestPendingCandidateAgeMs = ageMs;
            }

            if (ageMs >= MIN_HOLD_MS) {
                if (candidate.reason_if_blocked && SIMULATION_BLOCKING_REASONS.has(candidate.reason_if_blocked)) {
                    blockedBySimulationIssueCount++;
                } else if (candidate.reason_if_blocked && LIVE_READINESS_REASONS.has(candidate.reason_if_blocked)) {
                    blockedByLiveReadinessOnlyCount++;
                } else if (!candidate.side) {
                    candidatesMissingSideCount++;
                    blockedBySimulationIssueCount++;
                } else if (!candidate.simulated_entry_price || candidate.simulated_entry_price <= 0) {
                    candidatesMissingPriceCount++;
                    blockedBySimulationIssueCount++;
                } else {
                    // Check if we have future candles
                    const candles = await loadCandlesForSymbol(candidate.symbol, candleCache);
                    const futureCandles = candles.filter(candle =>
                        Number(candle ?.timestamp || 0) > entryAt.getTime()
                    );
                    if (futureCandles.length === 0) {
                        candidatesMissingFutureCandlesCount++;
                        blockedBySimulationIssueCount++;
                    } else {
                        // Ready for processing - even if blocked by live readiness
                        readyForExitSimulationCount++;
                    }
                }
            }
        }
    }

    return {
        window: {
            since: window.since.toISOString(),
            until: window.until.toISOString()
        },
        source_collection_used: upstream.source_collection_used,
        source_time_field_used: upstream.source_time_field_used,
        predictions_saved: upstream.predictions_saved,
        signals_emitted: upstream.signals_emitted,
        signals_by_symbol: upstream.signals_by_symbol,
        signals_by_origin: upstream.signals_by_origin,
        signals_by_status: upstream.signals_by_status,
        latest_signal_created_at: upstream.latest_signal_created_at,
        upstream_signals_emitted: upstream.upstream_signals_emitted,
        upstream_latest_signal_at: upstream.upstream_latest_signal_at,
        eligible_signals_count: upstream.eligible_signals_count,
        skipped_signals_count: upstream.skipped_signals_count,
        skip_reasons_breakdown: upstream.skip_reasons_breakdown,
        sample_skipped_signals: upstream.sample_skipped_signals,
        latest_shadow_candidate_created_at: candidates[candidates.length - 1] ?.signal_created_at ||
            existingCandidates.rows[0] ?.updated_at ||
            null,
        latest_shadow_result_created_at: results[results.length - 1] ?.signal_created_at ||
            existingResults.rows[0] ?.updated_at ||
            null,
        ...summary,
        shadow_candidates_total: existingCandidates.rows.length + candidates.length,
        shadow_results_total: existingResults.rows.length + results.length,
        strategy_shadow_results_total: strategyResults.length,
        live_eligible_shadow_count: liveEligibleResults.length,
        live_ineligible_but_simulated_count: liveIneligibleButSimulatedResults.length,
        pending_candidates_count: pendingCandidates.length,
        ready_for_exit_simulation_count: readyForExitSimulationCount,
        blocked_by_simulation_issue_count: blockedBySimulationIssueCount,
        blocked_by_live_readiness_only_count: blockedByLiveReadinessOnlyCount,
        no_exit_condition_met_count: summary.no_exit_condition_met_count || 0,
        should_have_closed_by_max_hold_count: summary.should_have_closed_by_max_hold_count || 0,
        should_have_closed_by_event_timeout_count: summary.should_have_closed_by_event_timeout_count || 0,
        closed_by_max_hold_count: summary.closed_by_max_hold_count || 0,
        closed_by_event_timeout_count: summary.closed_by_event_timeout_count || 0,
        results_by_symbol_all: summary.results_by_symbol_all || {},
        results_symbols_seen: summary.results_symbols_seen || [],
        pending_no_exit_samples: summary.pending_no_exit_samples || [],
        candidates_missing_price_count: candidatesMissingPriceCount,
        candidates_missing_side_count: candidatesMissingSideCount,
        candidates_missing_future_candles_count: candidatesMissingFutureCandlesCount,
        exit_simulation_attempts: exitSimulationAttempts,
        exit_simulation_success: exitSimulationSuccess,
        exit_simulation_fail: exitSimulationFail,
        result_write_success: resultWriteSuccess,
        result_write_fail: resultWriteFail,
        oldest_pending_candidate_age_ms: oldestPendingCandidateAgeMs,
        pending_candidates_sample: pendingCandidatesSample,
        btc_policy_tests: btcCounterfactuals,
        sol_policy_tests: solCounterfactuals,
        diagnosis: existingCandidates.rows.length > 0 && strategyResults.length === 0 && blockedByLiveReadinessOnlyCount > 0 ?
            'shadow_blocked_by_live_readiness_bug' :
            (strategyResults.length > 0 || summary.shadow_trades_closed > 0 ?
                summary.diagnosis :
                upstream.diagnosis_hint || summary.diagnosis)
    };
}

async function processPendingShadowCandidates(db, options = {}) {
    const now = Date.now();
    const MIN_AGE_MS = Number(options.minAgeMs || 30000); // 30 seconds minimum before eligible for processing
    const MAX_PROCESS = Number(options.maxProcess || 50); // Limit per execution

    console.log('[SHADOW_PROCESS_START]', {
        min_age_ms: MIN_AGE_MS,
        max_process: MAX_PROCESS
    });

    // Load existing candidates and results
    const candidatesSnap = await db.collection(SHADOW_TRADE_CANDIDATES_COLLECTION)
        .orderBy('updated_at', 'desc')
        .limit(Math.max(100, MAX_PROCESS * 2))
        .get()
        .catch(() => null);

    if (!candidatesSnap || candidatesSnap.empty) {
        console.log('[SHADOW_PROCESS_END]', { candidates_found: 0, processed: 0 });
        return { processed: 0, candidates_found: 0, results_created: 0 };
    }

    const resultsSnap = await db.collection(SHADOW_TRADE_RESULTS_COLLECTION)
        .orderBy('updated_at', 'desc')
        .limit(500)
        .get()
        .catch(() => null);

    const existingResultIds = new Set();
    if (resultsSnap && !resultsSnap.empty) {
        resultsSnap.docs.forEach(doc => existingResultIds.add(doc.id));
    }

    // Find candidates ready for processing
    const candidatesData = candidatesSnap.docs.map(doc => ({ id: doc.id, ...(doc.data() || {}) }));

    // Only block for real simulation issues, NOT for live eligibility
    const SIMULATION_BLOCKING_REASONS = new Set([
        'missing_side',
        'missing_entry_price',
        'missing_timestamp',
        'invalid_symbol',
        'simulation_error',
        'intent_not_creatable'
    ]);

    const pendingCandidates = candidatesData.filter(candidate => {
        if (existingResultIds.has(candidate.id)) {
            return false; // Already has result - idempotency
        }

        const entryAt = parseDateLike(candidate.simulated_entry_at);
        if (!entryAt) {
            return false; // No valid entry time
        }

        const ageMs = now - entryAt.getTime();
        if (ageMs < MIN_AGE_MS) {
            return false; // Too young
        }

        // CRITICAL FIX: Only block for simulation issues, NOT readiness/live issues
        if (candidate.reason_if_blocked && SIMULATION_BLOCKING_REASONS.has(candidate.reason_if_blocked)) {
            return false; // Real simulation blocker
        }

        return true;
    });

    console.log('[SHADOW_PROCESS_CANDIDATES]', {
        total_candidates: candidatesData.length,
        pending_candidates: pendingCandidates.length,
        existing_results: existingResultIds.size
    });

    const candleCache = new Map();
    let processed = 0;
    let resultsCreated = 0;

    // Process eligible candidates
    for (const candidate of pendingCandidates.slice(0, MAX_PROCESS)) {
        if (!candidate.symbol || !candidate.side || !candidate.simulated_entry_price || candidate.simulated_entry_price <= 0) {
            console.log('[SHADOW_PROCESS_SKIP]', {
                candidate_id: candidate.id,
                reason: 'missing_required_fields',
                symbol: candidate.symbol,
                side: candidate.side,
                entry_price: candidate.simulated_entry_price
            });
            processed++;
            continue;
        }

        // Determine shadow result type and live eligibility
        const isLiveEligible = !candidate.reason_if_blocked;
        const shadowResultType = isLiveEligible ? 'strategy_live_eligible' : 'strategy_shadow';
        const liveEligibility = {
            would_have_passed_runtime: candidate.would_have_created_intent || false,
            would_have_passed_readiness: candidate.would_have_passed_readiness || false,
            would_have_passed_min_notional: candidate.would_have_passed_min_notional || false,
            would_have_passed_quality: candidate.would_have_passed_quality || false,
            would_have_reached_live_order: isLiveEligible,
            reason_if_not_live_eligible: candidate.reason_if_blocked || null
        };

        try {
            const candles = await loadCandlesForSymbol(candidate.symbol, candleCache);
            const entryAt = parseDateLike(candidate.simulated_entry_at);

            // Check if we have sufficient future candles for simulation
            const futureCandles = candles.filter(candle =>
                Number(candle ?.timestamp || 0) > entryAt.getTime()
            );

            if (futureCandles.length === 0) {
                console.log('[SHADOW_PROCESS_SKIP]', {
                    candidate_id: candidate.id,
                    reason: 'no_future_candles',
                    symbol: candidate.symbol,
                    entry_at: candidate.simulated_entry_at
                });
                processed++;
                continue;
            }

            console.log('[SHADOW_EXIT_SIM_ATTEMPT]', {
                candidate_id: candidate.id,
                symbol: candidate.symbol,
                entry_at: candidate.simulated_entry_at,
                future_candles_count: futureCandles.length
            });

            const result = buildShadowSimulationResult(candidate, candles);

            if (!result) {
                console.log('[SHADOW_EXIT_SIM_RESULT]', {
                    candidate_id: candidate.id,
                    symbol: candidate.symbol,
                    success: false,
                    reason: 'no_exit_condition_met'
                });
                processed++;
                continue;
            }

            console.log('[SHADOW_EXIT_SIM_RESULT]', {
                candidate_id: candidate.id,
                symbol: candidate.symbol,
                success: true,
                close_reason: result.simulated_close_reason,
                pnl_neto: result.pnl_neto,
                duration_ms: result.simulated_duration_ms
            });

            const enriched = {
                ...result,
                signal_created_at: candidate.signal_created_at,
                entry_delay_ms: candidate.entry_delay_ms,
                delay_bucket: classifyDelayBucket(candidate.entry_delay_ms),
                expected_move: candidate.expected_move,
                processed_at: new Date().toISOString(),
                processed_by: 'processPendingShadowCandidates',
                shadow_result_type: shadowResultType,
                live_eligibility: liveEligibility
            };

            // Persist result - idempotent operation
            await persistShadowResult(db, enriched);
            resultsCreated++;

            console.log('[SHADOW_RESULT_WRITE]', {
                result_id: enriched.id,
                symbol: enriched.symbol,
                success: true,
                close_reason: enriched.simulated_close_reason,
                shadow_result_type: shadowResultType,
                live_eligible: isLiveEligible
            });

            processed++;

        } catch (error) {
            console.error('[SHADOW_PROCESS_ERROR]', {
                candidate_id: candidate.id,
                symbol: candidate.symbol,
                error: error.message
            });
            processed++;
        }
    }

    console.log('[SHADOW_PROCESS_END]', {
        candidates_found: candidatesData.length,
        pending_candidates: pendingCandidates.length,
        processed,
        results_created: resultsCreated
    });

    return {
        candidates_found: candidatesData.length,
        pending_candidates: pendingCandidates.length,
        processed,
        results_created: resultsCreated
    };
}

module.exports = {
    getShadowEdgeSamplerDiagnostic,
    processPendingShadowCandidates
};