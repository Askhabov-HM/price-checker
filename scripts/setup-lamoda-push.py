#!/usr/bin/env python3
"""Install an FCM sender key in the existing private secrets directory; no restart."""
import json
import os
from pathlib import Path
import pwd
import re
import sys
import tempfile


def install(source):
    if os.geteuid() != 0:
        raise ValueError('Run as root')
    raw = source.read_bytes()
    if len(raw) > 32768:
        raise ValueError('Invalid service account file')
    value = json.loads(raw)
    if (value.get('type') != 'service_account'
            or not re.fullmatch(r'[a-z][a-z0-9-]{4,62}', value.get('project_id', ''))
            or not re.fullmatch(r'[a-z0-9-]+@[a-z0-9-]+\.iam\.gserviceaccount\.com', value.get('client_email', ''))
            or not value.get('private_key', '').startswith('-----BEGIN PRIVATE KEY-----')):
        raise ValueError('Invalid service account file')
    owner = pwd.getpwnam('pricechecker')
    directory = Path('/var/lib/price-checker/secrets/lamoda')
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    directory.chmod(0o700)
    os.chown(directory, owner.pw_uid, owner.pw_gid)
    with tempfile.NamedTemporaryFile(dir=directory, prefix='.firebase-', delete=False) as output:
        pending = Path(output.name)
        try:
            os.fchmod(output.fileno(), 0o600)
            os.fchown(output.fileno(), owner.pw_uid, owner.pw_gid)
            output.write(raw)
            output.flush()
            os.fsync(output.fileno())
            os.replace(pending, directory / 'firebase-service-account.json')
        finally:
            pending.unlink(missing_ok=True)
    print('FCM sender key installed privately. The next application release will use it.')


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('Usage: sudo python3 scripts/setup-lamoda-push.py /private/service-account.json')
        install(Path(sys.argv[1]))
    except Exception:
        # JSON parse and IO errors must not echo private input or key material.
        raise SystemExit('Could not install the FCM key; check the input file and service account permissions.') from None
