'use strict';

const crypto = require('crypto');
const {
  DEFAULTS,
  reconstructInventory,
  historyCoversBalance,
  decideProfitProtection,
  protectionInventory
} = require('../services/spotOrphanProtection');
const {
  journalStore,
  deterministicClientOrderId,
  submitOrder,
  cancelOrder: cancelJournaledOrder,
  uncertain
} = require('../services/spotOrderSafety');

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_SECRET_KEY || process.env.BINANCE_SECRET || '';
const GH_TOKEN = process.env.GITHUB_TOKEN || '';
const REPOSITORY = process.env.GITHUB_REPOSITORY || '';
const EXCLUDED_ASSETS = new Set(['USDT', 'USDC', 'FDUSD', 'TUSD', 'DAI', 'USDP', 'BUSD', 'XEC']);
const ORPHAN_PREFIX = 'proypers-gh-orphan-';
const STOP_LIMIT_GAP_PCT = 0.006;
const orderJournal = journalStore();
const BASES = [
  'https://api.binance.com',
  'https://api1.binance.com',
  'https://api2.binance.com',
  'https://api3.binance.com',
  'https://api4.binance.com'
];

function fail(message) {
  console.error(`ORPHAN_PROTECT_BLOCKED: ${message}`);
  process.exit(2);
}

async function request(base, path, options = {}) {
  const response = await fetch(`${base}${path}`, options);
  const text = await response.text();
  let body;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text }; }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${body.msg || body.raw || response.statusText}`);
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
  return (account.balances || []).find((row) => row.asset === asset) || {};
}

function totalBalance(account, asset) {
  const row = balanceRow(account, asset);
  return Number(row.free || 0) + Number(row.locked || 0);
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
      'User-Agent': 'proypers25-orphan-protector',
      ...(options.headers || {})
    }
  });
  if (!response.ok) throw new Error(`GitHub HTTP ${response.status}`);
  return response.status === 204 ? null : response.json();
}

async function notifyExitOnce({ symbol, reason, orderId, entryPrice, exitPrice, pnlPct }) {
  if (!GH_TOKEN || !REPOSITORY || !orderId) return;
  const marker = `orderId=${orderId}`;
  const recent = await githubRequest('/issues?state=all&per_page=100&sort=created&direction=desc');
  if (Array.isArray(recent) && recent.some((issue) => String(issue.body || '').includes(marker))) return;
  const body = [
    'Proypers25 ejecutó una salida Spot automática sobre un saldo huérfano adoptado.',
    '',
    `- Símbolo: ${symbol}`,
    `- Motivo: ${reason}`,
    `- Entrada reconstruida aprox.: ${entryPrice}`,
    `- Salida aprox.: ${exitPrice}`,
    `- PnL aprox.: ${(pnlPct * 100).toFixed(3)}%`,
    `- orderId=${orderId}`,
    '- Ejecución: Binance Spot real',
    '- Aprobación manual requerida: no'
  ].join('\n');
  await githubRequest('/issues', {
    method: 'POST',
    body: JSON.stringify({ title: `[SPOT EXIT] ${symbol} ${reason}`, body })
  });
}

async function recentHigh24h(base, symbol, currentPrice) {
  try {
    const rows = await request(base, `/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=5m&limit=288`);
    if (!Array.isArray(rows) || !rows.length) return currentPrice;
    return Math.max(currentPrice, ...rows.map((row) => Number(row[2] || 0)));
  } catch (error) {
    console.log(`ORPHAN_HIGH_FALLBACK symbol=${symbol} error=${error.message || error}`);
    return currentPrice;
  }
}

function beginTransition({ symbol, intent, quantity, info, oldProtections = [], newClientOrderId, preBalanceQuantity = null, replacementStopPrice = null }) {
  const id = crypto.randomUUID();
  return orderJournal.begin(symbol, {
    id,
    intent,
    phase: 'INTENT',
    createdAt: Date.now(),
    quantity: Number(quantity || 0),
    preBalanceQuantity,
    baseAsset: String(info?.baseAsset || ''),
    orderIds: oldProtections.map((order) => String(order.orderId || '')).filter(Boolean),
    clientOrderIds: [
      ...oldProtections.map((order) => String(order.clientOrderId || '')).filter(Boolean),
      ...(newClientOrderId ? [newClientOrderId] : [])
    ],
    newClientOrderId,
    replacementStopPrice,
    protectionClientPrefix: ORPHAN_PREFIX,
    oldProtections: oldProtections.map((order) => ({
      orderId: String(order.orderId || ''),
      clientOrderId: String(order.clientOrderId || ''),
      origQty: Number(order.origQty || 0),
      executedQty: Number(order.executedQty || 0)
    }))
  });
}

async function cancelOrder(base, symbol, order, intent) {
  const canceled = await cancelJournaledOrder(signed, base, symbol, order, orderJournal, intent);
  if (canceled) console.log(`ORPHAN_STOP_CANCELLED symbol=${symbol} orderId=${order.orderId}`);
  return canceled;
}

async function placeProtection(base, info, symbol, quantity, stopPrice, transition = null) {
  const lot = info.filters?.find((f) => f.filterType === 'LOT_SIZE');
  const priceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');
  if (!lot || !priceFilter) throw new Error(`Protection filters missing for ${symbol}`);
  const normalizedQty = floorToStep(quantity, lot.stepSize);
  if (!(normalizedQty >= Number(lot.minQty || 0))) throw new Error(`ORPHAN quantity below minimum for ${symbol}`);

  const clientId = transition?.newClientOrderId || deterministicClientOrderId(
    ORPHAN_PREFIX,
    symbol,
    normalizedQty,
    stopPrice
  );
  const intent = transition || beginTransition({
    symbol,
    intent: 'PROTECT',
    quantity: normalizedQty,
    info,
    newClientOrderId: clientId,
    replacementStopPrice: stopPrice
  });
  let order;
  if ((info.orderTypes || []).includes('STOP_LOSS')) {
    order = await submitOrder(signed, base, {
      symbol,
      side: 'SELL',
      type: 'STOP_LOSS',
      quantity: String(normalizedQty),
      stopPrice: String(stopPrice),
      newOrderRespType: 'RESULT',
      newClientOrderId: clientId
    }, orderJournal, intent);
  } else if ((info.orderTypes || []).includes('STOP_LOSS_LIMIT')) {
    const limitPrice = floorToStep(stopPrice * (1 - STOP_LIMIT_GAP_PCT), priceFilter.tickSize);
    order = await submitOrder(signed, base, {
      symbol,
      side: 'SELL',
      type: 'STOP_LOSS_LIMIT',
      timeInForce: 'GTC',
      quantity: String(normalizedQty),
      stopPrice: String(stopPrice),
      price: String(limitPrice),
      newOrderRespType: 'RESULT',
      newClientOrderId: clientId
    }, orderJournal, intent);
  } else {
    throw new Error(`${symbol} does not support native stop orders`);
  }
  if (!order?.orderId) throw new Error(`ORPHAN native stop returned no orderId for ${symbol}`);
  orderJournal.complete(symbol, intent.id);
  console.log(`ORPHAN_STOP_ARMED symbol=${symbol} orderId=${order.orderId} stop=${stopPrice} quantity=${normalizedQty}`);
  return order;
}

async function marketSell(base, info, symbol, quantity, reason, entryPrice, currentPrice, oldProtection = null) {
  const account = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
  const balance = balanceRow(account, info.baseAsset);
  const free = Number(balance.free || 0);
  const total = free + Number(balance.locked || 0);
  const lot = info.filters?.find((f) => f.filterType === 'MARKET_LOT_SIZE' && Number(f.stepSize) > 0) || info.filters?.find((f) => f.filterType === 'LOT_SIZE');
  if (!lot) throw new Error(`LOT_SIZE missing for ${symbol}`);
  const sellQty = floorToStep(Math.min(quantity, total), lot.stepSize);
  if (!(sellQty > 0 && sellQty >= Number(lot.minQty || 0))) {
    console.log(`ORPHAN_SELL_SKIPPED_DUST symbol=${symbol} quantity=${sellQty} protection_preserved=${Boolean(oldProtection)}`);
    return false;
  }
  const notional = sellQty * currentPrice;
  const nf = info.filters?.find((f) => f.filterType === 'NOTIONAL') || info.filters?.find((f) => f.filterType === 'MIN_NOTIONAL');
  if (Number(nf?.minNotional || 0) > notional) {
    console.log(`ORPHAN_SELL_SKIPPED_DUST symbol=${symbol} quantity=${sellQty} reason=BELOW_MINIMUM_NOTIONAL protection_preserved=${Boolean(oldProtection)}`);
    return false;
  }

  const clientOrderId = deterministicClientOrderId(
    `${ORPHAN_PREFIX}exit-`,
    symbol,
    reason,
    entryPrice,
    sellQty
  );
  const intent = beginTransition({
    symbol,
    intent: 'SELL',
    quantity: sellQty,
    info,
    oldProtections: oldProtection ? [oldProtection] : [],
    newClientOrderId: clientOrderId,
    preBalanceQuantity: total
  });
  if (oldProtection) {
    const canceled = await cancelOrder(base, symbol, oldProtection, intent);
    if (!canceled) {
      const current = orderJournal.read(symbol);
      if (current?.phase === 'CANCEL_NOT_APPLIED') orderJournal.complete(symbol, intent.id);
      return false;
    }
  }
  const refreshed = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
  const refreshedBalance = balanceRow(refreshed, info.baseAsset);
  const refreshedFree = Number(refreshedBalance.free || 0);
  const refreshedTotal = refreshedFree + Number(refreshedBalance.locked || 0);
  const confirmedQty = floorToStep(Math.min(quantity, refreshedFree), lot.stepSize);
  if (confirmedQty < sellQty || refreshedTotal < sellQty) {
    throw uncertain(`ORPHAN_SELL_BALANCE_RECONCILIATION_REQUIRED ${symbol}`);
  }
  const order = await submitOrder(signed, base, {
    symbol,
    side: 'SELL',
    type: 'MARKET',
    quantity: String(confirmedQty),
    newOrderRespType: 'FULL',
    newClientOrderId: clientOrderId
  }, orderJournal, intent);
  if (String(order.status || '').toUpperCase() !== 'FILLED') {
    throw uncertain(`ORPHAN_SELL_NOT_CONFIRMED_FILLED ${symbol}`);
  }
  orderJournal.complete(symbol, intent.id);
  const executedQty = Number(order.executedQty || 0);
  const exitPrice = executedQty > 0 ? Number(order.cummulativeQuoteQty || 0) / executedQty : currentPrice;
  const pnlPct = exitPrice / entryPrice - 1;
  console.log(`ORPHAN_SELL_CREATED symbol=${symbol} reason=${reason} orderId=${order.orderId} quantity=${sellQty} entry=${entryPrice} exit=${exitPrice} pnl_pct=${(pnlPct * 100).toFixed(3)}`);
  await notifyExitOnce({ symbol, reason, orderId: order.orderId, entryPrice, exitPrice, pnlPct });
  return order;
}

async function main() {
  if (!API_KEY || !API_SECRET) fail('Binance API secrets missing');
  const base = await chooseBase();
  const [account, restrictions, prices] = await Promise.all([
    signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' }),
    signed(base, 'GET', '/sapi/v1/account/apiRestrictions'),
    request(base, '/api/v3/ticker/price')
  ]);
  if (account.canTrade !== true) fail('Binance account cannot trade');
  if (restrictions.enableWithdrawals !== false) fail('API withdrawals must remain disabled');

  const priceMap = new Map((Array.isArray(prices) ? prices : []).map((row) => [row.symbol, Number(row.price || 0)]));
  const candidates = (account.balances || [])
    .map((row) => ({ asset: row.asset, free: Number(row.free || 0), locked: Number(row.locked || 0) }))
    .filter((row) => !EXCLUDED_ASSETS.has(row.asset) && row.free + row.locked > 0)
    .map((row) => ({ ...row, symbol: `${row.asset}USDT`, currentPrice: priceMap.get(`${row.asset}USDT`) || 0 }))
    .filter((row) => row.currentPrice > 0 && (row.free + row.locked) * row.currentPrice >= DEFAULTS.minNotionalUsdt);

  let adopted = 0;
  let sold = 0;
  let updated = 0;
  let skipped = 0;

  for (const candidate of candidates) {
    const { asset, symbol, currentPrice } = candidate;
    try {
      const pendingTransition = orderJournal.read(symbol);
      if (pendingTransition) {
        console.error(`ORPHAN_SYMBOL_MUTATIONS_BLOCKED symbol=${symbol} reason=journal_pending intent=${pendingTransition.intent} phase=${pendingTransition.phase}`);
        skipped += 1;
        continue;
      }
      const [exchangeInfo, trades, openOrders] = await Promise.all([
        request(base, `/api/v3/exchangeInfo?symbol=${encodeURIComponent(symbol)}`),
        signed(base, 'GET', '/api/v3/myTrades', { symbol, limit: '1000' }),
        signed(base, 'GET', '/api/v3/openOrders', { symbol })
      ]);
      const info = exchangeInfo.symbols?.[0];
      if (!info || info.status !== 'TRADING' || info.isSpotTradingAllowed !== true) { skipped += 1; continue; }

      const owned = totalBalance(account, asset);
      const reconstructed = reconstructInventory(trades, asset, 'USDT');
      if (!(reconstructed.entryPrice > 0) || !historyCoversBalance(reconstructed.quantity, owned)) {
        console.log(`ORPHAN_SKIP_HISTORY_GAP symbol=${symbol} owned=${owned} reconstructed=${reconstructed.quantity}`);
        skipped += 1;
        continue;
      }

      const protectionState = protectionInventory(openOrders);
      if (protectionState.unsafe.length) {
        console.log(`ORPHAN_SKIP_UNSAFE_ORDER symbol=${symbol} orders=${protectionState.unsafe.map((row) => row.order.orderId).join(',')}`);
        skipped += 1;
        continue;
      }
      if (protectionState.core.length) {
        console.log(`ORPHAN_SKIP_CORE_MANAGED symbol=${symbol} orders=${protectionState.core.map((row) => row.order.orderId).join(',')} reason=native_core_or_v61_protection`);
        skipped += 1;
        continue;
      }
      if (protectionState.orphan.length > 1) {
        console.log(`ORPHAN_SKIP_DUPLICATE_PROTECTION symbol=${symbol} orders=${protectionState.orphan.map((row) => row.order.orderId).join(',')}`);
        skipped += 1;
        continue;
      }
      const orphanStop = protectionState.orphan[0]?.order || null;
      const orphanLocked = orphanStop ? Math.max(0, Number(orphanStop.origQty || 0) - Number(orphanStop.executedQty || 0)) : 0;
      const refreshed = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
      const free = Number(balanceRow(refreshed, asset).free || 0);
      const orphanQty = free + orphanLocked;
      if (!(orphanQty * currentPrice >= DEFAULTS.minNotionalUsdt)) {
        if (orphanStop) console.log(`ORPHAN_KEEP_EXISTING symbol=${symbol} orderId=${orphanStop.orderId} reason=no_free_significant_residue`);
        skipped += 1;
        continue;
      }

      const priceFilter = info.filters?.find((f) => f.filterType === 'PRICE_FILTER');
      if (!priceFilter) { skipped += 1; continue; }
      const high = await recentHigh24h(base, symbol, currentPrice);
      const decision = decideProfitProtection({
        entryPrice: reconstructed.entryPrice,
        currentPrice,
        recentHigh: high,
        tickSize: Number(priceFilter.tickSize || 0)
      });

      console.log(`ORPHAN_MONITOR symbol=${symbol} qty=${orphanQty} entry=${reconstructed.entryPrice} current=${currentPrice} high24h=${high} action=${decision.action} protection=${decision.protection || 'none'} stop=${decision.stopPrice || 0}`);

      if (decision.action === 'HOLD_UNARMED' || decision.action === 'SKIP') {
        if (orphanStop) console.log(`ORPHAN_KEEP_EXISTING symbol=${symbol} orderId=${orphanStop.orderId} reason=protection_already_armed`);
        skipped += 1;
        continue;
      }

      if (decision.action === 'EXIT') {
        const exitReason = decision.reason || (decision.protection === 'ORPHAN_TRAILING' ? 'ORPHAN_TRAILING_STOP' : 'ORPHAN_BREAK_EVEN_STOP');
        if (await marketSell(base, info, symbol, orphanQty, exitReason, reconstructed.entryPrice, currentPrice, orphanStop)) sold += 1;
        continue;
      }

      const existingStop = Number(orphanStop?.stopPrice || 0);
      const tickSize = Number(priceFilter.tickSize || 0);
      const shouldUpgrade = orphanStop && decision.stopPrice > existingStop + Math.max(tickSize * 0.5, Number.EPSILON);
      if (!orphanStop || shouldUpgrade) {
        let transition = null;
        let protectionQty = orphanStop ? orphanQty : Math.min(orphanQty, free);
        if (orphanStop) {
          const lot = info.filters?.find((f) => f.filterType === 'LOT_SIZE');
          const normalizedQty = lot ? floorToStep(protectionQty, lot.stepSize) : 0;
          if (!lot || !(normalizedQty > 0 && normalizedQty >= Number(lot.minQty || 0))) {
            console.log(`ORPHAN_KEEP_EXISTING symbol=${symbol} orderId=${orphanStop.orderId} reason=UNSELLABLE_REPLACEMENT`);
            skipped += 1;
            continue;
          }
          protectionQty = normalizedQty;
          const replacementId = deterministicClientOrderId(ORPHAN_PREFIX, symbol, protectionQty, decision.stopPrice);
          transition = beginTransition({
            symbol,
            intent: 'REPLACE_PROTECTION',
            quantity: protectionQty,
            info,
            oldProtections: [orphanStop],
            newClientOrderId: replacementId,
            replacementStopPrice: decision.stopPrice
          });
          const canceled = await cancelOrder(base, symbol, orphanStop, transition);
          if (!canceled) {
            if (orderJournal.read(symbol)?.phase === 'CANCEL_NOT_APPLIED') {
              orderJournal.complete(symbol, transition.id);
            }
            continue;
          }
        }
        const afterCancel = await signed(base, 'GET', '/api/v3/account', { omitZeroBalances: 'true' });
        const available = Number(balanceRow(afterCancel, asset).free || 0);
        if (transition && floorToStep(available, info.filters.find((f) => f.filterType === 'LOT_SIZE').stepSize) < protectionQty) {
          throw uncertain(`ORPHAN_REPLACEMENT_BALANCE_RECONCILIATION_REQUIRED ${symbol}`);
        }
        await placeProtection(base, info, symbol, Math.min(protectionQty, available), decision.stopPrice, transition);
        if (orphanStop) updated += 1; else adopted += 1;
      }
    } catch (error) {
      console.log(`ORPHAN_SYMBOL_ERROR symbol=${symbol} error=${error.message || error}`);
      skipped += 1;
    }
  }

  console.log(`ORPHAN_PROTECT_OK candidates=${candidates.length} adopted=${adopted} updated=${updated} sells=${sold} skipped=${skipped} xec_excluded=true`);
}

module.exports = { main, marketSell, placeProtection };
if (require.main === module) main().catch((error) => fail(error.message || String(error)));
