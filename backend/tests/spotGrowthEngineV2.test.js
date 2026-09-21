'use strict';

const assert = require('assert');
const { growthRatchet, pyramidDecision, parseGrowthState, growthStateBody } = require('../services/spotGrowthEngineV2');

const pre = growthRatchet({ equityUsdt: 559, previousHwmUsdt: 559, activated: false });
assert.strictEqual(pre.activated, false);
assert.strictEqual(pre.size_multiplier, 1);

const crossed = growthRatchet({ equityUsdt: 605, previousHwmUsdt: 599, activated: false });
assert.strictEqual(crossed.activated, true);
assert.strictEqual(crossed.hwm_usdt, 605);

const dd = growthRatchet({ equityUsdt: 575, previousHwmUsdt: 605, activated: true });
assert.strictEqual(dd.activated, true);
assert.strictEqual(dd.size_multiplier, 0.75);

const blocked = growthRatchet({ equityUsdt: 550, previousHwmUsdt: 605, activated: true });
assert.strictEqual(blocked.size_multiplier, 0);

const eligible = pyramidDecision({
  lane:'CORE', symbol:'ABCUSDT', isLeveraged:false, hasAddOn:false, hasFilledExit:false,
  hasNativeProtection:true, historyCoversOwned:true, ageHours:2, currentGainPct:0.07, mfePct:0.09,
  pullbackFromHighPct:0.018, currentPrice:109, nativeStopPrice:104, initialCostUsdt:60,
  currentPositionValueUsdt:64.2, equityUsdt:600, usdtFree:300, cashReserveUsdt:120, ratchetMultiplier:1
});
assert.strictEqual(eligible.allow, true);
assert.strictEqual(eligible.quote_order_qty, 10.79);

const loss = pyramidDecision({
  lane:'CORE', symbol:'ABCUSDT', hasNativeProtection:true, historyCoversOwned:true,
  currentGainPct:-0.01, mfePct:0.09, currentPrice:99, nativeStopPrice:95,
  initialCostUsdt:60, currentPositionValueUsdt:59, equityUsdt:600, usdtFree:300, cashReserveUsdt:120
});
assert.strictEqual(loss.allow, false);

const second = pyramidDecision({
  lane:'CORE', symbol:'ABCUSDT', hasAddOn:true, hasNativeProtection:true, historyCoversOwned:true,
  currentGainPct:0.10, mfePct:0.12, currentPrice:112, nativeStopPrice:106,
  initialCostUsdt:60, currentPositionValueUsdt:66, equityUsdt:600, usdtFree:300, cashReserveUsdt:120
});
assert.strictEqual(second.reason, 'MAX_ADDS_REACHED');

const body = growthStateBody({hwm_usdt:605,activated:true,updated_at:'2026-09-21T00:00:00Z'});
const parsed = parseGrowthState(body);
assert.strictEqual(parsed.hwm_usdt, 605);
assert.strictEqual(parsed.activated, true);

console.log('spotGrowthEngineV2 tests passed');
