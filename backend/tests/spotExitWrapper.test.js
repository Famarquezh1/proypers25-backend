'use strict';
const assert=require('node:assert/strict');
// Import compiles every exact production patch but never starts the runner.
const engine=require('../scripts/github-spot-auto-exit-legacy-v10-aware');
assert.equal(typeof engine.main,'function');
assert.equal(typeof engine.marketSell,'function');
const info={symbol:'TESTUSDT',filters:[{filterType:'PRICE_FILTER',tickSize:'0.01'}]};
const base=engine.protectionParams(info,100,100);
assert(base.stopPrice>0&&base.stopPrice<100);
console.log('spotExitWrapper: production patches compile without running orders');
