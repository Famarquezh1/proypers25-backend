'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = (name) => fs.readFileSync(path.join(__dirname, '../scripts', name), 'utf8');
const entry = read('github-spot-manual-execution-v10-aware.js');
const exit = read('github-spot-auto-exit-legacy.js');

assert.match(exit, /EXIT_SCOPE_INCOMPLETE github_registry_unavailable/, 'managed registry failure must abort incomplete exit scope');
assert.doesNotMatch(entry, /ENTRY_GATE_OPEN_ORDERS_UNAVAILABLE[^\n]{0,200}return \[\]/, 'failed open-orders read must not become empty inventory');
assert.doesNotMatch(entry, /GROWTH_ENGINE_PRICES_UNAVAILABLE[^\n]{0,200}return \[\]/, 'failed price read must not erase portfolio exposure');
assert.doesNotMatch(exit, /issues = await githubRequest\([^\n]+\.catch\(\(\) => \[\]\)/, 'growth ratchet must not silently reset its persisted state on GitHub failure');
console.log('spotCriticalReadContracts tests passed');
