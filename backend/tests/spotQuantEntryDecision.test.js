'use strict';

const assert = require('assert');
const { evaluateQuantEntryDecision } = require('../services/spotQuantEntryDecision');
const { buildEntrySafetyFailures } = require('../services/spotRealPipelinePolicy');

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
  reconciliation_required: false,
  account_consistent: true,
  quant_entry_min_score: 70,
  quant_entry_min_ev_pct: 0.10,
  quant_entry_reward_pct: 2.5,
  quant_entry_loss_pct: 1.5,
  quant_entry_round_trip_cost_pct: 0.25
};

const crvLikePaperGate = {
  allowed: false,
  selection_lane: 'EARLY_MOMENTUM',
  reasons: [
    'TECHNICAL_TECHNICAL_SCORE_BELOW_THRESHOLD',
    'TECHNICAL_MOVE_OVEREXTENDED',
    'TECHNICAL_VOLUME_NOT_CONFIRMED'
  ],
  candidate: {
    symbol: 'CRVUSDT',
    score: 100,
    opportunityScore: 100,
    selection_lane: 'EARLY_MOMENTUM',
    earlyMomentumScore: 100,
    impulseScore: 92.2,
    liquidityScore: 74.3,
    riskScore: 0,
    earlyMomentum: {
      volume_score: 100,
      structure_score: 100,
      relative_volume_15m: 4.082,
      confirmations: 3,
      valid: true
    }
  },
  validation: { sample_size: 0, positive_rate: 0 },
  technical_confirmation: {
    allowed: false,
    score: 58,
    confirmations: 1,
    required_confirmations: 2,
    reasons: ['TECHNICAL_SCORE_BELOW_THRESHOLD', 'MOVE_OVEREXTENDED', 'VOLUME_NOT_CONFIRMED']
  }
};

const drawdownGate = {
  allowed: false,
  state: 'DEGRADED',
  reasons: ['DRAWDOWN_TOO_HIGH'],
  regime: { regime: 'BULL_TREND' }
};

const quant = evaluateQuantEntryDecision({ paperGate: crvLikePaperGate, adaptiveGate: drawdownGate, config: safeConfig });
assert.strictEqual(quant.allowed, true);
assert(quant.score >= safeConfig.quant_entry_min_score);
assert(quant.expected_value_pct >= safeConfig.quant_entry_min_ev_pct);
assert.strictEqual(quant.hard_reasons.length, 0);
assert(quant.soft_technical_reasons.includes('TECHNICAL_MOVE_OVEREXTENDED'));

const quantWithDefaults = evaluateQuantEntryDecision({ paperGate: crvLikePaperGate, adaptiveGate: drawdownGate, config: {} });
assert.strictEqual(quantWithDefaults.allowed, true);
assert.strictEqual(quantWithDefaults.minimum_score, 72);

const failuresWithOneExistingPosition = buildEntrySafetyFailures({
  reconciliation: { account_consistent: true, entries_blocked: false },
  exits: { ok: true, blocked: false, exit_engine_healthy: true, failures: [] },
  adaptiveGate: { ...drawdownGate },
  paperGate: JSON.parse(JSON.stringify(crvLikePaperGate)),
  autonomy: { should_halt: false },
  config: safeConfig,
  openPositions: 1
});
assert.deepStrictEqual(failuresWithOneExistingPosition, []);

const hardDataFailure = evaluateQuantEntryDecision({
  paperGate: {
    ...crvLikePaperGate,
    reasons: [...crvLikePaperGate.reasons, 'TECHNICAL_DATA_INCOMPLETE']
  },
  adaptiveGate: drawdownGate,
  config: safeConfig
});
assert.strictEqual(hardDataFailure.allowed, false);
assert(hardDataFailure.hard_reasons.includes('TECHNICAL_DATA_INCOMPLETE'));

const nonDrawdownAdaptiveBlock = evaluateQuantEntryDecision({
  paperGate: crvLikePaperGate,
  adaptiveGate: { allowed: false, state: 'DEGRADED', reasons: ['BEAR_REGIME_RISK'] },
  config: safeConfig
});
assert.strictEqual(nonDrawdownAdaptiveBlock.allowed, false);
assert.strictEqual(nonDrawdownAdaptiveBlock.adaptive_compatible, false);

const weakCandidate = evaluateQuantEntryDecision({
  paperGate: {
    ...crvLikePaperGate,
    candidate: {
      ...crvLikePaperGate.candidate,
      score: 62,
      opportunityScore: 62,
      earlyMomentumScore: 58,
      impulseScore: 55,
      liquidityScore: 51,
      earlyMomentum: { volume_score: 50, structure_score: 55 }
    },
    technical_confirmation: { allowed: false, score: 45 },
    reasons: ['TECHNICAL_SCORE_BELOW_THRESHOLD']
  },
  adaptiveGate: drawdownGate,
  config: safeConfig
});
assert.strictEqual(weakCandidate.allowed, false);

console.log('spotQuantEntryDecision tests passed');
