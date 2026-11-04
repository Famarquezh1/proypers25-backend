#!/usr/bin/env bash
set -euo pipefail
RELEASE=${1:?release required}
[[ "$RELEASE" =~ ^[a-f0-9]{40}$ ]]
BASE=/opt/proypers25/research
TARGET=/opt/proypers25/research-releases/$RELEASE
systemctl is-active --quiet proypers25-live.service
LIVE_PID=$(systemctl show proypers25-live.service -p MainPID --value)
OLD=$(readlink "$BASE" || true)
install -d -m 0750 -o root -g spot "$TARGET"
tar -xzf /home/deploy/research-release.tgz -C "$TARGET"
chown -R root:spot "$TARGET"
chmod 0640 "$TARGET"/*
(cd "$TARGET" && sha256sum --status -c SHA256SUMS)
node --check "$TARGET/collector.cjs"
node --test "$TARGET/collector.test.cjs"
node -e 'require(process.argv[1]).validate(JSON.parse(require("fs").readFileSync(process.argv[2])))' "$TARGET/collector.cjs" "$TARGET/proposals.json"
install -d -m 0700 -o spot -g spot /var/lib/proypers25/research
rollback() {
  systemctl stop proypers25-research.timer proypers25-research.service || true
  if [[ -n "$OLD" ]]; then ln -sfn "$OLD" "$BASE"; systemctl start proypers25-research.timer; fi
  echo RESEARCH_DEPLOY_FAILED_LIVE_UNCHANGED
}
trap rollback ERR
systemctl stop proypers25-research.timer proypers25-research.service 2>/dev/null || true
ln -sfn "$TARGET" "$BASE"
cat > /etc/systemd/system/proypers25-research.service <<'UNIT'
[Unit]
Description=Proypers25 bounded public-data research collector
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=spot
Group=spot
WorkingDirectory=/opt/proypers25/research
ExecStart=/usr/bin/node /opt/proypers25/research/collector.cjs
TimeoutStartSec=150
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
ReadOnlyPaths=/var/lib/proypers25
ReadWritePaths=/var/lib/proypers25/research
InaccessiblePaths=/etc/proypers25 /run/credentials
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
MemoryMax=192M
CPUQuota=15%
TasksMax=24
UNIT
cat > /etc/systemd/system/proypers25-research.timer <<'UNIT'
[Unit]
Description=Collect Proypers25 research evidence every five minutes through November 15 UTC
[Timer]
OnCalendar=2026-11-04..15 *:0/5:00 UTC
AccuracySec=10s
RandomizedDelaySec=10
Persistent=true
[Install]
WantedBy=timers.target
UNIT
systemd-analyze verify /etc/systemd/system/proypers25-research.service /etc/systemd/system/proypers25-research.timer
systemctl daemon-reload
systemctl reset-failed proypers25-research.service || true
systemctl start proypers25-research.service
test "$(systemctl show proypers25-research.service -p Result --value)" = success
node - <<'JS'
const fs=require('node:fs'),h=JSON.parse(fs.readFileSync('/var/lib/proypers25/research/health.json'));
if(!h.ok||Date.now()-Date.parse(h.at)>180000)throw Error('RESEARCH_HEALTH_STALE');
console.log('RESEARCH_INITIAL_CYCLE_VERIFIED',JSON.stringify(h));
JS
systemctl enable --now proypers25-research.timer
systemctl is-active --quiet proypers25-research.timer
test "$(systemctl show proypers25-live.service -p MainPID --value)" = "$LIVE_PID"
systemctl is-active --quiet proypers25-live.service
trap - ERR
echo 'RESEARCH_DEPLOYED public_get_only=true live_restarted=false'
cat /var/lib/proypers25/research/report.json
