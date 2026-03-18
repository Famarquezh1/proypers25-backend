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

const BINANCE_EXECUTION_ENABLED = process.env.BINANCE_EXECUTION_ENABLED === 'true';
const BINANCE_EXECUTION_DRY_RUN = String(process.env.BINANCE_EXECUTION_DRY_RUN || '').toLowerCase() === 'true';
const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
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
const SOURCE_PROFILE_KEYS = new Set(['high_conviction', 'event_emitted', 'manual_prealert']);
const EXCHANGE_INFO_TTL_MS = 10 * 60 * 1000;
const exchangeInfoCache = new Map();
const leverageBracketCache = new Map();
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
const POSITION_HOLD_MIN_SECONDS = Math.max(60, Number(process.env.BINANCE_POSITION_MIN_HOLD_SECONDS || 180));
const POSITION_HOLD_MULTIPLIER = Math.max(1, Number(process.env.BINANCE_POSITION_SIGNAL_HOLD_MULTIPLIER || 5));
const POSITION_HOLD_MULTIPLIER_HIGH_CONVICTION = Math.max(
  POSITION_HOLD_MULTIPLIER,
  Number(process.env.BINANCE_POSITION_SIGNAL_HOLD_MULTIPLIER_HIGH_CONVICTION || 8)
);
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

function normalizeModelOutcome(raw) {
  const value = String(raw || '').trim().toUpperCase();
  if (!value) return 'PENDING';
  if (value.includes('WIN') || value.includes('VALIDADO')) return 'WIN';
  if (value.includes('LOSS') || value.includes('FAIL')) return 'LOSS';
  if (value.includes('SUPRIMIDA')) return 'SUPPRESSED';
  if (value.includes('PEND')) return 'PENDING';
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
    if (sourceProfile === 'high_conviction' && adaptiveHorizon > 0) {
      return Math.round(
        clamp(
          Math.max(expectedWindowBased, adaptiveHorizon * 0.5),
          POSITION_HOLD_MIN_SECONDS,
          globalMax
        )
      );
    }
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
  if (!symbol) return null;
  const upper = String(symbol).toUpperCase().replace('/', '-');
  if (upper.endsWith('-USD')) return `${upper.replace('-USD', '')}USDT`;
  if (upper.endsWith('-USDT')) return `${upper.replace('-USDT', '')}USDT`;
  return upper.replace(/[^A-Z0-9]/g, '');
}

function toSystemUsdSymbol(binanceSymbol) {
  const upper = String(binanceSymbol || '').toUpperCase();
  if (!upper.endsWith('USDT')) return upper;
  return `${upper.slice(0, -4)}-USD`;
}

function getOrderSide(direction) {
  if (direction === 'up') return 'BUY';
  if (direction === 'down') return 'SELL';
  return null;
}

function createSignature(queryString) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
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
    throw new Error(`Binance API ${path} failed (${response.status}): ${bodyText}`);
  }
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

  const data = await signedRequest('/fapi/v1/leverageBracket', { symbol: requestedSymbol }, 'GET');
  const normalized = Array.isArray(data) ? data[0] : data;
  leverageBracketCache.set(requestedSymbol, { fetchedAt: now, data: normalized || null });
  return normalized || null;
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
  const response = await fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/premiumIndex?symbol=${encodeURIComponent(symbol)}`);
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

async function getFuturesSymbolRules(symbol) {
  if (!symbol) return null;
  const requestedSymbol = String(symbol || '').toUpperCase();
  const now = Date.now();
  const cached = exchangeInfoCache.get(requestedSymbol);
  if (cached && now - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) {
    return cached.rules;
  }

  const response = await fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(requestedSymbol)}`);
  if (!response.ok) {
    throw new Error(`Binance exchangeInfo failed (${response.status})`);
  }
  const data = await response.json();
  const info = Array.isArray(data?.symbols)
    ? data.symbols.find(item => String(item?.symbol || '').toUpperCase() === requestedSymbol) || null
    : null;
  if (!info) return null;
  const filters = Array.isArray(info.filters) ? info.filters : [];
  const lot = filters.find(f => f.filterType === 'LOT_SIZE') || {};
  const marketLot = filters.find(f => f.filterType === 'MARKET_LOT_SIZE') || {};
  const price = filters.find(f => f.filterType === 'PRICE_FILTER') || {};

  const rules = {
    symbol: requestedSymbol,
    quantityPrecision: Number(info.quantityPrecision),
    pricePrecision: Number(info.pricePrecision),
    stepSize: Number(lot.stepSize || 0),
    minQty: Number(lot.minQty || 0),
    marketStepSize: Number(marketLot.stepSize || 0),
    marketMinQty: Number(marketLot.minQty || 0),
    tickSize: Number(price.tickSize || 0)
  };
  exchangeInfoCache.set(requestedSymbol, { fetchedAt: now, rules });
  return rules;
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

async function closePositionMarket(intent) {
  const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';
  return signedRequest('/fapi/v1/order', {
    symbol: intent.symbol,
    side: oppositeSide,
    type: 'MARKET',
    quantity: intent.quantity,
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

function buildEffectiveConfig(config, sourceProfile) {
  const profileKey = resolveSourceProfileKey(sourceProfile);
  const profile =
    config?.execution_profiles && typeof config.execution_profiles === 'object'
      ? (config.execution_profiles[profileKey] || {})
      : {};
  const mode = profile.mode && profile.mode !== 'inherit' ? profile.mode : config.mode;
  const profileAllowlist = Array.isArray(profile.symbols_allowlist) ? profile.symbols_allowlist : null;
  const allowUnlistedGlobal = Boolean(config.allow_unlisted_symbols);
  const allowUnlistedProfile = Boolean(profile.allow_unlisted_symbols);
  return {
    ...config,
    ...profile,
    mode,
    allow_unlisted_symbols: allowUnlistedGlobal || allowUnlistedProfile,
    symbols_allowlist: profileAllowlist && profileAllowlist.length > 0 ? profileAllowlist : config.symbols_allowlist,
    source_profile: profileKey
  };
}

function buildExecutionIntent(signalData, config) {
  const symbol = toBinanceSymbol(signalData?.symbol || signalData?.simbolo);
  const direction = signalData?.direction;
  const side = getOrderSide(direction);
  const confidence = normalizePercent(signalData?.confidence ?? signalData?.confianza);
  const quantum = normalizePercent(signalData?.quantum_score);
  const timing = normalizePercent(signalData?.timing_score);

  const sizingFactor = resolveSizingFactor(signalData, config);
  const computedNotional = resolveNotional(config) * sizingFactor;
  const notionalCap = Number(config?.max_notional_usdt || 0);
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
    sl_buffer_pct: Number(config?.sl_buffer_pct || 0)
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

  try {
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
  } catch (_) {
    return false;
  }
}

async function validateExecutionIntent(db, intent, config, options = {}) {
  const sourceProfile = resolveSourceProfileKey(options.source_profile);
  if (!BINANCE_EXECUTION_ENABLED) return { ok: false, reason: 'disabled_by_env' };
  if (config.enabled === false) return { ok: false, reason: 'profile_disabled' };
  if (config.mode === 'off') return { ok: false, reason: 'mode_off' };
  if (!intent.symbol) return { ok: false, reason: 'symbol_missing' };
  if (!intent.side) return { ok: false, reason: 'neutral_direction' };
  if (!Number.isFinite(intent.quantity) || intent.quantity <= 0) return { ok: false, reason: 'invalid_quantity' };
  if (!config.allow_unlisted_symbols && Array.isArray(config.symbols_allowlist) && config.symbols_allowlist.length > 0) {
    if (!config.symbols_allowlist.includes(intent.symbol)) return { ok: false, reason: 'symbol_not_allowed' };
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
  if (intent.notional_usdt > Number(config.max_notional_usdt || Number.MAX_SAFE_INTEGER)) {
    return { ok: false, reason: 'notional_cap_exceeded' };
  }
  const hasRecentRecords = await hasEnoughRecentValidRecords(db, intent, config);
  if (!hasRecentRecords) return { ok: false, reason: 'insufficient_recent_records' };

  const todayStart = startOfUtcDay();
  const daily = await db
    .collection('binance_execution_intents')
    .where('status', '==', 'executed')
    .where('source_profile', '==', sourceProfile)
    .where('created_at', '>=', todayStart)
    .limit(Number(config.max_daily_trades || 1))
    .get();
  if (daily.size >= Number(config.max_daily_trades || 1)) return { ok: false, reason: 'daily_trade_limit' };
  const symbolCooldownMinutes = Math.max(0, Math.floor(Number(config.symbol_cooldown_minutes || 0)));
  if (symbolCooldownMinutes > 0) {
    const cooldownStart = new Date(Date.now() - symbolCooldownMinutes * 60 * 1000);
    const recentExecuted = await db
      .collection('binance_execution_intents')
      .where('status', '==', 'executed')
      .where('source_profile', '==', sourceProfile)
      .where('created_at', '>=', cooldownStart)
      .limit(50)
      .get();
    const hasRecentSameSymbol = recentExecuted.docs.some((doc) => {
      const data = doc.data() || {};
      const symbol = data?.intent?.symbol || null;
      return symbol === intent.symbol;
    });
    if (hasRecentSameSymbol) return { ok: false, reason: 'symbol_cooldown_active' };
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

function adjustExitPrice(base, side, bufferPct, kind) {
  const price = Number(base || 0);
  const buffer = Number(bufferPct || 0) / 100;
  if (!price || !buffer) return price;
  if (kind === 'tp') {
    return side === 'BUY' ? price * (1 + buffer) : price * (1 - buffer);
  }
  return side === 'BUY' ? price * (1 - buffer) : price * (1 + buffer);
}

function isAlgoUnsupportedError(err) {
  const message = String(err?.message || '');
  return message.includes('-4120') || message.toLowerCase().includes('order type not supported');
}

async function placeReduceOnlyTpLimit(intent, rules = null) {
  const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';
  let tpPrice = Number(intent.take_profit || 0);
  if (rules?.tickSize) {
    tpPrice = roundToTick(tpPrice, rules.tickSize);
  }
  if (Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0) {
    tpPrice = Number(tpPrice.toFixed(rules.pricePrecision));
  }

  const qtyPrecision = Number.isFinite(intent?._quantity_precision)
    ? Number(intent._quantity_precision)
    : decimalsFromStep(rules?.marketStepSize || rules?.stepSize || 0);

  return signedRequest('/fapi/v1/order', {
    symbol: intent.symbol,
    side: oppositeSide,
    type: 'LIMIT',
    timeInForce: 'GTC',
    price: Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0
      ? toPlainFixed(tpPrice, rules.pricePrecision)
      : String(tpPrice),
    quantity: toPlainFixed(intent.quantity, qtyPrecision),
    reduceOnly: true
  });
}

async function placeExitOrders(intent, rules = null) {
  if (!intent.enable_tp_sl) return { placed: false, reason: 'tp_sl_disabled' };
  if (!intent.take_profit || !intent.stop_loss) return { placed: false, reason: 'tp_sl_missing' };
  const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';

  let tpStopPrice = Number(adjustExitPrice(intent.take_profit, intent.side, intent.tp_buffer_pct, 'tp').toFixed(8));
  let slStopPrice = Number(adjustExitPrice(intent.stop_loss, intent.side, intent.sl_buffer_pct, 'sl').toFixed(8));
  if (rules?.tickSize) {
    tpStopPrice = roundToTick(tpStopPrice, rules.tickSize);
    slStopPrice = roundToTick(slStopPrice, rules.tickSize);
  }
  if (Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0) {
    tpStopPrice = Number(tpStopPrice.toFixed(rules.pricePrecision));
    slStopPrice = Number(slStopPrice.toFixed(rules.pricePrecision));
  }

  const qtyPrecision = Number.isFinite(intent?._quantity_precision)
    ? Number(intent._quantity_precision)
    : decimalsFromStep(rules?.marketStepSize || rules?.stepSize || 0);
  const pricePrecision = Number.isFinite(rules?.pricePrecision) && rules.pricePrecision >= 0
    ? Number(rules.pricePrecision)
    : 8;

  try {
    const tpRes = await signedRequest('/fapi/v1/order', {
      symbol: intent.symbol,
      side: oppositeSide,
      type: intent.tp_order_type,
      stopPrice: toPlainFixed(tpStopPrice, pricePrecision),
      quantity: toPlainFixed(intent.quantity, qtyPrecision),
      reduceOnly: true,
      workingType: 'MARK_PRICE'
    });

    const slRes = await signedRequest('/fapi/v1/order', {
      symbol: intent.symbol,
      side: oppositeSide,
      type: intent.sl_order_type,
      stopPrice: toPlainFixed(slStopPrice, pricePrecision),
      quantity: toPlainFixed(intent.quantity, qtyPrecision),
      reduceOnly: true,
      workingType: 'MARK_PRICE'
    });

    return {
      placed: true,
      tp: tpRes,
      sl: slRes,
      tp_stop_price: tpStopPrice,
      sl_stop_price: slStopPrice
    };
  } catch (err) {
    if (!isAlgoUnsupportedError(err)) {
      return {
        placed: false,
        reason: 'exit_order_failed',
        error: String(err?.message || err)
      };
    }

    // Fallback: algunas cuentas de futures rechazan STOP/TP en este endpoint (-4120).
    // En ese caso dejamos al menos un TP limit reduce-only para no romper la ejecución.
    let tpLimitRes = null;
    try {
      tpLimitRes = await placeReduceOnlyTpLimit(intent, rules);
    } catch (limitErr) {
      return {
        placed: false,
        reason: 'algo_order_not_supported_tp_limit_failed',
        error: String(limitErr?.message || limitErr)
      };
    }

    return {
      placed: false,
      reason: 'algo_order_not_supported',
      fallback: 'tp_limit_only',
      tp_limit: tpLimitRes,
      tp_stop_price: tpStopPrice,
      sl_stop_price: slStopPrice,
      error: String(err?.message || err)
    };
  }
}

async function executeSignalTrade(db, signalData, options = {}) {
  const sourceProfile = resolveSourceProfileKey(options.source_profile || options.source || 'high_conviction');
  const receivedAtIso = new Date().toISOString();
  const signalDataForExecution = {
    ...signalData,
    signal_emitted_at:
      signalData?.signal_emitted_at || signalData?.emitted_at || signalData?.timestamp || receivedAtIso,
    timestamp: signalData?.timestamp || receivedAtIso
  };
  const config = await getBinanceBotConfig(db);
  const effectiveConfig = buildEffectiveConfig(config, sourceProfile);
  const intent = createExecutionIntent(signalDataForExecution, effectiveConfig, sourceProfile);
  const predictionId = signalDataForExecution?.prediction_id || signalDataForExecution?.id || null;
  let executionTrace = buildInitialExecutionTrace({
    ...signalDataForExecution,
    source_profile: sourceProfile
  });
  const intentRef = buildIntentDocRef(db, predictionId, sourceProfile);
  const existingIntent = await intentRef.get();
  if (existingIntent.exists) {
    const existingData = existingIntent.data() || {};
    if (existingData.status && existingData.status !== 'processing') {
      return { executed: false, reason: 'already_processed', dry_run: false, skipped: true };
    }
  }
  await writeIntentDoc(intentRef, {
    prediction_id: predictionId,
    source_profile: sourceProfile,
    source: options.source || sourceProfile,
    status: 'processing',
    trace_id: executionTrace.trace_id,
    execution_trace: executionTrace,
    created_at: existingIntent.exists ? existingIntent.get('created_at') || FieldValue.serverTimestamp() : FieldValue.serverTimestamp()
  });

  const modeDryRun = effectiveConfig.mode === 'dry-run' || BINANCE_EXECUTION_DRY_RUN;
  const preExecutionAudit = buildExecutionAudit(signalDataForExecution);
  const entryDiscipline = await evaluateEntryDiscipline({
    db,
    signalData: signalDataForExecution,
    intent,
    sourceProfile
  });

  const baseLog = {
    source: options.source || sourceProfile,
    source_profile: sourceProfile,
    signal_origin_stage: sourceProfile,
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
      sl_buffer_pct: effectiveConfig.sl_buffer_pct
    },
    validation: null,
    execution_discipline: entryDiscipline.details,
    trace_id: executionTrace.trace_id,
    execution_trace: executionTrace,
    intent,
    execution_audit: preExecutionAudit
  };
  await writeIntentDoc(intentRef, baseLog);
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
    return { executed: false, reason: entryDiscipline.reason, dry_run: modeDryRun };
  }

  const [rules, validation] = await Promise.all([
    getFuturesSymbolRules(intent.symbol),
    validateExecutionIntent(db, intent, effectiveConfig, { source_profile: sourceProfile })
  ]);
  const preciseIntent = applyIntentPrecision(intent, rules);
  executionTrace = advanceExecutionTrace(executionTrace, {
    intent_processed_at: Date.now()
  });
  await writeIntentDoc(intentRef, {
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
    return { executed: false, reason: validation.reason, dry_run: modeDryRun };
  }

  if (modeDryRun) {
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
      trace_id: tracePayload.trace_id,
      execution_trace: tracePayload.execution_trace,
      execution_trace_metrics: tracePayload.execution_trace_metrics,
      dominant_delay_stage: tracePayload.dominant_delay_stage,
      critical_delay: tracePayload.critical_delay
    });
    return { executed: false, reason: 'dry_run', dry_run: true };
  }

  let marginRes = null;
  let leverageRes = null;
  let orderRes = null;
  let exitsRes = null;
  let adaptiveExecutionProfile = null;
  const qtyPrecision = Number.isFinite(preciseIntent?._quantity_precision)
    ? Number(preciseIntent._quantity_precision)
    : decimalsFromStep(rules?.marketStepSize || rules?.stepSize || 0);
  try {
    executionTrace = advanceExecutionTrace(executionTrace, {
      execution_attempt_at: Date.now()
    });
    [marginRes, leverageRes] = await Promise.all([
      setMarginType(preciseIntent.symbol, preciseIntent.margin_type),
      setLeverageSafely(preciseIntent.symbol, preciseIntent.leverage)
    ]);
    executionTrace = advanceExecutionTrace(executionTrace, {
      order_sent_at: Date.now()
    });
    orderRes = await signedRequest('/fapi/v1/order', {
      symbol: preciseIntent.symbol,
      side: preciseIntent.side,
      type: preciseIntent.order_type,
      quantity: toPlainFixed(preciseIntent.quantity, qtyPrecision),
      newOrderRespType: 'RESULT'
    });
    executionTrace = advanceExecutionTrace(executionTrace, {
      order_ack_at: Date.now()
    });

    const slippageDiscipline = await evaluateFilledOrderDiscipline({
      db,
      signalData,
      intent: preciseIntent,
      orderResponse: orderRes,
      sourceProfile
    });
    if (slippageDiscipline.blocked) {
      const emergencyClose = await closePositionMarket({
        symbol: preciseIntent.symbol,
        side: preciseIntent.side,
        quantity: preciseIntent.quantity
      }).catch((err) => ({ error: String(err?.message || err) }));
      const tracePayload = await persistExecutionLatencyObservation(db, signalDataForExecution, {
        trace: executionTrace,
        symbol: preciseIntent.symbol,
        signal_type: sourceProfile,
        state: 'blocked',
        late_entry_blocked: false
      });

      await writeIntentDoc(intentRef, {
        ...baseLog,
        status: 'blocked',
        reason: slippageDiscipline.reason,
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
      return {
        executed: false,
        reason: slippageDiscipline.reason,
        dry_run: false,
        blocked: true
      };
    }

    exitsRes = await placeExitOrders(preciseIntent, rules);
  } catch (err) {
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
    throw err;
  }
  try {
    adaptiveExecutionProfile = await loadAdaptiveExecutionProfile();
  } catch (_) {
    adaptiveExecutionProfile = null;
  }
  const tpOrderId = exitsRes?.tp?.orderId || exitsRes?.tp_limit?.orderId || null;
  const slOrderId = exitsRes?.sl?.orderId || null;
  const executionAudit = buildExecutionAudit(signalDataForExecution, new Date());
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
      source_profile: sourceProfile,
      source: options.source || sourceProfile
    },
    adaptiveProfile: adaptiveExecutionProfile
  });

  await writeIntentDoc(intentRef, {
    ...baseLog,
    status: 'executed',
    trace_id: tracePayload.trace_id,
    execution_trace: tracePayload.execution_trace,
    execution_trace_metrics: tracePayload.execution_trace_metrics,
    dominant_delay_stage: tracePayload.dominant_delay_stage,
    critical_delay: tracePayload.critical_delay,
    execution_audit: executionAudit,
    exchange_response: {
      margin: marginRes,
      leverage: leverageRes,
      order: orderRes,
      exits: exitsRes
    }
  });

  const openedAt = new Date().toISOString();
  const openPositionRef = await db.collection('binance_open_positions').add({
    source: options.source || sourceProfile,
    source_profile: sourceProfile,
    signal_origin_stage: sourceProfile,
    prediction_id: predictionId,
    symbol: preciseIntent.symbol,
    side: preciseIntent.side,
    quantity: preciseIntent.quantity,
    entry_price: preciseIntent.entry_price,
    take_profit: preciseIntent.take_profit,
    stop_loss: preciseIntent.stop_loss,
    order_id: orderRes?.orderId || null,
    tp_order_id: tpOrderId,
    sl_order_id: slOrderId,
    opened_at: openedAt,
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
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  });

  await logExecutionDiscipline(db, {
    type: 'entry_control',
    event: 'entry_accepted',
      blocked: false,
      source_profile: sourceProfile,
      symbol: preciseIntent.symbol,
      prediction_id: predictionId,
      details: {
        execution_delay_seconds: executionAudit?.delay_seconds ?? null,
        execution_delay_ms: entryDiscipline?.details?.execution_delay_ms ?? null,
        is_late_entry: executionAudit?.is_late_entry ?? null,
        quantity: preciseIntent.quantity,
        late_entry_type: entryDiscipline?.details?.late_entry_type || 'none',
        override_applied: Boolean(entryDiscipline?.details?.override_applied),
        override_reason: entryDiscipline?.details?.override_reason || 'normal_execution'
      }
    });

  return {
    executed: true,
    dry_run: false,
    symbol: preciseIntent.symbol,
    side: preciseIntent.side,
    quantity: preciseIntent.quantity,
    order_id: orderRes?.orderId || null,
    open_position_id: openPositionRef.id,
    exits: exitsRes?.placed
      ? {
          tp_order_id: tpOrderId,
          sl_order_id: slOrderId,
          tp_stop_price: exitsRes?.tp_stop_price || null,
          sl_stop_price: exitsRes?.sl_stop_price || null
        }
      : exitsRes?.tp_limit
        ? {
            tp_order_id: tpOrderId,
            sl_order_id: null,
            fallback: exitsRes?.fallback || 'tp_limit_only',
            reason: exitsRes?.reason || null
          }
        : null
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
  closePositionMarket
};

