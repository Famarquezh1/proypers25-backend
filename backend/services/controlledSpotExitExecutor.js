'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');
const { recordConfirmedSpotClose } = require('./spotPositionLifecycle');

const POSITIONS = 'real_spot_positions';
const RESULTS = 'real_spot_execution_results';
const BALANCE_DOC = 'real_spot_config/balance';
const SAFETY_VERSION = 'controlled_real_spot_exit_v3_adaptive';

function parseDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
}

function clamp(value, min, max) {
  const numeric = Number(value);
  return Math.min(max, Math.max(min, Number.isFinite(numeric) ? numeric : min));
}

function assertExitConfig(config) {
  const reasons = [];
  if (config?.enabled !== true) reasons.push('REAL_SPOT_NOT_ENABLED');
  if (config?.kill_switch === true) reasons.push('KILL_SWITCH_ACTIVE');
  if (config?.real_sells_enabled !== true) reasons.push('REAL_SELLS_NOT_ENABLED');
  if (config?.auto_order_execution !== true) reasons.push('AUTO_ORDER_EXECUTION_DISABLED');
  if (config?.spot_only !== true) reasons.push('NOT_SPOT_ONLY');
  if (config?.futures_allowed === true) reasons.push('FUTURES_NOT_ALLOWED');
  if (config?.margin_allowed === true) reasons.push('MARGIN_NOT_ALLOWED');
  if (config?.leverage_allowed === true) reasons.push('LEVERAGE_NOT_ALLOWED');
  if (config?.withdrawals_allowed !== false) reasons.push('WITHDRAWALS_MUST_BE_DISABLED');
  if (reasons.length) throw new Error(`REAL_SPOT_EXIT_BLOCKED: ${reasons.join(',')}`);
}

function signedQuery(params, secret) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function privateRequest(method, path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = signedQuery({ ...params, recvWindow: 5000, timestamp: Date.now() }, apiSecret);
  const response = await axios({
    method,
    url: `https://api.binance.com${path}?${query}`,
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.data?.msg || `Binance HTTP ${response.status}`);
    error.code = response.data?.code || 'BINANCE_API_ERROR';
    throw error;
  }
  return response.data;
}

async function publicGet(path, params = {}) {
  return (await axios.get(`https://api.binance.com${path}`, { params, timeout: 10000 })).data;
}

function decimalPlaces(step) {
  const text = String(step);
  return text.includes('.') ? (text.replace(/0+$/, '').split('.')[1]?.length || 0) : 0;
}

function floorToStep(quantity, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Number((Math.floor((Number(quantity) + Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}

function buildExitClientOrderId(position) {
  const seed = [
    position.id,
    position.symbol,
    Number(position.quantity || 0).toPrecision(12),
    Number(position.capital_usdt || 0).toPrecision(12)
  ].join('|');
  return `px25x_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

async function getSellableQuantity(symbol, requestedQuantity) {
  const [account, exchangeInfo] = await Promise.all([
    privateRequest('GET', '/api/v3/account'),
    publicGet('/api/v3/exchangeInfo', { symbol })
  ]);
  const info = exchangeInfo.symbols?.[0];
  if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) {
    throw new Error('SYMBOL_NOT_AVAILABLE_FOR_SPOT_SELL');
  }
  const free = Number(account.balances?.find((item) => item.asset === info.baseAsset)?.free || 0);
  const filter = info.filters?.find((item) => item.filterType === 'MARKET_LOT_SIZE') ||
    info.filters?.find((item) => item.filterType === 'LOT_SIZE');
  if (!filter) throw new Error('LOT_SIZE_FILTER_NOT_FOUND');
  const quantity = floorToStep(Math.min(Number(requestedQuantity || 0), free), filter.stepSize);
  if (quantity < Number(filter.minQty || 0)) throw new Error('SELL_QUANTITY_BELOW_MINIMUM');
  if (Number(filter.maxQty || 0) > 0 && quantity > Number(filter.maxQty)) throw new Error('SELL_QUANTITY_ABOVE_MAXIMUM');
  return quantity;
}

function trueRange(previousClose, candle) {
  return Math.max(
    Number(candle.high) - Number(candle.low),
    Math.abs(Number(candle.high) - Number(previousClose)),
    Math.abs(Number(candle.low) - Number(previousClose))
  );
}

function calculateAtrPct(rows, period = 14) {
  if (!Array.isArray(rows) || rows.length <= period) return null;
  const ranges = [];
  for (let index = rows.length - period; index < rows.length; index += 1) {
    ranges.push(trueRange(rows[index - 1].close, rows[index]));
  }
  const atr = ranges.reduce((sum, value) => sum + value, 0) / ranges.length;
  const close = Number(rows[rows.length - 1].close);
  return close > 0 ? atr / close : null;
}

async function fetchRecentKlines(symbol) {
  const rows = await publicGet('/api/v3/klines', { symbol, interval: '5m', limit: 50 });
  return (rows || []).map((row) => ({
    open: Number(row[1]),
    high: Number(row[2]),
    low: Number(row[3]),
    close: Number(row[4])
  })).filter((row) => row.close > 0 && row.high > 0 && row.low > 0);
}

function resolveAdaptiveProtection(position, currentPrice, atrPct, now = new Date()) {
  const entry = Number(position.entry_price || 0);
  if (!(entry > 0) || !(currentPrice > 0)) return null;

  const normalizedAtr = clamp(atrPct || Number(position.entry_atr_pct || 0.01), 0.003, 0.05);
  const gainPct = (currentPrice / entry) - 1;
  const highest = Math.max(Number(position.highest_price || entry), currentPrice);
  const persistedLow = Number(position.lowest_price || entry);
  const lowest = persistedLow > 0 ? Math.min(persistedLow, currentPrice) : currentPrice;
  const originalSl = Number(position.sl_price || entry * (1 - clamp(normalizedAtr, 0.005, 0.03)));
  const originalTp = Number(position.tp1_price || entry * (1 + clamp(normalizedAtr * 2, 0.008, 0.06)));

  const breakEvenTrigger = clamp(normalizedAtr * 1.2, 0.006, 0.025);
  const trailingTrigger = clamp(normalizedAtr * 1.8, 0.01, 0.04);
  const trailingDistance = clamp(normalizedAtr * 1.1, 0.006, 0.03);

  let effectiveSl = originalSl;
  let mode = 'BASE';
  if (gainPct >= breakEvenTrigger) {
    effectiveSl = Math.max(effectiveSl, entry * 1.0015);
    mode = 'BREAK_EVEN';
  }
  if (gainPct >= trailingTrigger) {
    effectiveSl = Math.max(effectiveSl, highest * (1 - trailingDistance));
    mode = 'TRAILING';
  }

  const openedAt = parseDate(position.opened_at) || now;
  const ageMinutes = Math.max(0, (now.getTime() - openedAt.getTime()) / 60000);
  const timeoutMinutes = clamp(Math.round(180 + (normalizedAtr * 10000)), 180, 720);
  const adaptiveTimeoutAt = new Date(openedAt.getTime() + timeoutMinutes * 60000);
  const existingTimeout = parseDate(position.timeout_at);
  const effectiveTimeoutAt = existingTimeout && existingTimeout < adaptiveTimeoutAt ? existingTimeout : adaptiveTimeoutAt;

  return {
    highest_price: highest,
    lowest_price: lowest,
    atr_pct: normalizedAtr,
    effective_sl_price: effectiveSl,
    effective_tp_price: originalTp,
    effective_timeout_at: effectiveTimeoutAt.toISOString(),
    protection_mode: mode,
    gain_pct: gainPct,
    age_minutes: ageMinutes,
    break_even_trigger_pct: breakEvenTrigger,
    trailing_trigger_pct: trailingTrigger,
    trailing_distance_pct: trailingDistance
  };
}

function determineExit(position, currentPrice, now = new Date()) {
  const tp = Number(position.effective_tp_price || position.tp1_price || 0);
  const sl = Number(position.effective_sl_price || position.sl_price || 0);
  const timeoutAt = parseDate(position.effective_timeout_at || position.timeout_at);
  if (currentPrice > 0 && sl > 0 && currentPrice <= sl) {
    if (position.protection_mode === 'TRAILING') return 'TRAILING_STOP';
    if (position.protection_mode === 'BREAK_EVEN') return 'BREAK_EVEN_STOP';
    return 'STOP_LOSS';
  }
  if (currentPrice > 0 && tp > 0 && currentPrice >= tp) return 'TAKE_PROFIT';
  if (timeoutAt && timeoutAt.getTime() <= now.getTime()) return 'TIMEOUT';
  // These are written by the strategy evaluator when it has fresh evidence.
  // They intentionally return a reason only; the sell always follows the
  // same claimed, idempotent Binance-order path below.
  if (position.momentum_lost === true || position.exit_signal_reason === 'MOMENTUM_LOSS') return 'MOMENTUM_LOSS';
  const currentScore = Number(position.current_score);
  const exitScoreFloor = Number(position.exit_score_floor);
  if (Number.isFinite(currentScore) && Number.isFinite(exitScoreFloor) && currentScore < exitScoreFloor) {
    return 'SCORE_DETERIORATION';
  }
  return null;
}

async function persistAdaptiveProtection(ref, adaptive) {
  if (!adaptive) return;
  await ref.set({
    highest_price: adaptive.highest_price,
    lowest_price: adaptive.lowest_price,
    atr_pct_runtime: adaptive.atr_pct,
    effective_sl_price: adaptive.effective_sl_price,
    effective_tp_price: adaptive.effective_tp_price,
    effective_timeout_at: adaptive.effective_timeout_at,
    protection_mode: adaptive.protection_mode,
    adaptive_exit_updated_at: new Date().toISOString(),
    exit_safety_version: SAFETY_VERSION
  }, { merge: true });
}

async function claimPosition(db, ref, reason, price) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    const data = snap.data();
    if (data.status !== 'REAL_OPEN' || data.exit_status === 'EXIT_PENDING') return null;
    const claimId = `exit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    const clientOrderId = data.exit_client_order_id || buildExitClientOrderId({ id: snap.id, ...data });
    tx.update(ref, {
      exit_status: 'EXIT_PENDING',
      exit_claim_id: claimId,
      exit_client_order_id: clientOrderId,
      exit_reason_pending: reason,
      exit_price_observed: price,
      exit_claimed_at: new Date().toISOString()
    });
    return { id: snap.id, ...data, claimId, clientOrderId };
  });
}

async function releaseClaim(ref, claimId, error) {
  const snap = await ref.get();
  if (!snap.exists || snap.data().exit_claim_id !== claimId) return;
  await ref.update({
    exit_status: 'EXIT_FAILED',
    exit_error: String(error?.message || error).slice(0, 300),
    exit_failed_at: new Date().toISOString()
  });
}

async function findExistingSellOrder(symbol, clientOrderId) {
  try {
    const order = await privateRequest('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
    if (String(order.side || '').toUpperCase() !== 'SELL') throw new Error('EXISTING_ORDER_IS_NOT_SELL');
    return order;
  } catch (error) {
    if (Number(error.code) === -2013) return null;
    throw error;
  }
}

async function executeMarketSell(symbol, quantity, clientOrderId) {
  const existing = await findExistingSellOrder(symbol, clientOrderId);
  if (existing) return existing;
  try {
    return await privateRequest('POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'FULL'
    });
  } catch (error) {
    const recovered = await findExistingSellOrder(symbol, clientOrderId);
    if (recovered) return recovered;
    throw error;
  }
}

async function finalizeExit(db, ref, position, order, reason, observedPrice) {
  const executedQty = Number(order.executedQty || 0);
  const quoteReceived = Number(order.cummulativeQuoteQty || 0);
  if (!(executedQty > 0)) throw new Error(`SELL_ORDER_NOT_FILLED:${order.status || 'UNKNOWN'}`);

  const feeUsdt = (order.fills || []).reduce((sum, fill) =>
    String(fill.commissionAsset || '').toUpperCase() === 'USDT' ? sum + Number(fill.commission || 0) : sum, 0);
  const exitPrice = quoteReceived / executedQty || observedPrice;
  const recorded = await recordConfirmedSpotClose(db, {
    positionRef: ref,
    position,
    eventId: `binance_order_${order.orderId}`,
    reason,
    source: 'BINANCE_ORDER',
    executedQuantity: executedQty,
    quoteReceivedUsdt: quoteReceived,
    exitPrice,
    feeUsdt,
    order,
    expectedClaimId: position.claimId,
    metadata: {
      sell_order_id: order.orderId || null,
      sell_client_order_id: position.clientOrderId || null,
      exit_safety_version: SAFETY_VERSION
    }
  });
  const allocatedCapital = recorded.allocatedCapital || 0;
  const netPnl = recorded.netPnl || 0;
  return {
    fullyClosed: recorded.fullyClosed === true,
    executedQty,
    quoteReceived,
    netPnl,
    netPnlPct: allocatedCapital > 0 ? (netPnl / allocatedCapital) * 100 : null,
    exitPrice,
    resultId: recorded.resultId,
    idempotent: recorded.idempotent === true
  };
}

async function evaluateAndExecuteRealSpotExits(db, config, options = {}) {
  const startedAt = Date.now();
  try {
    assertExitConfig(config);
  } catch (error) {
    return { ok: true, blocked: true, blocked_reason: error.message, evaluated: 0, sold: 0, failures: [] };
  }

  const snapshot = await db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get();
  const outcomes = [];
  for (const doc of snapshot.docs) {
    let position = { id: doc.id, ...doc.data() };
    const symbol = String(position.symbol || '').toUpperCase();
    try {
      const ticker = options.currentPrices?.[symbol]
        ? { price: options.currentPrices[symbol] }
        : await publicGet('/api/v3/ticker/price', { symbol });
      const currentPrice = Number(ticker.price || 0);
      const klines = options.klines?.[symbol] || await fetchRecentKlines(symbol);
      const atrPct = calculateAtrPct(klines);
      const adaptive = resolveAdaptiveProtection(position, currentPrice, atrPct);
      await persistAdaptiveProtection(doc.ref, adaptive);
      position = { ...position, ...(adaptive || {}) };

      const reason = determineExit(position, currentPrice);
      if (!reason) {
        outcomes.push({
          symbol,
          action: 'HOLD',
          current_price: currentPrice,
          protection_mode: adaptive?.protection_mode || 'BASE',
          effective_sl_price: adaptive?.effective_sl_price || position.sl_price || null,
          effective_tp_price: adaptive?.effective_tp_price || position.tp1_price || null,
          effective_timeout_at: adaptive?.effective_timeout_at || position.timeout_at || null
        });
        continue;
      }
      const claimed = await claimPosition(db, doc.ref, reason, currentPrice);
      if (!claimed) {
        outcomes.push({ symbol, action: 'SKIP_ALREADY_CLAIMED' });
        continue;
      }
      try {
        const quantity = await getSellableQuantity(symbol, claimed.quantity);
        const order = await executeMarketSell(symbol, quantity, claimed.clientOrderId);
        outcomes.push({
          symbol,
          action: 'SELL',
          reason,
          order_id: order.orderId,
          client_order_id: claimed.clientOrderId,
          ...(await finalizeExit(db, doc.ref, claimed, order, reason, currentPrice))
        });
      } catch (error) {
        await releaseClaim(doc.ref, claimed.claimId, error);
        outcomes.push({ symbol, action: 'SELL_FAILED', reason, error: error.message });
      }
    } catch (error) {
      outcomes.push({ symbol, action: 'EVALUATION_FAILED', error: error.message });
    }
  }

  const failures = outcomes.filter((item) => item.action.endsWith('FAILED'));
  return {
    ok: failures.length === 0,
    blocked: false,
    exit_engine_healthy: failures.length === 0,
    evaluated: snapshot.size,
    sold: outcomes.filter((item) => item.action === 'SELL').length,
    held: outcomes.filter((item) => item.action === 'HOLD').length,
    failures,
    outcomes,
    duration_ms: Date.now() - startedAt,
    safety_version: SAFETY_VERSION
  };
}

module.exports = {
  SAFETY_VERSION,
  assertExitConfig,
  buildExitClientOrderId,
  calculateAtrPct,
  resolveAdaptiveProtection,
  determineExit,
  floorToStep,
  evaluateAndExecuteRealSpotExits
};
