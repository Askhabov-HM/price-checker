#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && $# -le 1 && ( ${1:-} == '' || ${1:-} == '--enable' ) ]]
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
if [[ ${1:-} == '--enable' ]]; then
  exec bash "$directory/setup-independent-backups.sh" --enable
fi
test -f /etc/price-checker-backup.json
test -f /usr/local/lib/price-checker/google-drive-backup.py
install -d -m 700 /var/lib/price-checker-lamoda-backup /var/lib/price-checker-backup-coordination
install -m 644 "$directory/lamoda-backup.py" /usr/local/lib/price-checker/
install -m 644 "$directory/systemd/price-checker-lamoda-backup.service" /etc/systemd/system/
install -m 644 "$directory/systemd/price-checker-lamoda-backup.timer" /etc/systemd/system/
systemctl daemon-reload
echo 'Lamoda backup installed. Use setup-independent-backups.sh --enable for verified activation of all three stores.'
