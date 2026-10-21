#!/usr/bin/env bash
# Give Lamoda its own fixed Russian VPN exit without changing other routes.
set -euo pipefail
if [[ $EUID != 0 || $# -gt 1 ]]; then
  echo 'Usage: sudo bash scripts/setup-lamoda-proxy.sh [NODE_ALIAS]' >&2
  exit 1
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
node=${1:-eos-dd691bfb0441}
helper=$directory/lamoda-proxy-config.py
service=price-checker-lamoda-proxy.service
configdir=/etc/price-checker-lamoda-proxy
config=$configdir/config.json
test -f /opt/price-checker/current/scripts/lamoda-browser.js
test -f /etc/systemd/system/price-checker-lamoda-browser.service
test -x /usr/local/bin/mihomo
test -x /usr/bin/curl
getent passwd priceproxy >/dev/null
python3 -c 'import yaml' >/dev/null
for path in "$configdir" "$config" /etc/price-checker-lamoda-proxy.env \
  /var/lib/price-checker-lamoda-proxy \
  /etc/systemd/system/price-checker-lamoda-browser.service.d \
  /etc/systemd/system/price-checker-lamoda-browser.service.d/proxy.conf \
  /etc/systemd/system/price-checker-lamoda-proxy.service; do
  [[ ! -L $path ]]
done
# Never replace a listener belonging to another service.
if ! systemctl is-active --quiet "$service"; then
  python3 -c 'import socket; s=socket.socket(); s.bind(("127.0.0.1",17892)); s.close()'
fi
install -d -o root -g priceproxy -m 750 "$configdir"
workdir=$(mktemp -d "$configdir/.setup.XXXXXX")
was_active=0
systemctl is-active --quiet "$service" && was_active=1
rollback=0
cleanup() {
  if (( rollback )); then
    systemctl stop "$service" || true
    if [[ -f $workdir/previous.json ]]; then
      install -o priceproxy -g priceproxy -m 600 "$workdir/previous.json" "$config"
    else
      rm -f -- "$config"
    fi
    if (( was_active )); then systemctl start "$service" || true; fi
  fi
  rm -rf -- "$workdir"
}
trap cleanup EXIT
python3 "$helper" prepare /var/lib/price-checker-proxy/providers/eos.yaml "$node" "$workdir/candidate.json"
if ! /usr/local/bin/mihomo -t -d "$workdir" -f "$workdir/candidate.json" >"$workdir/validation.log" 2>&1; then
  echo 'Private Lamoda proxy configuration failed validation; no route changed.' >&2
  exit 1
fi
if [[ -f $config ]]; then cp -p -- "$config" "$workdir/previous.json"; fi
rollback=1
install -o priceproxy -g priceproxy -m 600 "$workdir/candidate.json" "$config"
install -m 644 "$directory/systemd/$service" "/etc/systemd/system/$service"
systemctl daemon-reload
systemctl restart "$service"
# Geolocation is checked through the candidate proxy, before switching Chrome.
python3 "$helper" verify
rollback=0
systemctl enable "$service"
printf 'LAMODA_PROXY_URL=http://127.0.0.1:17892\n' > "$workdir/browser.env"
chmod 600 "$workdir/browser.env"
mv -- "$workdir/browser.env" /etc/price-checker-lamoda-proxy.env
install -d -m 755 /etc/systemd/system/price-checker-lamoda-browser.service.d
install -m 644 "$directory/systemd/price-checker-lamoda-proxy.conf" \
  /etc/systemd/system/price-checker-lamoda-browser.service.d/proxy.conf
systemctl daemon-reload
# Apply to an already running browser without enabling it or changing schedules.
systemctl try-restart price-checker-lamoda-browser.service
echo 'Independent Russian Lamoda proxy configured; collection schedules preserved.'
