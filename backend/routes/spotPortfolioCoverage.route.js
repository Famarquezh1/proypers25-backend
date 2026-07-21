'use strict';

const express = require('express');
const crypto = require('crypto');
const axios = require('axios');
const db = require('../firebase-admin-config');
const { getBinanceSpotCredentials } = require('../lib/secretManager');

const router = express.Router();
const POSITIONS = 'real_spot_positions';
const DUST_USDT = 0.10;

function safeEquals(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function validateSecret(req, res, next) {
  const supplied = req.header('x-investments-secret') || req.header('x-cron-secret');
  const expected = process.env.INVESTMENTS_SUMMARY_SECRET || process.env.CRON_SECRET;
  if (!expected) return res.status(503).json({ ok: false, error: 'SUMMARY_SECRET_NOT_CONFIGURED' });
  if (!safeEquals(supplied, expected)) return res.status(403).json({ ok: false, error: 'FORBIDDEN' });
  return next();
}

function signParams(params, secret) {
  const query = Object.entries(params)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
  const signature = crypto.createHmac('sha256', secret).update(query).digest('hex');
  return `${query}&signature=${signature}`;
}

async function signedBinanceGet(path, params = {}) {
  const { apiKey, apiSecret } = await getBinanceSpotCredentials();
  const query = signParams({ ...params, recvWindow: 10000, timestamp: Date.now() }, apiSecret);
  const response = await axios.get(`https://api.binance.com${path}?${query}`, {
    headers: { 'X-MBX-APIKEY': apiKey },
    timeout: 15000
  });
  return response.data;
}

async function getPrices() {
  const response = await axios.get('https://api.binance.com/api/v3/ticker/price', { timeout: 10000 });
  return new Map((response.data || []).map((item) => [String(item.symbol), Number(item.price || 0)]));
}

function valueInUsdt(asset, quantity, prices) {
  if (asset === 'USDT') return quantity;
  const direct = Number(prices.get(`${asset}USDT`) || 0);
  if (direct > 0) return quantity * direct;
  const btc = Number(prices.get('BTCUSDT') || 0);
  const viaBtc = Number(prices.get(`${asset}BTC`) || 0);
  return btc > 0 && viaBtc > 0 ? quantity * viaBtc * btc : 0;
}

function sumManagedForAsset(asset, openPositions) {
  const symbol = `${asset}USDT`;
  const positions = openPositions.filter((position) => String(position.symbol || '').toUpperCase() === symbol);
  const managedQuantity = positions.reduce((sum, position) => sum + Math.max(0, Number(position.quantity || 0)), 0);
  const managedCapitalUsdt = positions.reduce((sum, position) => sum + Math.max(0, Number(position.capital_usdt || 0)), 0);
  const managedPnlUsdt = positions.reduce((sum, position) => {
    const quantity = Math.max(0, Number(position.quantity || 0));
    const entry = Number(position.entry_price || 0);
    const current = Number(position.current_price || 0);
    return sum + (entry > 0 && current > 0 ? quantity * (current - entry) : 0);
  }, 0);
  return { positions, managedQuantity, managedCapitalUsdt, managedPnlUsdt };
}

async function buildCoverage() {
  const [account, prices, snapshot] = await Promise.all([
    signedBinanceGet('/api/v3/account'),
    getPrices(),
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get()
  ]);

  const openPositions = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }));
  const assets = (account.balances || []).map((balance) => {
    const asset = String(balance.asset || '').toUpperCase();
    const free = Number(balance.free || 0);
    const locked = Number(balance.locked || 0);
    const quantity = free + locked;
    const currentPrice = asset === 'USDT' ? 1 : Number(prices.get(`${asset}USDT`) || 0);
    const totalValueUsdt = valueInUsdt(asset, quantity, prices);
    const managed = sumManagedForAsset(asset, openPositions);
    const managedQuantity = Math.min(quantity, managed.managedQuantity);
    const unmanagedQuantity = Math.max(0, quantity - managedQuantity);
    const managedValueUsdt = valueInUsdt(asset, managedQuantity, prices);
    const unmanagedValueUsdt = valueInUsdt(asset, unmanagedQuantity, prices);
    const tolerance = Math.max(1e-8, quantity * 0.0001);
    let coverageStatus = 'UNMANAGED';
    if (asset === 'USDT') coverageStatus = 'RESERVE';
    else if (managedQuantity <= tolerance) coverageStatus = 'UNMANAGED';
    else if (unmanagedQuantity <= tolerance) coverageStatus = 'FULLY_MANAGED';
    else coverageStatus = 'PARTIALLY_MANAGED';

    const managedPnlUsdt = managed.positions.reduce((sum, position) => {
      const positionQty = Math.max(0, Number(position.quantity || 0));
      const entry = Number(position.entry_price || 0);
      if (entry <= 0 || currentPrice <= 0) return sum;
      return sum + positionQty * (currentPrice - entry);
    }, 0);

    return {
      asset,
      symbol: asset === 'USDT' ? null : `${asset}USDT`,
      free,
      locked,
      total_quantity: quantity,
      managed_quantity: managedQuantity,
      unmanaged_quantity: unmanagedQuantity,
      total_value_usdt: Number(totalValueUsdt.toFixed(8)),
      managed_value_usdt: Number(managedValueUsdt.toFixed(8)),
      unmanaged_value_usdt: Number(unmanagedValueUsdt.toFixed(8)),
      managed_capital_usdt: Number(managed.managedCapitalUsdt.toFixed(8)),
      managed_unrealized_pnl_usdt: asset === 'USDT' ? null : Number(managedPnlUsdt.toFixed(8)),
      open_position_count: managed.positions.length,
      coverage_status: coverageStatus,
      coverage_pct: quantity > 0 ? Number(((managedQuantity / quantity) * 100).toFixed(4)) : 0
    };
  }).filter((asset) => asset.total_quantity > 0 && (asset.total_value_usdt >= 0.01 || asset.asset === 'USDT'))
    .sort((a, b) => b.total_value_usdt - a.total_value_usdt);

  const unmanagedAssets = assets.filter((asset) => asset.asset !== 'USDT' && asset.unmanaged_value_usdt > DUST_USDT);
  const partialAssets = unmanagedAssets.filter((asset) => asset.coverage_status === 'PARTIALLY_MANAGED');
  const fullyUnmanagedAssets = unmanagedAssets.filter((asset) => asset.coverage_status === 'UNMANAGED');
  const deficits = openPositions.filter((position) => {
    const symbol = String(position.symbol || '').toUpperCase();
    const asset = symbol.endsWith('USDT') ? symbol.slice(0, -4) : '';
    const actual = Number(assets.find((item) => item.asset === asset)?.total_quantity || 0);
    const recorded = Number(position.quantity || 0);
    return actual + Math.max(1e-8, recorded * 0.0001) < recorded;
  });

  const blockers = [];
  if (deficits.length > 0) blockers.push('MANAGED_POSITION_DEFICIT');
  if (partialAssets.length > 0) blockers.push('PARTIALLY_UNMANAGED_HOLDINGS');
  if (fullyUnmanagedAssets.length > 0) blockers.push('UNMANAGED_LEGACY_HOLDINGS');

  return {
    ok: true,
    mode: 'READ_ONLY_AUDIT',
    generated_at: new Date().toISOString(),
    policy: {
      dust_threshold_usdt: DUST_USDT,
      new_entries_should_be_blocked: blockers.length > 0,
      adoption_execution_enabled: false,
      note: 'La adopción requiere precio base verificable y aprobación explícita. Este endpoint no crea posiciones ni envía órdenes.'
    },
    totals: {
      equity_usdt: Number(assets.reduce((sum, asset) => sum + asset.total_value_usdt, 0).toFixed(8)),
      managed_value_usdt: Number(assets.reduce((sum, asset) => sum + asset.managed_value_usdt, 0).toFixed(8)),
      unmanaged_value_usdt: Number(assets.reduce((sum, asset) => sum + asset.unmanaged_value_usdt, 0).toFixed(8)),
      unmanaged_asset_count: unmanagedAssets.length,
      partially_managed_asset_count: partialAssets.length,
      fully_unmanaged_asset_count: fullyUnmanagedAssets.length
    },
    diagnosis: {
      ready_for_new_entries: blockers.length === 0,
      blockers,
      position_deficits: deficits.map((position) => ({ id: position.id, symbol: position.symbol, quantity: Number(position.quantity || 0) }))
    },
    assets
  };
}

router.get('/internal/investments/coverage', validateSecret, async (req, res) => {
  try {
    return res.json(await buildCoverage());
  } catch (error) {
    console.error('[SPOT_PORTFOLIO_COVERAGE] Failed:', error.message);
    return res.status(500).json({
      ok: false,
      error: 'COVERAGE_AUDIT_FAILED',
      details: error.response?.data?.msg || error.message
    });
  }
});

module.exports = router;
