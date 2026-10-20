#!/usr/bin/env bash
# Installs the socket only; does not open Chrome or enable collection schedules.
set -euo pipefail
if [[ $EUID != 0 || $# != 1 ]]; then
  echo 'Usage: sudo bash scripts/setup-ozon-recovery.sh /var/lib/price-checker-ozon-browser/.../profile' >&2
  exit 1
fi
profile=$1
[[ $profile =~ ^/var/lib/price-checker-ozon-browser/[a-zA-Z0-9_/-]+/profile$ ]]
[[ -d $profile && ! -L $profile && $(realpath -- "$profile") == "$profile" ]]
[[ $(stat -c %u -- "$profile") == $(id -u ozonbrowser) ]]
test -x /usr/bin/Xvfb
test -x /opt/google/chrome/chrome
test -f /opt/price-checker/current/scripts/ozon-recovery-worker.js
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 644 "$directory/systemd/price-checker-ozon-recovery.socket" /etc/systemd/system/
install -m 644 "$directory/systemd/price-checker-ozon-recovery@.service" /etc/systemd/system/
config=$(mktemp /etc/price-checker-ozon-recovery.env.XXXXXX)
trap 'rm -f -- "$config"' EXIT
# Both the recovery worker and the standalone browser inherit this UI locale.
printf 'OZON_BROWSER_PROFILE=%s\nLANG=ru_RU.UTF-8\nLC_ALL=ru_RU.UTF-8\nLANGUAGE=ru_RU:ru\nTZ=Europe/Moscow\nOZON_BROWSER_SCREEN=3840x2160\nOZON_BROWSER_WINDOW=1282x1344\nOZON_BROWSER_SCALE=1.5\nOZON_BROWSER_GRAPHICS=swiftshader\n' "$profile" > "$config"
chmod 600 "$config"
mv -- "$config" /etc/price-checker-ozon-recovery.env
systemctl daemon-reload
systemctl enable --now price-checker-ozon-recovery.socket
echo 'Ozon recovery socket enabled; Chrome and collection schedules were not started.'
