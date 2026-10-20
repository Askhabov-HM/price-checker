#!/usr/bin/env python3
"""The sandboxed web service reaches the separate root Codex process over SSH."""

import base64
import json
import os
import sys

KEY = '/var/lib/price-checker/secrets/codex-root-ed25519'
KNOWN_HOSTS = '/var/lib/price-checker/secrets/codex-root-known-hosts'
command = 'codex-v1 ' + base64.urlsafe_b64encode(json.dumps(sys.argv[1:]).encode()).decode()
os.execv('/usr/bin/ssh', ['ssh', '-T', '-i', KEY, '-o', 'IdentitiesOnly=yes',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes',
    '-o', 'UserKnownHostsFile=' + KNOWN_HOSTS, '-o', 'ConnectTimeout=10',
    '-o', 'ServerAliveInterval=15', '-o', 'ServerAliveCountMax=3',
    'root@127.0.0.1', command])
