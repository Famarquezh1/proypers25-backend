#!/usr/bin/env python3
"""Render a secret-free Ubuntu cloud-init; trading services remain absent."""
import argparse
import json
from pathlib import Path
import re
import yaml

PINNED_COMMIT = '8d88021dea30eb87f786b5685818d01204d132a3'

def render(public_key):
    if not re.fullmatch(r'ssh-ed25519 [A-Za-z0-9+/]+={0,3}(?: [^\r\n]+)?', public_key):
        raise ValueError('Expected one Ed25519 public key')
    probe = Path(__file__).with_name('preflight.cjs').read_text()
    setup = f'''#!/bin/bash
set -euo pipefail
umask 027
install -d -m 0755 /etc/apt/keyrings
curl --fail --silent --show-error --proto '=https' --tlsv1.2 https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key -o /run/nodesource.asc
gpg --batch --dearmor -o /etc/apt/keyrings/nodesource.gpg /run/nodesource.asc
chmod 0644 /etc/apt/keyrings/nodesource.gpg
echo 'deb [arch=amd64 signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_22.x nodistro main' > /etc/apt/sources.list.d/nodesource.list
apt-get update
DEBIAN_FRONTEND=noninteractive apt-get install -y nodejs
node -e 'if(Number(process.versions.node.split(".")[0])!==22)process.exit(1)'
install -d -m 0755 /opt/proypers25
git clone --depth 1 https://github.com/Famarquezh1/proypers25-backend.git /opt/proypers25/repo
git -C /opt/proypers25/repo fetch --depth 1 origin {PINNED_COMMIT}
git -C /opt/proypers25/repo checkout --detach {PINNED_COMMIT}
test "$(git -C /opt/proypers25/repo rev-parse HEAD)" = '{PINNED_COMMIT}'
chgrp -R spot /opt/proypers25/repo
chmod -R g+rX /opt/proypers25/repo
install -d -o spot -g spot -m 0700 /var/lib/proypers25
install -d -o root -g root -m 0700 /etc/proypers25
install -o root -g root -m 0600 /dev/null /etc/proypers25/binance-key
install -o root -g root -m 0600 /dev/null /etc/proypers25/binance-secret
install -o root -g root -m 0600 /dev/null /etc/proypers25/TRADING_DISABLED
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp comment 'SSH public key only'
ufw --force enable
install -d -m 0755 /run/sshd
sshd -t
systemctl reload ssh
systemctl daemon-reload
systemctl enable --now proypers25-preflight.timer
echo 'BOOTSTRAP_READY trading_disabled=true'
'''
    service = '''[Unit]
Description=Proypers25 read-only Binance connectivity probe
After=network-online.target time-sync.target
Wants=network-online.target

[Service]
Type=oneshot
User=spot
Group=spot
WorkingDirectory=/opt/proypers25/repo/backend
ExecStart=/usr/bin/node /opt/proypers25/preflight.cjs
LoadCredential=binance-key:/etc/proypers25/binance-key
LoadCredential=binance-secret:/etc/proypers25/binance-secret
StateDirectory=proypers25
Environment=PROYPERS_LOCAL_STATE_DIR=/var/lib/proypers25
UMask=0077
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
CapabilityBoundingSet=
MemoryMax=256M
CPUQuota=50%
TimeoutStartSec=90
StandardOutput=journal
StandardError=journal
'''
    files = {
        '/usr/local/sbin/proypers25-bootstrap': (setup, '0700'),
        '/opt/proypers25/preflight.cjs': (probe, '0644'),
        '/etc/systemd/system/proypers25-preflight.service': (service, '0644'),
        '/etc/systemd/system/proypers25-preflight.timer': ('''[Unit]
Description=Run Proypers25 read-only probe every five minutes
[Timer]
OnBootSec=90s
OnUnitActiveSec=5min
Unit=proypers25-preflight.service
[Install]
WantedBy=timers.target
''', '0644'),
        '/etc/ssh/sshd_config.d/00-proypers25.conf': ('''PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
PubkeyAuthentication yes
AllowUsers deploy
''', '0644'),
        '/etc/systemd/journald.conf.d/proypers25.conf': ('''[Journal]
Storage=persistent
SystemMaxUse=150M
MaxRetentionSec=14day
''', '0644')
    }
    config = {
        'package_update': True,
        'packages': ['ca-certificates', 'curl', 'gnupg', 'git', 'ufw', 'unattended-upgrades'],
        'ssh_pwauth': False,
        'disable_root': True,
        'timezone': 'UTC',
        'users': [
            {'name': 'deploy', 'groups': ['sudo'], 'shell': '/bin/bash', 'lock_passwd': True,
             'sudo': ['ALL=(ALL) NOPASSWD:ALL'], 'ssh_authorized_keys': [public_key]},
            {'name': 'spot', 'system': True, 'shell': '/usr/sbin/nologin', 'lock_passwd': True}
        ],
        'write_files': [{'path': name, 'owner': 'root:root', 'permissions': mode, 'content': content}
                        for name, (content, mode) in files.items()],
        'runcmd': [['bash', '/usr/local/sbin/proypers25-bootstrap']],
        'final_message': 'Proypers25 bootstrap finished; trading is disabled. Check bootstrap logs.'
    }
    return '#cloud-config\n' + yaml.safe_dump(config, sort_keys=False)

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--public-key', type=Path, required=True)
    parser.add_argument('--output', type=Path, required=True)
    args = parser.parse_args()
    rendered = render(args.public_key.read_text().strip())
    if len(rendered.encode()) > 32768:
        raise SystemExit('Cloud-init exceeds Hetzner 32 KiB limit')
    args.output.write_text(rendered)
    args.output.chmod(0o600)
    print(json.dumps({'bytes': len(rendered.encode()), 'tradingActivated': False,
                      'sourceCommit': PINNED_COMMIT}))
