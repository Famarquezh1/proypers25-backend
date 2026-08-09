'use strict';

const assert = require('assert');
const { buildEntrySafetyFailures, buildPromotionConfidence, firstFailureReason } = require('../services/spotRealPipelinePolicy');
const {
  validationEvidenceForSymbol,
  evaluateTacticalMomentumCandidate,
  tacticalThresholds,
  buildCandidateAudit
} = require('../services/paperToRealEntryGate');

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
assert(configurationFailures.some((item) => item.code === 'MAX_OPEN_POSITIONS_MUST_BE_1'));

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
