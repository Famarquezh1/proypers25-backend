const crypto = require('crypto');
const { FieldValue } = require('firebase-admin/firestore');
const { getBinanceBotConfig } = require('./binanceBotConfig');

const BINANCE_EXECUTION_ENABLED = process.env.BINANCE_EXECUTION_ENABLED === 'true';
const BINANCE_EXECUTION_DRY_RUN = String(process.env.BINANCE_EXECUTION_DRY_RUN || '').toLowerCase() === 'true';
const BINANCE_FUTURES_BASE_URL = process.env.BINANCE_FUTURES_BASE_URL || 'https://fapi.binance.com';
const BINANCE_API_KEY = process.env.BINANCE_API_KEY || '';
const BINANCE_API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_DEFAULT_LEVERAGE = Math.max(1, Number(process.env.BINANCE_DEFAULT_LEVERAGE || 5));
const BINANCE_TRADE_NOTIONAL_USDT = Math.max(5, Number(process.env.BINANCE_TRADE_NOTIONAL_USDT || 35));
const BINANCE_MIN_CONFIDENCE = Number(process.env.BINANCE_EXEC_MIN_CONFIDENCE || 0.9);
const BINANCE_MIN_QUANTUM = Number(process.env.BINANCE_EXEC_MIN_QUANTUM || 0.85);
const BINANCE_MIN_TIMING = Number(process.env.BINANCE_EXEC_MIN_TIMING || 0.8);
const SOURCE_PROFILE_KEYS = new Set(['high_conviction', 'event_emitted', 'manual_prealert']);
const EXCHANGE_INFO_TTL_MS = 10 * 60 * 1000;
const exchangeInfoCache = new Map();
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

function getOrderSide(direction) {
  if (direction === 'up') return 'BUY';
  if (direction === 'down') return 'SELL';
  return null;
}

function createSignature(queryString) {
  return crypto.createHmac('sha256', BINANCE_API_SECRET).update(queryString).digest('hex');
}

async function signedRequest(path, params, method = 'POST') {
  const timestamp = Date.now();
  const payload = new URLSearchParams({ ...params, timestamp, recvWindow: 5000 });
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
  const now = Date.now();
  const cached = exchangeInfoCache.get(symbol);
  if (cached && now - cached.fetchedAt < EXCHANGE_INFO_TTL_MS) {
    return cached.rules;
  }

  const response = await fetch(`${BINANCE_FUTURES_BASE_URL}/fapi/v1/exchangeInfo?symbol=${encodeURIComponent(symbol)}`);
  if (!response.ok) {
    throw new Error(`Binance exchangeInfo failed (${response.status})`);
  }
  const data = await response.json();
  const info = Array.isArray(data?.symbols) ? data.symbols[0] : null;
  if (!info) return null;
  const filters = Array.isArray(info.filters) ? info.filters : [];
  const lot = filters.find(f => f.filterType === 'LOT_SIZE') || {};
  const price = filters.find(f => f.filterType === 'PRICE_FILTER') || {};

  const rules = {
    quantityPrecision: Number(info.quantityPrecision),
    pricePrecision: Number(info.pricePrecision),
    stepSize: Number(lot.stepSize || 0),
    minQty: Number(lot.minQty || 0),
    tickSize: Number(price.tickSize || 0)
  };
  exchangeInfoCache.set(symbol, { fetchedAt: now, rules });
  return rules;
}

function applyIntentPrecision(intent, rules) {
  if (!rules) return intent;
  const adjusted = { ...intent };

  adjusted.quantity = floorToStep(adjusted.quantity, rules.stepSize);
  if (Number.isFinite(rules.minQty) && rules.minQty > 0) {
    if (adjusted.quantity < rules.minQty) {
      adjusted.quantity = Number(rules.minQty);
    }
    adjusted.quantity = floorToStep(adjusted.quantity, rules.stepSize);
  }

  adjusted.entry_price = roundToTick(adjusted.entry_price, rules.tickSize);
  adjusted.take_profit = roundToTick(adjusted.take_profit, rules.tickSize);
  adjusted.stop_loss = roundToTick(adjusted.stop_loss, rules.tickSize);

  if (Number.isFinite(rules.quantityPrecision) && rules.quantityPrecision >= 0) {
    adjusted.quantity = Number(adjusted.quantity.toFixed(rules.quantityPrecision));
  }
  if (Number.isFinite(rules.pricePrecision) && rules.pricePrecision >= 0) {
    adjusted.entry_price = Number(adjusted.entry_price.toFixed(rules.pricePrecision));
    adjusted.take_profit = Number(adjusted.take_profit.toFixed(rules.pricePrecision));
    adjusted.stop_loss = Number(adjusted.stop_loss.toFixed(rules.pricePrecision));
  }

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
    reduceOnly: true
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
  return {
    ...config,
    ...profile,
    mode,
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
  const notionalUsdt = resolveNotional(config) * sizingFactor;
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
  if (intent.context_score < Number(config.min_context_score ?? 0)) return { ok: false, reason: 'context_score_low' };
  if (intent.risk_reward_ratio < Number(config.min_risk_reward ?? 0)) return { ok: false, reason: 'risk_reward_low' };
  if (intent.expected_move_percent < Number(config.min_expected_move_pct ?? 0)) return { ok: false, reason: 'expected_move_low' };

  const todayStart = startOfUtcDay();
  const daily = await db
    .collection('binance_execution_intents')
    .where('status', '==', 'executed')
    .where('source_profile', '==', sourceProfile)
    .where('created_at', '>=', todayStart)
    .limit(Number(config.max_daily_trades || 1))
    .get();
  if (daily.size >= Number(config.max_daily_trades || 1)) return { ok: false, reason: 'daily_trade_limit' };

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

  return signedRequest('/fapi/v1/order', {
    symbol: intent.symbol,
    side: oppositeSide,
    type: 'LIMIT',
    timeInForce: 'GTC',
    price: tpPrice,
    quantity: intent.quantity,
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

  try {
    const tpRes = await signedRequest('/fapi/v1/order', {
      symbol: intent.symbol,
      side: oppositeSide,
      type: intent.tp_order_type,
      stopPrice: tpStopPrice,
      quantity: intent.quantity,
      reduceOnly: true,
      workingType: 'MARK_PRICE'
    });

    const slRes = await signedRequest('/fapi/v1/order', {
      symbol: intent.symbol,
      side: oppositeSide,
      type: intent.sl_order_type,
      stopPrice: slStopPrice,
      quantity: intent.quantity,
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
      throw err;
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
  const config = await getBinanceBotConfig(db);
  const effectiveConfig = buildEffectiveConfig(config, sourceProfile);
  const intent = buildExecutionIntent(signalData, effectiveConfig);
  const predictionId = signalData?.prediction_id || signalData?.id || null;

  if (predictionId) {
    const existing = await db
      .collection('binance_execution_intents')
      .where('prediction_id', '==', predictionId)
      .where('source_profile', '==', sourceProfile)
      .limit(1)
      .get();
    if (!existing.empty) {
      return { executed: false, reason: 'already_processed', dry_run: false, skipped: true };
    }
  }

  const rules = await getFuturesSymbolRules(intent.symbol);
  const preciseIntent = applyIntentPrecision(intent, rules);
  const validation = await validateExecutionIntent(db, preciseIntent, effectiveConfig, { source_profile: sourceProfile });
  const modeDryRun = effectiveConfig.mode === 'dry-run' || BINANCE_EXECUTION_DRY_RUN;
  const preExecutionAudit = buildExecutionAudit(signalData);

  const baseLog = {
    source: options.source || sourceProfile,
    source_profile: sourceProfile,
    prediction_id: predictionId,
    created_at: FieldValue.serverTimestamp(),
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
      min_confidence: effectiveConfig.min_confidence,
      min_quantum: effectiveConfig.min_quantum,
      min_timing: effectiveConfig.min_timing,
      min_context_score: effectiveConfig.min_context_score,
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
    validation,
    intent: preciseIntent,
    execution_audit: preExecutionAudit
  };

  if (!validation.ok) {
    await db.collection('binance_execution_intents').add({
      ...baseLog,
      status: 'skipped'
    });
    return { executed: false, reason: validation.reason, dry_run: modeDryRun };
  }

  if (modeDryRun) {
    await db.collection('binance_execution_intents').add({
      ...baseLog,
      status: 'dry_run'
    });
    return { executed: false, reason: 'dry_run', dry_run: true };
  }

  const marginRes = await setMarginType(preciseIntent.symbol, preciseIntent.margin_type);
  const leverageRes = await setLeverage(preciseIntent.symbol, preciseIntent.leverage);
  const orderRes = await signedRequest('/fapi/v1/order', {
    symbol: preciseIntent.symbol,
    side: preciseIntent.side,
    type: preciseIntent.order_type,
    quantity: preciseIntent.quantity
  });
  const exitsRes = await placeExitOrders(preciseIntent, rules);
  const tpOrderId = exitsRes?.tp?.orderId || exitsRes?.tp_limit?.orderId || null;
  const slOrderId = exitsRes?.sl?.orderId || null;
  const executionAudit = buildExecutionAudit(signalData, new Date());

  await db.collection('binance_execution_intents').add({
    ...baseLog,
    status: 'executed',
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
    execution_audit: executionAudit,
    win_model: executionAudit.win_model,
    win_exchange: null,
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
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
  toBinanceSymbol,
  getMarkPrice,
  getPositionRisk,
  closePositionMarket
};

