'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const POSITIONS = 'real_spot_positions';
const RESULTS = 'real_spot_execution_results';
const BALANCE_DOC = 'real_spot_config/balance';
const SAFETY_VERSION = 'controlled_real_spot_exit_v1';

function parseDate(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date : null;
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
  if (reasons.length) {
    const error = new Error(`REAL_SPOT_EXIT_BLOCKED: ${reasons.join(',')}`);
    error.code = 'EXIT_CONFIG_BLOCKED';
    throw error;
  }
}

function signedQuery(params, secret) {
  const query = Object.entries(params)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function privateRequest(method, path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const signed = signedQuery({ ...params, recvWindow: 5000, timestamp: Date.now() }, apiSecret);
  const response = await axios({
    method,
    url: `https://api.binance.com${path}?${signed}`,
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 10000,
    validateStatus: () => true
  });
  if (response.status < 200 || response.status >= 300) {
    const error = new Error(response.data?.msg || `Binance HTTP ${response.status}`);
    error.code = response.data?.code || 'BINANCE_API_ERROR';
    error.status = response.status;
    throw error;
  }
  return response.data;
}

async function publicGet(path, params = {}) {
  const response = await axios.get(`https://api.binance.com${path}`, {
    params,
    timeout: 10000
  });
  return response.data;
}

function decimalPlaces(step) {
  const text = String(step);
  if (!text.includes('.')) return 0;
  return text.replace(/0+$/, '').split('.')[1]?.length || 0;
}

function floorToStep(quantity, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) return 0;
  const precision = decimalPlaces(stepSize);
  return Number((Math.floor((Number(quantity) + Number.EPSILON) / step) * step).toFixed(precision));
}

async function getSellableQuantity(symbol, requestedQuantity) {
  const [account, exchangeInfo] = await Promise.all([
    privateRequest('GET', '/api/v3/account'),
    publicGet('/api/v3/exchangeInfo', { symbol })
  ]);
  const symbolInfo = exchangeInfo.symbols?.[0];
  if (!symbolInfo || symbolInfo.status !== 'TRADING' || symbolInfo.isSpotTradingAllowed !== true) {
    throw new Error('SYMBOL_NOT_AVAILABLE_FOR_SPOT_SELL');
  }

  const baseAsset = symbolInfo.baseAsset;
  const balance = account.balances?.find((item) => item.asset === baseAsset);
  const free = Number(balance?.free || 0);
  const filter = symbolInfo.filters?.find((item) => item.filterType === 'MARKET_LOT_SIZE') ||
    symbolInfo.filters?.find((item) => item.filterType === 'LOT_SIZE');
  if (!filter) throw new Error('LOT_SIZE_FILTER_NOT_FOUND');

  const raw = Math.min(Number(requestedQuantity || 0), free);
  const quantity = floorToStep(raw, filter.stepSize);
  if (quantity < Number(filter.minQty || 0)) {
    const error = new Error('SELL_QUANTITY_BELOW_MINIMUM');
    error.details = { requestedQuantity, free, quantity, minQty: filter.minQty };
    throw error;
  }
  if (Number(filter.maxQty || 0) > 0 && quantity > Number(filter.maxQty)) {
    throw new Error('SELL_QUANTITY_ABOVE_MAXIMUM');
  }
  return { quantity, free, baseAsset };
}

function determineExit(position, currentPrice, now = new Date()) {
  const tp = Number(position.tp1_price || 0);
  const sl = Number(position.sl_price || 0);
  const timeoutAt = parseDate(position.timeout_at);
  if (Number.isFinite(currentPrice) && currentPrice > 0 && tp > 0 && currentPrice >= tp) {
    return 'TAKE_PROFIT';
  }
  if (Number.isFinite(currentPrice) && currentPrice > 0 && sl > 0 && currentPrice <= sl) {
    return 'STOP_LOSS';
  }
  if (timeoutAt && timeoutAt.getTime() <= now.getTime()) {
    return 'TIMEOUT';
  }
  return null;
}

async function claimPosition(db, docRef, reason, currentPrice) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(docRef);
    if (!snap.exists) return null;
    const position = snap.data();
    if (position.status !== 'REAL_OPEN' || position.exit_status === 'EXIT_PENDING') return null;
    const claimId = `exit_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    tx.update(docRef, {
      exit_status: 'EXIT_PENDING',
      exit_claim_id: claimId,
      exit_reason_pending: reason,
      exit_price_observed: currentPrice,
      exit_claimed_at: new Date().toISOString()
    });
    return { id: snap.id, ...position, claimId };
  });
}

async function releaseClaim(docRef, claimId, error) {
  const snap = await docRef.get();
  if (!snap.exists || snap.data().exit_claim_id !== claimId) return;
  await docRef.update({
    exit_status: 'EXIT_FAILED',
    exit_error: String(error?.message || error).slice(0, 300),
    exit_failed_at: new Date().toISOString()
  });
}

async function executeMarketSell(symbol, quantity) {
  return privateRequest('POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity
  });
}

async function finalizeExit(db, docRef, position, order, reason, observedPrice) {
  const executedQty = Number(order.executedQty || 0);
  const quoteReceived = Number(order.cummulativeQuoteQty || 0);
  if (!(executedQty > 0) || !(quoteReceived >= 0)) throw new Error('SELL_ORDER_WITHOUT_EXECUTION');

  const originalQty = Number(position.quantity || 0);
  const originalCapital = Number(position.capital_usdt || 0);
  const soldFraction = originalQty > 0 ? Math.min(1, executedQty / originalQty) : 1;
  const allocatedCapital = originalCapital * soldFraction;
  const grossPnl = quoteReceived - allocatedCapital;
  const feeUsdt = (order.fills || []).reduce((sum, fill) => {
    return String(fill.commissionAsset || '').toUpperCase() === 'USDT'
      ? sum + Number(fill.commission || 0)
      : sum;
  }, 0);
  const netPnl = grossPnl - feeUsdt;
  const netPnlPct = allocatedCapital > 0 ? (netPnl / allocatedCapital) * 100 : 0;
  const exitPrice = executedQty > 0 ? quoteReceived / executedQty : observedPrice;
  const closedAt = new Date().toISOString();
  const fullyClosed = soldFraction >= 0.999;
  const resultId = `real_spot_result_${position.id}_${order.orderId}`;

  await db.runTransaction(async (tx) => {
    const latest = await tx.get(docRef);
    if (!latest.exists || latest.data().exit_claim_id !== position.claimId) {
      throw new Error('EXIT_CLAIM_LOST');
    }

    if (fullyClosed) {
      tx.update(docRef, {
        status: 'REAL_CLOSED',
        exit_status: 'EXIT_FILLED',
        closing_reason: reason,
        closed_at: closedAt,
        exit_price: exitPrice,
        pnl_usdt: netPnl,
        sell_order_id: order.orderId,
        sold_quantity: executedQty,
        quote_received_usdt: quoteReceived
      });
    } else {
      tx.update(docRef, {
        quantity: Math.max(0, originalQty - executedQty),
        capital_usdt: Math.max(0, originalCapital - allocatedCapital),
        exit_status: 'PARTIAL_EXIT_FILLED',
        last_partial_exit_at: closedAt,
        last_sell_order_id: order.orderId,
        last_sold_quantity: executedQty
      });
    }

    const resultRef = db.collection(RESULTS).doc(resultId);
    tx.set(resultRef, {
      id: resultId,
      position_id: position.id,
      symbol: position.symbol,
      entry_price: Number(position.entry_price || 0),
      exit_price: exitPrice,
      quantity: executedQty,
      allocated_capital_usdt: allocatedCapital,
      quote_received_usdt: quoteReceived,
      gross_pnl_usdt: grossPnl,
      actual_fee_usdt: feeUsdt,
      net_pnl_usdt: netPnl,
      net_pnl_pct: netPnlPct,
      closing_reason: reason,
      opened_at: position.opened_at || null,
      closed_at: closedAt,
      order_id: order.orderId,
      order_status: order.status,
      fully_closed: fullyClosed,
      real_mode: true,
      safety_version: SAFETY_VERSION
    });

    const balanceRef = db.doc(BALANCE_DOC);
    const balanceSnap = await tx.get(balanceRef);
    const balance = balanceSnap.exists ? balanceSnap.data() : {};
    tx.set(balanceRef, {
      available_usdt: Number(balance.available_usdt || 0) + quoteReceived,
      in_positions_usdt: Math.max(0, Number(balance.in_positions_usdt || 0) - allocatedCapital),
      realized_pnl_usdt: Number(balance.realized_pnl_usdt || 0) + netPnl,
      updated_at: closedAt
    }, { merge: true });
  });

  return { fullyClosed, executedQty, quoteReceived, netPnl, netPnlPct, exitPrice, resultId };
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
    const position = { id: doc.id, ...doc.data() };
    const symbol = String(position.symbol || '').toUpperCase();
    try {
      const ticker = options.currentPrices?.[symbol]
        ? { price: options.currentPrices[symbol] }
        : await publicGet('/api/v3/ticker/price', { symbol });
      const currentPrice = Number(ticker.price || 0);
      const reason = determineExit(position, currentPrice);
      if (!reason) {
        outcomes.push({ symbol, action: 'HOLD', current_price: currentPrice });
        continue;
      }

      const claimed = await claimPosition(db, doc.ref, reason, currentPrice);
      if (!claimed) {
        outcomes.push({ symbol, action: 'SKIP_ALREADY_CLAIMED' });
        continue;
      }

      try {
        const sellable = await getSellableQuantity(symbol, claimed.quantity);
        const order = await executeMarketSell(symbol, sellable.quantity);
        const finalized = await finalizeExit(db, doc.ref, claimed, order, reason, currentPrice);
        outcomes.push({ symbol, action: 'SELL', reason, order_id: order.orderId, ...finalized });
      } catch (error) {
        await releaseClaim(doc.ref, claimed.claimId, error);
        outcomes.push({ symbol, action: 'SELL_FAILED', reason, error: error.message });
      }
    } catch (error) {
      outcomes.push({ symbol, action: 'EVALUATION_FAILED', error: error.message });
    }
  }

  return {
    ok: true,
    blocked: false,
    evaluated: snapshot.size,
    sold: outcomes.filter((item) => item.action === 'SELL').length,
    held: outcomes.filter((item) => item.action === 'HOLD').length,
    failures: outcomes.filter((item) => item.action.endsWith('FAILED')),
    outcomes,
    duration_ms: Date.now() - startedAt
  };
}

module.exports = {
  SAFETY_VERSION,
  assertExitConfig,
  determineExit,
  floorToStep,
  evaluateAndExecuteRealSpotExits
};
