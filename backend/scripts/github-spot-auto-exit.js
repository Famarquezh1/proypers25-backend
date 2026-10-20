'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function execute(script) {
  const target = path.join(__dirname, script);
  return spawnSync(process.execPath, [target], {
    stdio: 'inherit',
    env: process.env
  });
}

let failures = 0;
function run(script, label) {
  const result = execute(script);
  if (result.error || result.status !== 0) {
    failures += 1;
    console.error(`${label}_FAILED exit=${result.status} error=${result.error?.message || ''}`);
  }
}

function runAdvisory(script, label) {
  const result = execute(script);
  if (result.error) {
    failures += 1;
    console.error(`${label}_ADVISORY_ERROR ${result.error.message || result.error}`);
    return;
  }
  if (result.status !== 0) { failures += 1; console.error(`${label}_ADVISORY_FAILED exit=${result.status}`); }
}

run('github-xec-historical-protection.js', 'XEC_HISTORICAL_PROTECT');
run('github-spot-v61-protect.js', 'V61_PROTECT');
run('github-spot-auto-exit-legacy-v10-aware.js', 'LEGACY_AUTO_EXIT');
run('github-spot-orphan-protect.js', 'ORPHAN_BALANCE_PROTECT');
runAdvisory('github-spot-orphan-audit.js', 'ORPHAN_BALANCE_AUDIT');
if (failures) { console.error(`AUTO_EXIT_DEGRADED failures=${failures}`); process.exitCode = 2; }
else console.log('AUTO_EXIT_V61_OK xec_historical_protect=true protect_policy=V6.1 legacy_exit_preserved=true v10_hunter_exit_aligned=true orphan_balance_protect=true orphan_balance_audit=true');
