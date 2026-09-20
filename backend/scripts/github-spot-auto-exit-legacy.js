'use strict';

const crypto = require('crypto');
const EXIT_POLICY = require('../config/spot-exit-policy-v2.json');
const { managedCoreProtectionSymbols, isProypersSpotBuyOrder } = require('../services/spotOrphanProtection');
const { resolveTrailingDistance } = require('../services/spotProgressiveTrailing');
const { latestOpenProtection, latestFilledExit, resolveManagedResidual } = require('../services/spotManagedResidual');
const { highHistoryCadence } = require('../services/spotHighHistoryPolicy');
const { decideCoreGrowthExit } = require('../services/spotGrowthExitPolicy');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const REPOSITORY = process.env.GITHUB_REPOSITORY || '';

if (EXIT_POLICY.mode !== 'PRODUCTION') throw new Error(`Exit policy must be PRODUCTION, got ${EXIT_POLICY.mode}`);
const CORE_EXIT = EXIT_POLICY.core;
const HARD_STOP_PCT = Number(CORE_EXIT.hard_stop_pct);
const BREAK_EVEN_TRIGGER_PCT = Number(CORE_EXIT.break_even_trigger_pct);
const BREAK_EVEN_LOCK_PCT = Number(CORE_EXIT.break_even_lock_pct);
const TRAILING_TRIGGER_PCT = Number(CORE_EXIT.trailing_trigger_pct);
const TRAILING_DISTANCE_PCT = Number(CORE_EXIT.trailing_distance_pct);
const STALE_TIMEOUT_HOURS = Number(CORE_EXIT.stale_timeout_hours);
const STALE_TIMEOUT_MAX_GAIN_PCT = Number(CORE_EXIT.stale_max_gain_pct);
const MAX_MANAGED_AGE_DAYS = 7;
const STOP_LIMIT_GAP_PCT = 0.006;
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

function fail(message) {
  console.error(`EXIT_ENGINE_BLOCKED: ${message}`);
  process.exit(2);
}

function isNotionalFilterError(error) {
  const message = String(error?.message || error || '');
  const bodyMessage = String(error?.body?.msg || '');
  return /Filter failure:\s*(NOTIONAL|MIN_NOTIONAL)/i.test(message) ||
    /Filter failure:\s*(NOTIONAL|MIN_NOTIONAL)/i.test(bodyMessage) ||
    /notional below minimum/i.test(message);
}

function minimumNotional(info, orderType = 'MARKET') {
  const filters = Array.isArray(info?.filters) ? info.filters : [];
  const notional = filters.find((f) => f.filterType === 'NOTIONAL');
  if (notional) {
    if (orderType === 'MARKET' && notional.applyMinToMarket === false) return 0;
    return Number(notional.minNotional || 0);
  }
  const minNotional = filters.find((f) => f.filterType === 'MIN_NOTIONAL');
  if (minNotional) {
    if (orderType === 'MARKET' && minNotional.applyToMarket === false) return 0;
    return Number(minNotional.minNotional || 0);
  }
  return 0;
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
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

async function signed(base, method, path, params = {}) {
  const query = new URLSearchParams({ ...params, recvWindow: '5000', timestamp: String(Date.now()) }).toString();
  const signature = crypto.createHmac('sha256', API_SECRET).update(query).digest('hex');
  return request(base, `${path}?${query}&signature=${signature}`, {
    method,
    headers: { 'X-MBX-APIKEY': API_KEY }
  });
}

async function chooseBase() {
  for (const base of BASES) {
    try {
      await request(base, '/api/v3/ping');
      await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      return base;
    } catch (_) {}
  }
  fail('Binance private API unreachable from local runner');
}

async function githubRequest(path, options = {}) {
  if (!GH_TOKEN || !REPOSITORY) return null;
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${GH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'Content-Type': 'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'proypers25-exit-runner',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function managedSymbols(base) {
  const since = Date.now() - MAX_MANAGED_AGE_DAYS * 86400000;
  const [issues, openOrders] = await Promise.all([
    githubRequest('/issues?state=closed&per_page=100&sort=updated&direction=desc')
      .catch((error) => {
        console.warn(`EXIT_SCOPE_GITHUB_FALLBACK error=${error.message || error}`);
        return [];
      }),
    signed(base, 'GET', '/api/v3/openOrders')
  ]);
  const issueSymbols = (Array.isArray(issues) ? issues : [])
    .filter((issue) => issue.state_reason === 'completed')
    .filter((issue) => new Date(issue.created_at).getTime() >= since)
    .map((issue) => String(issue.title || '').match(/^\[SPOT SIGNAL\] ([A-Z0-9]+USDT)\b/))
    .filter(Boolean)
    .map((match) => match[1]);
  const protectionSymbols = managedCoreProtectionSymbols(openOrders);
  const symbols = [...new Set([...issueSymbols, ...protectionSymbols])];
  console.log(`EXIT_SCOPE issue_symbols=${issueSymbols.length} native_protection_symbols=${protectionSymbols.length} total=${symbols.length}`);
  return symbols;
}

async function notifyExitOnce({ symbol, reason, orderId, entryPrice, exitPrice, pnlPct }) {
  if (!GH_TOKEN || !REPOSITORY || !orderId) return;
  const marker = `orderId=${orderId}`;
  const recent = await githubRequest('/issues?state=all&per_page=100&sort=created&direction=desc');
  if (Array.isArray(recent) && recent.some((issue) => String(issue.body || '').includes(marker))) return;

  const title = `[SPOT EXIT] ${symbol} ${reason}`;
  const body = [
    'Proypers25 ejecutó una salida Spot automática.',
    '',
    `- Símbolo: ${symbol}`,
    `- Motivo: ${reason}`,
    `- Entrada aprox.: ${entryPrice}`,
    `- Salida aprox.: ${exitPrice}`,
    `- PnL aprox.: ${(pnlPct * 100).toFixed(3)}%`,
    `- orderId=${orderId}`,
    '- Ejecución: Binance Spot real',
    '- Aprobación manual requerida: no'
  ].join('\n');

  await githubRequest('/issues', {
    method: 'POST',
    body: JSON.stringify({ title, body })
  });
  console.log(`EXIT_NOTIFICATION_CREATED symbol=${symbol} reason=${reason} orderId=${orderId}`);
}

function decimalPlaces(step) {
  const text = String(step);
  if (!text.includes('.')) return 0;
  return (text.replace(/0+$/, '').split('.')[1] || '').length;
}

function floorToStep(value, stepSize) {
  const step = Number(stepSize);
  if (!(step > 0)) return Number(value);
  return Number((Math.floor((Number(value) + Number.EPSILON) / step) * step).toFixed(decimalPlaces(stepSize)));
}

function balanceRow(account, asset) {
  return (account.balances || []).find((x) => x.asset === asset) || {};
}

function freeBalance(account, asset) {
  return Number(balanceRow(account, asset).free || 0);
}

function totalBalance(account, asset) {
  const row = balanceRow(account, asset);
  return Number(row.free || 0) + Number(row.locked || 0);
}

async function getHighSince(base, symbol, startTime, entryPrice, currentPrice) {
  let high = Math.max(entryPrice, currentPrice);
  let cursor = Number(startTime);
  const end = Date.now();
  const cadence = highHistoryCadence(cursor, end);
  const intervalMs = cadence.interval_ms;

  try {
    for (let page = 0; page < cadence.max_pages && cursor < end; page += 1) {
      const params = new URLSearchParams({ symbol, interval: cadence.interval, startTime: String(cursor), endTime: String(end), limit: '1000' });
      const rows = await request(base, `/api/v3/klines?${params}`);
      if (!Array.isArray(rows) || !rows.length) break;
      high = Math.max(high, ...rows.map((r) => Number(r[2] || 0)));
      const lastOpen = Number(rows[rows.length - 1][0] || cursor);
      const next = lastOpen + intervalMs;
      if (next <= cursor) break;
      cursor = next;
      if (rows.length < 1000) break;
    }
    console.log(`HIGH_HISTORY symbol=${symbol} interval=${cadence.interval} high=${high} start=${startTime}`);
  } catch (error) {
    console.log(`HIGH_HISTORY_FALLBACK symbol=${symbol} error=${error.message || error}`);
  }
  return high;
}

function protectionParams(info, entryPrice, recentHigh) {
  const priceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');
  if (!priceFilter) throw new Error(`PRICE_FILTER missing for ${info.symbol}`);

  let rawStop = entryPrice * (1 - HARD_STOP_PCT);
  let protection = 'HARD_STOP';
  if (recentHigh / entryPrice - 1 >= BREAK_EVEN_TRIGGER_PCT) {
    rawStop = Math.max(rawStop, entryPrice * (1 + BREAK_EVEN_LOCK_PCT));
    protection = 'BREAK_EVEN';
  }
  if (recentHigh / entryPrice - 1 >= TRAILING_TRIGGER_PCT) {
    const mfePct = recentHigh / entryPrice - 1;
    const trailingDistancePct = resolveTrailingDistance(mfePct, TRAILING_DISTANCE_PCT, CORE_EXIT.trailing_tiers);
    rawStop = Math.max(rawStop, recentHigh * (1 - trailingDistancePct));
    protection = 'TRAILING';
  }
  return {
    stopPrice: floorToStep(rawStop, priceFilter.tickSize),
    protection,
    tickSize: Number(priceFilter.tickSize || 0)
  };
}

async function cancelProtection(base, symbol, protectionOrder) {
  if (!protectionOrder) return;
  await signed(base, 'DELETE', '/api/v3/order', { symbol, orderId: String(protectionOrder.orderId) });
  console.log(`NATIVE_STOP_CANCELLED symbol=${symbol} orderId=${protectionOrder.orderId}`);
}

async function placeProtection(base, info, symbol, quantity, stopPrice) {
  const lot = info.filters?.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');
  if (!lot || !priceFilter) throw new Error(`Protection filters missing for ${symbol}`);
  const normalizedQty = floorToStep(quantity, lot.stepSize);
  if (!(normalizedQty >= Number(lot.minQty || 0))) throw new Error(`Protection quantity below minimum for ${symbol}`);
  const minNotional = minimumNotional(info, 'STOP_LOSS');
  const protectionNotional = normalizedQty * stopPrice;
  if (minNotional > 0 && protectionNotional + Number.EPSILON < minNotional) {
    const error = new Error(`Protection notional below minimum for ${symbol}: ${protectionNotional} < ${minNotional}`);
    error.code = 'PROTECTION_NOTIONAL_TOO_SMALL';
    throw error;
  }

  const clientId = `proypers-gh-protect-${Date.now()}`;
  let order;
  if ((info.orderTypes || []).includes('STOP_LOSS')) {
    order = await signed(base, 'POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'STOP_LOSS',
      quantity: String(normalizedQty),
      stopPrice: String(stopPrice),
      newOrderRespType: 'RESULT',
      newClientOrderId: clientId
    });
  } else if ((info.orderTypes || []).includes('STOP_LOSS_LIMIT')) {
    const limitPrice = floorToStep(stopPrice * (1 - STOP_LIMIT_GAP_PCT), priceFilter.tickSize);
    order = await signed(base, 'POST', '/api/v3/order', {
      symbol,
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      timeInForce: 'GTC',
      quantity: String(normalizedQty),
      stopPrice: String(stopPrice),
      price: String(limitPrice),
      newOrderRespType: 'RESULT',
      newClientOrderId: clientId
    });
  } else {
    throw new Error(`${symbol} does not support native stop orders`);
  }
  if (!order?.orderId) throw new Error(`Native stop returned no orderId for ${symbol}`);
  console.log(`NATIVE_STOP_ARMED symbol=${symbol} orderId=${order.orderId} stop=${stopPrice} quantity=${normalizedQty}`);
  return order;
}

async function marketSell(base, info, symbol, managedQty, reason, entryPrice, currentPrice) {
  const account = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
  const free = freeBalance(account, info.baseAsset);
  const lot = info.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE' && Number(f.stepSize) > 0) || info.filters?.find((f) => f.filterType === 'LOT_SIZE');
  if (!lot) throw new Error(`LOT_SIZE missing for ${symbol}`);
  const quantity = floorToStep(Math.min(managedQty, free), lot.stepSize);
  if (!(quantity >= Number(lot.minQty || 0))) throw new Error(`SELL quantity below minimum for ${symbol}`);

  const notional = quantity * currentPrice;
  const minNotional = minimumNotional(info, 'MARKET');
  if (minNotional > 0 && notional < minNotional) throw new Error(`SELL notional below minimum for ${symbol}`);

  const order = await signed(base, 'POST', '/api/v3/order', {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(quantity),
    newOrderRespType: 'FULL',
    newClientOrderId: `proypers-gh-exit-${Date.now()}`
  });
  if (!order?.orderId) throw new Error(`SELL returned no orderId for ${symbol}`);
  const exitPrice = Number(order.executedQty || 0) > 0 ? Number(order.cummulativeQuoteQty || 0) / Number(order.executedQty) : currentPrice;
  const pnlPct = exitPrice / entryPrice - 1;
  console.log(`SELL_CREATED symbol=${symbol} reason=${reason} orderId=${order.orderId} status=${order.status} quantity=${quantity} entry=${entryPrice} exit=${exitPrice} pnl_pct=${(pnlPct * 100).toFixed(3)}`);
  await notifyExitOnce({ symbol, reason, orderId: order.orderId, entryPrice, exitPrice, pnlPct });
  return order;
}

async function main() {
  if (!API_KEY || !API_SECRET) fail('Binance API secrets missing');
  const base = await chooseBase();
  const [initialAccount, restrictions, symbols] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),
    managedSymbols(base)
  ]);

  if (initialAccount.canTrade !== true) fail('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) fail('API withdrawals must remain disabled');

  if (!symbols.length) {
    console.log('EXIT_ENGINE_OK no managed symbols');
    return;
  }

  let openCount = 0;
  let soldCount = 0;
  let protectedCount = 0;

  for (const symbol of symbols) {
    const orders = await signed(base, 'GET', '/api/v3/allOrders', { symbol, limit: '100' });
    const managedBuys = orders
      .filter(isProypersSpotBuyOrder)
      .sort((a, b) => Number(a.updateTime || a.time) - Number(b.updateTime || b.time));
    if (!managedBuys.length) continue;

    const buy = managedBuys[managedBuys.length - 1];
    const buyTime = Number(buy.updateTime || buy.time || 0);
    const executedQty = Number(buy.executedQty || 0);
    const quoteQty = Number(buy.cummulativeQuoteQty || 0);
    const entryPrice = executedQty > 0 ? quoteQty / executedQty : 0;
    if (!(entryPrice > 0 && executedQty > 0)) continue;

    const openProtect = latestOpenProtection(orders, buyTime);
    const filledExit = latestFilledExit(orders, buyTime);

    const [ticker, exchangeInfo, account] = await Promise.all([
      request(base, `/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`),
      request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`),
      signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' })
    ]);
    const currentPrice = Number(ticker.price || 0);
    const info = exchangeInfo.symbols?.[0];
    if (!(currentPrice > 0) || !info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) continue;

    const ownedTotal = totalBalance(account, info.baseAsset);
    if (!(ownedTotal > 0)) {
      if (filledExit) {
        const exitQty = Number(filledExit.executedQty || 0);
        const exitPrice = exitQty > 0 ? Number(filledExit.cummulativeQuoteQty || 0) / exitQty : entryPrice;
        const pnlPct = exitPrice / entryPrice - 1;
        const reason = String(filledExit.clientOrderId || '').startsWith('proypers-gh-protect-') ? 'NATIVE_PROTECTIVE_STOP' : 'AUTOMATIC_EXIT';
        await notifyExitOnce({ symbol, reason, orderId: filledExit.orderId, entryPrice, exitPrice, pnlPct });
      }
      continue;
    }

    let residualTrades = [];
    if (filledExit && openProtect) {
      residualTrades = await signed(base, 'GET', '/api/v3/myTrades', { symbol, limit: '1000' }).catch((error) => {
        console.warn(`RESIDUAL_TRADES_UNAVAILABLE symbol=${symbol} error=${error.message || error}`);
        return [];
      });
    }

    const managed = resolveManagedResidual({
      buy,
      orders,
      trades: residualTrades,
      ownedTotal,
      baseAsset: info.baseAsset
    });

    if (!managed.active) {
      if (filledExit) {
        const exitQty = Number(filledExit.executedQty || 0);
        const exitPrice = exitQty > 0 ? Number(filledExit.cummulativeQuoteQty || 0) / exitQty : entryPrice;
        const pnlPct = exitPrice / entryPrice - 1;
        const reason = String(filledExit.clientOrderId || '').startsWith('proypers-gh-protect-') ? 'NATIVE_PROTECTIVE_STOP' : 'AUTOMATIC_EXIT';
        await notifyExitOnce({ symbol, reason, orderId: filledExit.orderId, entryPrice, exitPrice, pnlPct });
      }
      continue;
    }

    if (filledExit) {
      const exitQty = Number(filledExit.executedQty || 0);
      const exitPrice = exitQty > 0 ? Number(filledExit.cummulativeQuoteQty || 0) / exitQty : managed.entryPrice;
      const pnlPct = exitPrice / managed.entryPrice - 1;
      const reason = String(filledExit.clientOrderId || '').startsWith('proypers-gh-protect-') ? 'NATIVE_PROTECTIVE_STOP' : 'AUTOMATIC_EXIT';
      await notifyExitOnce({ symbol, reason, orderId: filledExit.orderId, entryPrice: managed.entryPrice, exitPrice, pnlPct });
    }

    const effectiveEntryPrice = managed.entryPrice;
    const effectiveStartTime = managed.startTime || buyTime;
    const managedQty = managed.managedQty;

    openCount += 1;
    const ageHours = (Date.now() - effectiveStartTime) / 3600000;
    const gainPct = currentPrice / effectiveEntryPrice - 1;
    const recentHigh = await getHighSince(base, symbol, effectiveStartTime, effectiveEntryPrice, currentPrice);
    const { stopPrice, protection, tickSize } = protectionParams(info, effectiveEntryPrice, recentHigh);
    if (managed.residualMode) {
      console.log(`RESIDUAL_MONITOR_ACTIVE symbol=${symbol} qty=${managedQty} entry=${effectiveEntryPrice} current=${currentPrice} open_protect=${openProtect?.orderId || 'none'}`);
    }

    const growthExit = String(buy.clientOrderId || '').startsWith('proypers-gh-v10-')
      ? { reason: null }
      : decideCoreGrowthExit({ ageHours, gainPct, recentHighPct: recentHigh / effectiveEntryPrice - 1, policy: CORE_EXIT });

    let reason = null;
    if (currentPrice <= stopPrice) reason = protection === 'TRAILING' ? 'TRAILING_STOP' : protection === 'BREAK_EVEN' ? 'BREAK_EVEN_STOP' : 'STOP_LOSS';
    else if (growthExit.reason) reason = growthExit.reason;
    else if (ageHours >= STALE_TIMEOUT_HOURS && gainPct <= STALE_TIMEOUT_MAX_GAIN_PCT) reason = 'TIMEOUT_STALE';

    console.log(`MONITOR symbol=${symbol} entry=${effectiveEntryPrice} current=${currentPrice} gain_pct=${(gainPct * 100).toFixed(3)} high=${recentHigh} stop=${stopPrice} protection=${protection} age_h=${ageHours.toFixed(2)} native_stop=${openProtect?.orderId || 'none'} residual=${managed.residualMode} action=${reason || 'HOLD'}`);

    const existingStop = Number(openProtect?.stopPrice || 0);
    const nativeStopCurrent = openProtect && existingStop + Math.max(tickSize * 0.5, Number.EPSILON) >= stopPrice;
    if (reason) {
      if (openProtect && !['TIMEOUT_STALE', 'MOMENTUM_FAILURE', 'NO_PROGRESS'].includes(reason)) {
        if (nativeStopCurrent) {
          console.log(`EXIT_NATIVE_PENDING symbol=${symbol} reason=${reason} orderId=${openProtect.orderId}`);
          continue;
        }
        console.log(`EXIT_NATIVE_STALE symbol=${symbol} reason=${reason} orderId=${openProtect.orderId} existing_stop=${existingStop} desired_stop=${stopPrice}`);
      }
      if (openProtect) await cancelProtection(base, symbol, openProtect);
      try {
        await marketSell(base, info, symbol, managedQty, reason, effectiveEntryPrice, currentPrice);
        soldCount += 1;
      } catch (error) {
        if (!isNotionalFilterError(error)) throw error;
        console.warn(`EXIT_SKIPPED_NOTIONAL symbol=${symbol} reason=${reason} detail=${error.message || error}`);
      }
      continue;
    }

    const shouldUpgrade = openProtect && stopPrice > existingStop + Math.max(tickSize * 0.5, Number.EPSILON);
    if (!openProtect || shouldUpgrade) {
      if (openProtect) await cancelProtection(base, symbol, openProtect);
      const refreshed = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      const free = freeBalance(refreshed, info.baseAsset);
      const quantity = Math.min(managedQty, free);
      try {
        await placeProtection(base, info, symbol, quantity, stopPrice);
        protectedCount += 1;
      } catch (error) {
        if (!isNotionalFilterError(error) && error?.code !== 'PROTECTION_NOTIONAL_TOO_SMALL') throw error;
        console.warn(`PROTECTION_SKIPPED_NOTIONAL symbol=${symbol} stop=${stopPrice} quantity=${quantity} detail=${error.message || error}`);
      }
    }
  }

  console.log(`EXIT_ENGINE_OK managed_symbols=${symbols.length} open_positions=${openCount} sells=${soldCount} protection_updates=${protectedCount} model=${EXIT_POLICY.model_version}`);
}

main().catch((error) => fail(error.message || String(error)));