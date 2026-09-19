'use strict';

const DEFAULTS = Object.freeze({
  minNotionalUsdt: 10,
  breakEvenTriggerPct: 0.05,
  breakEvenLockPct: 0.002,
  trailingTriggerPct: 0.08,
  trailingDistancePct: 0.06,
  historyCoverageRatio: 0.95
});

function finite(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function reconstructInventory(trades, baseAsset, quoteAsset = 'USDT') {
  const rows = Array.isArray(trades) ? [...trades] : [];
  rows.sort((a, b) => finite(a.time) - finite(b.time) || finite(a.id) - finite(b.id));

  let quantity = 0;
  let costQuote = 0;
  let startTime = null;

  for (const trade of rows) {
    const qty = finite(trade.qty);
    const quoteQty = finite(trade.quoteQty, qty * finite(trade.price));
    if (!(qty > 0) || !(quoteQty >= 0)) continue;

    const commission = Math.max(0, finite(trade.commission));
    const commissionAsset = String(trade.commissionAsset || '');
    const time = finite(trade.time, Date.now());

    if (trade.isBuyer === true) {
      const acquired = Math.max(0, qty - (commissionAsset === baseAsset ? commission : 0));
      const spend = quoteQty + (commissionAsset === quoteAsset ? commission : 0);
      if (!(acquired > 0) || !(spend > 0)) continue;
      if (!(quantity > 1e-12)) startTime = time;
      quantity += acquired;
      costQuote += spend;
      continue;
    }

    const disposed = qty + (commissionAsset === baseAsset ? commission : 0);
    if (!(disposed > 0) || !(quantity > 0)) continue;
    const average = costQuote / quantity;
    const removed = Math.min(quantity, disposed);
    quantity -= removed;
    costQuote = Math.max(0, costQuote - average * removed);
    if (!(quantity > 1e-12)) {
      quantity = 0;
      costQuote = 0;
      startTime = null;
    }
  }

  return {
    quantity,
    costQuote,
    entryPrice: quantity > 0 ? costQuote / quantity : 0,
    startTime
  };
}

function historyCoversBalance(reconstructedQty, ownedQty, ratio = DEFAULTS.historyCoverageRatio) {
  const owned = finite(ownedQty);
  if (!(owned > 0)) return false;
  return finite(reconstructedQty) + 1e-10 >= owned * ratio;
}

function decideProfitProtection({ entryPrice, currentPrice, recentHigh, tickSize = 0, config = {} }) {
  const cfg = { ...DEFAULTS, ...config };
  const entry = finite(entryPrice);
  const current = finite(currentPrice);
  const high = Math.max(current, finite(recentHigh));
  if (!(entry > 0) || !(current > 0) || !(high > 0)) return { action: 'SKIP', reason: 'INVALID_PRICE' };

  const highGainPct = high / entry - 1;
  const gainPct = current / entry - 1;
  let rawStop = 0;
  let protection = null;

  if (highGainPct >= cfg.trailingTriggerPct) {
    rawStop = high * (1 - cfg.trailingDistancePct);
    protection = 'ORPHAN_TRAILING';
  } else if (highGainPct >= cfg.breakEvenTriggerPct) {
    rawStop = entry * (1 + cfg.breakEvenLockPct);
    protection = 'ORPHAN_BREAK_EVEN';
  } else {
    return { action: 'HOLD_UNARMED', protection: null, gainPct, highGainPct, stopPrice: 0 };
  }

  const step = finite(tickSize);
  const stopPrice = step > 0 ? Math.floor(rawStop / step + 1e-9) * step : rawStop;
  const normalizedStop = Number(stopPrice.toFixed(12));
  return {
    action: current <= normalizedStop ? 'EXIT' : 'PROTECT',
    protection,
    gainPct,
    highGainPct,
    stopPrice: normalizedStop
  };
}


function isOpenSellOrder(order = {}) {
  return String(order.side || '').toUpperCase() === 'SELL' &&
    ['NEW', 'PARTIALLY_FILLED'].includes(String(order.status || '').toUpperCase());
}

function classifyProtectionOrder(order = {}) {
  const id = String(order.clientOrderId || '');
  if (!isOpenSellOrder(order)) return { kind: 'NOT_OPEN_SELL', owned: false, managedBy: null };
  if (id.startsWith('proypers-gh-protect-v61-')) {
    return { kind: 'V61_PROTECTION', owned: true, managedBy: 'V61' };
  }
  if (id.startsWith('proypers-gh-protect-')) {
    return { kind: 'CORE_PROTECTION', owned: true, managedBy: 'CORE' };
  }
  if (id.startsWith('proypers-gh-orphan-')) {
    return { kind: 'ORPHAN_PROTECTION', owned: true, managedBy: 'ORPHAN' };
  }
  const knownOther = [
    'proypers-gh-exit-',
    'proypers-gh-v10-',
    'proypers-gh-',
    'px25b_',
    'px25x_',
    'px25lr_',
    'px25xec_',
    'px25ghxec_'
  ].some((prefix) => id.startsWith(prefix));
  if (knownOther) return { kind: 'PROYPERS_OTHER', owned: true, managedBy: null };
  return { kind: 'MANUAL_OR_UNKNOWN', owned: false, managedBy: null };
}

function isProypersSpotBuyOrder(order = {}) {
  if (String(order.side || '').toUpperCase() !== 'BUY' || String(order.status || '').toUpperCase() !== 'FILLED') return false;
  const id = String(order.clientOrderId || '');
  return id.startsWith('proypers-gh-') || id.startsWith('px25b_');
}

function managedCoreProtectionSymbols(openOrders = []) {
  return [...new Set((Array.isArray(openOrders) ? openOrders : [])
    .filter((order) => {
      const classification = classifyProtectionOrder(order);
      return classification.kind === 'CORE_PROTECTION' || classification.kind === 'V61_PROTECTION';
    })
    .map((order) => String(order.symbol || '').toUpperCase())
    .filter(Boolean))];
}

function protectionInventory(openOrders = []) {
  const rows = (Array.isArray(openOrders) ? openOrders : [])
    .filter(isOpenSellOrder)
    .map((order) => ({ order, classification: classifyProtectionOrder(order) }));
  const core = rows.filter((row) => ['CORE_PROTECTION', 'V61_PROTECTION'].includes(row.classification.kind));
  const orphan = rows.filter((row) => row.classification.kind === 'ORPHAN_PROTECTION');
  const unsafe = rows.filter((row) => !row.classification.owned || row.classification.kind === 'PROYPERS_OTHER');
  return { rows, core, orphan, unsafe };
}

module.exports = {
  DEFAULTS,
  reconstructInventory,
  historyCoversBalance,
  decideProfitProtection,
  isOpenSellOrder,
  classifyProtectionOrder,
  isProypersSpotBuyOrder,
  managedCoreProtectionSymbols,
  protectionInventory
};
