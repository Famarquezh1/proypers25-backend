'use strict';

const {
  getRealSpotConfig,
  validateRealSpotConfig,
  getRealSpotCapitalExposure,
  createRealExecutionIntent,
  placeSpotMarketBuy,
  runRealSpotPreflightCheck
} = require('./binanceSpotRealExecutor');
const { recordConfirmedSpotEntry } = require('./spotPositionLifecycle');

const POSITIONS = 'real_spot_positions';

function diagnostic(candidate, overrides = {}) {
  return {
    approved_candidate: candidate ? {
      id: candidate.id || null,
      symbol: String(candidate.symbol || '').toUpperCase(),
      scan_id: candidate.scan_id || null,
      score: Number(candidate.score ?? candidate.opportunityScore ?? 0),
      category: candidate.category || null
    } : null,
    order_creation_path_reached: false,
    order_created: false,
    rejected_reasons: [],
    ...overrides
  };
}

async function executeApprovedSpotCandidate(db, candidate, options = {}) {
  const started = Date.now();
  const normalizedCandidate = candidate ? {
    ...candidate,
    symbol: String(candidate.symbol || '').toUpperCase(),
    opportunityScore: Number(candidate.opportunityScore ?? candidate.score ?? 0)
  } : null;
  const config = await getRealSpotConfig(db);
  const configValidation = validateRealSpotConfig(config);
  if (!configValidation.valid) return { ok: true, skipped: true, reason: configValidation.reason, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: [configValidation.reason] }) };
  if (!normalizedCandidate?.symbol || !normalizedCandidate.symbol.endsWith('USDT')) return { ok: true, skipped: true, reason: 'APPROVED_CANDIDATE_INVALID', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['APPROVED_CANDIDATE_INVALID'] }) };

  const [openPositions, exposure] = await Promise.all([
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    getRealSpotCapitalExposure(db)
  ]);
  if (openPositions.size >= 1) return { ok: true, skipped: true, reason: 'MAX_OPEN_POSITIONS_REACHED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['MAX_OPEN_POSITIONS_REACHED'] }) };
  if (Number(exposure.total || 0) + 10 > Number(config.max_total_capital_usdt || 10)) return { ok: true, skipped: true, reason: 'TOTAL_CAPITAL_LIMIT_REACHED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['TOTAL_CAPITAL_LIMIT_REACHED'] }) };

  const preflight = await runRealSpotPreflightCheck(db);
  if (preflight.ok !== true || preflight.credentials_valid !== true || preflight.account_accessible !== true) {
    const reason = preflight.error || 'BINANCE_PREFLIGHT_FAILED';
    return { ok: true, skipped: true, reason, preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: [reason] }) };
  }
  if (preflight.can_trade !== true) return { ok: true, skipped: true, reason: 'ACCOUNT_CANNOT_TRADE', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ACCOUNT_CANNOT_TRADE'] }) };
  if (preflight.enable_withdrawals_api_key !== false) return { ok: true, skipped: true, reason: 'WITHDRAWALS_MUST_BE_LOCKED_AT_API_KEY_LEVEL', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['WITHDRAWALS_MUST_BE_LOCKED_AT_API_KEY_LEVEL'] }) };
  if (Number(preflight.usdt_balance_free || 0) < 10) return { ok: true, skipped: true, reason: 'INSUFFICIENT_BINANCE_USDT_BALANCE', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['INSUFFICIENT_BINANCE_USDT_BALANCE'] }) };

  const intent = await createRealExecutionIntent(db, normalizedCandidate, 10, config);
  if (!intent?.id) return { ok: false, skipped: true, reason: 'ENTRY_INTENT_RESERVATION_FAILED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ENTRY_INTENT_RESERVATION_FAILED'] }) };
  if (intent.created === false && intent.status === 'REAL_FILLED') return { ok: true, skipped: true, reason: 'ENTRY_ALREADY_FILLED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ENTRY_ALREADY_FILLED'] }) };

  const order = await placeSpotMarketBuy(normalizedCandidate.symbol, 10, config, preflight, intent.clientOrderId);
  if (!(order.ok === true && (order.order_created === true || order.recovered_existing_order === true))) {
    const reason = order.reason || 'BINANCE_ORDER_NOT_CREATED';
    await db.collection('real_spot_execution_intents').doc(intent.id).set({ status: 'REAL_REJECTED', rejection_reason: reason, updated_at: new Date().toISOString() }, { merge: true });
    return { ok: order.blocked !== false, skipped: true, reason, order, entry_diagnostic: diagnostic(normalizedCandidate, { order_creation_path_reached: true, rejected_reasons: [reason] }) };
  }

  const entry = await recordConfirmedSpotEntry(db, {
    intentId: intent.id,
    candidate: {
      ...normalizedCandidate,
      safety_version: 'real_spot_controlled_v1',
      execution_decision_snapshot: {
        executed_at: new Date().toISOString(),
        source_module: 'approvedSpotRealExecutor',
        validation_reason: 'Paper-to-Real and Technical Confirmation approved this exact candidate',
        promotion_confidence: options.promotion_confidence || null,
        paper_gate: options.paper_gate || null
      }
    },
    config,
    order,
    strategyMetadata: options.strategy_metadata || { strategy: 'CONTROLLED_PAPER_TO_REAL' },
    openedAt: new Date().toISOString()
  });

  if (!entry.idempotent) {
    await db.doc('real_spot_config/control').set({
      entries_used_this_session: Number(config.entries_used_this_session || 0) + 1,
      last_entry_symbol: normalizedCandidate.symbol,
      last_entry_at: new Date().toISOString()
    }, { merge: true });
  }

  return {
    ok: true,
    real_mode: true,
    positions_opened: entry.idempotent ? 0 : 1,
    order_created: !entry.idempotent,
    recovered_existing_order: order.recovered_existing_order === true,
    selected_symbol: normalizedCandidate.symbol,
    symbol: normalizedCandidate.symbol,
    order_id: order.orderId || null,
    intent_id: intent.id,
    position_id: entry.positionId,
    preflight: { credentials_valid: true, account_accessible: true, can_trade: true, withdrawals_locked: true, usdt_balance_free: preflight.usdt_balance_free },
    entry_diagnostic: diagnostic(normalizedCandidate, { order_creation_path_reached: true, order_created: !entry.idempotent }),
    duration_ms: Date.now() - started
  };
}

module.exports = { executeApprovedSpotCandidate, diagnostic };