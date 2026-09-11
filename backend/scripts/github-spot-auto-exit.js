'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

function run(script, label) {
  const target = path.join(__dirname, script);
  const result = spawnSync(process.execPath, [target], {
    stdio: 'inherit',
    env: process.env
  });
  if (result.error) {
    console.error(`${label}_SPAWN_ERROR ${result.error.message || result.error}`);
    process.exit(2);
  }
  if (result.status !== 0) {
    console.error(`${label}_FAILED exit=${result.status}`);
    process.exit(result.status || 2);
  }
}

run('github-spot-v61-protect.js', 'V61_PROTECT');
run('github-spot-auto-exit-legacy.js', 'LEGACY_AUTO_EXIT');
console.log('AUTO_EXIT_V61_OK protect_policy=V6.1 legacy_exit_preserved=true');
