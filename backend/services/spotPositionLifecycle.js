'use strict';

// The canonical ledger writer for every real Spot close. Binance (or the
// Binance Convert history) proves the execution; this module makes the
// corresponding Firestore transition idempotent and complete.

const POSITIONS = 'real_spot_positions';
const RESULTS = 'real_spot_execution_results';
const BALANCE_DOC = 'real_spot_config/balance';
const VERSION = 'spot_position_lifecycle_v1';

function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function asIso(value) {
  if (!value) return null;
  if (typeof value.toDate === 'function') return value.toDate().toISOString();
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function closeMetrics(position, { exitPrice, allocatedCapital, netPnl, closedAt, finalScore = null }) {
  const entryPrice = number(position.entry_price);
  const highest = Math.max(entryPrice, number(position.highest_price, entryPrice));
  const lowestCandidate = number(position.lowest_price, entryPrice);
  const lowest = lowestCandidate > 0 ? Math.min(entryPrice, lowestCandidate) : entryPrice;
  const openedAt = asIso(position.opened_at || position.created_at);
  const closedAtIso = asIso(closedAt) || new Date().toISOString();
  const durationMs = openedAt ? Math.max(0, new Date(closedAtIso).getTime() - new Date(openedAt).getTime()) : null;
  const mfePct = entryPrice > 0 ? ((highest / entryPrice) - 1) * 100 : null;
  const maePct = entryPrice > 0 ? ((lowest / entryPrice) - 1) * 100 : null;
  return {
    entry_score: number(position.entry_score ?? position.opportunity_score, null),
    final_score: finalScore === null || finalScore === undefined ? null : number(finalScore, null),
    model_version: position.model_version || position.strategy_version || position.safety_version || null,
    decision_quality: position.decision_quality || position.execution_decision_snapshot?.validation_reason || null,
    market_regime: position.market_regime || position.execution_decision_snapshot?.market_regime || null,
    opened_at: openedAt,
    closed_at: closedAtIso,
    duration_ms: durationMs,
    duration_hours: durationMs === null ? null : Number((durationMs / 3600000).toFixed(6)),
    mfe_pct: mfePct === null ? null : Number(mfePct.toFixed(6)),
    mae_pct: maePct === null ? null : Number(maePct.toFixed(6)),
    exit_price: number(exitPrice),
    allocated_capital_usdt: number(allocatedCapital),
    net_pnl_usdt: netPnl === null || netPnl === undefined ? null : number(netPnl)
  };
}

/**
 * Persist a confirmed full or partial close exactly once.
 * `eventId` must identify the Binance order/conversion. It is intentionally
 * deterministic so retries, scheduler overlap and process restarts are safe.
 */
async function recordConfirmedSpotClose(db, {
  positionRef,
  position,
  eventId,
  reason,
  source,
  executedQuantity,
  quoteReceivedUsdt,
  exitPrice,
  feeUsdt = 0,
  finalScore = null,
  pnlVerified = true,
  order = null,
  metadata = {},
  expectedClaimId = null,
  closedAt = new Date().toISOString()
}) {
  if (!db || !positionRef || !position?.id || !eventId || !reason || !source) {
    throw new Error('INVALID_SPOT_CLOSE_EVENT');
  }

  const resultRef = db.collection(RESULTS).doc(`real_spot_result_${position.id}_${eventId}`);
  const balanceRef = db.doc(BALANCE_DOC);
  const qty = Math.max(0, number(executedQuantity));
  const quote = Math.max(0, number(quoteReceivedUsdt));

  return db.runTransaction(async (tx) => {
    const [positionSnap, resultSnap, balanceSnap] = await Promise.all([
      tx.get(positionRef), tx.get(resultRef), tx.get(balanceRef)
    ]);
    if (resultSnap.exists) return { idempotent: true, resultId: resultRef.id };
    if (!positionSnap.exists) throw new Error('POSITION_NOT_FOUND');

    const latest = { id: positionSnap.id, ...positionSnap.data() };
    if (latest.status !== 'REAL_OPEN') {
      return { idempotent: true, skipped: 'POSITION_NOT_OPEN', resultId: resultRef.id };
    }
    if (expectedClaimId && latest.exit_claim_id !== expectedClaimId) {
      throw new Error('EXIT_CLAIM_LOST');
    }

    const originalQty = Math.max(0, number(latest.quantity));
    if (!(qty > 0) || !(originalQty > 0)) throw new Error('CLOSE_QUANTITY_INVALID');
    const effectiveQty = Math.min(originalQty, qty);
    const soldFraction = Math.min(1, effectiveQty / originalQty);
    const originalCapital = Math.max(0, number(latest.capital_usdt));
    const allocatedCapital = originalCapital * soldFraction;
    const grossPnl = quote - allocatedCapital;
    const netPnl = pnlVerified ? grossPnl - Math.max(0, number(feeUsdt)) : null;
    const fullyClosed = soldFraction >= 0.999999;
    const metrics = closeMetrics(latest, { exitPrice, allocatedCapital, netPnl, closedAt, finalScore });
    const balance = balanceSnap.exists ? balanceSnap.data() : {};

    const positionUpdate = fullyClosed ? {
      status: 'REAL_CLOSED',
      exit_status: source === 'BINANCE_ORDER' ? 'EXIT_FILLED' : 'RECONCILED',
      closing_reason: reason,
      close_source: source,
      closed_at: metrics.closed_at,
      exit_price: metrics.exit_price,
      pnl_usdt: netPnl,
      remaining_quantity: 0,
      sold_quantity: effectiveQty,
      quote_received_usdt: quote,
      exit_event_id: eventId,
      lifecycle_version: VERSION,
      ...metadata
    } : {
      quantity: Math.max(0, originalQty - effectiveQty),
      capital_usdt: Math.max(0, originalCapital - allocatedCapital),
      exit_status: 'PARTIAL_EXIT_FILLED',
      last_partial_exit_at: metrics.closed_at,
      last_partial_exit_reason: reason,
      last_partial_exit_source: source,
      last_partial_exit_event_id: eventId,
      lifecycle_version: VERSION,
      ...metadata
    };
    tx.update(positionRef, positionUpdate);
    tx.set(resultRef, {
      id: resultRef.id,
      position_id: position.id,
      symbol: latest.symbol || position.symbol || null,
      reason,
      closing_reason: reason,
      close_source: source,
      fully_closed: fullyClosed,
      quantity: effectiveQty,
      quote_received_usdt: quote,
      gross_pnl_usdt: grossPnl,
      actual_fee_usdt: Math.max(0, number(feeUsdt)),
      net_pnl_usdt: netPnl,
      net_pnl_pct: pnlVerified && allocatedCapital > 0 ? (netPnl / allocatedCapital) * 100 : null,
      pnl_verified: pnlVerified,
      order_id: order?.orderId || order?.order_id || null,
      client_order_id: order?.clientOrderId || order?.client_order_id || null,
      order_status: order?.status || null,
      real_mode: true,
      spot_only: true,
      lifecycle_version: VERSION,
      ...metrics,
      ...metadata
    });
    tx.set(balanceRef, {
      available_usdt: number(balance.available_usdt) + quote,
      in_positions_usdt: Math.max(0, number(balance.in_positions_usdt) - allocatedCapital),
      realized_pnl_usdt: number(balance.realized_pnl_usdt) + (pnlVerified ? netPnl : 0),
      updated_at: metrics.closed_at,
      source: 'SPOT_LIFECYCLE_CONFIRMED'
    }, { merge: true });
    return { idempotent: false, resultId: resultRef.id, fullyClosed, allocatedCapital, netPnl, metrics };
  });
}

module.exports = { VERSION, number, closeMetrics, recordConfirmedSpotClose };
