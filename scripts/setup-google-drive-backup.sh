#!/usr/bin/env bash
# Install the standalone backup service; --enable requires successful Drive recovery.
set -euo pipefail
if [[ $EUID != 0 || $# -gt 1 || ${1:-} != '' && ${1:-} != '--enable' ]]; then
  echo 'Usage: sudo bash scripts/setup-google-drive-backup.sh [--enable]' >&2
  exit 1
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -d /var/lib/price-checker/data
if ! command -v rclone >/dev/null || ! command -v restic >/dev/null; then
  apt-get update
  DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l \
    apt-get install --no-install-recommends --yes rclone restic
fi
install -d -m 700 /var/lib/price-checker-backup /var/lib/price-checker/secrets/google-drive-backup
install -d -m 755 /usr/local/lib/price-checker
install -m 644 "$directory/google-drive-backup.py" /usr/local/lib/price-checker/google-drive-backup.py
python3 - <<'PY'
import json
import os
from pathlib import Path
import secrets
os.umask(0o077)
private = Path('/var/lib/price-checker/secrets/google-drive-backup')
password = private / 'restic-password'
if not password.exists():
    with password.open('x') as output:
        output.write(secrets.token_urlsafe(48) + '\n')
config = Path('/etc/price-checker-backup.json')
if not config.exists():
    with config.open('x') as output:
        json.dump({'data_dir': '/var/lib/price-checker/data',
                   'work_dir': '/var/lib/price-checker-backup',
                   'rclone_config': str(private / 'rclone.conf'),
                   'password_file': str(password),
                   'repository': 'rclone:pricechecker-drive:price-checker-backups'}, output, indent=2)
password.chmod(0o600)
config.chmod(0o600)
PY
install -m 644 "$directory/systemd/price-checker-backup.service" /etc/systemd/system/
install -m 644 "$directory/systemd/price-checker-backup.timer" /etc/systemd/system/
systemctl daemon-reload
if [[ ${1:-} == '--enable' ]]; then
  python3 /usr/local/lib/price-checker/google-drive-backup.py run --force
  systemctl enable --now price-checker-backup.timer
  echo 'Encrypted Drive backups enabled; first upload and isolated recovery succeeded.'
else
  echo 'Backup tools installed. Authorize Drive, initialize storage, save the recovery password off-server, then rerun with --enable.'
fi
