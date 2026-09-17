'use strict';

const assert = require('assert');
const {
  classifySpotAsset,
  buildSpotAssetRiskPolicy,
  LEVERAGED_MAX_ENTRY_USDT,
  LEVERAGED_MIN_OPPORTUNITY_SCORE
} = require('../services/spotAssetClassification');

const leveraged2x = classifySpotAsset('SNXXBUSDT');
assert.strictEqual(leveraged2x.asset_class, 'LEVERAGED_TOKENIZED_SECURITY');
assert.strictEqual(leveraged2x.product_family, 'BSTOCK');
assert.strictEqual(leveraged2x.is_leveraged, true);
assert.strictEqual(leveraged2x.leverage_multiple, 2);
assert.strictEqual(leveraged2x.direction, 'LONG');
assert.strictEqual(leveraged2x.max_entry_usdt, 5);

const ordinaryBstock = classifySpotAsset('SNDKBUSDT');
assert.strictEqual(ordinaryBstock.asset_class, 'TOKENIZED_SECURITY');
assert.strictEqual(ordinaryBstock.is_leveraged, false);
assert.strictEqual(ordinaryBstock.max_entry_usdt, null);

// MUB is intentionally covered because it is a bStock whose symbol does not end in B.
const mub = classifySpotAsset('MUBUSDT');
assert.strictEqual(mub.asset_class, 'TOKENIZED_SECURITY');
assert.strictEqual(mub.product_family, 'BSTOCK');

const genericCrypto = classifySpotAsset('BOMEUSDT');
assert.strictEqual(genericCrypto.asset_class, 'UNCLASSIFIED_SPOT');
assert.strictEqual(genericCrypto.is_tokenized_security, false);

const allowed2x = buildSpotAssetRiskPolicy({
  symbol: 'SNXXBUSDT',
  requestedEntryUsdt: 15,
  candidate: { opportunityScore: LEVERAGED_MIN_OPPORTUNITY_SCORE }
});
assert.strictEqual(allowed2x.entry_allowed, true);
assert.strictEqual(allowed2x.capped_entry_usdt, LEVERAGED_MAX_ENTRY_USDT);

const weak2x = buildSpotAssetRiskPolicy({
  symbol: 'SNXXBUSDT',
  requestedEntryUsdt: 15,
  candidate: { opportunityScore: LEVERAGED_MIN_OPPORTUNITY_SCORE - 1 }
});
assert.strictEqual(weak2x.entry_allowed, false);
assert.strictEqual(weak2x.blocker, 'LEVERAGED_TOKENIZED_SECURITY_SCORE_BELOW_MINIMUM');

const leveraged3x = buildSpotAssetRiskPolicy({
  symbol: 'SOXSBUSDT',
  requestedEntryUsdt: 20,
  candidate: { opportunityScore: 95 }
});
assert.strictEqual(leveraged3x.classification.leverage_multiple, 3);
assert.strictEqual(leveraged3x.classification.direction, 'SHORT');
assert.strictEqual(leveraged3x.capped_entry_usdt, 5);

const normalPolicy = buildSpotAssetRiskPolicy({
  symbol: 'BOMEUSDT',
  requestedEntryUsdt: 14.75,
  candidate: { opportunityScore: 75 }
});
assert.strictEqual(normalPolicy.entry_allowed, true);
assert.strictEqual(normalPolicy.capped_entry_usdt, 14.75);

console.log('spotAssetClassification.test.js PASS');
