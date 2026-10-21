#!/usr/bin/env bash
set -euo pipefail
[[ $EUID == 0 && $# -le 1 && ( ${1:-} == '' || ${1:-} == '--enable' ) ]]
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -f /etc/price-checker-backup.json
test -f /usr/local/lib/price-checker/google-drive-backup.py
install -d -m 700 /var/lib/price-checker-lamoda-backup
install -m 644 "$directory/lamoda-backup.py" /usr/local/lib/price-checker/
install -m 644 "$directory/systemd/price-checker-lamoda-backup.service" /etc/systemd/system/
install -m 644 "$directory/systemd/price-checker-lamoda-backup.timer" /etc/systemd/system/
systemctl daemon-reload
if [[ ${1:-} == '--enable' ]]; then
  python3 /usr/local/lib/price-checker/lamoda-backup.py run --force --verify
  systemctl enable --now price-checker-lamoda-backup.timer
fi
echo 'Lamoda backup installed; existing Randewoo/Ozon backup configuration is preserved.'
