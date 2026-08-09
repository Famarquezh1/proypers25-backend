'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');
const { floorToStep, buildCurrentCostBasis } = require('./legacySpotRecoveryLiquidator');
const { evaluateXecHistoricalHolding, normalizeXecPolicy } = require('./xecHistoricalHoldingPolicy');

const VERSION = 'xec_historical_holding_manager_v1';
const CONFIG_DOC = 'real_spot_config/xec_holding_manager';
const STATE_DOC = 'real_spot_holding_states/XEC';
const RUN_COLLECTION = 'xec_holding_manager_runs';
const SYMBOL = 'XECUSDT';
const ASSET = 'XEC';

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  xec_managed_exit_enabled: true,
  new_xec_entries_allowed: false,
  sell_to_usdt: true,
  strategy: 'RECOVERY_RUNNER_PROGRESSIVE_EXIT',
  xec_upside_arm_recovery_pct: 12,
  xec_first_take_min_recovery_pct: 15,
  xec_second_take_min_recovery_pct: 30,
  xec_final_take_min_recovery_pct: 50,
  xec_minimum_positive_cycles: 2,
  xec_minimum_1h_change_pct: 0.5,
  xec_minimum_24h_change_pct: 0,
  xec_first_trailing_pullback_pct: 5,
  xec_second_trailing_pullback_pct: 6,
  xec_final_trailing_pullback_pct: 8,
  xec_first_sell_fraction: 0.25,
  xec_second_sell_fraction: 0.5,
  xec_downside_trim_pct_from_baseline: -15,
  xec_downside_24h_confirmation_pct: -3,
  xec_downside_trim_fraction: 0.25,
  xec_near_cost_basis_drawdown_pct: -5
});

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeConfig(config = {}) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: config.enabled !== false,
    xec_managed_exit_enabled: config.xec_managed_exit_enabled !== false,
    new_xec_entries_allowed: false,
    sell_to_usdt: true,
    policy: normalizeXecPolicy({ ...DEFAULT_CONFIG, ...config }),
    version: VERSION
  };
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
  const query = signedQuery({ ...params, recvWindow: 10000, timestamp: Date.now() }, apiSecret);
  const response = await axios({
    method,
    url: `https://api.binance.com${path}?${query}`,
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 15000,
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
  return (await axios.get(`https://api.binance.com${path}`, { params, timeout: 15000 })).data;
}

function calculateReturnPct(current, reference) {
  const base = n(reference);
  return base > 0 ? ((n(current) / base) - 1) * 100 : null;
}

function buildClientOrderId(state = {}, decision = {}) {
  const key = [
    state.baseline_at || state.created_at || 'baseline',
    decision.reason || 'sale',
    decision.next_stage ?? state.xec_exit_stage ?? 0,
    decision.mark_downside_trim_done === true ? 'trimmed' : 'notrim'
  ].join('|');
  return `px25xec_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}

async function findExistingSellOrder(clientOrderId, dependencies = {}) {
  const requestPrivate = dependencies.privateRequest || privateRequest;
  try {
    const order = await requestPrivate('GET', '/api/v3/order', { symbol: SYMBOL, origClientOrderId: clientOrderId });
    return String(order.side || '').toUpperCase() === 'SELL' ? order : null;
  } catch (error) {
    if (Number(error.code) === -2013) return null;
    throw error;
  }
}

async function placeMarketSell(quantity, clientOrderId, dependencies = {}) {
  const requestPrivate = dependencies.privateRequest || privateRequest;
  const existing = await findExistingSellOrder(clientOrderId, { privateRequest: requestPrivate });
  if (existing) return { order: existing, recovered_existing_order: true };
  try {
    const order = await requestPrivate('POST', '/api/v3/order', {
      symbol: SYMBOL,
      side: 'SELL',
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'FULL'
    });
    return { order, recovered_existing_order: false };
  } catch (error) {
    const recovered = await findExistingSellOrder(clientOrderId, { privateRequest: requestPrivate });
    if (recovered) return { order: recovered, recovered_existing_order: true };
    throw error;
  }
}

async function loadSnapshot(dependencies = {}) {
  const requestPrivate = dependencies.privateRequest || privateRequest;
  const requestPublic = dependencies.publicGet || publicGet;
  const [account, ticker, klines, trades, exchangeInfo] = await Promise.all([
    requestPrivate('GET', '/api/v3/account'),
    requestPublic('/api/v3/ticker/24hr', { symbol: SYMBOL }),
    requestPublic('/api/v3/klines', { symbol: SYMBOL, interval: '15m', limit: 6 }),
    requestPrivate('GET', '/api/v3/myTrades', { symbol: SYMBOL, limit: 1000 }),
    requestPublic('/api/v3/exchangeInfo', { symbol: SYMBOL })
  ]);
  const balance = (account.balances || []).find((item) => String(item.asset || '').toUpperCase() === ASSET) || {};
  const currentPrice = n(ticker.lastPrice);
  const firstClose = n(klines?.[0]?.[4], currentPrice);
  const costBasis = buildCurrentCostBasis(Array.isArray(trades) ? trades : []);
  return {
    current_price: currentPrice,
    change_24h_pct: n(ticker.priceChangePercent),
    one_hour_change_pct: calculateReturnPct(currentPrice, firstClose) || 0,
    free_quantity: Math.max(0, n(balance.free)),
    locked_quantity: Math.max(0, n(balance.locked)),
    total_quantity: Math.max(0, n(balance.free)) + Math.max(0, n(balance.locked)),
    average_cost_usdt: n(costBasis.average_cost_usdt, 0),
    remaining_cost_usdt: n(costBasis.remaining_cost_usdt, 0),
    exchange_info: exchangeInfo?.symbols?.[0] || null
  };
}

function sellableQuantity(snapshot, decision) {
  const info = snapshot.exchange_info;
  const lot = info?.filters?.find((item) => item.filterType === 'LOT_SIZE') || info?.filters?.find((item) => item.filterType === 'MARKET_LOT_SIZE');
  if (!lot) return { ok: false, reason: 'LOT_SIZE_FILTER_NOT_FOUND' };
  const fraction = decision.final_exit === true ? 1 : Math.max(0, Math.min(1, n(decision.sell_fraction)));
  const quantity = floorToStep(snapshot.free_quantity * fraction, lot.stepSize);
  const minQty = n(lot.minQty);
  const notional = info.filters?.find((item) => item.filterType === 'NOTIONAL') || info.filters?.find((item) => item.filterType === 'MIN_NOTIONAL');
  const minNotional = n(notional?.minNotional);
  const estimatedNotional = quantity * snapshot.current_price;
  if (!(quantity >= minQty)) return { ok: false, reason: 'XEC_QUANTITY_BELOW_MINIMUM', quantity, estimated_notional_usdt: estimatedNotional };
  if (minNotional > 0 && estimatedNotional < minNotional) return { ok: false, reason: 'XEC_NOTIONAL_BELOW_MINIMUM', quantity, estimated_notional_usdt: estimatedNotional };
  return { ok: true, quantity, fraction, estimated_notional_usdt: estimatedNotional };
}

async function claimSale(db, stateRef, state, decision, sizing, clientOrderId) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const latest = snap.exists ? snap.data() : state;
    if (latest.status === 'CONVERTED' || latest.status === 'SELL_PENDING') return false;
    tx.set(stateRef, {
      ...latest,
      status: 'SELL_PENDING',
      pending_client_order_id: clientOrderId,
      pending_quantity: sizing.quantity,
      pending_fraction: sizing.fraction,
      pending_decision: decision,
      pending_claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { merge: true });
    return true;
  });
}

async function finalizeSale(db, stateRef, state, decision, execution, quantity) {
  const order = execution.order || {};
  const executedQty = n(order.executedQty, quantity);
  const quoteReceived = n(order.cummulativeQuoteQty);
  if (!(executedQty > 0) || !(quoteReceived > 0)) throw new Error(`XEC_SELL_NOT_FILLED:${order.status || 'UNKNOWN'}`);
  const finalExit = decision.final_exit === true;
  const now = new Date().toISOString();
  const nextStatus = finalExit ? 'CONVERTED' : (decision.armed ? 'ARMED' : 'WATCHING');
  const result = {
    asset: ASSET,
    symbol: SYMBOL,
    action: finalExit ? 'XEC_CONVERTED_TO_USDT' : 'XEC_PARTIAL_CONVERTED_TO_USDT',
    reason: decision.reason,
    status: nextStatus,
    executed_quantity: executedQty,
    quote_received_usdt: quoteReceived,
    average_sell_price: quoteReceived / executedQty,
    sell_order_id: order.orderId || null,
    sell_client_order_id: order.clientOrderId || state.pending_client_order_id || null,
    recovered_existing_order: execution.recovered_existing_order === true,
    xec_exit_stage: decision.next_stage,
    xec_downside_trim_done: decision.mark_downside_trim_done === true,
    sold_at: now,
    decision,
    version: VERSION
  };
  await stateRef.set({
    ...state,
    status: nextStatus,
    xec_exit_stage: decision.next_stage,
    xec_downside_trim_done: decision.mark_downside_trim_done === true,
    xec_runner_armed: decision.armed,
    highest_price_after_arm: decision.highest_price_after_arm,
    positive_cycles: decision.positive_cycles,
    last_sale: result,
    last_price: decision.current_price,
    pending_client_order_id: null,
    pending_quantity: null,
    pending_fraction: null,
    pending_decision: null,
    updated_at: now
  }, { merge: true });
  await db.collection(RUN_COLLECTION).doc(`xec_sale_${order.orderId || Date.now()}`).set(result);
  return result;
}

async function executePendingSale(db, stateRef, state, dependencies = {}) {
  const clientOrderId = state.pending_client_order_id;
  const quantity = n(state.pending_quantity);
  const decision = state.pending_decision;
  if (!clientOrderId || !(quantity > 0) || !decision) return null;
  const execution = await placeMarketSell(quantity, clientOrderId, dependencies);
  return finalizeSale(db, stateRef, state, decision, execution, quantity);
}

async function runXecHistoricalHoldingCycle(db, options = {}, dependencies = {}) {
  if (!db) throw new Error('xec_holding_manager_requires_db');
  const configRef = db.doc(CONFIG_DOC);
  const configSnap = await configRef.get();
  const config = normalizeConfig({ ...(configSnap.exists ? configSnap.data() : {}), ...options });
  await configRef.set({ ...config, last_cycle_at: new Date().toISOString() }, { merge: true });
  if (!config.enabled || !config.xec_managed_exit_enabled) return { ok: true, enabled: false, action: 'DISABLED', version: VERSION };

  const managedXec = await db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').where('symbol', '==', SYMBOL).limit(1).get();
  if (!managedXec.empty) {
    return { ok: true, enabled: true, action: 'SKIP', reason: 'XEC_MANAGED_BY_REAL_ENTRY_ENGINE', version: VERSION };
  }

  const snapshot = await loadSnapshot(dependencies);
  const stateRef = db.doc(STATE_DOC);
  const stateSnap = await stateRef.get();
  const existing = stateSnap.exists ? stateSnap.data() : null;
  const now = new Date().toISOString();

  if (!(snapshot.total_quantity > 0)) {
    const result = { ok: true, enabled: true, action: 'NO_XEC_BALANCE', version: VERSION, created_at: now };
    await stateRef.set({ status: 'NO_BALANCE', account_quantity: 0, updated_at: now, version: VERSION }, { merge: true });
    return result;
  }

  if (existing?.status === 'SELL_PENDING') {
    try {
      const recovered = await executePendingSale(db, stateRef, existing, dependencies);
      if (recovered) return { ok: true, enabled: true, ...recovered };
    } catch (error) {
      await stateRef.set({ sell_error: error.message, sell_failed_at: now, updated_at: now }, { merge: true });
      return { ok: false, enabled: true, action: 'SELL_FAILED', error: error.message, version: VERSION };
    }
  }

  if (!existing || existing.status === 'PROTECTED') {
    const baselineDrawdown = snapshot.average_cost_usdt > 0 ? calculateReturnPct(snapshot.current_price, snapshot.average_cost_usdt) : null;
    const initialized = {
      asset: ASSET,
      symbol: SYMBOL,
      status: 'WATCHING',
      strategy: config.strategy,
      baseline_price: snapshot.current_price,
      baseline_drawdown_pct: baselineDrawdown,
      baseline_at: now,
      last_price: snapshot.current_price,
      positive_cycles: 0,
      xec_exit_stage: 0,
      xec_downside_trim_done: false,
      xec_runner_armed: false,
      highest_price_after_arm: null,
      account_quantity: snapshot.total_quantity,
      free_quantity: snapshot.free_quantity,
      average_cost_usdt: snapshot.average_cost_usdt || null,
      remaining_cost_usdt: snapshot.remaining_cost_usdt || null,
      created_at: now,
      updated_at: now,
      version: VERSION
    };
    await stateRef.set(initialized, { merge: false });
    const result = { ok: true, enabled: true, action: 'INITIALIZED_NO_SALE', state: initialized, version: VERSION };
    await db.collection(RUN_COLLECTION).doc(`xec_run_${Date.now()}`).set({ ...result, created_at: now });
    return result;
  }

  if (existing.status === 'CONVERTED') return { ok: true, enabled: true, action: 'ALREADY_CONVERTED', last_sale: existing.last_sale || null, version: VERSION };

  const decision = evaluateXecHistoricalHolding({
    state: existing,
    currentPrice: snapshot.current_price,
    averageCost: snapshot.average_cost_usdt,
    oneHourChangePct: snapshot.one_hour_change_pct,
    change24hPct: snapshot.change_24h_pct,
    config
  });
  const nextState = {
    ...existing,
    status: decision.armed ? 'ARMED' : 'WATCHING',
    strategy: config.strategy,
    last_price: snapshot.current_price,
    positive_cycles: decision.positive_cycles,
    xec_runner_armed: decision.armed,
    xec_runner_armed_at: decision.arm_now ? now : (existing.xec_runner_armed_at || null),
    highest_price_after_arm: decision.highest_price_after_arm,
    current_drawdown_pct: decision.current_drawdown_pct,
    recovery_pct: decision.recovery_pct,
    improvement_pct: decision.improvement_pct,
    high_recovery_pct: decision.high_recovery_pct,
    pullback_from_recovery_high_pct: decision.pullback_from_recovery_high_pct,
    one_hour_change_pct: decision.one_hour_change_pct,
    change_24h_pct: decision.change_24h_pct,
    account_quantity: snapshot.total_quantity,
    free_quantity: snapshot.free_quantity,
    average_cost_usdt: snapshot.average_cost_usdt || existing.average_cost_usdt || null,
    remaining_cost_usdt: snapshot.remaining_cost_usdt || null,
    xec_exit_stage: decision.stage,
    xec_downside_trim_done: existing.xec_downside_trim_done === true,
    updated_at: now,
    version: VERSION
  };
  await stateRef.set(nextState, { merge: true });

  if (!decision.sell) {
    const result = { ok: true, enabled: true, action: decision.armed ? 'ARMED' : 'WATCHING', decision, version: VERSION, created_at: now };
    await db.collection(RUN_COLLECTION).doc(`xec_run_${Date.now()}`).set(result);
    return result;
  }

  const info = snapshot.exchange_info;
  if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) {
    return { ok: true, enabled: true, action: 'SELL_BLOCKED', reason: 'XEC_NOT_AVAILABLE_FOR_SPOT_SELL', decision, version: VERSION };
  }
  const sizing = sellableQuantity(snapshot, decision);
  if (!sizing.ok) return { ok: true, enabled: true, action: 'SELL_BLOCKED', reason: sizing.reason, sizing, decision, version: VERSION };

  const clientOrderId = buildClientOrderId(existing, decision);
  const claimed = await claimSale(db, stateRef, nextState, decision, sizing, clientOrderId);
  if (!claimed) return { ok: true, enabled: true, action: 'SKIP_ALREADY_CLAIMED', version: VERSION };

  try {
    const execution = await placeMarketSell(sizing.quantity, clientOrderId, dependencies);
    const latestState = { ...nextState, pending_client_order_id: clientOrderId, pending_quantity: sizing.quantity, pending_fraction: sizing.fraction, pending_decision: decision };
    const sale = await finalizeSale(db, stateRef, latestState, decision, execution, sizing.quantity);
    return { ok: true, enabled: true, ...sale };
  } catch (error) {
    await stateRef.set({ sell_error: error.message, sell_failed_at: new Date().toISOString(), updated_at: new Date().toISOString() }, { merge: true });
    return { ok: false, enabled: true, action: 'SELL_FAILED', error: error.message, decision, version: VERSION };
  }
}

module.exports = {
  VERSION,
  DEFAULT_CONFIG,
  normalizeConfig,
  calculateReturnPct,
  buildClientOrderId,
  sellableQuantity,
  runXecHistoricalHoldingCycle
};
