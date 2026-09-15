'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { evaluateXecHistoricalHolding } = require('../services/xecHistoricalHoldingPolicy');

const VERSION = 'github_xec_historical_protection_v1';
const SYMBOL = 'XECUSDT';
const ASSET = 'XEC';
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];
const STATE_DIR = process.env.PROYPERS_LOCAL_STATE_DIR || path.join(os.homedir(), '.proypers25');
const STATE_FILE = path.join(STATE_DIR, 'xec-historical-state.json');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}
function round(value, decimals = 12) { return Number(n(value).toFixed(decimals)); }
function decimalPlaces(step) {
  const text = String(step || '');
  return text.includes('.') ? (text.replace(/0+$/, '').split('.')[1]?.length || 0) : 0;
}
function floorToStep(quantity, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Number((Math.floor((Number(quantity) + Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}
function calculateReturnPct(current, reference) {
  const base = n(reference);
  return base > 0 ? ((n(current) / base) - 1) * 100 : null;
}

function buildCurrentCostBasis(trades = []) {
  const ordered = [...trades].sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  let quantity = 0;
  let cost = 0;
  for (const trade of ordered) {
    const qty = Math.max(0, n(trade.qty));
    const quote = Math.max(0, n(trade.quoteQty, qty * n(trade.price)));
    const fee = Math.max(0, n(trade.commission));
    const feeAsset = String(trade.commissionAsset || '').toUpperCase();
    if (trade.isBuyer === true) {
      const received = Math.max(0, qty - (feeAsset === ASSET ? fee : 0));
      quantity += received;
      cost += quote + (feeAsset === 'USDT' ? fee : 0);
    } else if (quantity > 0) {
      const average = cost / quantity;
      const removed = Math.min(quantity, qty + (feeAsset === ASSET ? fee : 0));
      quantity -= removed;
      cost = Math.max(0, cost - (average * removed));
    }
  }
  return {
    tracked_quantity: round(quantity),
    remaining_cost_usdt: round(cost, 8),
    average_cost_usdt: quantity > 0 ? round(cost / quantity) : null
  };
}

async function request(base, pathName, options = {}) {
  const response = await fetch(`${base}${pathName}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }
  return body;
}
async function signed(base, method, pathName, params = {}) {
  const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  return request(base, `${pathName}?${query}&signature=${signature}`, { method, headers: { 'X-MBX-APIKEY': API_KEY } });
}
async function chooseBase() {
  const failures = [];
  for (const base of BASES) {
    try {
      await request(base, '/api/v3/ping');
      await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      return base;
    } catch (error) {
      failures.push(`${base}=${error.status || error.message}`);
    }
  }
  throw new Error(`Binance private API unreachable (${failures.join(', ')})`);
}
function balanceRow(account, asset) {
  return (account.balances || []).find((item) => String(item.asset || '').toUpperCase() === asset) || {};
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return null;
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch (error) {
    const backup = `${STATE_FILE}.corrupt-${Date.now()}`;
    try { fs.renameSync(STATE_FILE, backup); } catch (_) {}
    console.warn(`XEC_STATE_CORRUPT reset=true error=${error.message || error}`);
    return null;
  }
}
function saveState(state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const temp = `${STATE_FILE}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  fs.renameSync(temp, STATE_FILE);
}

function buildInitialState(snapshot, now = new Date().toISOString()) {
  const baselineDrawdownPct = snapshot.average_cost_usdt > 0 ? calculateReturnPct(snapshot.current_price, snapshot.average_cost_usdt) : null;
  return {
    asset: ASSET,
    symbol: SYMBOL,
    status: 'WATCHING',
    strategy: 'RECOVERY_RUNNER_PROGRESSIVE_EXIT',
    baseline_price: snapshot.current_price,
    baseline_drawdown_pct: baselineDrawdownPct,
    baseline_at: now,
    last_price: snapshot.current_price,
    positive_cycles: 0,
    xec_exit_stage: 0,
    xec_downside_trim_done: false,
    xec_runner_armed: false,
    xec_runner_armed_at: null,
    highest_price_after_arm: null,
    current_drawdown_pct: baselineDrawdownPct,
    account_quantity: snapshot.total_quantity,
    free_quantity: snapshot.free_quantity,
    average_cost_usdt: snapshot.average_cost_usdt || null,
    remaining_cost_usdt: snapshot.remaining_cost_usdt || null,
    pending_client_order_id: null,
    pending_quantity: null,
    pending_decision: null,
    created_at: now,
    updated_at: now,
    version: VERSION
  };
}
function buildClientOrderId(state = {}, decision = {}) {
  const key = [state.baseline_at || state.created_at || 'baseline', decision.reason || 'sale', decision.next_stage ?? state.xec_exit_stage ?? 0, decision.mark_downside_trim_done === true ? 'trimmed' : 'notrim'].join('|');
  return `px25ghxec_${crypto.createHash('sha256').update(key).digest('hex').slice(0, 20)}`;
}
function sellableQuantity(snapshot, decision) {
  const info = snapshot.exchange_info;
  const marketLot = info?.filters?.find((item) => item.filterType === 'MARKET_LOT_SIZE' && n(item.stepSize) > 0);
  const lot = marketLot || info?.filters?.find((item) => item.filterType === 'LOT_SIZE');
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

async function findExistingSellOrder(base, clientOrderId) {
  try {
    const order = await signed(base, 'GET', '/api/v3/order', { symbol: SYMBOL, origClientOrderId: clientOrderId });
    return String(order.side || '').toUpperCase() === 'SELL' ? order : null;
  } catch (error) {
    if (Number(error.body?.code) === -2013) return null;
    throw error;
  }
}
async function placeOrRecoverMarketSell(base, quantity, clientOrderId) {
  const existing = await findExistingSellOrder(base, clientOrderId);
  if (existing) return existing;
  try {
    return await signed(base, 'POST', '/api/v3/order', { symbol: SYMBOL, side: 'SELL', type: 'MARKET', quantity: String(quantity), newClientOrderId: clientOrderId, newOrderRespType: 'FULL' });
  } catch (error) {
    const recovered = await findExistingSellOrder(base, clientOrderId);
    if (recovered) return recovered;
    throw error;
  }
}

function finalizeStateAfterSale(state, decision, order, now = new Date().toISOString()) {
  const executedQty = n(order.executedQty);
  const quoteReceived = n(order.cummulativeQuoteQty);
  if (!(executedQty > 0) || !(quoteReceived > 0)) throw new Error(`XEC_SELL_NOT_FILLED:${order.status || 'UNKNOWN'}`);
  const finalExit = decision.final_exit === true;
  const sale = {
    reason: decision.reason,
    executed_quantity: executedQty,
    quote_received_usdt: quoteReceived,
    average_sell_price: quoteReceived / executedQty,
    order_id: order.orderId || null,
    client_order_id: order.clientOrderId || state.pending_client_order_id || null,
    sold_at: now
  };
  return {
    ...state,
    status: finalExit ? 'CONVERTED' : (decision.armed ? 'ARMED' : 'WATCHING'),
    xec_exit_stage: decision.next_stage,
    xec_downside_trim_done: decision.mark_downside_trim_done === true,
    xec_runner_armed: decision.armed,
    highest_price_after_arm: decision.highest_price_after_arm,
    positive_cycles: decision.positive_cycles,
    last_price: decision.current_price,
    last_sale: sale,
    pending_client_order_id: null,
    pending_quantity: null,
    pending_decision: null,
    updated_at: now,
    version: VERSION
  };
}

async function loadSnapshot(base) {
  const [account, restrictions, ticker, klines, trades, exchangeInfo] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),
    request(base, `/api/v3/ticker/24hr?symbol=${SYMBOL}`),
    request(base, `/api/v3/klines?symbol=${SYMBOL}&interval=15m&limit=6`),
    signed(base, 'GET', '/api/v3/myTrades', { symbol: SYMBOL, limit: '1000' }),
    request(base, `/api/v3/exchangeInfo?symbol=${SYMBOL}`)
  ]);
  if (account.canTrade !== true) throw new Error('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) throw new Error('API withdrawals must remain disabled');
  const balance = balanceRow(account, ASSET);
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

async function main() {
  if (!API_KEY || !API_SECRET) throw new Error('BINANCE_API_KEY/BINANCE_SECRET_KEY missing');
  const base = await chooseBase();
  const snapshot = await loadSnapshot(base);
  const now = new Date().toISOString();
  let state = loadState();

  if (!(snapshot.total_quantity > 0)) {
    saveState({ ...(state || {}), asset: ASSET, symbol: SYMBOL, status: 'NO_BALANCE', account_quantity: 0, updated_at: now, version: VERSION });
    console.log(`XEC_HISTORICAL_PROTECTION_OK action=NO_XEC_BALANCE price=${snapshot.current_price}`);
    return;
  }
  if (!state || state.status === 'NO_BALANCE' || state.status === 'CONVERTED') {
    state = buildInitialState(snapshot, now);
    saveState(state);
    console.log(`XEC_HISTORICAL_PROTECTION_OK action=INITIALIZED_NO_SALE price=${snapshot.current_price} change24h=${snapshot.change_24h_pct.toFixed(3)} baseline=${state.baseline_price}`);
    return;
  }
  if (state.pending_client_order_id && state.pending_decision && n(state.pending_quantity) > 0) {
    const order = await placeOrRecoverMarketSell(base, n(state.pending_quantity), state.pending_client_order_id);
    if (String(order.status || '').toUpperCase() !== 'FILLED') {
      console.log(`XEC_HISTORICAL_PROTECTION_OK action=SELL_PENDING orderId=${order.orderId || 'unknown'}`);
      return;
    }
    const finalized = finalizeStateAfterSale(state, state.pending_decision, order, now);
    saveState(finalized);
    console.log(`XEC_HISTORICAL_SALE reason=${finalized.last_sale.reason} quote_received_usdt=${finalized.last_sale.quote_received_usdt.toFixed(6)} stage=${finalized.xec_exit_stage}`);
    return;
  }

  const decision = evaluateXecHistoricalHolding({ state, currentPrice: snapshot.current_price, averageCost: snapshot.average_cost_usdt, oneHourChangePct: snapshot.one_hour_change_pct, change24hPct: snapshot.change_24h_pct, config: {} });
  const nextState = {
    ...state,
    status: decision.armed ? 'ARMED' : 'WATCHING',
    last_price: snapshot.current_price,
    positive_cycles: decision.positive_cycles,
    xec_runner_armed: decision.armed,
    xec_runner_armed_at: decision.arm_now ? now : (state.xec_runner_armed_at || null),
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
    average_cost_usdt: snapshot.average_cost_usdt || state.average_cost_usdt || null,
    remaining_cost_usdt: snapshot.remaining_cost_usdt || null,
    xec_exit_stage: decision.stage,
    xec_downside_trim_done: state.xec_downside_trim_done === true,
    updated_at: now,
    version: VERSION
  };
  saveState(nextState);
  if (!decision.sell) {
    console.log(`XEC_HISTORICAL_PROTECTION_OK action=${decision.armed ? 'ARMED' : 'WATCHING'} price=${snapshot.current_price} recovery=${decision.recovery_pct.toFixed(3)} change24h=${decision.change_24h_pct.toFixed(3)} stage=${decision.stage}`);
    return;
  }

  const info = snapshot.exchange_info;
  if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) {
    console.log('XEC_HISTORICAL_PROTECTION_OK action=SELL_BLOCKED reason=XEC_NOT_AVAILABLE_FOR_SPOT_SELL');
    return;
  }
  const sizing = sellableQuantity(snapshot, decision);
  if (!sizing.ok) {
    console.log(`XEC_HISTORICAL_PROTECTION_OK action=SELL_BLOCKED reason=${sizing.reason}`);
    return;
  }
  const clientOrderId = buildClientOrderId(state, decision);
  const pending = { ...nextState, status: 'SELL_PENDING', pending_client_order_id: clientOrderId, pending_quantity: sizing.quantity, pending_decision: decision, pending_claimed_at: now };
  saveState(pending);
  const order = await placeOrRecoverMarketSell(base, sizing.quantity, clientOrderId);
  if (String(order.status || '').toUpperCase() !== 'FILLED') {
    console.log(`XEC_HISTORICAL_PROTECTION_OK action=SELL_PENDING orderId=${order.orderId || 'unknown'}`);
    return;
  }
  const finalized = finalizeStateAfterSale(pending, decision, order, new Date().toISOString());
  saveState(finalized);
  console.log(`XEC_HISTORICAL_SALE reason=${finalized.last_sale.reason} quote_received_usdt=${finalized.last_sale.quote_received_usdt.toFixed(6)} stage=${finalized.xec_exit_stage}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`XEC_HISTORICAL_PROTECTION_FAILED ${error.message || error}`);
    process.exit(2);
  });
}
module.exports = { VERSION, SYMBOL, STATE_FILE, calculateReturnPct, buildCurrentCostBasis, buildInitialState, buildClientOrderId, sellableQuantity, finalizeStateAfterSale };
