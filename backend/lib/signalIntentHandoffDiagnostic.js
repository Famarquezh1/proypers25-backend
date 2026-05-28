const { getBinanceBotConfig } = require('./binanceBotConfig');
const { STALE_PENDING_PREDICTION_TIMEOUT_MS } = require('../services/execution/pendingPredictionWatchdog');

const SUPPORTED_TIMEFRAMES = new Set(['1m', '5m', '15m']);

function normalizeToBinanceSymbol(symbol) {
  const raw = String(symbol || '')
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/\//g, '-')
    .replace(/_/g, '-');

  if (!raw) return null;
  if (/^[A-Z0-9]{2,30}USDT$/.test(raw)) return raw;
  if (/^[A-Z0-9]{2,30}-USDT$/.test(raw)) return raw.replace(/-USDT$/, 'USDT');
  if (/^[A-Z0-9]{2,30}-USD$/.test(raw)) return `${raw.replace(/-USD$/, '')}USDT`;
  if (/^[A-Z0-9]{2,30}USD$/.test(raw) && !raw.endsWith('USDT')) return `${raw.slice(0, -3)}USDT`;
  if (/^[A-Z0-9]{2,30}$/.test(raw) && !raw.endsWith('USDT')) return `${raw}USDT`;

  const collapsed = raw.replace(/[^A-Z0-9]/g, '');
  return /^[A-Z0-9]{2,30}USDT$/.test(collapsed) ? collapsed : null;
}

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

function getWindow(options = {}) {
  const until = parseDateLike(options.until) || new Date();
  const sinceExplicit = parseDateLike(options.since);
  const hours = Math.max(0.1, Number(options.hours || 24));
  const since = sinceExplicit || new Date(until.getTime() - (hours * 60 * 60 * 1000));
  return { since, until };
}

async function loadRecentRows(db, collectionName, orderField, maxDocs) {
  const snapshot = await db.collection(collectionName).orderBy(orderField, 'desc').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function loadCurrentOpenRows(db, maxDocs) {
  const snapshot = await db.collection('binance_open_positions').where('status', '==', 'open').limit(maxDocs).get();
  return snapshot.docs.map((doc) => ({ id: doc.id, ...(doc.data() || {}) }));
}

async function loadCooldownStates(db, maxDocs) {
  const snapshot = await db.collection('velas_symbol_runtime_state').limit(maxDocs).get();
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

function resolveSignalEmittedAt(row = {}) {
  return parseDateLike(row.signal_emitted_at) || parseDateLike(row.signal_ready_at) || null;
}

function resolveCreatedAt(row = {}) {
  return parseDateLike(row.created_at) || parseDateLike(row.timestamp) || parseDateLike(row.ahora) || null;
}

function resolvePredictionCreatedAt(row = {}) {
  return parseDateLike(row.signal_created_at) || resolveCreatedAt(row);
}

function resolveSourceProfile(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'event_emitted') return 'event_emitted';
  if (normalized === 'high_conviction') return 'high_conviction';
  if (normalized === 'manual_prealert') return 'manual_prealert';
  return normalized || 'unknown';
}

function resolveSignalOrigin(row = {}) {
  return resolveSourceProfile(
    row.binance_execution?.source_profile ||
    row.binance_route_source ||
    row.early_execution_source_profile ||
    row.source_profile
  );
}

function buildEffectiveConfigLite(config = {}, sourceProfile = 'unknown') {
  const profileKey = resolveSourceProfile(sourceProfile);
  const profile =
    config?.execution_profiles && typeof config.execution_profiles === 'object'
      ? (config.execution_profiles[profileKey] || {})
      : {};
  const configuredMode = profile.mode && profile.mode !== 'inherit' ? profile.mode : config.mode;
  return {
    ...config,
    ...profile,
    source_profile: profileKey,
    configured_mode: configuredMode || config.mode || 'off',
    execution_enabled: profile.execution_enabled ?? config.execution_enabled,
    max_concurrent_trades: Number(profile.max_concurrent_trades ?? config.max_concurrent_trades ?? 1),
    symbol_cooldown_minutes: Number(profile.symbol_cooldown_minutes ?? config.symbol_cooldown_minutes ?? 0),
    allow_unlisted_symbols: Boolean(profile.allow_unlisted_symbols ?? config.allow_unlisted_symbols),
    symbols_allowlist: Array.isArray(profile.symbols_allowlist) && profile.symbols_allowlist.length
      ? profile.symbols_allowlist
      : (Array.isArray(config.symbols_allowlist) ? config.symbols_allowlist : []),
    min_confidence: Number(profile.min_confidence ?? config.min_confidence ?? 0),
    min_quantum: Number(profile.min_quantum ?? config.min_quantum ?? 0),
    min_timing: Number(profile.min_timing ?? config.min_timing ?? 0)
  };
}

function buildIntentIndex(intentRows = []) {
  const index = new Map();
  for (const row of intentRows) {
    const predictionId = row.prediction_id || null;
    if (!predictionId) continue;
    if (!index.has(String(predictionId))) {
      index.set(String(predictionId), []);
    }
    index.get(String(predictionId)).push(row);
  }
  return index;
}

function resolveSignalReasonCandidates(signal = {}) {
  const executionMeta = signal.execution_meta || {};
  return [
    signal.binance_terminal_reason,
    signal.binance_execution?.reason,
    signal.binance_execution?.error_message,
    signal.last_error_message,
    executionMeta.missed_opportunity_type,
    executionMeta.override_reason,
    signal.pending_state_resolution,
    signal.status
  ].filter((value) => String(value || '').trim().length > 0);
}

function mapExplicitHandoffReason(value) {
  const message = String(value || '').trim().toLowerCase();
  if (!message) return null;
  if (message.includes('execution_disabled_runtime') || message.includes('execution_disabled')) return 'execution_disabled';
  if (message.includes('binance_disabled')) return 'binance_disabled';
  if (message.includes('neutral_direction') || message.includes('signal_not_emitted')) return 'signal_origin_not_allowed';
  if (message.includes('already_processed') || message.includes('duplicate')) return 'duplicate_intent';
  if (message.includes('already_open') || message.includes('existing_open_position')) return 'existing_open_position';
  if (message.includes('max_concurrent_trades_reached')) return 'max_concurrent_trades_reached';
  if (message.includes('symbol_cooldown_active') || message.includes('cooldown')) return 'cooldown_active';
  if (message.includes('symbol_not_allowed') || message.includes('symbol_not_tradeable')) return 'symbol_not_tradeable';
  if (message.includes('symbol_missing')) return 'missing_signal_fields';
  if (message.includes('spot_price_invalid') || message.includes('expected_move_percent_invalid')) return 'missing_signal_fields';
  if (message.includes('invalid_symbol')) return 'invalid_symbol';
  if (message.includes('unsupported_timeframe') || message.includes('timeframe')) return 'unsupported_timeframe';
  if (message.includes('signal_origin_not_allowed')) return 'signal_origin_not_allowed';
  if (message.includes('expired_watchdog') || message.includes('intent_expired') || message.includes('stale')) return 'stale_signal';
  if (message.includes('confidence_low')) return 'confidence_low';
  if (message.includes('event_quality_gate') || message.includes('quality_not_passed')) return 'quality_not_passed_for_execution';
  if (
    message.includes('risk') ||
    message.includes('stop_loss_required') ||
    message.includes('take_profit_required') ||
    message.includes('execution_guard') ||
    message.includes('execution_protection')
  ) {
    return 'risk_guard_blocked';
  }
  if (message.includes('pre_validation_failed')) return 'pre_validation_failed';
  if (
    message.includes('write_timeout') ||
    message.includes('permission_denied') ||
    message.includes('failed_precondition') ||
    message.includes('requires an index') ||
    message.includes('intent_write_failed')
  ) {
    return 'intent_write_failed';
  }
  return null;
}

function resolveDisabledHandoffReason(runtimeExecutionEnabled, effectiveConfig = {}) {
  if (!runtimeExecutionEnabled) return 'execution_disabled';
  if (effectiveConfig.execution_enabled === false) return 'binance_disabled';
  if (String(effectiveConfig.configured_mode || '').toLowerCase() === 'off') return 'trading_mode_disabled';
  return null;
}

function hasIntentCreationAttempt(signal = {}) {
  const execution = signal.binance_execution || {};
  const origin = resolveSignalOrigin(signal);
  const explicitReason = String(execution.reason || '').trim().toLowerCase();
  return Boolean(
    execution.queued === true ||
    execution.attempted === true ||
    signal.binance_terminal_status ||
    signal.execution_meta ||
    (origin !== 'none' && origin !== 'unknown' && explicitReason && explicitReason !== 'not_attempted')
  );
}

function hasMissingSignalFields(signal = {}) {
  const rawSymbol = signal.symbol || signal.simbolo || signal.simbolo_normalizado || null;
  const normalizedSymbol = normalizeToBinanceSymbol(rawSymbol);
  const direction = String(signal.direction || '').toLowerCase();
  const expectedMove = toNumber(signal.expected_move_percent, null);
  const confidence = toNumber(
    signal.decision_post_learning?.confidence ??
    signal.confidence_score ??
    signal.confidence ??
    signal.confianza,
    null
  );
  const spotPrice = toNumber(signal.spot_price ?? signal.precio_actual ?? signal.trade_plan?.entry_price, null);

  return {
    missing: !normalizedSymbol || !direction || (direction !== 'up' && direction !== 'down') || expectedMove === null || confidence === null || spotPrice === null,
    normalizedSymbol,
    direction,
    expectedMove,
    confidence,
    spotPrice
  };
}

function classifyExplicitSignalReason(signal = {}, disabledReason = null) {
  const queuedForExecution =
    signal.binance_execution?.queued === true ||
    String(signal.binance_execution?.reason || '').trim().toLowerCase() === 'queued_for_execution';
  const hasTerminalExecutionState = Boolean(signal.binance_terminal_status || signal.binance_terminal_reason);

  for (const candidate of resolveSignalReasonCandidates(signal)) {
    const mapped = mapExplicitHandoffReason(candidate);
    if (!mapped) continue;
    if (mapped === 'stale_signal' && queuedForExecution && !hasTerminalExecutionState && disabledReason) {
      return disabledReason;
    }
    return mapped;
  }

  return null;
}

function classifySignalWithoutIntent(signal = {}, context = {}) {
  const sourceProfile = resolveSignalOrigin(signal);
  const effectiveConfig = context.configByProfile?.[sourceProfile] || context.defaultConfig || {};
  const runtimeExecutionEnabled = context.runtimeExecutionEnabled !== false;
  const disabledReason = resolveDisabledHandoffReason(runtimeExecutionEnabled, effectiveConfig);
  const explicitReason = classifyExplicitSignalReason(signal, disabledReason);
  if (explicitReason) return explicitReason;
  if (sourceProfile === 'none' || sourceProfile === 'unknown') return 'signal_origin_not_allowed';
  if (disabledReason) return disabledReason;

  const missingState = hasMissingSignalFields(signal);
  if (missingState.missing) {
    return missingState.normalizedSymbol ? 'missing_signal_fields' : 'invalid_symbol';
  }

  if (!SUPPORTED_TIMEFRAMES.has(String(signal.timeframe || '').trim())) {
    return 'unsupported_timeframe';
  }

  const allowlist = Array.isArray(effectiveConfig.symbols_allowlist) ? effectiveConfig.symbols_allowlist : [];
  if (allowlist.length > 0 && !allowlist.includes(missingState.normalizedSymbol)) {
    return 'symbol_not_tradeable';
  }

  const qualityPassed = signal.decision_post_learning?.quality_gate_passed;
  if (qualityPassed === false) return 'quality_not_passed_for_execution';

  if (missingState.confidence !== null && missingState.confidence < Number(effectiveConfig.min_confidence || 0)) {
    return 'confidence_low';
  }

  const emittedAt = resolvePredictionTimestamp(signal);
  const cooldownUntil = context.cooldownBySymbol?.get(missingState.normalizedSymbol) || null;
  if (cooldownUntil && emittedAt && cooldownUntil.getTime() >= emittedAt.getTime()) {
    return 'cooldown_active';
  }

  const currentOpenSameSymbol = context.openPositionsBySymbol?.get(missingState.normalizedSymbol) || 0;
  if (currentOpenSameSymbol > 0) {
    return 'existing_open_position';
  }

  if (Number(context.currentOpenPositions || 0) >= Number(effectiveConfig.max_concurrent_trades || 1)) {
    return 'max_concurrent_trades_reached';
  }

  const ageMs = emittedAt ? Math.max(0, context.until.getTime() - emittedAt.getTime()) : null;
  if (
    signal.pending_state_resolution === 'expired_watchdog' ||
    String(signal.status || '').toLowerCase() === 'expirada' ||
    (ageMs != null && ageMs >= STALE_PENDING_PREDICTION_TIMEOUT_MS)
  ) {
    return 'stale_signal';
  }

  return 'unknown';
}

function increment(bucket, key, amount = 1) {
  const normalized = String(key || 'unknown');
  bucket[normalized] = (bucket[normalized] || 0) + amount;
}

function topEntries(map = {}, limit = 10) {
  return Object.entries(map)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([key, count]) => ({ key, count }));
}

function resolveLastErrorMessage(signal = {}) {
  return String(
    signal.last_error_message ||
    signal.binance_execution?.error_message ||
    signal.binance_terminal_reason ||
    signal.execution_meta?.override_reason ||
    ''
  ).trim() || null;
}

function resolveLifecycle(signal = {}) {
  return signal.binance_execution?.lifecycle || {};
}

function buildStaleSignalTrace(signal = {}, until) {
  const lifecycle = resolveLifecycle(signal);
  const emittedAt = resolveSignalEmittedAt(signal);
  const createdAt = resolveCreatedAt(signal);
  const predictionTimestamp = resolvePredictionCreatedAt(signal);
  const sourceTimestamp = resolvePredictionTimestamp(signal);
  const handoffAttemptAt = parseDateLike(lifecycle.handoff_attempt_at);
  const ageMs = sourceTimestamp ? Math.max(0, until.getTime() - sourceTimestamp.getTime()) : null;
  const delayPredictionToSignalMs =
    emittedAt && predictionTimestamp ? Math.max(0, emittedAt.getTime() - predictionTimestamp.getTime()) : null;
  const delaySignalToHandoffMs = handoffAttemptAt && emittedAt
    ? Math.max(0, handoffAttemptAt.getTime() - emittedAt.getTime())
    : (emittedAt ? Math.max(0, until.getTime() - emittedAt.getTime()) : null);

  return {
    signal_id: signal.id || signal.prediction_id || null,
    symbol: signal.simbolo || signal.symbol || signal.simbolo_normalizado || null,
    emitted_at: emittedAt?.toISOString() || signal.signal_emitted_at || null,
    created_at: createdAt?.toISOString() || signal.created_at || signal.timestamp || null,
    server_now: until.toISOString(),
    age_ms: ageMs,
    max_allowed_age_ms: STALE_PENDING_PREDICTION_TIMEOUT_MS,
    source_timestamp: sourceTimestamp?.toISOString() || null,
    prediction_timestamp: predictionTimestamp?.toISOString() || null,
    delay_from_prediction_to_signal_ms: delayPredictionToSignalMs,
    delay_from_signal_to_handoff_ms: delaySignalToHandoffMs,
    handoff_attempt_at: handoffAttemptAt?.toISOString() || null,
    handoff_status: lifecycle.handoff_status || null
  };
}

function buildSample(signal = {}, hasIntent, handoffReason, until) {
  const emittedAt = resolvePredictionTimestamp(signal);
  const staleTrace = handoffReason === 'stale_signal' ? buildStaleSignalTrace(signal, until) : null;
  return {
    signal_id: signal.id || signal.prediction_id || null,
    symbol: signal.simbolo || signal.symbol || signal.simbolo_normalizado || null,
    origin: resolveSignalOrigin(signal),
    emitted_at: emittedAt?.toISOString() || signal.signal_emitted_at || signal.created_at || signal.timestamp || null,
    age_ms: emittedAt ? Math.max(0, until.getTime() - emittedAt.getTime()) : null,
    expected_move: toNumber(signal.expected_move_percent, null),
    confidence: toNumber(
      signal.decision_post_learning?.confidence ??
      signal.confidence_score ??
      signal.confidence ??
      signal.confianza,
      null
    ),
    has_intent: Boolean(hasIntent),
    handoff_reason: handoffReason,
    last_error_message: resolveLastErrorMessage(signal),
    ...(staleTrace || {})
  };
}

function average(values = []) {
  const finite = values.map((value) => Number(value)).filter(Number.isFinite);
  if (!finite.length) return null;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function deriveStaleSignalDiagnosis(staleSamples = []) {
  if (!staleSamples.length) return null;
  const threshold = STALE_PENDING_PREDICTION_TIMEOUT_MS;
  const ageValues = staleSamples.map((item) => item.age_ms);
  const signalDelayValues = staleSamples.map((item) => item.delay_from_signal_to_handoff_ms);
  const predictionDelayValues = staleSamples.map((item) => item.delay_from_prediction_to_signal_ms);
  const avgAge = average(ageValues);
  const avgSignalDelay = average(signalDelayValues);
  const avgPredictionDelay = average(predictionDelayValues);

  const hasClockSkew = staleSamples.some((item) => {
    const emittedAt = parseDateLike(item.emitted_at);
    const createdAt = parseDateLike(item.created_at);
    const predictionAt = parseDateLike(item.prediction_timestamp);
    const serverNow = parseDateLike(item.server_now);
    return (
      (emittedAt && serverNow && emittedAt.getTime() - serverNow.getTime() > 5000) ||
      (predictionAt && emittedAt && predictionAt.getTime() - emittedAt.getTime() > 5000) ||
      (createdAt && emittedAt && Math.abs(createdAt.getTime() - emittedAt.getTime()) > 5 * 60 * 1000)
    );
  });
  if (hasClockSkew) return 'clock_skew';

  const hasTimestampMismatch = staleSamples.some((item) => {
    const sourceTs = parseDateLike(item.source_timestamp);
    const emittedAt = parseDateLike(item.emitted_at);
    return sourceTs && emittedAt && Math.abs(sourceTs.getTime() - emittedAt.getTime()) > 60 * 1000;
  });
  if (hasTimestampMismatch) return 'timestamp_mismatch';

  const allExpiredByLongMargin = staleSamples.every((item) => Number(item.age_ms || 0) >= threshold * 3);
  if (allExpiredByLongMargin && (avgPredictionDelay == null || avgPredictionDelay <= 60 * 1000)) {
    return 'old_signal_reprocessed';
  }

  if (avgSignalDelay != null && avgSignalDelay > threshold * 2) {
    return 'handoff_delay';
  }

  if (avgAge != null && avgAge >= threshold && avgAge <= threshold * 1.35) {
    return 'max_age_too_strict';
  }

  return 'handoff_delay';
}

function buildHandoffLifecycleSummary(rows = []) {
  const attemptedWithin5s = [];
  const attemptedWithin30s = [];
  const signalToHandoffMsValues = [];
  let staleBecauseNotAttempted = 0;
  let staleBecauseReprocessedOldSignal = 0;

  for (const row of rows) {
    const signal = row.signal || {};
    const handoffReason = row.handoffReason || null;
    const lifecycle = resolveLifecycle(signal);
    const attempted5s = lifecycle.handoff_attempted_within_5s === true;
    const attempted30s = lifecycle.handoff_attempted_within_30s === true;
    if (attempted5s) attemptedWithin5s.push(signal.id);
    if (attempted30s) attemptedWithin30s.push(signal.id);

    const handoffAgeMs = toNumber(
      lifecycle.handoff_age_ms ??
      (parseDateLike(lifecycle.handoff_attempt_at) && resolveSignalEmittedAt(signal)
        ? parseDateLike(lifecycle.handoff_attempt_at).getTime() - resolveSignalEmittedAt(signal).getTime()
        : null),
      null
    );
    if (handoffAgeMs != null) {
      signalToHandoffMsValues.push(handoffAgeMs);
    }

    if (handoffReason !== 'stale_signal') continue;
    if (!lifecycle.handoff_attempt_at || lifecycle.handoff_status === 'not_attempted_immediately') {
      staleBecauseNotAttempted += 1;
    } else {
      staleBecauseReprocessedOldSignal += 1;
    }
  }

  return {
    handoff_attempted_within_5s: attemptedWithin5s.length,
    handoff_attempted_within_30s: attemptedWithin30s.length,
    avg_signal_to_handoff_ms: average(signalToHandoffMsValues) == null ? null : round(average(signalToHandoffMsValues), 0),
    stale_because_not_attempted: staleBecauseNotAttempted,
    stale_because_reprocessed_old_signal: staleBecauseReprocessedOldSignal
  };
}

function deriveDiagnosis(reasonsBreakdown = [], lifecycleSummary = {}, staleSignalTrace = null) {
  const getCount = (key) => reasonsBreakdown.find((item) => item.key === key)?.count || 0;
  const disabled =
    getCount('execution_disabled') +
    getCount('binance_disabled') +
    getCount('trading_mode_disabled');
  const notEligible =
    getCount('signal_origin_not_allowed') +
    getCount('symbol_not_tradeable') +
    getCount('missing_signal_fields') +
    getCount('invalid_symbol') +
    getCount('unsupported_timeframe') +
    getCount('stale_signal') +
    getCount('confidence_low') +
    getCount('quality_not_passed_for_execution');
  const writeIssue = getCount('intent_write_failed');
  const stateGuard =
    getCount('duplicate_intent') +
    getCount('existing_open_position') +
    getCount('max_concurrent_trades_reached') +
    getCount('cooldown_active') +
    getCount('risk_guard_blocked') +
    getCount('pre_validation_failed');

  const dominant = Math.max(disabled, notEligible, writeIssue, stateGuard);
  if (dominant === 0) return 'unknown_handoff';
  if (lifecycleSummary.stale_because_not_attempted > 0 && lifecycleSummary.handoff_attempted_within_5s === 0) {
    return 'handoff_not_triggered';
  }
  if (lifecycleSummary.stale_because_reprocessed_old_signal > 0 && staleSignalTrace?.diagnosis === 'old_signal_reprocessed') {
    return 'old_signal_reprocessed';
  }
  if (staleSignalTrace?.diagnosis === 'handoff_delay' || lifecycleSummary.avg_signal_to_handoff_ms > 30000) {
    return 'handoff_worker_delayed';
  }
  if (lifecycleSummary.handoff_attempted_within_5s > 0) {
    return 'handoff_ok';
  }
  if (dominant === disabled) return 'handoff_disabled';
  if (dominant === notEligible) return 'signals_not_eligible';
  if (dominant === writeIssue) return 'intent_write_issue';
  if (dominant === stateGuard) return 'state_guard_blocking';
  return 'unknown_handoff';
}

async function getSignalIntentHandoffDiagnostic(db, options = {}) {
  const maxDocs = Math.max(200, Math.min(5000, Number(options.maxDocs || 2000)));
  const { since, until } = getWindow(options);

  const [config, runtimeControl, predictionRows, intentRows, openRows, cooldownRows] = await Promise.all([
    getBinanceBotConfig(db),
    db.collection('system_runtime_config').doc('bot_execution').get().catch(() => null),
    loadRecentRows(db, 'velas_predicciones', 'created_at', maxDocs),
    loadRecentRows(db, 'binance_execution_intents', 'created_at', maxDocs),
    loadCurrentOpenRows(db, Math.min(maxDocs, 500)),
    loadCooldownStates(db, 1000)
  ]);

  const runtimeExecutionEnabled = runtimeControl?.exists
    ? runtimeControl.data()?.execution_enabled !== false
    : true;

  const emittedSignals = predictionRows.filter((row) => {
    const ts = resolvePredictionTimestamp(row);
    return ts && ts >= since && ts <= until && row.signal_emitted === true;
  });

  const intentIndex = buildIntentIndex(intentRows);
  const openPositionsBySymbol = new Map();
  for (const row of openRows) {
    const symbol = String(row.symbol || '').toUpperCase();
    if (!symbol) continue;
    openPositionsBySymbol.set(symbol, (openPositionsBySymbol.get(symbol) || 0) + 1);
  }

  const cooldownBySymbol = new Map();
  for (const row of cooldownRows) {
    const symbol = normalizeToBinanceSymbol(row.id || row.symbol || row.simbolo);
    const cooldownUntil = parseDateLike(row.cooldown_until);
    if (!symbol || !cooldownUntil) continue;
    cooldownBySymbol.set(symbol, cooldownUntil);
  }

  const configByProfile = {
    high_conviction: buildEffectiveConfigLite(config, 'high_conviction'),
    event_emitted: buildEffectiveConfigLite(config, 'event_emitted'),
    manual_prealert: buildEffectiveConfigLite(config, 'manual_prealert'),
    unknown: buildEffectiveConfigLite(config, 'high_conviction')
  };

  const reasons = {};
  const samples = [];
  const staleSignalSamples = [];
  const noIntentSignals = [];
  let signalsWithIntent = 0;
  let attemptCount = 0;
  let failCount = 0;

  for (const signal of emittedSignals) {
    const predictionId = String(signal.id || signal.prediction_id || '');
    const matchingIntents = predictionId ? (intentIndex.get(predictionId) || []) : [];
    const hasIntent = matchingIntents.length > 0;
    if (hasIntent) {
      signalsWithIntent += 1;
      continue;
    }

    const attempted = hasIntentCreationAttempt(signal);
    if (attempted) {
      attemptCount += 1;
    }

    const handoffReason = classifySignalWithoutIntent(signal, {
      runtimeExecutionEnabled,
      configByProfile,
      defaultConfig: buildEffectiveConfigLite(config, 'high_conviction'),
      openPositionsBySymbol,
      currentOpenPositions: openRows.length,
      cooldownBySymbol,
      until
    });

    increment(reasons, handoffReason);
    noIntentSignals.push({ signal, handoffReason });
    if (attempted) {
      failCount += 1;
    }
    if (handoffReason === 'stale_signal' && staleSignalSamples.length < 5) {
      staleSignalSamples.push(buildStaleSignalTrace(signal, until));
    }
    if (samples.length < 5) {
      samples.push(buildSample(signal, hasIntent, handoffReason, until));
    }
  }

  const reasonsBreakdown = topEntries(reasons, 20);
  const staleSignalTrace = {
    diagnosis: deriveStaleSignalDiagnosis(staleSignalSamples),
    samples: staleSignalSamples
  };
  const lifecycleSummary = buildHandoffLifecycleSummary(noIntentSignals);

  return {
    window: {
      since: since.toISOString(),
      until: until.toISOString(),
      hours: round((until.getTime() - since.getTime()) / (60 * 60 * 1000), 2)
    },
    signals_emitted: emittedSignals.length,
    signals_with_intent: signalsWithIntent,
    signals_without_intent: Math.max(0, emittedSignals.length - signalsWithIntent),
    intent_creation_attempts: attemptCount,
    intent_creation_success: signalsWithIntent,
    intent_creation_fail: failCount,
    handoff_attempted_within_5s: lifecycleSummary.handoff_attempted_within_5s,
    handoff_attempted_within_30s: lifecycleSummary.handoff_attempted_within_30s,
    avg_signal_to_handoff_ms: lifecycleSummary.avg_signal_to_handoff_ms,
    stale_because_not_attempted: lifecycleSummary.stale_because_not_attempted,
    stale_because_reprocessed_old_signal: lifecycleSummary.stale_because_reprocessed_old_signal,
    top_handoff_reason: reasonsBreakdown[0]?.key || null,
    reasons_breakdown: reasonsBreakdown,
    stale_signal_trace: staleSignalTrace,
    samples,
    diagnosis: deriveDiagnosis(reasonsBreakdown, lifecycleSummary, staleSignalTrace)
  };
}

module.exports = {
  getSignalIntentHandoffDiagnostic
};
