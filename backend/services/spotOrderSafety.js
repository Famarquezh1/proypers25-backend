'use strict';

const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ACTIVE_STATUSES = new Set(['NEW', 'PARTIALLY_FILLED']);
const LEASE_STALE_MS = Number(process.env.PROYPERS_SPOT_LEASE_STALE_MS || 120000);
const TERMINAL_STATUSES = new Set(['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH']);

function syncDirectory(root) {
  if (process.platform === 'win32') return;
  const fd = fs.openSync(root, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function uncertain(message, cause) {
  return Object.assign(new Error(message, cause ? { cause } : undefined), { code: 'ORDER_OUTCOME_UNCERTAIN' });
}

function journalStore(root = process.env.PROYPERS_SPOT_ORDER_JOURNAL_DIR ||
  path.join(os.homedir(), '.proypers25', 'order-intents')) {
  const fileFor = (symbol) => {
    const key = String(symbol || '').toUpperCase();
    if (!/^[A-Z0-9]+$/.test(key)) throw new Error('INVALID_ORDER_SYMBOL');
    return path.join(root, `${key}.json`);
  };
  const read = (symbol) => {
    try {
      return JSON.parse(fs.readFileSync(fileFor(symbol), 'utf8'));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const replace = (symbol, value) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = fileFor(symbol);
    const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(fd, JSON.stringify(value), 'utf8');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temporary, target);
    syncDirectory(root);
  };

  const leaseFor = (symbol) => fileFor(symbol).replace(/\.json$/, '.lock');
  const acquireLease = (symbol, owner = 'unknown', staleMs = LEASE_STALE_MS) => {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
    const target = leaseFor(symbol);
    const token = crypto.randomUUID();
    const attempt = () => {
      const fd = fs.openSync(target, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({ token, owner, pid: process.pid, host: os.hostname(), acquiredAt: Date.now() }), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    };
    for (let tries = 0; tries < 2; tries += 1) {
      try {
        attempt();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          try {
            if (JSON.parse(fs.readFileSync(target, 'utf8')).token === token) fs.unlinkSync(target);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
        };
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        let age;
        try {
          age = Date.now() - fs.statSync(target).mtimeMs;
        } catch (statError) {
          if (statError.code === 'ENOENT') continue;
          throw statError;
        }
        if (!(age > staleMs)) throw uncertain(`SYMBOL_MUTATION_LEASE_HELD ${symbol}`, error);
        const stale = `${target}.stale.${process.pid}.${crypto.randomBytes(4).toString('hex')}`;
        try { fs.renameSync(target, stale); fs.unlinkSync(stale); } catch (renameError) {
          if (renameError.code !== 'ENOENT') throw renameError;
        }
      }
    }
    throw uncertain(`SYMBOL_MUTATION_LEASE_HELD ${symbol}`);
  };

  return {
    read,
    acquireLease,
    async withLease(symbol, owner, fn) {
      const release = acquireLease(symbol, owner);
      try { return await fn(); } finally { release(); }
    },
    list() {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      return fs.readdirSync(root)
        .filter((name) => /^[A-Z0-9]+\.json$/.test(name))
        .map((name) => read(name.slice(0, -5)))
        .filter(Boolean);
    },
    begin(symbol, intent) {
      fs.mkdirSync(root, { recursive: true, mode: 0o700 });
      const target = fileFor(symbol);
      const existing = read(symbol);
      if (existing && existing.phase !== 'COMPLETE') throw uncertain(`SYMBOL_TRANSITION_PENDING ${symbol}`);
      if (existing) fs.unlinkSync(target);
      let fd;
      try {
        fd = fs.openSync(target, 'wx', 0o600);
      } catch (error) {
        if (error.code === 'EEXIST') throw uncertain(`SYMBOL_TRANSITION_PENDING ${symbol}`, error);
        throw error;
      }
      try {
        fs.writeFileSync(fd, JSON.stringify({ ...intent, symbol: String(symbol).toUpperCase() }), 'utf8');
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      syncDirectory(root);
      return read(symbol);
    },
    update(symbol, intentId, patch) {
      const current = read(symbol);
      if (!current || current.id !== intentId) throw uncertain(`TRANSITION_JOURNAL_CHANGED ${symbol}`);
      const next = { ...current, ...patch, updatedAt: Date.now() };
      replace(symbol, next);
      return next;
    },
    complete(symbol, intentId) {
      const current = read(symbol);
      if (!current || current.id !== intentId) throw uncertain(`TRANSITION_JOURNAL_CHANGED ${symbol}`);
      replace(symbol, { ...current, phase: 'COMPLETE', completedAt: Date.now() });
      fs.unlinkSync(fileFor(symbol));
    }
  };
}

function deterministicClientOrderId(prefix, ...parts) {
  const digest = crypto.createHash('sha256').update(parts.map((part) => String(part ?? '')).join('|')).digest('hex');
  const maxHashLength = Math.max(1, 36 - prefix.length);
  return `${prefix}${digest.slice(0, maxHashLength)}`;
}

function orderMissing(error) {
  return Number(error?.body?.code) === -2013 ||
    /order does not exist|unknown order/i.test(String(error?.message || ''));
}

async function findOrder(send, base, symbol, clientOrderId) {
  try {
    return await send(base, 'GET', '/api/v3/order', { symbol, origClientOrderId: clientOrderId });
  } catch (error) {
    if (orderMissing(error)) return null;
    throw error;
  }
}

async function submitOrder(send, base, params, store, intent) {
  const symbol = String(params.symbol || '').toUpperCase();
  const clientOrderId = String(params.newClientOrderId || '');
  if (!clientOrderId) throw new Error('CLIENT_ORDER_ID_REQUIRED');
  const existing = await findOrder(send, base, symbol, clientOrderId);
  if (existing) {
    if (ACTIVE_STATUSES.has(String(existing.status || '').toUpperCase()) ||
      String(existing.status || '').toUpperCase() === 'FILLED') return existing;
    throw uncertain(`ORDER_ID_ALREADY_TERMINAL ${symbol} ${clientOrderId} ${existing.status}`);
  }

  store.update(symbol, intent.id, {
    phase: 'SUBMIT_INTENT',
    quantity: Number(params.quantity || intent.quantity || 0),
    newClientOrderId: clientOrderId,
    clientOrderIds: [...new Set([...(intent.clientOrderIds || []), clientOrderId])]
  });
  try {
    const order = await send(base, 'POST', '/api/v3/order', params);
    if (!order?.orderId || !ACTIVE_STATUSES.has(String(order.status || '').toUpperCase()) &&
      String(order.status || '').toUpperCase() !== 'FILLED') {
      throw uncertain(`INVALID_ORDER_ACK ${symbol} ${clientOrderId}`);
    }
    store.update(symbol, intent.id, {
      phase: 'ORDER_ACKNOWLEDGED',
      orderIds: [...new Set([...(intent.orderIds || []), String(order.orderId)])],
      lastOrderStatus: String(order.status).toUpperCase()
    });
    return order;
  } catch (error) {
    let order;
    try {
      order = await findOrder(send, base, symbol, clientOrderId);
    } catch (lookupError) {
      throw uncertain(`ORDER_RECONCILIATION_REQUIRED ${symbol} ${clientOrderId}`, lookupError);
    }
    if (order?.orderId) {
      store.update(symbol, intent.id, {
        phase: 'ORDER_RECONCILED',
        orderIds: [...new Set([...(intent.orderIds || []), String(order.orderId)])],
        lastOrderStatus: String(order.status || '').toUpperCase()
      });
      if (ACTIVE_STATUSES.has(String(order.status || '').toUpperCase()) ||
        String(order.status || '').toUpperCase() === 'FILLED') return order;
      throw uncertain(`ORDER_TERMINAL_REQUIRES_REVIEW ${symbol} ${clientOrderId} ${order.status}`);
    }
    throw uncertain(`ORDER_OUTCOME_UNCERTAIN ${symbol} ${clientOrderId}; no retry was sent`, error);
  }
}

async function cancelOrder(send, base, symbol, order, store, intent) {
  store.update(symbol, intent.id, {
    phase: 'CANCEL_INTENT',
    quantity: Number(order.origQty || intent.quantity || 0),
    orderIds: [...new Set([...(intent.orderIds || []), String(order.orderId)])],
    clientOrderIds: [...new Set([...(intent.clientOrderIds || []), String(order.clientOrderId || '')].filter(Boolean))]
  });
  try {
    const result = await send(base, 'DELETE', '/api/v3/order', {
      symbol,
      orderId: String(order.orderId)
    });
    const state = String(result?.status || '').toUpperCase();
    if (state === 'CANCELED' || state === 'EXPIRED') {
      store.update(symbol, intent.id, { phase: 'CANCEL_CONFIRMED', lastOrderStatus: state });
      return true;
    }
    if (state === 'FILLED') {
      store.update(symbol, intent.id, { phase: 'CANCEL_RECONCILED', lastOrderStatus: state });
      return false;
    }
    if (ACTIVE_STATUSES.has(state)) {
      store.update(symbol, intent.id, { phase: 'CANCEL_NOT_APPLIED', lastOrderStatus: state });
      return false;
    }
    throw uncertain(`CANCEL_INVALID_ACK ${symbol} ${order.orderId} ${state}`);
  } catch (error) {
    let status;
    try {
      if (order.clientOrderId) {
        try {
          status = await send(base, 'GET', '/api/v3/order', {
            symbol,
            origClientOrderId: String(order.clientOrderId)
          });
        } catch (lookupError) {
          if (!orderMissing(lookupError)) throw lookupError;
          status = await send(base, 'GET', '/api/v3/order', { symbol, orderId: String(order.orderId) });
        }
      } else {
        status = await send(base, 'GET', '/api/v3/order', { symbol, orderId: String(order.orderId) });
      }
    } catch (lookupError) {
      throw uncertain(`CANCEL_RECONCILIATION_REQUIRED ${symbol} ${order.orderId}`, lookupError);
    }
    const state = String(status?.status || '').toUpperCase();
    if (state === 'CANCELED' || state === 'EXPIRED' || state === 'FILLED') {
      store.update(symbol, intent.id, { phase: 'CANCEL_RECONCILED', lastOrderStatus: state });
      return state !== 'FILLED';
    }
    if (ACTIVE_STATUSES.has(state)) {
      store.update(symbol, intent.id, { phase: 'CANCEL_NOT_APPLIED', lastOrderStatus: state });
      return false;
    }
    throw uncertain(`CANCEL_OUTCOME_UNCERTAIN ${symbol} ${order.orderId}`, error);
  }
}

async function reconcileTransition(record, { getOpenOrders, getOrder, getAccount }) {
  try {
    const [openOrders, account] = await Promise.all([
      getOpenOrders(record.symbol),
      getAccount()
    ]);
    if (!Array.isArray(openOrders) || !Array.isArray(account?.balances)) {
      throw new Error('INVALID_RECONCILIATION_SNAPSHOT');
    }
    const orders = new Map();
    const references = new Map();
    for (const clientOrderId of record.clientOrderIds || []) {
      if (clientOrderId) references.set(`client:${clientOrderId}`, { value: clientOrderId, byOrderId: false });
    }
    const oldProtections = Array.isArray(record.oldProtections)
      ? record.oldProtections
      : record.oldProtection ? [record.oldProtection] : [];
    for (const protection of oldProtections) {
      if (protection.clientOrderId) {
        references.set(`client:${protection.clientOrderId}`, { value: protection.clientOrderId, byOrderId: false });
      } else if (protection.orderId) {
        references.set(`order:${protection.orderId}`, { value: protection.orderId, byOrderId: true });
      }
    }
    for (const orderId of record.orderIds || []) {
      if (orderId) references.set(`order:${orderId}`, { value: orderId, byOrderId: true });
    }
    for (const [key, reference] of references) {
      try {
        const order = await getOrder(record.symbol, reference.value, { byOrderId: reference.byOrderId });
        if (order?.orderId) orders.set(key, order);
      } catch (error) {
        if (!orderMissing(error)) throw error;
      }
    }
    const newOrder = orders.get(`client:${record.newClientOrderId}`);
    const newStatus = String(newOrder?.status || '').toUpperCase();
    const oldIds = new Set(oldProtections.map((order) => String(order.clientOrderId || '')).filter(Boolean));
    const oldOrderIds = new Set(oldProtections.map((order) => String(order.orderId || '')).filter(Boolean));
    const oldOrder = (order) => order.clientOrderId
      ? orders.get(`client:${order.clientOrderId}`)
      : orders.get(`order:${order.orderId}`);
    const activeOrders = openOrders.filter((order) =>
      String(order.side || '').toUpperCase() === 'SELL' &&
      ACTIVE_STATUSES.has(String(order.status || '').toUpperCase()));
    const activeNewProtection = activeOrders.some((order) =>
      String(order.clientOrderId || '') === record.newClientOrderId);
    const activeOldProtection = activeOrders.some((order) =>
      oldIds.has(String(order.clientOrderId || '')) || oldOrderIds.has(String(order.orderId || '')));
    const balance = (account.balances || []).find((row) =>
      String(row.asset || '').toUpperCase() === String(record.baseAsset || '').toUpperCase());
    const total = Number(balance?.free || 0) + Number(balance?.locked || 0);
    const coveredByBalance = (order) => {
      const remaining = Math.max(0, Number(order?.origQty || 0) - Number(order?.executedQty || 0));
      return total > 0 && remaining <= total + Math.max(1e-10, total * 1e-8);
    };

    if (record.intent === 'SELL' && newStatus === 'FILLED') {
      if (activeOrders.length) {
        return { resolved: false, outcome: 'SELL_CONFIRMED_WITH_OPEN_SELL_ORDERS', order: newOrder, balance: total };
      }
      if (Number.isFinite(record.preBalanceQuantity)) {
        const sold = Number(newOrder.executedQty || record.quantity || 0);
        const decrease = record.preBalanceQuantity - total;
        if (sold > 0 && decrease + Math.max(1e-8, sold * 0.1) < Math.min(sold, record.preBalanceQuantity)) {
          return { resolved: false, outcome: 'SELL_BALANCE_NOT_RECONCILED', order: newOrder, balance: total };
        }
      }
      return { resolved: true, outcome: 'SELL_CONFIRMED', order: newOrder, balance: total };
    }
    if (record.intent === 'SELL' && ACTIVE_STATUSES.has(newStatus)) {
      return { resolved: false, outcome: 'SELL_STILL_ACTIVE', order: newOrder, balance: total };
    }
    const activeNewOrder = activeOrders.find((order) =>
      String(order.clientOrderId || '') === record.newClientOrderId);
    const filledOldOrder = oldProtections
      .map(oldOrder)
      .find((order) => String(order?.status || '').toUpperCase() === 'FILLED');
    if (filledOldOrder && activeOrders.length === 0) {
      return { resolved: true, outcome: 'OLD_PROTECTION_FILLED', order: filledOldOrder, balance: total };
    }
    if (activeNewProtection && coveredByBalance(activeNewOrder)) {
      return { resolved: true, outcome: 'NEW_PROTECTION_ACTIVE', order: activeNewOrder, balance: total };
    }
    const activeOldOrder = activeOrders.find((order) =>
      oldIds.has(String(order.clientOrderId || '')) || oldOrderIds.has(String(order.orderId || '')));
    if (activeOldProtection && !ACTIVE_STATUSES.has(newStatus) && newStatus !== 'FILLED' && coveredByBalance(activeOldOrder)) {
      return { resolved: true, outcome: 'OLD_PROTECTION_PRESERVED', order: activeOldOrder, balance: total };
    }
    if (newStatus === 'FILLED' && record.intent !== 'SELL') {
      return { resolved: true, outcome: 'PROTECTIVE_ORDER_FILLED', order: newOrder, balance: total };
    }
    if (TERMINAL_STATUSES.has(newStatus) && newStatus !== 'FILLED' && !activeOldProtection) {
      return { resolved: false, outcome: 'TRANSITION_TERMINAL_WITHOUT_PROTECTION', order: newOrder, balance: total };
    }
    const oldOrdersTerminal = oldProtections.every((order) => {
      const status = String(oldOrder(order)?.status || '').toUpperCase();
      return status === 'CANCELED' || status === 'EXPIRED';
    });
    if ((record.intent === 'PROTECT' || record.intent === 'REPLACE_PROTECTION') &&
      !newOrder && newStatus === '' && activeOrders.length === 0 && oldOrdersTerminal &&
      record.newClientOrderId && Number(record.replacementStopPrice) > 0 &&
      Number(record.quantity) > 0 && total >= Number(record.quantity)) {
      return { resolved: false, recoverable: true, outcome: 'PROTECTION_CAN_BE_RESUMED', balance: total };
    }
    return { resolved: false, outcome: 'TRANSITION_UNRESOLVED', order: newOrder || null, balance: total };
  } catch (error) {
    throw uncertain(`ORDER_RECONCILIATION_REQUIRED ${record.symbol}`, error);
  }
}

function sellableQuantity({ managedQuantity, totalQuantity, lot, price, minimumNotional }) {
  const step = Number(lot?.stepSize || 0);
  if (!(step > 0)) return { quantity: 0, sellable: false, reason: 'LOT_SIZE_MISSING' };
  const precision = String(lot.stepSize).includes('.')
    ? String(lot.stepSize).replace(/0+$/, '').split('.')[1].length
    : 0;
  const quantity = Number((Math.floor((Math.min(Number(managedQuantity) || 0, Number(totalQuantity) || 0) + Number.EPSILON) / step) * step)
    .toFixed(precision));
  if (!(quantity > 0 && quantity >= Number(lot.minQty || 0))) {
    return { quantity, sellable: false, reason: 'BELOW_MINIMUM_QUANTITY' };
  }
  if (Number(minimumNotional) > 0 && quantity * Number(price) < Number(minimumNotional)) {
    return { quantity, sellable: false, reason: 'BELOW_MINIMUM_NOTIONAL' };
  }
  return { quantity, sellable: true, reason: null };
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  journalStore,
  deterministicClientOrderId,
  orderMissing,
  findOrder,
  submitOrder,
  cancelOrder,
  reconcileTransition,
  sellableQuantity,
  uncertain
};
