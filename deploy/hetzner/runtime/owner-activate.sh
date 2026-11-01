#!/usr/bin/env bash
set -euo pipefail
# OWNER ACTION ONLY. The agent must never execute this script or dispatch its workflow.
test "$(id -u)" = 0
test "${1:-}" = '--activate-core-with-real-money'
runtime_dir=$(dirname "$(readlink -f "$0")")
export CREDENTIALS_DIRECTORY=/etc/proypers25
/usr/bin/node "$runtime_dir/pre-live-check.cjs" --require-ready
/usr/bin/node - "$runtime_dir" <<'JS'
const fs=require('node:fs'),path=require('node:path');
const release=path.basename(path.dirname(process.argv[2]));
const value={version:1,mode:'LIVE_CORE_ONLY',release,strategy:'8d88021dea30eb87f786b5685818d01204d132a3',authorizedAt:new Date().toISOString(),ownerAction:true};
fs.writeFileSync('/etc/proypers25/LIVE_AUTHORIZATION.json',JSON.stringify(value),{mode:0o600});
JS
systemctl stop proypers25-engine.service
systemctl disable proypers25-engine.service
systemctl enable --now proypers25-live.service
systemctl is-active proypers25-live.service
printf '%s\n' 'OWNER_ACTIVATED_LIVE_CORE_ONLY'
