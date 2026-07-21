'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');
const { recordConfirmedSpotClose } = require('./spotPositionLifecycle');

const POSITIONS = 'real_spot_positions';
const RESULTS = 'real_spot_execution_results';
const BALANCE_PATH = 'real_spot_config/balance';
const CONTROL_PATH = 'real_spot_config/control';
const RECONCILIATIONS = 'real_spot_reconciliations';
const VERSION = 'spot_account_reconciliation_v1';
const QUANTITY_TOLERANCE = 1e-8;

function asNumber(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
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

function assetFromSymbol(symbol) {
  const normalized = String(symbol || '').toUpperCase();
  return normalized.endsWith('USDT') ? normalized.slice(0, -4) : null;
}

function accountBalanceMap(account) {
  return new Map((account?.balances || []).map((item) => [
    String(item.asset || '').toUpperCase(),
    {
      free: asNumber(item.free),
      locked: asNumber(item.locked),
      total: asNumber(item.free) + asNumber(item.locked)
    }
  ]));
}

function calculateReconciliation(position, actualQuantity) {
  const recordedQuantity = Math.max(0, asNumber(position.quantity));
  const recordedCapital = Math.max(0, asNumber(position.capital_usdt));
  const actual = Math.max(0, asNumber(actualQuantity));
  const deficit = Math.max(0, recordedQuantity - actual);
  const soldFraction = recordedQuantity > 0 ? Math.min(1, deficit / recordedQuantity) : 0;
  const remainingCapital = recordedCapital * (1 - soldFraction);
  return {
    recordedQuantity,
    actualQuantity: Math.min(recordedQuantity, actual),
    deficit,
    soldFraction,
    remainingCapital: Math.max(0, remainingCapital),
    fullyExternalClosed: recordedQuantity > 0 && actual <= QUANTITY_TOLERANCE
  };
}

function buildReconciliationClose(position, reconciliation, conversion, spotSales, now = new Date().toISOString()) {
  const allocatedCapital = Math.max(0, asNumber(position.capital_usdt) - reconciliation.remainingCapital);
  const source = conversion ? 'BINANCE_CONVERT' : spotSales ? 'BINANCE_SPOT_FILLS' : 'BINANCE_BALANCE_RECONCILIATION';
  const quoteReceived = conversion ? asNumber(conversion.toAmount) : spotSales ? asNumber(spotSales.quoteAmount) : null;
  const pnlVerified = quoteReceived !== null;
  const reason = (conversion || spotSales) ? 'MANUAL_RECONCILIATION' : 'AUTO_RECONCILED';
  const eventId = conversion?.latestOrderId
    ? `binance_convert_${conversion.latestOrderId}`
    : spotSales?.latestTradeId
      ? `binance_spot_trade_${spotSales.latestTradeId}`
      : `balance_absence_${position.id}_${Math.round(reconciliation.actualQuantity * 1e8)}`;
  const exitPrice = reconciliation.deficit > 0 && quoteReceived !== null
    ? quoteReceived / reconciliation.deficit
    : asNumber(position.current_price || position.entry_price);
  return {
    allocatedCapital,
    source,
    quoteReceived,
    pnlVerified,
    reason,
    eventId,
    exitPrice,
    realizedPnl: pnlVerified ? quoteReceived - allocatedCapital : null,
    metadata: {
      external_conversion: Boolean(conversion),
      external_spot_sale: Boolean(spotSales),
      conversion_trades: conversion?.trades || 0,
      conversion_order_id: conversion?.latestOrderId || null,
      spot_sale_trades: spotSales?.trades || 0,
      spot_sale_order_id: spotSales?.latestOrderId || null,
      pnl_verified: pnlVerified,
      externally_sold_quantity: reconciliation.deficit,
      externally_received_usdt: quoteReceived,
      last_reconciled_at: now,
      reconciliation_version: VERSION
    }
  };
}

async function findExternalConversion(position, asset) {
  const since = new Date(position.last_reconciled_at || position.opened_at || position.created_at || 0).getTime();
  if (!Number.isFinite(since) || since <= 0) return null;
  try {
    const flow = await privateRequest('GET', '/sapi/v1/convert/tradeFlow', {
      startTime: since,
      endTime: Date.now(),
      limit: 100
    });
    const conversions = Array.isArray(flow?.list) ? flow.list : [];
    const matching = conversions.filter((trade) =>
      String(trade.fromAsset || '').toUpperCase() === asset &&
      String(trade.toAsset || '').toUpperCase() === 'USDT' &&
      String(trade.orderStatus || '').toUpperCase() === 'SUCCESS'
    );
    if (!matching.length) return null;
    return matching.reduce((summary, trade) => ({
      fromAmount: summary.fromAmount + asNumber(trade.fromAmount),
      toAmount: summary.toAmount + asNumber(trade.toAmount),
      trades: summary.trades + 1,
      latestOrderId: trade.orderId || summary.latestOrderId
    }), { fromAmount: 0, toAmount: 0, trades: 0, latestOrderId: null });
  } catch (error) {
    return null;
  }
}

async function findExternalSpotSales(position) {
  const since = new Date(position.last_reconciled_at || position.opened_at || position.created_at || 0).getTime();
  const symbol = String(position.symbol || '').toUpperCase();
  if (!Number.isFinite(since) || since <= 0 || !symbol.endsWith('USDT')) return null;
  try {
    const trades = await privateRequest('GET', '/api/v3/myTrades', {
      symbol,
      startTime: since,
      limit: 1000
    });
    const sells = (Array.isArray(trades) ? trades : []).filter((trade) => trade.isBuyer === false);
    if (!sells.length) return null;
    return sells.reduce((summary, trade) => ({
      quantity: summary.quantity + asNumber(trade.qty),
      quoteAmount: summary.quoteAmount + asNumber(trade.quoteQty),
      feesUsdt: summary.feesUsdt + (String(trade.commissionAsset || '').toUpperCase() === 'USDT' ? asNumber(trade.commission) : 0),
      trades: summary.trades + 1,
      latestOrderId: trade.orderId || summary.latestOrderId,
      latestTradeId: trade.id || summary.latestTradeId
    }), { quantity: 0, quoteAmount: 0, feesUsdt: 0, trades: 0, latestOrderId: null, latestTradeId: null });
  } catch (error) {
    // A missing trade-history permission must not be interpreted as a sale.
    return null;
  }
}

async function reconcileRealSpotAccount(db) {
  const startedAt = Date.now();
  const now = new Date().toISOString();
  const [account, openSnapshot, resultsSnapshot] = await Promise.all([
    privateRequest('GET', '/api/v3/account'),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    db.collection(RESULTS).get()
  ]);

  const balances = accountBalanceMap(account);
  const usdt = balances.get('USDT') || { free: 0, locked: 0, total: 0 };
  const actions = [];
  let inPositionsUsdt = 0;
  let inconsistencies = 0;

  for (const doc of openSnapshot.docs) {
    const position = { id: doc.id, ...doc.data() };
    const asset = assetFromSymbol(position.symbol);
    if (!asset) {
      inconsistencies += 1;
      actions.push({ position_id: doc.id, symbol: position.symbol, action: 'BLOCKED_INVALID_SYMBOL' });
      continue;
    }

    const actualAsset = balances.get(asset) || { free: 0, locked: 0, total: 0 };
    const reconciliation = calculateReconciliation(position, actualAsset.total);

    if (reconciliation.deficit <= QUANTITY_TOLERANCE) {
      inPositionsUsdt += reconciliation.remainingCapital;
      actions.push({ position_id: doc.id, symbol: position.symbol, action: 'MATCHED' });
      continue;
    }

    inconsistencies += 1;
    const [conversion, spotSales] = await Promise.all([
      findExternalConversion(position, asset),
      findExternalSpotSales(position)
    ]);
    // Binance evidence decides the close classification. Without a matching
    // Convert/fill record, a missing balance is a zombie position and PnL is
    // intentionally left unverified rather than fabricated.
    const close = buildReconciliationClose(position, reconciliation, conversion, spotSales, now);
    await recordConfirmedSpotClose(db, {
      positionRef: doc.ref,
      position,
      eventId: close.eventId,
      reason: close.reason,
      source: close.source,
      executedQuantity: reconciliation.deficit,
      quoteReceivedUsdt: close.quoteReceived || 0,
      exitPrice: close.exitPrice,
      pnlVerified: close.pnlVerified,
      feeUsdt: spotSales?.feesUsdt || 0,
      metadata: close.metadata
    });

    inPositionsUsdt += reconciliation.remainingCapital;
    actions.push({
      position_id: doc.id,
      symbol: position.symbol,
      action: reconciliation.fullyExternalClosed ? close.reason : 'PARTIAL_RECONCILIATION',
      recorded_quantity: reconciliation.recordedQuantity,
      actual_quantity: reconciliation.actualQuantity,
      external_quantity: reconciliation.deficit,
      quote_received_usdt: close.quoteReceived,
      pnl_usdt: close.realizedPnl,
      pnl_verified: close.realizedPnl !== null,
      reason: close.reason
    });
  }

  const realizedPnlUsdt = resultsSnapshot.docs.reduce((sum, doc) => {
    const pnl = Number(doc.data()?.net_pnl_usdt);
    return Number.isFinite(pnl) ? sum + pnl : sum;
  }, 0) + actions.reduce((sum, action) => Number.isFinite(action.pnl_usdt) ? sum + action.pnl_usdt : sum, 0);

  const totalUsdt = usdt.free + usdt.locked + inPositionsUsdt;
  const balanceRef = db.doc(BALANCE_PATH);
  const controlRef = db.doc(CONTROL_PATH);
  const reconciliationRef = db.collection(RECONCILIATIONS).doc(`reconciliation_${Date.now()}`);

  await db.runTransaction(async (tx) => {
    const controlSnap = await tx.get(controlRef);
    const currentControl = controlSnap.exists ? controlSnap.data() : {};
    tx.set(balanceRef, {
      available_usdt: usdt.free,
      locked_usdt: usdt.locked,
      in_positions_usdt: inPositionsUsdt,
      total_usdt: totalUsdt,
      realized_pnl_usdt: realizedPnlUsdt,
      source: 'BINANCE_ACCOUNT_RECONCILED',
      updated_at: now,
      reconciliation_version: VERSION
    }, { merge: true });
    tx.set(controlRef, {
      account_consistent: inconsistencies === 0,
      reconciliation_required: inconsistencies > 0,
      reconciliation_last_run_at: now,
      reconciliation_last_inconsistencies: inconsistencies,
      new_entries_enabled: inconsistencies > 0 ? false : currentControl.new_entries_enabled === true,
      entry_block_reason: inconsistencies > 0 ? 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED' : null
    }, { merge: true });
    tx.set(reconciliationRef, {
      created_at: now,
      version: VERSION,
      inconsistencies,
      account_consistent: inconsistencies === 0,
      usdt_free: usdt.free,
      usdt_locked: usdt.locked,
      in_positions_usdt: inPositionsUsdt,
      total_usdt: totalUsdt,
      actions
    });
  });

  return {
    ok: true,
    account_consistent: inconsistencies === 0,
    inconsistencies,
    entries_blocked: inconsistencies > 0,
    available_usdt: usdt.free,
    locked_usdt: usdt.locked,
    in_positions_usdt: inPositionsUsdt,
    total_usdt: totalUsdt,
    realized_pnl_usdt: realizedPnlUsdt,
    actions,
    duration_ms: Date.now() - startedAt,
    version: VERSION
  };
}

module.exports = {
  VERSION,
  assetFromSymbol,
  calculateReconciliation,
  buildReconciliationClose,
  reconcileRealSpotAccount,
  findExternalSpotSales
};
