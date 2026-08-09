'use strict';

const assert = require('assert');
const { buildEntrySafetyFailures, buildPromotionConfidence, firstFailureReason } = require('../services/spotRealPipelinePolicy');
const {
  validationEvidenceForSymbol,
  evaluateTacticalMomentumCandidate,
  tacticalThresholds,
  buildCandidateAudit
} = require('../services/paperToRealEntryGate');
const {
  isBotPerformanceResult,
  buildPerformanceClassificationPatch
} = require('../services/spotPerformanceClassification');
const { buildReconciliationControlPatch } = require('../services/spotAccountReconciliation');
const { buildAutonomyControlPatch } = require('../services/spotAutonomyController');

const safeConfig = {
  enabled: true,
  kill_switch: false,
  new_entries_enabled: true,
  auto_order_execution: true,
  real_sells_enabled: true,
  spot_only: true,
  futures_allowed: false,
  margin_allowed: false,
  leverage_allowed: false,
  withdrawals_allowed: false,
  max_position_usdt: 10,
  // Legacy compatibility field. Managed Spot capacity is now governed by the
  // dedicated four-acquisition policy instead of Futures-style position wording.
  max_open_positions: 1,
  reconciliation_required: false,
  account_consistent: true
};

const lowPromotion = buildPromotionConfidence({ allowed: false, state: 'OBSERVE', symbol: 'BTCUSDT', reasons: ['QUANT_CHAMPION_NOT_ELIGIBLE'] });
assert.strictEqual(lowPromotion.indicator_only, true);
assert.strictEqual(lowPromotion.blocks_entry, false);
assert.strictEqual(lowPromotion.high_confidence, false);

const noFailures = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { allowed: true },
  paperGate: { allowed: true },
  autonomy: { should_halt: false },
  config: safeConfig,
  openPositions: 0,
  promotionGate: lowPromotion
});
assert.deepStrictEqual(noFailures, []);

const threeManagedAssets = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { allowed: true },
  paperGate: { allowed: true },
  autonomy: { should_halt: false },
  config: safeConfig,
  openPositions: 3
});
assert.deepStrictEqual(threeManagedAssets, []);

const fourManagedAssets = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { allowed: true },
  paperGate: { allowed: true },
  autonomy: { should_halt: false },
  config: safeConfig,
  openPositions: 4
});
assert(fourManagedAssets.some((item) => item.code === 'MAX_MANAGED_SPOT_ASSETS_REACHED'));

const technicalFailure = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { allowed: true },
  paperGate: { allowed: false, reasons: ['TECHNICAL_VOLUME_NOT_CONFIRMED'] },
  autonomy: { should_halt: false },
  config: safeConfig,
  openPositions: 0
});
assert.strictEqual(technicalFailure[0].component, 'Technical Confirmation');
assert.strictEqual(technicalFailure[0].code, 'TECHNICAL_VOLUME_NOT_CONFIRMED');
assert.strictEqual(firstFailureReason(technicalFailure), 'TECHNICAL_VOLUME_NOT_CONFIRMED');

const configurationFailures = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { allowed: true },
  paperGate: { allowed: true },
  autonomy: { should_halt: false },
  config: { ...safeConfig, max_position_usdt: 11, max_open_positions: 2 },
  openPositions: 0
});
assert(configurationFailures.some((item) => item.code === 'POSITION_LIMIT_MUST_BE_10_USDT'));
assert(!configurationFailures.some((item) => item.code === 'MAX_OPEN_POSITIONS_MUST_BE_1'));

const manualReconciliation = {
  closing_reason: 'MANUAL_RECONCILIATION',
  close_source: 'BINANCE_SPOT_FILLS',
  allocated_capital_usdt: 0.01,
  quote_received_usdt: 9.88,
  net_pnl_usdt: 9.87,
  pnl_verified: true,
  external_spot_sale: true
};
assert.strictEqual(isBotPerformanceResult(manualReconciliation), false);
const manualPatch = buildPerformanceClassificationPatch(manualReconciliation, '2026-08-09T16:00:00.000Z');
assert.strictEqual(manualPatch.performance_excluded, true);
assert.strictEqual(manualPatch.external_conversion, true);

const verifiedBotTimeout = {
  closing_reason: 'TIMEOUT',
  close_source: 'BINANCE_ORDER',
  allocated_capital_usdt: 9.97,
  quote_received_usdt: 9.88,
  net_pnl_usdt: -0.09,
  pnl_verified: true
};
assert.strictEqual(isBotPerformanceResult(verifiedBotTimeout), true);
assert.strictEqual(buildPerformanceClassificationPatch(verifiedBotTimeout).performance_excluded, false);

const unverifiableLegacyRow = {
  closing_reason: 'TIMEOUT',
  net_pnl_usdt: 0
};
assert.strictEqual(isBotPerformanceResult(unverifiableLegacyRow), false);

const healthyOrphanedGate = buildReconciliationControlPatch({
  enabled: true,
  kill_switch: false,
  new_entries_enabled: false,
  entry_block_reason: null
}, 0, '2026-08-09T16:01:00.000Z');
assert.strictEqual(healthyOrphanedGate.new_entries_enabled, true);
assert.strictEqual(healthyOrphanedGate.reconciliation_required, false);
assert.strictEqual(healthyOrphanedGate.account_consistent, true);

const manualPauseGate = buildReconciliationControlPatch({
  enabled: true,
  kill_switch: false,
  new_entries_enabled: false,
  manual_entry_pause: true
}, 0);
assert.strictEqual(manualPauseGate.new_entries_enabled, false);

const otherBlockGate = buildReconciliationControlPatch({
  enabled: true,
  kill_switch: false,
  new_entries_enabled: false,
  entry_block_reason: 'OPERATOR_MAINTENANCE'
}, 0);
assert.strictEqual(otherBlockGate.new_entries_enabled, false);
assert.strictEqual(otherBlockGate.entry_block_reason, 'OPERATOR_MAINTENANCE');

const inconsistentGate = buildReconciliationControlPatch({ enabled: true, kill_switch: false }, 1);
assert.strictEqual(inconsistentGate.new_entries_enabled, false);
assert.strictEqual(inconsistentGate.entry_block_reason, 'ACCOUNT_POSITION_RECONCILIATION_REQUIRED');

const releasedAutonomy = buildAutonomyControlPatch({
  enabled: true,
  kill_switch: true,
  new_entries_enabled: false,
  autonomy_halt_reason: 'THREE_CONSECUTIVE_LOSSES',
  reconciliation_required: false,
  account_consistent: true
}, {
  should_halt: false,
  current_stage: 'CONTROLLED_10_USDT'
}, '2026-08-09T16:02:00.000Z');
assert.strictEqual(releasedAutonomy.kill_switch, false);
assert.strictEqual(releasedAutonomy.new_entries_enabled, true);
assert.strictEqual(releasedAutonomy.autonomy_halt_reason, null);

const protectedManualKill = buildAutonomyControlPatch({
  enabled: true,
  kill_switch: true,
  manual_kill_switch: true,
  new_entries_enabled: false,
  autonomy_halt_reason: 'THREE_CONSECUTIVE_LOSSES'
}, {
  should_halt: false,
  current_stage: 'CONTROLLED_10_USDT'
});
assert.strictEqual(protectedManualKill.kill_switch, undefined);
assert.strictEqual(protectedManualKill.new_entries_enabled, undefined);

const validations = [
  {
    id: 'current_BTCUSDT', scan_id: 'current', symbol: 'BTCUSDT',
    horizons: { h1: { status: 'completed', variation_pct: 4, max_favorable_move_pct: 5, label: '1h' } }
  },
  {
    id: 'old_positive', scan_id: 'old_1', symbol: 'BTCUSDT',
    horizons: {
      h1: { status: 'completed', variation_pct: 2, max_favorable_move_pct: 4, label: '1h' },
      h4: { status: 'completed', variation_pct: 3, max_favorable_move_pct: 6, label: '4h' }
    }
  },
  {
    id: 'old_negative', scan_id: 'old_2', symbol: 'BTCUSDT',
    horizons: { h1: { status: 'completed', variation_pct: -2, max_favorable_move_pct: 1, label: '1h' } }
  }
];
const evidence = validationEvidenceForSymbol(validations, [{ symbol: 'BTCUSDT', estimated_net_pnl_pct: 1.2 }], 'BTCUSDT', 'current');
assert.strictEqual(evidence.historical_validation_documents, 2);
assert.strictEqual(evidence.completed_horizons, 3);
assert.strictEqual(evidence.paper_trades, 1);
assert.strictEqual(evidence.sample_size, 4);
assert.strictEqual(evidence.positive_horizons, 2);
assert.strictEqual(evidence.positive_paper_trades, 1);
assert.strictEqual(evidence.positive_rate, 0.75);
assert.strictEqual(evidence.latest_positive_validation_id, 'old_positive');

const tacticalCandidate = {
  symbol: 'BICOUSDT',
  scan_id: 'current',
  opportunityScore: 76,
  quoteVolume24h: 3500000,
  priceChange24h: 7.4,
  impulseScore: 74,
  liquidityScore: 71,
  riskScore: 32,
  category: 'MOMENTUM',
  warnings: [],
  recommendation: 'WATCH'
};
const tacticalWithoutHistory = evaluateTacticalMomentumCandidate(tacticalCandidate, { sample_size: 0, positive_rate: 0 }, {});
assert.strictEqual(tacticalWithoutHistory.allowed, true);
assert.strictEqual(tacticalThresholds({}).maximum_price_change_24h, 18);
assert.strictEqual(tacticalThresholds({}).minimum_technical_score, 65);

const parabolicCandidate = evaluateTacticalMomentumCandidate({
  ...tacticalCandidate,
  priceChange24h: 31,
  warnings: ['parabolic_24h_move']
}, { sample_size: 0, positive_rate: 0 }, {});
assert.strictEqual(parabolicCandidate.allowed, false);
assert(parabolicCandidate.reasons.includes('TACTICAL_MOVE_ALREADY_EXTENDED'));
assert(parabolicCandidate.reasons.includes('TACTICAL_BLOCKING_WARNING'));

const illiquidCandidate = evaluateTacticalMomentumCandidate({
  ...tacticalCandidate,
  quoteVolume24h: 120000,
  liquidityScore: 35
}, { sample_size: 0, positive_rate: 0 }, {});
assert.strictEqual(illiquidCandidate.allowed, false);
assert(illiquidCandidate.reasons.includes('TACTICAL_LIQUIDITY_VOLUME_TOO_LOW'));

const negativeHistoryCandidate = evaluateTacticalMomentumCandidate(
  tacticalCandidate,
  { sample_size: 4, positive_rate: 0.25 },
  {}
);
assert.strictEqual(negativeHistoryCandidate.allowed, false);
assert(negativeHistoryCandidate.reasons.includes('TACTICAL_EXISTING_EVIDENCE_NEGATIVE'));

const audit = buildCandidateAudit(
  [tacticalCandidate, { ...tacticalCandidate, symbol: 'PUMPUSDT', priceChange24h: 28, warnings: ['parabolic_24h_move'] }],
  [],
  [],
  'current',
  {}
);
assert.strictEqual(audit.length, 2);
assert.strictEqual(audit[0].tactical_allowed, true);
assert.strictEqual(audit[1].tactical_allowed, false);
assert(audit[1].tactical_reasons.includes('TACTICAL_MOVE_ALREADY_EXTENDED'));

console.log('spotRealPipeline tests passed');
