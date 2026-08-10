'use strict';

const assert = require('assert');
const {
  normalizeConfig,
  buildClientId,
  isBalancePureDust,
  convertibleDetailForAsset,
  parseDustConversionResult,
  classifyDustCandidate
} = require('../services/spotDustSweeper');

const config = normalizeConfig({});
assert.strictEqual(config.enabled, true);
assert.strictEqual(config.target_asset, 'USDT');
assert.strictEqual(config.max_residual_value_usdt, 5);
assert.strictEqual(config.require_pure_dust_balance, true);

assert.strictEqual(isBalancePureDust(0.000929, 0.000929, config), true);
assert.strictEqual(isBalancePureDust(0.000929, 1.000929, config), false);

const convertible = {
  details: [
    { asset: 'AAOIB', amountFree: '0.000929', toTargetAssetOffExchange: '0.13' },
    { asset: 'ABC', amountFree: '2', toTargetAssetOffExchange: '0.02' }
  ]
};
assert.strictEqual(convertibleDetailForAsset(convertible, 'aaoib').asset, 'AAOIB');
assert.strictEqual(convertibleDetailForAsset(convertible, 'MISSING'), null);

const parsed = parseDustConversionResult({
  transferResult: [
    {
      tranId: 1001,
      fromAsset: 'AAOIB',
      amount: '0.000929',
      transferedAmount: '0.128',
      serviceChargeAmount: '0.002',
      operateTime: 1786360000000
    }
  ]
}, 'AAOIB');
assert.strictEqual(parsed.converted_quantity, 0.000929);
assert.strictEqual(parsed.received_usdt, 0.128);
assert.strictEqual(parsed.service_charge_usdt, 0.002);
assert.deepStrictEqual(parsed.transaction_ids, [1001]);

const pureBalances = new Map([['AAOIB', { free: 0.000929, locked: 0 }]]);
const eligible = classifyDustCandidate({
  id: 'dust-aaoib',
  asset: 'AAOIB',
  residual_quantity: 0.000929,
  residual_value_usdt: 0.13
}, new Set(), pureBalances, config);
assert.strictEqual(eligible.eligible, true);
assert.strictEqual(eligible.asset, 'AAOIB');

const protectedXec = classifyDustCandidate({
  id: 'dust-xec', asset: 'XEC', residual_quantity: 1000, residual_value_usdt: 0.01
}, new Set(), new Map([['XEC', { free: 1000 }]]), config);
assert.strictEqual(protectedXec.eligible, false);
assert.strictEqual(protectedXec.reason, 'PROTECTED_ASSET');

const managed = classifyDustCandidate({
  id: 'dust-cvx', asset: 'CVX', residual_quantity: 0.01, residual_value_usdt: 0.02
}, new Set(['CVX']), new Map([['CVX', { free: 0.01 }]]), config);
assert.strictEqual(managed.eligible, false);
assert.strictEqual(managed.reason, 'ASSET_CURRENTLY_MANAGED');

const mixedBalance = classifyDustCandidate({
  id: 'dust-aaoib', asset: 'AAOIB', residual_quantity: 0.000929, residual_value_usdt: 0.13
}, new Set(), new Map([['AAOIB', { free: 1.000929 }]]), config);
assert.strictEqual(mixedBalance.eligible, false);
assert.strictEqual(mixedBalance.reason, 'BALANCE_NOT_PURE_DUST');

const tooLarge = classifyDustCandidate({
  id: 'dust-big', asset: 'ABC', residual_quantity: 2, residual_value_usdt: 8
}, new Set(), new Map([['ABC', { free: 2 }]]), config);
assert.strictEqual(tooLarge.eligible, false);
assert.strictEqual(tooLarge.reason, 'RESIDUAL_VALUE_OUTSIDE_SWEEPER_LIMIT');

const id1 = buildClientId({ id: 'dust-aaoib', asset: 'AAOIB', residual_quantity: 0.000929 });
const id2 = buildClientId({ id: 'dust-aaoib', asset: 'AAOIB', residual_quantity: 0.000929 });
assert.strictEqual(id1, id2);
assert.ok(id1.startsWith('px25dust_'));

console.log('spot dust sweeper tests passed');
