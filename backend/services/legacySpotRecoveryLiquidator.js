'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const CONFIG_DOC = 'real_spot_config/legacy_recovery';
const STATE_COLLECTION = 'legacy_spot_recovery_states';
const RUN_COLLECTION = 'legacy_spot_recovery_runs';
const VERSION = 'legacy_spot_recovery_v1';

const DEFAULT_TARGET_ASSETS = Object.freeze(['QTUM', 'ANKR', 'BAR', 'LAYER', 'CATI']);
const HARD_PROTECTED_ASSETS = Object.freeze(['XEC']);

const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  target_assets: DEFAULT_TARGET_ASSETS,
  protected_assets: HARD_PROTECTED_ASSETS,
  minimum_recovery_pct: 5,
  minimum_positive_cycles: 2,
  minimum_1h_change_pct: 0.5,
  minimum_24h_change_pct: 0,
  target_max_loss_pct: -10,
  trailing_pullback_pct: 2.5,
  minimum_improvement_at_sale_pct: 3,
  use_market_sell_to_usdt: true,
  sell_entire_free_balance: true,
  xec_never_sell: true
});

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function round(value, decimals = 8) {
  return Number(n(value).toFixed(decimals));
}

function normalizeAsset(value) {
  return String(value || '').trim().toUpperCase();
}

function normalizeConfig(config = {}) {
  const targets = [...new Set((Array.isArray(config.target_assets) ? config.target_assets : DEFAULT_TARGET_ASSETS)
    .map(normalizeAsset).filter(Boolean))]
    .filter((asset) => !HARD_PROTECTED_ASSETS.includes(asset));
  const protectedAssets = [...new Set([
    ...HARD_PROTECTED_ASSETS,
    ...(Array.isArray(config.protected_assets) ? config.protected_assets.map(normalizeAsset) : [])
  ])];
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: config.enabled !== false,
    target_assets: targets,
    protected_assets: protectedAssets,
    minimum_recovery_pct: Math.max(1, n(config.minimum_recovery_pct, DEFAULT_CONFIG.minimum_recovery_pct)),
    minimum_positive_cycles: Math.max(1, Math.floor(n(config.minimum_positive_cycles, DEFAULT_CONFIG.minimum_positive_cycles))),
    minimum_1h_change_pct: n(config.minimum_1h_change_pct, DEFAULT_CONFIG.minimum_1h_change_pct),
    minimum_24h_change_pct: n(config.minimum_24h_change_pct, DEFAULT_CONFIG.minimum_24h_change_pct),
    target_max_loss_pct: Math.min(0, n(config.target_max_loss_pct, DEFAULT_CONFIG.target_max_loss_pct)),
    trailing_pullback_pct: Math.max(0.5, n(config.trailing_pullback_pct, DEFAULT_CONFIG.trailing_pullback_pct)),
    minimum_improvement_at_sale_pct: Math.max(0, n(config.minimum_improvement_at_sale_pct, DEFAULT_CONFIG.minimum_improvement_at_sale_pct)),
    xec_never_sell: true,
    version: VERSION
  };
}

function isProtectedAsset(asset, config = {}) {
  const normalized = normalizeAsset(asset);
  const configured = normalizeConfig(config).protected_assets;
  return HARD_PROTECTED_ASSETS.includes(normalized) || configured.includes(normalized);
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

function decimalPlaces(step) {
  const text = String(step || '');
  return text.includes('.') ? (text.replace(/0+$/, '').split('.')[1]?.length || 0) : 0;
}

function floorToStep(quantity, stepSize) {
  const step = Number(stepSize);
  if (!Number.isFinite(step) || step <= 0) return 0;
  return Number((Math.floor((Number(quantity) + Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}

function buildCurrentCostBasis(trades = []) {
  const ordered = [...trades].sort((a, b) => Number(a.time || 0) - Number(b.time || 0));
  let quantity = 0;
  let cost = 0;
  for (const trade of ordered) {
    const qty = Math.max(0, n(trade.qty));
    const quote = Math.max(0, n(trade.quoteQty, qty * n(trade.price)));
    const fee = Math.max(0, n(trade.commission));
    const feeAsset = normalizeAsset(trade.commissionAsset);
    if (trade.isBuyer === true) {
      const received = Math.max(0, qty - (feeAsset && feeAsset !== 'USDT' ? fee : 0));
      quantity += received;
      cost += quote + (feeAsset === 'USDT' ? fee : 0);
    } else {
      if (quantity <= 0) continue;
      const average = cost / quantity;
      const removed = Math.min(quantity, qty);
      quantity -= removed;
      cost = Math.max(0, cost - (average * removed));
    }
  }
  return {
    tracked_quantity: round(quantity, 12),
    remaining_cost_usdt: round(cost),
    average_cost_usdt: quantity > 0 ? round(cost / quantity, 12) : null
  };
}

function calculateReturnPct(current, reference) {
  const base = n(reference);
  return base > 0 ? ((n(current) / base) - 1) * 100 : null;
}

function evaluateRecoveryDecision({ state = {}, currentPrice, averageCost, oneHourChangePct, change24hPct, config = {} } = {}) {
  const policy = normalizeConfig(config);
  const price = n(currentPrice);
  const baselinePrice = n(state.baseline_price, price);
  const lastPrice = n(state.last_price, baselinePrice);
  const currentDrawdownPct = averageCost > 0 ? calculateReturnPct(price, averageCost) : null;
  const baselineDrawdownPct = Number.isFinite(Number(state.baseline_drawdown_pct)) ? Number(state.baseline_drawdown_pct) : null;
  const priceRecoveryPct = calculateReturnPct(price, baselinePrice) || 0;
  const improvementPct = currentDrawdownPct !== null && baselineDrawdownPct !== null
    ? currentDrawdownPct - baselineDrawdownPct
    : priceRecoveryPct;
  const positiveNow = price > lastPrice && n(oneHourChangePct) >= policy.minimum_1h_change_pct && n(change24hPct) >= policy.minimum_24h_change_pct;
  const positiveCycles = positiveNow ? Math.max(0, n(state.positive_cycles)) + 1 : 0;
  const armedBefore = state.status === 'ARMED' || state.armed === true;
  const shouldArm = !armedBefore && improvementPct >= policy.minimum_recovery_pct && positiveCycles >= policy.minimum_positive_cycles;
  const armed = armedBefore || shouldArm;
  const highestPrice = armed ? Math.max(n(state.highest_price_after_arm, price), price) : null;
  const pullbackPct = armed && highestPrice > 0 ? ((highestPrice - price) / highestPrice) * 100 : 0;
  const targetReached = currentDrawdownPct !== null && currentDrawdownPct >= policy.target_max_loss_pct;
  const trailingReached = armed && pullbackPct >= policy.trailing_pullback_pct && improvementPct >= policy.minimum_improvement_at_sale_pct;
  const sell = targetReached || trailingReached;
  const reason = targetReached ? 'LOSS_REDUCED_TO_TARGET' : trailingReached ? 'RECOVERY_TRAILING_EXIT' : null;

  return {
    sell,
    reason,
    arm_now: shouldArm,
    armed,
    positive_now: positiveNow,
    positive_cycles: positiveCycles,
    baseline_price: baselinePrice,
    current_price: price,
    average_cost_usdt: averageCost > 0 ? averageCost : null,
    baseline_drawdown_pct: baselineDrawdownPct,
    current_drawdown_pct: currentDrawdownPct,
    price_recovery_pct: priceRecoveryPct,
    improvement_pct: improvementPct,
    highest_price_after_arm: highestPrice,
    pullback_from_recovery_high_pct: pullbackPct,
    one_hour_change_pct: n(oneHourChangePct),
    change_24h_pct: n(change24hPct),
    policy
  };
}

function buildClientOrderId(asset, state = {}) {
  const seed = `${normalizeAsset(asset)}|${state.baseline_at || state.created_at || 'baseline'}`;
  return `px25lr_${crypto.createHash('sha256').update(seed).digest('hex').slice(0, 24)}`;
}

async function findExistingSellOrder(symbol, clientOrderId, dependencies = {}) {
  const requestPrivate = dependencies.privateRequest || privateRequest;
  try {
    const order = await requestPrivate('GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
    return String(order.side || '').toUpperCase() === 'SELL' ? order : null;
  } catch (error) {
    if (Number(error.code) === -2013) return null;
    throw error;
  }
}

async function placeMarketSell(symbol, quantity, clientOrderId, dependencies = {}) {
  const requestPrivate = dependencies.privateRequest || privateRequest;
  const existing = await findExistingSellOrder(symbol, clientOrderId, { privateRequest: requestPrivate });
  if (existing) return { order: existing, recovered_existing_order: true };
  try {
    const order = await requestPrivate('POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity,
      newClientOrderId: clientOrderId,
      newOrderRespType: 'FULL'
    });
    return { order, recovered_existing_order: false };
  } catch (error) {
    const recovered = await findExistingSellOrder(symbol, clientOrderId, { privateRequest: requestPrivate });
    if (recovered) return { order: recovered, recovered_existing_order: true };
    throw error;
  }
}

async function loadMarketSnapshot(asset, dependencies = {}) {
  const symbol = `${asset}USDT`;
  const requestPrivate = dependencies.privateRequest || privateRequest;
  const requestPublic = dependencies.publicGet || publicGet;
  const [ticker, klines, trades, exchangeInfo] = await Promise.all([
    requestPublic('/api/v3/ticker/24hr', { symbol }),
    requestPublic('/api/v3/klines', { symbol, interval: '15m', limit: 6 }),
    requestPrivate('GET', '/api/v3/myTrades', { symbol, limit: 1000 }),
    requestPublic('/api/v3/exchangeInfo', { symbol })
  ]);
  const currentPrice = n(ticker.lastPrice);
  const firstClose = n(klines?.[0]?.[4], currentPrice);
  return {
    symbol,
    current_price: currentPrice,
    change_24h_pct: n(ticker.priceChangePercent),
    one_hour_change_pct: calculateReturnPct(currentPrice, firstClose) || 0,
    trades: Array.isArray(trades) ? trades : [],
    exchange_info: exchangeInfo?.symbols?.[0] || null
  };
}

async function claimSale(db, stateRef, asset, state, clientOrderId) {
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(stateRef);
    const latest = snap.exists ? snap.data() : state;
    if (latest.status === 'CONVERTED' || latest.status === 'SELL_PENDING') return false;
    tx.set(stateRef, {
      ...latest,
      status: 'SELL_PENDING',
      sell_client_order_id: clientOrderId,
      sell_claimed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { merge: true });
    return true;
  });
}

async function evaluateAsset(db, asset, accountBalance, managedSymbols, config, dependencies = {}) {
  const normalized = normalizeAsset(asset);
  const stateRef = db.collection(STATE_COLLECTION).doc(normalized);
  const existingSnap = await stateRef.get();
  const existing = existingSnap.exists ? existingSnap.data() : null;

  if (isProtectedAsset(normalized, config)) {
    const protectedResult = { asset: normalized, action: 'PROTECTED', reason: 'HARD_PROTECTED_ASSET', version: VERSION };
    await stateRef.set({ ...protectedResult, status: 'PROTECTED', updated_at: new Date().toISOString() }, { merge: true });
    return protectedResult;
  }
  if (managedSymbols.has(`${normalized}USDT`)) return { asset: normalized, action: 'SKIP', reason: 'MANAGED_BY_REAL_ENGINE' };
  const freeQuantity = Math.max(0, n(accountBalance?.free));
  const totalQuantity = freeQuantity + Math.max(0, n(accountBalance?.locked));
  if (!(totalQuantity > 0)) return { asset: normalized, action: 'NO_BALANCE' };

  const market = await loadMarketSnapshot(normalized, dependencies);
  const costBasis = buildCurrentCostBasis(market.trades);
  const averageCost = n(costBasis.average_cost_usdt, 0);
  const now = new Date().toISOString();
  const baselineDrawdown = averageCost > 0 ? calculateReturnPct(market.current_price, averageCost) : null;

  if (!existing) {
    const initialized = {
      asset: normalized,
      symbol: market.symbol,
      status: 'WATCHING',
      baseline_price: market.current_price,
      baseline_drawdown_pct: baselineDrawdown,
      baseline_at: now,
      last_price: market.current_price,
      positive_cycles: 0,
      highest_price_after_arm: null,
      account_quantity: totalQuantity,
      average_cost_usdt: averageCost || null,
      created_at: now,
      updated_at: now,
      version: VERSION
    };
    await stateRef.set(initialized);
    return { asset: normalized, action: 'INITIALIZED', state: initialized };
  }
  if (existing.status === 'CONVERTED') return { asset: normalized, action: 'ALREADY_CONVERTED', order_id: existing.sell_order_id || null };

  const decision = evaluateRecoveryDecision({
    state: existing,
    currentPrice: market.current_price,
    averageCost,
    oneHourChangePct: market.one_hour_change_pct,
    change24hPct: market.change_24h_pct,
    config
  });
  const nextState = {
    ...existing,
    status: decision.armed ? 'ARMED' : 'WATCHING',
    armed: decision.armed,
    armed_at: decision.arm_now ? now : (existing.armed_at || null),
    last_price: market.current_price,
    positive_cycles: decision.positive_cycles,
    highest_price_after_arm: decision.highest_price_after_arm,
    current_drawdown_pct: decision.current_drawdown_pct,
    price_recovery_pct: decision.price_recovery_pct,
    improvement_pct: decision.improvement_pct,
    pullback_from_recovery_high_pct: decision.pullback_from_recovery_high_pct,
    one_hour_change_pct: decision.one_hour_change_pct,
    change_24h_pct: decision.change_24h_pct,
    account_quantity: totalQuantity,
    free_quantity: freeQuantity,
    average_cost_usdt: averageCost || existing.average_cost_usdt || null,
    updated_at: now,
    version: VERSION
  };
  await stateRef.set(nextState, { merge: true });
  if (!decision.sell) return { asset: normalized, action: decision.armed ? 'ARMED' : 'WATCHING', decision };

  const info = market.exchange_info;
  if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) {
    return { asset: normalized, action: 'SELL_BLOCKED', reason: 'SYMBOL_NOT_AVAILABLE_FOR_SPOT_SELL', decision };
  }
  const lot = info.filters?.find((item) => item.filterType === 'LOT_SIZE') || info.filters?.find((item) => item.filterType === 'MARKET_LOT_SIZE');
  const notional = info.filters?.find((item) => item.filterType === 'NOTIONAL') || info.filters?.find((item) => item.filterType === 'MIN_NOTIONAL');
  if (!lot) return { asset: normalized, action: 'SELL_BLOCKED', reason: 'LOT_SIZE_FILTER_NOT_FOUND', decision };
  const submittedQuantity = floorToStep(freeQuantity, lot.stepSize);
  const minQty = n(lot.minQty);
  const minNotional = n(notional?.minNotional);
  const estimatedNotional = submittedQuantity * market.current_price;
  if (!(submittedQuantity >= minQty) || (minNotional > 0 && estimatedNotional < minNotional)) {
    await stateRef.set({ status: 'DUST', dust_quantity: freeQuantity, dust_value_usdt: estimatedNotional, updated_at: now }, { merge: true });
    return { asset: normalized, action: 'DUST', quantity: freeQuantity, estimated_value_usdt: estimatedNotional };
  }

  const clientOrderId = existing.sell_client_order_id || buildClientOrderId(normalized, existing);
  const claimed = await claimSale(db, stateRef, normalized, nextState, clientOrderId);
  if (!claimed) return { asset: normalized, action: 'SKIP_ALREADY_CLAIMED' };

  try {
    const execution = await placeMarketSell(market.symbol, submittedQuantity, clientOrderId, dependencies);
    const order = execution.order || {};
    const executedQty = n(order.executedQty);
    const quoteReceived = n(order.cummulativeQuoteQty);
    if (!(executedQty > 0) || !(quoteReceived > 0)) throw new Error(`LEGACY_SELL_NOT_FILLED:${order.status || 'UNKNOWN'}`);
    const entryCost = averageCost > 0 ? executedQty * averageCost : null;
    const realizedPnl = entryCost !== null ? quoteReceived - entryCost : null;
    const result = {
      asset: normalized,
      symbol: market.symbol,
      action: 'CONVERTED_TO_USDT',
      reason: decision.reason,
      status: 'CONVERTED',
      executed_quantity: executedQty,
      quote_received_usdt: quoteReceived,
      average_sell_price: quoteReceived / executedQty,
      estimated_cost_basis_usdt: entryCost,
      estimated_realized_pnl_usdt: realizedPnl,
      sell_order_id: order.orderId || null,
      sell_client_order_id: clientOrderId,
      recovered_existing_order: execution.recovered_existing_order === true,
      converted_at: new Date().toISOString(),
      decision,
      version: VERSION
    };
    await stateRef.set({ ...result, updated_at: result.converted_at }, { merge: true });
    await db.collection(RUN_COLLECTION).doc(`legacy_recovery_sale_${normalized}_${order.orderId || Date.now()}`).set(result);
    return result;
  } catch (error) {
    await stateRef.set({
      status: 'SELL_FAILED',
      sell_error: error.message,
      sell_failed_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, { merge: true });
    return { asset: normalized, action: 'SELL_FAILED', error: error.message, decision };
  }
}

async function runLegacySpotRecoveryCycle(db, options = {}, dependencies = {}) {
  if (!db) throw new Error('legacy_recovery_requires_db');
  const configRef = db.doc(CONFIG_DOC);
  const configSnap = await configRef.get();
  const config = normalizeConfig({ ...(configSnap.exists ? configSnap.data() : {}), ...options });
  await configRef.set({ ...config, last_cycle_at: new Date().toISOString() }, { merge: true });
  if (!config.enabled) return { ok: true, enabled: false, outcomes: [], version: VERSION };

  const requestPrivate = dependencies.privateRequest || privateRequest;
  const [account, managedSnapshot] = await Promise.all([
    requestPrivate('GET', '/api/v3/account'),
    db.collection('real_spot_positions').where('status', '==', 'REAL_OPEN').get()
  ]);
  const balances = new Map((account.balances || []).map((item) => [normalizeAsset(item.asset), item]));
  const managedSymbols = new Set(managedSnapshot.docs.map((doc) => normalizeAsset(doc.data().symbol)));
  const outcomes = [];
  for (const asset of config.target_assets) {
    try {
      outcomes.push(await evaluateAsset(db, asset, balances.get(asset), managedSymbols, config, dependencies));
    } catch (error) {
      outcomes.push({ asset, action: 'EVALUATION_FAILED', error: error.message });
    }
  }
  const run = {
    id: `legacy_recovery_run_${Date.now()}`,
    created_at: new Date().toISOString(),
    enabled: true,
    target_assets: config.target_assets,
    protected_assets: config.protected_assets,
    converted: outcomes.filter((item) => item.action === 'CONVERTED_TO_USDT').length,
    failures: outcomes.filter((item) => item.action.endsWith('FAILED')),
    outcomes,
    version: VERSION
  };
  await db.collection(RUN_COLLECTION).doc(run.id).set(run);
  return { ok: run.failures.length === 0, ...run };
}

module.exports = {
  VERSION,
  DEFAULT_CONFIG,
  DEFAULT_TARGET_ASSETS,
  HARD_PROTECTED_ASSETS,
  normalizeConfig,
  isProtectedAsset,
  floorToStep,
  buildCurrentCostBasis,
  evaluateRecoveryDecision,
  buildClientOrderId,
  runLegacySpotRecoveryCycle
};
