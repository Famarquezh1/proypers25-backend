'use strict';

// Fail closed before evaluating a new Spot entry. Never synthesize a
// successful empty exchange response after a failed inventory/price read.
function assertSpotEntryInventory({ openOrders, allPrices } = {}) {
  if (!Array.isArray(openOrders)) {
    throw new Error('ENTRY_GATE_OPEN_ORDERS_INCOMPLETE');
  }
  if (!Array.isArray(allPrices) || allPrices.length === 0 ||
      !allPrices.every((row) => typeof row?.symbol === 'string' &&
        row.symbol.length > 0 && Number.isFinite(Number(row.price)) &&
        Number(row.price) > 0)) {
    throw new Error('ENTRY_GATE_PRICES_INCOMPLETE');
  }
  return true;
}

module.exports = { assertSpotEntryInventory };
