#!/usr/bin/env bash
set -euo pipefail
source_dir=$1
release_id=$2
if systemctl is-active --quiet proypers25-live.service; then echo 'LIVE_SERVICE_ACTIVE_UPDATE_REFUSED'; exit 2; fi
test ! -f /etc/proypers25/LIVE_AUTHORIZATION.json
test "$(git -C /opt/proypers25/repo rev-parse HEAD)" = '8d88021dea30eb87f786b5685818d01204d132a3'
test -f /etc/proypers25/TRADING_DISABLED
test -f "$source_dir/runtime/managed-context.json"
PROYPERS_CHECK_REPO=/opt/proypers25/repo node --test "$source_dir/runtime/runtime.test.cjs" "$source_dir/runtime/exit-safety.test.cjs" "$source_dir/runtime/cutover-check.test.cjs" "$source_dir/runtime/migration.test.cjs" "$source_dir/runtime/protection-transition.test.cjs" "$source_dir/runtime/candidate.test.cjs"
PROYPERS_CHECK_REPO=/opt/proypers25/repo node "$source_dir/runtime/executor-check.cjs"
PROYPERS_CHECK_REPO=/opt/proypers25/repo node "$source_dir/runtime/lifecycle-check.cjs"
target="/opt/proypers25/releases/$release_id"
install -d -m 0750 -o root -g spot "$target"
cp -R "$source_dir/runtime" "$target/"
chown -R root:spot "$target"
chmod -R g+rX,o-rwx "$target"
chmod 0750 "$target/runtime/owner-activate.sh"
python3 - "$target/runtime" "$release_id" <<'PY'
import pathlib,hashlib,json,sys,datetime
p=pathlib.Path(sys.argv[1])
files=sorted(p.glob('*.cjs'))+[f for f in sorted(p.glob('*.json')) if f.name!='release-evidence.json']+[p/'owner-activate.sh']
(p/'SHA256SUMS').write_text(''.join(hashlib.sha256(f.read_bytes()).hexdigest()+'  '+str(f)+'\n' for f in files))
(p/'release-evidence.json').write_text(json.dumps({'release':sys.argv[2],'offlineChecksPassed':True,'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'realOrdersSent':0}))
PY
chmod 0640 "$target/runtime/SHA256SUMS" "$target/runtime/release-evidence.json"
chown root:spot "$target/runtime/SHA256SUMS" "$target/runtime/release-evidence.json"
ln -sfn "$target/runtime" /opt/proypers25/runtime
install -d -m 0700 -o spot -g spot /var/lib/proypers25
cat >/etc/systemd/system/proypers25-engine.service <<'UNIT'
[Unit]
Description=Proypers25 staged Spot engine (all exchange mutations blocked)
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=1800
StartLimitBurst=3
[Service]
Type=simple
User=spot
Group=spot
WorkingDirectory=/opt/proypers25/repo/backend
Environment=HOME=/var/lib/proypers25
Environment=PROYPERS_STATE_DIR=/var/lib/proypers25
Environment=PROYPERS_REPO=/opt/proypers25/repo
LoadCredential=binance-key:/etc/proypers25/binance-key
LoadCredential=binance-secret:/etc/proypers25/binance-secret
LoadCredential=trading-disabled:/etc/proypers25/TRADING_DISABLED
ExecStart=/usr/bin/node /opt/proypers25/runtime/engine.cjs
Restart=on-failure
RestartSec=60
TimeoutStopSec=20
KillMode=control-group
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/proypers25
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=768M
CPUQuota=75%
TasksMax=64
LimitNOFILE=4096
[Install]
WantedBy=multi-user.target
UNIT
cat >/etc/systemd/system/proypers25-v10.service <<'UNIT'
[Unit]
Description=Proypers25 public-data V10 detector (bounded original calibration)
After=network-online.target
Wants=network-online.target
[Service]
Type=oneshot
User=spot
Group=spot
WorkingDirectory=/opt/proypers25/repo/backend
Environment=HOME=/var/lib/proypers25
Environment=PROYPERS_STATE_DIR=/var/lib/proypers25
Environment=PROYPERS_REPO=/opt/proypers25/repo
EnvironmentFile=/etc/proypers25/v10-release.env
ExecStart=/usr/bin/node /opt/proypers25/runtime/v10-scan.cjs
TimeoutStartSec=260
UMask=0077
NoNewPrivileges=true
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
ReadWritePaths=/var/lib/proypers25
RestrictAddressFamilies=AF_INET AF_UNIX
MemoryMax=512M
CPUQuota=25%
TasksMax=32
KillMode=control-group
UNIT
printf 'PROYPERS_RELEASE_ID=%s\n' "$release_id" >/etc/proypers25/v10-release.env
chmod 0600 /etc/proypers25/v10-release.env
cat >/etc/systemd/system/proypers25-v10.timer <<'UNIT'
[Unit]
Description=Proypers25 V10 scan every 15 minutes
[Timer]
OnCalendar=*-*-* *:07,22,37,52:00 UTC
Persistent=true
Unit=proypers25-v10.service
[Install]
WantedBy=timers.target
UNIT
systemd-analyze verify /etc/systemd/system/proypers25-engine.service
python3 - <<'PY'
from pathlib import Path
s=Path('/etc/systemd/system/proypers25-engine.service').read_text()
s=s.replace('Description=Proypers25 staged Spot engine (all exchange mutations blocked)','Description=Proypers25 owner-activated CORE engine')
s=s.replace('LoadCredential=trading-disabled:/etc/proypers25/TRADING_DISABLED','LoadCredential=live-authorization:/etc/proypers25/LIVE_AUTHORIZATION.json')
s=s.replace('ExecStart=/usr/bin/node /opt/proypers25/runtime/engine.cjs','ExecStart=/usr/bin/node /opt/proypers25/runtime/engine.cjs --candidate')
Path('/etc/systemd/system/proypers25-live.service').write_text(s)
PY
systemd-analyze verify /etc/systemd/system/proypers25-live.service
systemd-analyze verify /etc/systemd/system/proypers25-v10.service /etc/systemd/system/proypers25-v10.timer
systemctl daemon-reload
systemctl reset-failed proypers25-engine.service || true
systemctl enable proypers25-engine.service
systemctl restart proypers25-engine.service
test "$(systemctl is-enabled proypers25-live.service 2>/dev/null || true)" != 'enabled'
test "$(systemctl is-active proypers25-live.service 2>/dev/null || true)" != 'active'
systemctl enable --now proypers25-v10.timer
systemctl start proypers25-v10.service
python3 - "$release_id" <<'PY'
import json,sys
s=json.load(open('/var/lib/proypers25/v10-last.json'))
assert s['release']==sys.argv[1] and s['code']==0 and s['result']['ok'] is True
print('V10_ORIGINAL_DETECTOR_VERIFIED trading_activated=false notify='+str(s['result']['notify']))
PY
printf '%s\n' 'STAGING_ENGINE_INSTALLED trading_activated=false'
