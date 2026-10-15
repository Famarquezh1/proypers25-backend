'use strict';

// Safe static regression: never calls Binance or GitHub or starts the exit runner.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const runner = fs.readFileSync(path.join(root, 'github-spot-auto-exit.js'), 'utf8');
const wrapper = fs.readFileSync(path.join(root, 'github-spot-auto-exit-legacy-v10-aware.js'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'github-spot-auto-exit-legacy.js'), 'utf8');
assert.match(runner, /run\('github-spot-auto-exit-legacy-v10-aware\.js', 'LEGACY_AUTO_EXIT'\)/);
assert.match(wrapper, /github-spot-auto-exit-legacy\.js/);
assert.match(engine, /EXIT_SCOPE_INCOMPLETE github_registry_unavailable/);
assert.match(engine, /EXIT_SCOPE_INCOMPLETE github_registry_missing/);
assert.doesNotMatch(engine, /EXIT_SCOPE_GITHUB_FALLBACK/);
assert.match(engine, /if \(!symbols\.length\)/);
console.log('EXIT_SCOPE_FAIL_CLOSED_REGRESSION_OK');
