#!/usr/bin/env bash
set -euo pipefail
source_dir=$1
release_id=$2
test "$(git -C /opt/proypers25/repo rev-parse HEAD)" = '8d88021dea30eb87f786b5685818d01204d132a3'
test -f /etc/proypers25/TRADING_DISABLED
test -f "$source_dir/runtime/managed-context.json"
PROYPERS_CHECK_REPO=/opt/proypers25/repo node --test "$source_dir/runtime/runtime.test.cjs"
PROYPERS_CHECK_REPO=/opt/proypers25/repo node "$source_dir/runtime/executor-check.cjs"
target="/opt/proypers25/releases/$release_id"
install -d -m 0750 -o root -g spot "$target"
cp -R "$source_dir/runtime" "$target/"
chown -R root:spot "$target"
chmod -R g+rX,o-rwx "$target"
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
systemd-analyze verify /etc/systemd/system/proypers25-engine.service
systemctl daemon-reload
systemctl reset-failed proypers25-engine.service || true
systemctl enable proypers25-engine.service
systemctl restart proypers25-engine.service
printf '%s\n' 'STAGING_ENGINE_INSTALLED trading_activated=false'
