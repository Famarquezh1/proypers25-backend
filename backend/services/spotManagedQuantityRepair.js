'use strict';

const axios = require('axios');
const crypto = require('crypto');
const { getBinanceSpotCredentials } = require('../lib/secretManager');
const { reconcileRealSpotAccount } = require('./spotAccountReconciliation');

const POSITIONS = 'real_spot_positions';
const CONTROL_PATH = 'real_spot_config/control';
const VERSION = 'spot_managed_quantity_v1';
const TOLERANCE = 1e-8;

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function assetFromSymbol(symbol) {
  const normalized = String(symbol || '').toUpperCase();
  return normalized.endsWith('USDT') ? normalized.slice(0, -4) : null;
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

function summarizeManagedQuantity(position, trades, baseAsset) {
  const orderId = position.order_id === null || position.order_id === undefined ? null : String(position.order_id);
  const clientOrderId = position.client_order_id ? String(position.client_order_id) : null;
  const matching = (Array.isArray(trades) ? trades : []).filter((trade) => {
    if (trade.isBuyer !== true) return false;
    if (orderId && String(trade.orderId) === orderId) return true;
    return clientOrderId && String(trade.clientOrderId || '') === clientOrderId;
  });

  const grossFromTrades = matching.reduce((sum, trade) => sum + number(trade.qty), 0);
  const grossQuantity = grossFromTrades > 0
    ? grossFromTrades
    : Math.max(0, number(position.gross_quantity, number(position.quantity)));
  const baseAssetCommission = matching.reduce((sum, trade) =>
    String(trade.commissionAsset || '').toUpperCase() === baseAsset
      ? sum + number(trade.commission)
      : sum, 0);
  const storedBaseCommission = Math.max(0, number(position.base_asset_commission));
  const effectiveCommission = matching.length > 0 ? baseAssetCommission : storedBaseCommission;
  const netQuantity = Math.max(0, grossQuantity - effectiveCommission);

  return {
    gross_quantity: grossQuantity,
    base_asset_commission: effectiveCommission,
    managed_quantity: netQuantity,
    net_quantity: netQuantity,
    matched_buy_fills: matching.length
  };
}

function buildManagedDifference(position, accountTotal, summary) {
  const managed = Math.max(0, number(summary.managed_quantity));
  const actual = Math.max(0, number(accountTotal));
  const deficit = Math.max(0, managed - actual);
  const historical = Math.max(0, actual - managed);
  return {
    position_id: position.id,
    symbol: String(position.symbol || '').toUpperCase(),
    gross_quantity: summary.gross_quantity,
    base_asset_commission: summary.base_asset_commission,
    managed_quantity: managed,
    binance_total_quantity: actual,
    historical_unmanaged_quantity: historical,
    managed_deficit: deficit,
    consistent: deficit <= Math.max(TOLERANCE, managed * 0.000001)
  };
}

async function repairManagedSpotQuantities(db, dependencies = {}) {
  const request = dependencies.privateRequest || privateRequest;
  const [account, snapshot] = await Promise.all([
    request('GET', '/api/v3/account'),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get()
  ]);
  const balances = new Map((account?.balances || []).map((item) => [
    String(item.asset || '').toUpperCase(),
    number(item.free) + number(item.locked)
  ]));

  const differences = [];
  for (const doc of snapshot.docs) {
    const position = { id: doc.id, ...doc.data() };
    const symbol = String(position.symbol || '').toUpperCase();
    const baseAsset = assetFromSymbol(symbol);
    if (!baseAsset) {
      differences.push({ position_id: doc.id, symbol, consistent: false, reason: 'INVALID_SPOT_SYMBOL' });
      continue;
    }

    let trades = [];
    try {
      trades = await request('GET', '/api/v3/myTrades', { symbol, limit: 1000 });
    } catch (error) {
      if (!(number(position.managed_quantity) > 0 || number(position.net_quantity) > 0)) {
        differences.push({ position_id: doc.id, symbol, consistent: false, reason: 'BUY_FILLS_UNAVAILABLE', error: error.message });
        continue;
      }
    }

    const summary = summarizeManagedQuantity(position, trades, baseAsset);
    const difference = buildManagedDifference(position, balances.get(baseAsset) || 0, summary);
    differences.push(difference);
    await doc.ref.set({
      gross_quantity: summary.gross_quantity,
      base_asset_commission: summary.base_asset_commission,
      managed_quantity: summary.managed_quantity,
      net_quantity: summary.net_quantity,
      quantity: summary.managed_quantity,
      historical_unmanaged_quantity: difference.historical_unmanaged_quantity,
      managed_quantity_repaired_at: new Date().toISOString(),
      managed_quantity_version: VERSION
    }, { merge: true });
  }

  return {
    ok: true,
    version: VERSION,
    repaired_positions: differences.length,
    consistent: differences.every((item) => item.consistent === true),
    firestore_differences: differences
  };
}

async function reconcileManagedSpotAccount(db, dependencies = {}) {
  const repair = await repairManagedSpotQuantities(db, dependencies);
  const reconciliation = await reconcileRealSpotAccount(db);
  const managedConsistent = repair.consistent === true &&
    repair.firestore_differences.every((item) => item.consistent === true);
  const accountConsistent = reconciliation.account_consistent === true && managedConsistent;

  if (!accountConsistent) {
    await db.doc(CONTROL_PATH).set({
      account_consistent: false,
      reconciliation_required: true,
      new_entries_enabled: false,
      entry_block_reason: 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED',
      managed_reconciliation_failed_at: new Date().toISOString()
    }, { merge: true });
  }

  return {
    ...reconciliation,
    account_consistent: accountConsistent,
    entries_blocked: reconciliation.entries_blocked === true || !managedConsistent,
    inconsistencies: number(reconciliation.inconsistencies) + repair.firestore_differences.filter((item) => item.consistent !== true).length,
    managed_quantity_repair: repair,
    firestore_differences: repair.firestore_differences,
    version: `${reconciliation.version || 'reconciliation'}+${VERSION}`
  };
}

module.exports = {
  VERSION,
  assetFromSymbol,
  summarizeManagedQuantity,
  buildManagedDifference,
  repairManagedSpotQuantities,
  reconcileManagedSpotAccount
};
