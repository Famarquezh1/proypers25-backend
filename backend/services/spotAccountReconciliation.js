'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

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

async function findExternalConversion(position, asset) {
  const openedAt = new Date(position.opened_at || position.created_at || 0).getTime();
  if (!Number.isFinite(openedAt) || openedAt <= 0) return null;
  try {
    const flow = await privateRequest('GET', '/sapi/v1/convert/tradeFlow', {
      startTime: openedAt,
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
    const conversion = await findExternalConversion(position, asset);
    const allocatedCapital = Math.max(0, asNumber(position.capital_usdt) - reconciliation.remainingCapital);
    const quoteReceived = conversion
      ? Math.min(asNumber(conversion.toAmount), Math.max(asNumber(conversion.toAmount), 0))
      : null;
    const realizedPnl = quoteReceived === null ? null : quoteReceived - allocatedCapital;
    const resultId = `external_reconciliation_${doc.id}_${Date.now()}`;

    await db.runTransaction(async (tx) => {
      const latest = await tx.get(doc.ref);
      if (!latest.exists || latest.data().status !== 'REAL_OPEN') return;

      if (reconciliation.fullyExternalClosed) {
        tx.update(doc.ref, {
          status: 'REAL_CLOSED_EXTERNAL',
          exit_status: 'EXTERNAL_CONVERSION_RECONCILED',
          closing_reason: 'MANUAL_CONVERSION_TO_USDT',
          closed_at: now,
          quantity: 0,
          capital_usdt: 0,
          externally_sold_quantity: reconciliation.deficit,
          externally_received_usdt: quoteReceived,
          reconciliation_version: VERSION
        });
      } else {
        tx.update(doc.ref, {
          quantity: reconciliation.actualQuantity,
          capital_usdt: reconciliation.remainingCapital,
          exit_status: 'PARTIAL_EXTERNAL_CONVERSION_RECONCILED',
          externally_sold_quantity: reconciliation.deficit,
          externally_received_usdt: quoteReceived,
          last_reconciled_at: now,
          reconciliation_version: VERSION
        });
      }

      tx.set(db.collection(RESULTS).doc(resultId), {
        id: resultId,
        position_id: doc.id,
        symbol: position.symbol,
        entry_price: asNumber(position.entry_price),
        quantity: reconciliation.deficit,
        allocated_capital_usdt: allocatedCapital,
        quote_received_usdt: quoteReceived,
        gross_pnl_usdt: realizedPnl,
        net_pnl_usdt: realizedPnl,
        net_pnl_pct: realizedPnl === null || allocatedCapital <= 0 ? null : (realizedPnl / allocatedCapital) * 100,
        closing_reason: 'MANUAL_CONVERSION_TO_USDT',
        opened_at: position.opened_at || null,
        closed_at: now,
        fully_closed: reconciliation.fullyExternalClosed,
        external_conversion: true,
        conversion_trades: conversion?.trades || 0,
        conversion_order_id: conversion?.latestOrderId || null,
        pnl_verified: realizedPnl !== null,
        real_mode: true,
        safety_version: VERSION
      }, { merge: true });
    });

    inPositionsUsdt += reconciliation.remainingCapital;
    actions.push({
      position_id: doc.id,
      symbol: position.symbol,
      action: reconciliation.fullyExternalClosed ? 'CLOSED_EXTERNAL' : 'REDUCED_EXTERNAL',
      recorded_quantity: reconciliation.recordedQuantity,
      actual_quantity: reconciliation.actualQuantity,
      external_quantity: reconciliation.deficit,
      quote_received_usdt: quoteReceived,
      pnl_usdt: realizedPnl,
      pnl_verified: realizedPnl !== null
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
  reconcileRealSpotAccount
};
