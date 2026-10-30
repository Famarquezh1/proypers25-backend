'use strict';

const crypto = require('crypto');

const COLLECTION = 'spot_execution_leases';
const DEFAULT_LEASE_MS = 30000;

function accountScope(accountId) {
  if (typeof accountId !== 'string' || !accountId.trim()) throw new Error('SPOT_COORDINATION_ACCOUNT_REQUIRED');
  return crypto.createHash('sha256').update(accountId.trim()).digest('hex');
}

function leaseDocumentId(accountId, symbol) {
  const normalizedSymbol = String(symbol || '').toUpperCase();
  if (!/^[A-Z0-9]+$/.test(normalizedSymbol)) throw new Error('SPOT_COORDINATION_SYMBOL_REQUIRED');
  return crypto.createHash('sha256')
    .update(`${accountScope(accountId)}|${normalizedSymbol}`)
    .digest('hex');
}

function createSpotExecutionCoordinator(db, options = {}) {
  if (!db || typeof db.collection !== 'function' || typeof db.runTransaction !== 'function') {
    throw new Error('SPOT_COORDINATION_FIRESTORE_REQUIRED');
  }
  const now = options.now || Date.now;
  const leaseMs = Number(options.leaseMs || DEFAULT_LEASE_MS);
  const ownerId = options.ownerId || crypto.randomUUID();

  function refFor(accountId, symbol) {
    return db.collection(COLLECTION).doc(leaseDocumentId(accountId, symbol));
  }

  async function acquire(accountId, symbol, intentId, metadata = {}) {
    if (typeof intentId !== 'string' || !intentId.trim()) throw new Error('SPOT_COORDINATION_INTENT_REQUIRED');
    const ref = refFor(accountId, symbol);
    const timestamp = now();
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : {};
      if (current.state === 'AMBIGUOUS') {
        return { acquired: false, reason: 'SPOT_SYMBOL_AMBIGUOUS', fencingToken: current.fencingToken };
      }
      if (current.owner && Number(current.expiresAt || 0) > timestamp) {
        return { acquired: false, reason: 'SPOT_SYMBOL_BUSY', fencingToken: current.fencingToken };
      }
      if (current.phase === 'MUTATING') {
        tx.set(ref, {
          ...current,
          state: 'AMBIGUOUS',
          ambiguousAt: timestamp,
          ambiguityReason: 'EXPIRED_MUTATION_LEASE'
        }, { merge: true });
        return { acquired: false, reason: 'SPOT_SYMBOL_AMBIGUOUS', fencingToken: current.fencingToken };
      }
      const fencingToken = Number(current.fencingToken || 0) + 1;
      tx.set(ref, {
        accountScope: accountScope(accountId),
        symbol: String(symbol).toUpperCase(),
        state: 'ACTIVE',
        owner: ownerId,
        fencingToken,
        phase: 'ACQUIRED',
        intentId: intentId.trim(),
        clientOrderId: String(metadata.clientOrderId || intentId).slice(0, 36),
        side: String(metadata.side || ''),
        orderType: String(metadata.type || ''),
        quantity: Number(metadata.quantity || metadata.quoteOrderQty || 0),
        acquiredAt: timestamp,
        expiresAt: timestamp + leaseMs,
        updatedAt: timestamp
      }, { merge: true });
      return { acquired: true, ref, owner: ownerId, fencingToken, symbol: String(symbol).toUpperCase(), intentId: intentId.trim() };
    });
  }

  async function updateOwned(lease, patch) {
    if (!lease?.ref || lease.owner !== ownerId || !Number.isFinite(Number(lease.fencingToken))) {
      throw new Error('SPOT_LEASE_TOKEN_INVALID');
    }
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(lease.ref);
      const current = snap.exists ? snap.data() : {};
      if (current.owner !== ownerId || Number(current.fencingToken) !== Number(lease.fencingToken) ||
        current.state !== 'ACTIVE' || Number(current.expiresAt || 0) <= now()) {
        throw new Error('SPOT_LEASE_FENCE_REJECTED');
      }
      tx.set(lease.ref, { ...patch, updatedAt: now() }, { merge: true });
      return true;
    });
  }

  async function beginMutation(lease) {
    await updateOwned(lease, { phase: 'MUTATING', mutationStartedAt: now() });
  }

  async function release(lease, evidence = {}) {
    if (!lease?.ref || lease.owner !== ownerId || !Number.isFinite(Number(lease.fencingToken))) {
      throw new Error('SPOT_LEASE_TOKEN_INVALID');
    }
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(lease.ref);
      const current = snap.exists ? snap.data() : {};
      if (current.owner !== ownerId || Number(current.fencingToken) !== Number(lease.fencingToken) ||
        current.state !== 'ACTIVE') {
        throw new Error('SPOT_LEASE_FENCE_REJECTED');
      }
      tx.set(lease.ref, {
        state: 'IDLE',
        owner: null,
        phase: 'IDLE',
        expiresAt: 0,
        lastOrderId: String(evidence.orderId || ''),
        lastOrderStatus: String(evidence.status || ''),
        releasedAt: now(),
        updatedAt: now()
      }, { merge: true });
      return true;
    });
  }

  async function markAmbiguous(lease, reason) {
    if (!lease?.ref || lease.owner !== ownerId) return false;
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(lease.ref);
      const current = snap.exists ? snap.data() : {};
      if (current.owner !== ownerId || Number(current.fencingToken) !== Number(lease.fencingToken)) return false;
      tx.set(lease.ref, {
        state: 'AMBIGUOUS',
        phase: 'MUTATING',
        ambiguousAt: now(),
        ambiguityReason: String(reason || 'MUTATION_OUTCOME_UNKNOWN').slice(0, 160),
        updatedAt: now()
      }, { merge: true });
      return true;
    });
  }

  async function resolveAmbiguous(accountId, symbol, expectedIntentId, evidence) {
    const status = String(evidence?.status || '').toUpperCase();
    const terminal = ['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(status);
    const confirmedProtection = ['NEW', 'PARTIALLY_FILLED'].includes(status) &&
      String(evidence?.side || '').toUpperCase() === 'SELL' &&
      String(evidence?.type || '').toUpperCase().includes('STOP');
    if (evidence?.orderFound !== true || (!terminal && !confirmedProtection)) {
      return false;
    }
    const ref = refFor(accountId, symbol);
    return db.runTransaction(async (tx) => {
      const snap = await tx.get(ref);
      const current = snap.exists ? snap.data() : {};
      if (current.state !== 'AMBIGUOUS' || current.intentId !== String(expectedIntentId || '')) return false;
      tx.set(ref, {
        state: 'IDLE',
        owner: null,
        phase: 'IDLE',
        expiresAt: 0,
        resolvedAt: now(),
        resolutionOrderStatus: status,
        resolutionOrderId: String(evidence.orderId || ''),
        updatedAt: now()
      }, { merge: true });
      return true;
    });
  }

  async function withMutation(accountId, symbol, intentId, operation, metadata = {}, preflight = null) {
    const lease = await acquire(accountId, symbol, intentId, metadata);
    if (!lease.acquired) {
      const error = new Error(lease.reason);
      error.code = lease.reason;
      error.fencingToken = lease.fencingToken;
      throw error;
    }
    let mutationStarted = false;
    try {
      if (preflight) await preflight();
      await beginMutation(lease);
      mutationStarted = true;
      const result = await operation({
        fencingToken: lease.fencingToken,
        assertCurrent: () => updateOwned(lease, { phase: 'MUTATING', lastFenceCheckAt: now() })
      });
      const marketOrderUnsettled = String(metadata.type || '').toUpperCase() === 'MARKET' &&
        !['FILLED', 'CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(String(result?.status || '').toUpperCase());
      if (marketOrderUnsettled) await markAmbiguous(lease, 'MARKET_ORDER_REQUIRES_TERMINAL_RECONCILIATION');
      else await release(lease, result);
      return result;
    } catch (error) {
      if (mutationStarted) await markAmbiguous(lease, error.code || error.message);
      else await release(lease);
      throw error;
    }
  }

  return { acquire, beginMutation, release, markAmbiguous, resolveAmbiguous, withMutation };
}

async function withLocalSpotMutation(accountId, symbol, intentId, operation, options = {}) {
  if (typeof accountId !== 'string' || !accountId.trim()) {
    const blocked = new Error('SPOT_COORDINATION_ACCOUNT_REQUIRED');
    blocked.code = 'SPOT_COORDINATION_ACCOUNT_REQUIRED';
    throw blocked;
  }
  let db;
  try {
    db = options.db || require('../firebase-admin-config');
  } catch (error) {
    const blocked = new Error(`SPOT_COORDINATION_UNAVAILABLE: ${error.message}`);
    blocked.code = 'SPOT_COORDINATION_UNAVAILABLE';
    throw blocked;
  }
  const coordinator = createSpotExecutionCoordinator(db, options);
  if (options.findExisting) {
    const existing = await options.findExisting();
    if (existing) {
      if (String(existing.clientOrderId || '') !== String(intentId) ||
        String(existing.side || '').toUpperCase() !== String(options.metadata?.side || '').toUpperCase()) {
        throw new Error('SPOT_ORDER_IDEMPOTENCY_CONFLICT');
      }
      if (['CANCELED', 'EXPIRED', 'REJECTED', 'EXPIRED_IN_MATCH'].includes(String(existing.status || '').toUpperCase())) {
        throw new Error(`SPOT_ORDER_IDEMPOTENCY_TERMINAL:${existing.status}`);
      }
      return existing;
    }
  }
  return coordinator.withMutation(accountId, symbol, intentId, operation, options.metadata);
}

async function resolveLocalSpotMutation(accountId, symbol, intentId, evidence, options = {}) {
  if (typeof accountId !== 'string' || !accountId.trim()) return false;
  let db;
  try {
    db = options.db || require('../firebase-admin-config');
  } catch (_) {
    return false;
  }
  return createSpotExecutionCoordinator(db, options)
    .resolveAmbiguous(accountId, symbol, intentId, evidence);
}

module.exports = {
  COLLECTION,
  DEFAULT_LEASE_MS,
  accountScope,
  leaseDocumentId,
  createSpotExecutionCoordinator,
  withLocalSpotMutation,
  resolveLocalSpotMutation
};
