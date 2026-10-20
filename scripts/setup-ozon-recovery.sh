#!/usr/bin/env bash
# Starts the browser service; does not enable or change collection schedules.
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
test -f /opt/price-checker/current/scripts/ozon-recovery-server.js
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -m 644 "$directory/systemd/price-checker-ozon-recovery.socket" /etc/systemd/system/
install -m 644 "$directory/systemd/price-checker-ozon-recovery.service" /etc/systemd/system/
if [[ -f /etc/price-checker-ozon-proxy.env ]]; then
  install -d -m 755 /etc/systemd/system/price-checker-ozon-recovery.service.d
  printf '[Unit]\nWants=price-checker-ozon-proxy.service\nAfter=price-checker-ozon-proxy.service\n' \
    > /etc/systemd/system/price-checker-ozon-recovery.service.d/ozon-proxy.conf
fi
config=$(mktemp /etc/price-checker-ozon-recovery.env.XXXXXX)
trap 'rm -f -- "$config"' EXIT
# Preserve existing browser options; only the explicitly supplied profile changes.
if [[ -f /etc/price-checker-ozon-recovery.env ]]; then
  sed '/^OZON_BROWSER_PROFILE=/d' /etc/price-checker-ozon-recovery.env > "$config"
fi
printf '\nOZON_BROWSER_PROFILE=%s\n' "$profile" >> "$config"
for setting in LANG=ru_RU.UTF-8 LC_ALL=ru_RU.UTF-8 LANGUAGE=ru_RU:ru TZ=Europe/Moscow \
  OZON_BROWSER_SCREEN=3840x2160 OZON_BROWSER_WINDOW=1282x1344 OZON_BROWSER_SCALE=1.5 \
  OZON_BROWSER_GRAPHICS=swiftshader OZON_BROWSER_IDLE_MINUTES=0; do
  grep -q "^${setting%%=*}=" "$config" || printf '%s\n' "$setting" >> "$config"
done
chmod 600 "$config"
mv -- "$config" /etc/price-checker-ozon-recovery.env
systemctl stop price-checker-ozon-recovery.socket 'price-checker-ozon-recovery@*.service'
if systemctl is-active --quiet price-checker-ozon-recovery.service; then
  systemctl stop price-checker-ozon-recovery.service
fi
systemctl daemon-reload
systemctl enable --now price-checker-ozon-recovery.socket
systemctl enable --now price-checker-ozon-recovery.service
echo 'Ozon browser service enabled; collection schedules were preserved.'
