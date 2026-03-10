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

async function placeExitOrders(intent) {
  if (!intent.enable_tp_sl) return { placed: false, reason: 'tp_sl_disabled' };
  if (!intent.take_profit || !intent.stop_loss) return { placed: false, reason: 'tp_sl_missing' };
  const oppositeSide = intent.side === 'BUY' ? 'SELL' : 'BUY';

  const tpStopPrice = Number(adjustExitPrice(intent.take_profit, intent.side, intent.tp_buffer_pct, 'tp').toFixed(8));
  const slStopPrice = Number(adjustExitPrice(intent.stop_loss, intent.side, intent.sl_buffer_pct, 'sl').toFixed(8));

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

  const validation = await validateExecutionIntent(db, intent, effectiveConfig, { source_profile: sourceProfile });
  const modeDryRun = effectiveConfig.mode === 'dry-run' || BINANCE_EXECUTION_DRY_RUN;

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
    intent
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

  const marginRes = await setMarginType(intent.symbol, intent.margin_type);
  const leverageRes = await setLeverage(intent.symbol, intent.leverage);
  const orderRes = await signedRequest('/fapi/v1/order', {
    symbol: intent.symbol,
    side: intent.side,
    type: intent.order_type,
    quantity: intent.quantity
  });
  const exitsRes = await placeExitOrders(intent);

  await db.collection('binance_execution_intents').add({
    ...baseLog,
    status: 'executed',
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
    symbol: intent.symbol,
    side: intent.side,
    quantity: intent.quantity,
    entry_price: intent.entry_price,
    take_profit: intent.take_profit,
    stop_loss: intent.stop_loss,
    order_id: orderRes?.orderId || null,
    tp_order_id: exitsRes?.tp?.orderId || null,
    sl_order_id: exitsRes?.sl?.orderId || null,
    opened_at: openedAt,
    status: 'open',
    mode: 'live',
    early_exit_enabled: Boolean(effectiveConfig.early_exit_enabled),
    early_exit_drawdown_pct: Number(effectiveConfig.early_exit_drawdown_pct || 0),
    created_at: FieldValue.serverTimestamp(),
    updated_at: FieldValue.serverTimestamp()
  });

  return {
    executed: true,
    dry_run: false,
    symbol: intent.symbol,
    side: intent.side,
    quantity: intent.quantity,
    order_id: orderRes?.orderId || null,
    open_position_id: openPositionRef.id,
    exits: exitsRes?.placed
      ? {
          tp_order_id: exitsRes?.tp?.orderId || null,
          sl_order_id: exitsRes?.sl?.orderId || null,
          tp_stop_price: exitsRes?.tp_stop_price || null,
          sl_stop_price: exitsRes?.sl_stop_price || null
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
