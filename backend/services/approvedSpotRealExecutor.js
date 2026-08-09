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
const { managedAcquisitionCapacity, MAX_PER_ACQUISITION_USDT } = require('./spotManagedAcquisitionPolicy');

const POSITIONS = 'real_spot_positions';
const HARD_PROTECTED_RESERVE_ASSETS = Object.freeze(['XEC']);

function diagnostic(candidate, overrides = {}) {
  return {
    approved_candidate: candidate ? {
      id: candidate.id || null,
      symbol: String(candidate.symbol || '').toUpperCase(),
      scan_id: candidate.scan_id || null,
      score: Number(candidate.score ?? candidate.opportunityScore ?? 0),
      category: candidate.category || null,
      entry_mode: candidate.entry_mode || null
    } : null,
    order_creation_path_reached: false,
    order_created: false,
    rejected_reasons: [],
    ...overrides
  };
}

function resolveStrategyMetadata(candidate = {}, options = {}) {
  const entryMode = String(candidate.entry_mode || options.paper_gate?.entry_mode || '').toUpperCase();
  const supplied = options.strategy_metadata || {};
  if (entryMode === 'TACTICAL_MOMENTUM') {
    return {
      ...supplied,
      strategy: 'TACTICAL_MOMENTUM',
      decision_reason: supplied.decision_reason || 'Fresh tactical momentum and technical confirmation approved',
      partial_exit: false,
      runner_mode: true,
      minimum_hold_policy: 'WEAKNESS_GRACE_6H',
      entry_mode: 'TACTICAL_MOMENTUM'
    };
  }
  return {
    strategy: supplied.strategy || 'CONTROLLED_PAPER_TO_REAL',
    ...supplied,
    entry_mode: entryMode || 'STANDARD_PAPER_TO_REAL'
  };
}

function isProtectedReserveSymbol(symbol, config = {}) {
  const normalized = String(symbol || '').toUpperCase();
  if (!normalized.endsWith('USDT')) return false;
  const asset = normalized.slice(0, -4);
  const configured = Array.isArray(config.protected_assets)
    ? config.protected_assets.map((value) => String(value || '').toUpperCase())
    : [];
  return HARD_PROTECTED_RESERVE_ASSETS.includes(asset) || configured.includes(asset);
}

function snapshotContainsManagedSymbol(snapshot, symbol) {
  const normalized = String(symbol || '').toUpperCase();
  if (!snapshot?.docs || !normalized) return false;
  return snapshot.docs.some((doc) => String(doc.data()?.symbol || '').toUpperCase() === normalized);
}

async function executeApprovedSpotCandidate(db, candidate, options = {}) {
  const started = Date.now();
  const normalizedCandidate = candidate ? {
    ...candidate,
    symbol: String(candidate.symbol || '').toUpperCase(),
    opportunityScore: Number(candidate.opportunityScore ?? candidate.score ?? 0),
    entry_mode: candidate.entry_mode || options.paper_gate?.entry_mode || null
  } : null;
  const config = await getRealSpotConfig(db);
  const configValidation = validateRealSpotConfig(config);
  if (!configValidation.valid) return { ok: true, skipped: true, reason: configValidation.reason, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: [configValidation.reason] }) };
  if (!normalizedCandidate?.symbol || !normalizedCandidate.symbol.endsWith('USDT')) return { ok: true, skipped: true, reason: 'APPROVED_CANDIDATE_INVALID', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['APPROVED_CANDIDATE_INVALID'] }) };
  if (isProtectedReserveSymbol(normalizedCandidate.symbol, config)) {
    return {
      ok: true,
      skipped: true,
      reason: 'PROTECTED_RESERVE_ASSET',
      entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['PROTECTED_RESERVE_ASSET'] })
    };
  }

  const [managedAcquisitions, exposure] = await Promise.all([
    db.collection(POSITIONS).where('status', '==', 'REAL_OPEN').get(),
    getRealSpotCapitalExposure(db)
  ]);
  const capacity = managedAcquisitionCapacity({
    currentManagedAssets: managedAcquisitions.size,
    currentManagedCapitalUsdt: Number(exposure.total || 0),
    config
  });
  if (managedAcquisitions.size >= capacity.max_managed_spot_assets) {
    return {
      ok: true,
      skipped: true,
      reason: 'MAX_MANAGED_SPOT_ASSETS_REACHED',
      managed_spot_capacity: capacity,
      entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['MAX_MANAGED_SPOT_ASSETS_REACHED'] })
    };
  }
  if (snapshotContainsManagedSymbol(managedAcquisitions, normalizedCandidate.symbol)) {
    return {
      ok: true,
      skipped: true,
      reason: 'ASSET_ALREADY_UNDER_SPOT_MANAGEMENT',
      managed_spot_capacity: capacity,
      entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ASSET_ALREADY_UNDER_SPOT_MANAGEMENT'] })
    };
  }
  if (Number(exposure.total || 0) + MAX_PER_ACQUISITION_USDT > capacity.max_total_managed_capital_usdt) {
    return {
      ok: true,
      skipped: true,
      reason: 'MANAGED_SPOT_CAPITAL_LIMIT_REACHED',
      managed_spot_capacity: capacity,
      entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['MANAGED_SPOT_CAPITAL_LIMIT_REACHED'] })
    };
  }

  const preflight = await runRealSpotPreflightCheck(db);
  if (preflight.ok !== true || preflight.credentials_valid !== true || preflight.account_accessible !== true) {
    const reason = preflight.error || 'BINANCE_PREFLIGHT_FAILED';
    return { ok: true, skipped: true, reason, preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: [reason] }) };
  }
  if (preflight.can_trade !== true) return { ok: true, skipped: true, reason: 'ACCOUNT_CANNOT_TRADE', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ACCOUNT_CANNOT_TRADE'] }) };
  if (preflight.enable_withdrawals_api_key !== false) return { ok: true, skipped: true, reason: 'WITHDRAWALS_MUST_BE_LOCKED_AT_API_KEY_LEVEL', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['WITHDRAWALS_MUST_BE_LOCKED_AT_API_KEY_LEVEL'] }) };
  if (Number(preflight.usdt_balance_free || 0) < MAX_PER_ACQUISITION_USDT) return { ok: true, skipped: true, reason: 'INSUFFICIENT_BINANCE_USDT_BALANCE', preflight, entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['INSUFFICIENT_BINANCE_USDT_BALANCE'] }) };

  const intent = await createRealExecutionIntent(db, normalizedCandidate, MAX_PER_ACQUISITION_USDT, config);
  if (!intent?.id) return { ok: false, skipped: true, reason: 'ENTRY_INTENT_RESERVATION_FAILED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ENTRY_INTENT_RESERVATION_FAILED'] }) };
  if (intent.created === false && intent.status === 'REAL_FILLED') return { ok: true, skipped: true, reason: 'ENTRY_ALREADY_FILLED', entry_diagnostic: diagnostic(normalizedCandidate, { rejected_reasons: ['ENTRY_ALREADY_FILLED'] }) };

  const order = await placeSpotMarketBuy(normalizedCandidate.symbol, MAX_PER_ACQUISITION_USDT, config, preflight, intent.clientOrderId);
  if (!(order.ok === true && (order.order_created === true || order.recovered_existing_order === true))) {
    const reason = order.reason || 'BINANCE_ORDER_NOT_CREATED';
    await db.collection('real_spot_execution_intents').doc(intent.id).set({ status: 'REAL_REJECTED', rejection_reason: reason, updated_at: new Date().toISOString() }, { merge: true });
    return { ok: order.blocked !== false, skipped: true, reason, order, entry_diagnostic: diagnostic(normalizedCandidate, { order_creation_path_reached: true, rejected_reasons: [reason] }) };
  }

  const strategyMetadata = resolveStrategyMetadata(normalizedCandidate, options);
  const entry = await recordConfirmedSpotEntry(db, {
    intentId: intent.id,
    candidate: {
      ...normalizedCandidate,
      safety_version: 'real_spot_controlled_v1',
      execution_decision_snapshot: {
        executed_at: new Date().toISOString(),
        source_module: 'approvedSpotRealExecutor',
        validation_reason: normalizedCandidate.entry_mode === 'TACTICAL_MOMENTUM'
          ? 'Tactical momentum and technical confirmation approved this exact candidate'
          : 'Paper-to-Real and Technical Confirmation approved this exact candidate',
        promotion_confidence: options.promotion_confidence || null,
        paper_gate: options.paper_gate || null,
        entry_mode: normalizedCandidate.entry_mode || null,
        managed_spot_capacity_before_entry: capacity
      }
    },
    config,
    order,
    strategyMetadata,
    openedAt: new Date().toISOString()
  });

  if (!entry.idempotent) {
    await db.doc('real_spot_config/control').set({
      entries_used_this_session: Number(config.entries_used_this_session || 0) + 1,
      max_managed_spot_assets: capacity.max_managed_spot_assets,
      max_managed_spot_capital_usdt: capacity.max_total_managed_capital_usdt,
      managed_spot_terminology_version: capacity.version,
      last_entry_symbol: normalizedCandidate.symbol,
      last_entry_mode: normalizedCandidate.entry_mode || null,
      last_entry_at: new Date().toISOString()
    }, { merge: true });
  }

  return {
    ok: true,
    real_mode: true,
    positions_opened: entry.idempotent ? 0 : 1,
    managed_acquisitions_created: entry.idempotent ? 0 : 1,
    order_created: !entry.idempotent,
    recovered_existing_order: order.recovered_existing_order === true,
    selected_symbol: normalizedCandidate.symbol,
    symbol: normalizedCandidate.symbol,
    entry_mode: normalizedCandidate.entry_mode || null,
    strategy: strategyMetadata.strategy,
    order_id: order.orderId || null,
    intent_id: intent.id,
    position_id: entry.positionId,
    managed_spot_capacity_before_entry: capacity,
    preflight: { credentials_valid: true, account_accessible: true, can_trade: true, withdrawals_locked: true, usdt_balance_free: preflight.usdt_balance_free },
    entry_diagnostic: diagnostic(normalizedCandidate, { order_creation_path_reached: true, order_created: !entry.idempotent }),
    duration_ms: Date.now() - started
  };
}

module.exports = {
  HARD_PROTECTED_RESERVE_ASSETS,
  executeApprovedSpotCandidate,
  diagnostic,
  resolveStrategyMetadata,
  isProtectedReserveSymbol,
  snapshotContainsManagedSymbol
};
