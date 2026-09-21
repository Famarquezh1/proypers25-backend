'use strict';

const { reconstructInventory, historyCoversBalance } = require('./spotOrphanProtection');

function n(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function isManagedProtection(order = {}) {
  const id = String(order.clientOrderId || '');
  return id.startsWith('proypers-gh-protect-');
}

function isManagedExit(order = {}) {
  const id = String(order.clientOrderId || '');
  return id.startsWith('proypers-gh-exit-') || id.startsWith('proypers-gh-protect-');
}

function isOwnedManagedOrder(order = {}) {
  const id = String(order.clientOrderId || '');
  return id.startsWith('proypers-gh-') ||
    id.startsWith('px25b_') ||
    id.startsWith('px25x_') ||
    id.startsWith('px25lr_') ||
    id.startsWith('px25xec_') ||
    id.startsWith('px25ghxec_');
}

function managedTradesOnly(trades = [], orders = []) {
  const ids = new Set((Array.isArray(orders) ? orders : [])
    .filter(isOwnedManagedOrder)
    .map((order) => String(order.orderId || ''))
    .filter(Boolean));
  return (Array.isArray(trades) ? trades : [])
    .filter((trade) => ids.has(String(trade.orderId || '')));
}

function remainingOrderQty(order = {}) {
  return Math.max(0, n(order.origQty) - n(order.executedQty));
}

function latestOpenProtection(orders = [], buyTime = 0) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => String(o.side || '').toUpperCase() === 'SELL')
    .filter((o) => ['NEW', 'PARTIALLY_FILLED'].includes(String(o.status || '').toUpperCase()))
    .filter((o) => n(o.time || o.updateTime) > n(buyTime))
    .filter(isManagedProtection)
    .sort((a, b) => n(b.time || b.updateTime) - n(a.time || a.updateTime))[0] || null;
}

function latestFilledExit(orders = [], buyTime = 0) {
  return (Array.isArray(orders) ? orders : [])
    .filter((o) => String(o.side || '').toUpperCase() === 'SELL' && String(o.status || '').toUpperCase() === 'FILLED')
    .filter((o) => n(o.updateTime || o.time) > n(buyTime))
    .filter(isManagedExit)
    .sort((a, b) => n(b.updateTime || b.time) - n(a.updateTime || a.time))[0] || null;
}

function resolveManagedResidual({ buy = {}, orders = [], trades = [], ownedTotal = 0, baseAsset = '', forceReconstruct = false } = {}) {
  const buyTime = n(buy.updateTime || buy.time);
  const buyQty = n(buy.executedQty);
  const quoteQty = n(buy.cummulativeQuoteQty);
  const buyEntryPrice = buyQty > 0 ? quoteQty / buyQty : 0;
  const openProtect = latestOpenProtection(orders, buyTime);
  const filledExit = latestFilledExit(orders, buyTime);
  const owned = Math.max(0, n(ownedTotal));

  if (!(buyEntryPrice > 0 && buyQty > 0) || !(owned > 0)) {
    return { active: false, openProtect, filledExit, reason: 'NO_OWNED_POSITION' };
  }
  if (filledExit && !openProtect) {
    return { active: false, openProtect: null, filledExit, reason: 'FULL_EXIT_DETECTED' };
  }

  let entryPrice = buyEntryPrice;
  let startTime = buyTime;
  let managedQty = Math.min(buyQty, owned);
  let residualMode = false;
  let reconstructed = null;

  if (openProtect) {
    const protectedQty = remainingOrderQty(openProtect);
    if (protectedQty > 0) managedQty = Math.min(protectedQty, owned);
  }

  if ((forceReconstruct || (filledExit && openProtect)) && Array.isArray(trades) && trades.length && baseAsset) {
    const reconstructionTrades = forceReconstruct ? managedTradesOnly(trades, orders) : trades;
    reconstructed = reconstructInventory(reconstructionTrades, baseAsset);
    if (
      reconstructed.entryPrice > 0 &&
      reconstructed.quantity > 0 &&
      historyCoversBalance(reconstructed.quantity, owned)
    ) {
      entryPrice = reconstructed.entryPrice;
      startTime = reconstructed.startTime || buyTime;
      managedQty = openProtect
        ? Math.min(Math.max(managedQty, reconstructed.quantity), reconstructed.quantity, owned)
        : Math.min(reconstructed.quantity, owned);
      residualMode = Boolean(filledExit);
    }
  }

  return {
    active: managedQty > 0,
    openProtect,
    filledExit,
    entryPrice,
    startTime,
    managedQty,
    residualMode,
    reconstructed,
    reason: residualMode ? 'RESIDUAL_RECONSTRUCTED' : 'ACTIVE_MANAGED'
  };
}

module.exports = {
  isOwnedManagedOrder,
  managedTradesOnly,
  remainingOrderQty,
  latestOpenProtection,
  latestFilledExit,
  resolveManagedResidual
};
