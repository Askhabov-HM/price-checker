#!/usr/bin/env bash
# Route only Lamoda's browser through the existing fixed Kazakhstan proxy.
set -euo pipefail
if [[ $EUID != 0 || $# != 0 ]]; then
  echo 'Usage: sudo bash scripts/setup-lamoda-proxy.sh' >&2
  exit 1
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -f /opt/price-checker/current/scripts/lamoda-browser.js
test -f /etc/systemd/system/price-checker-lamoda-browser.service
test -f /etc/price-checker-ozon-proxy.env
systemctl is-active --quiet price-checker-ozon-proxy.service

# Copy only the local endpoint, never source the Ozon environment or copy keys.
proxy=$(sed -n 's/^OZON_PROXY_URL=//p' /etc/price-checker-ozon-proxy.env)
if [[ ! $proxy =~ ^http://127\.0\.0\.1:[1-9][0-9]{0,4}$ ]] || (( ${proxy##*:} > 65535 )); then
  echo 'Expected one local HTTP endpoint in OZON_PROXY_URL; no changes applied.' >&2
  exit 1
fi
[[ ! -L /etc/price-checker-lamoda-proxy.env ]]
config=$(mktemp /etc/price-checker-lamoda-proxy.env.XXXXXX)
trap 'rm -f -- "$config"' EXIT
printf 'LAMODA_PROXY_URL=%s\n' "$proxy" > "$config"
chmod 600 "$config"
mv -- "$config" /etc/price-checker-lamoda-proxy.env
install -d -m 755 /etc/systemd/system/price-checker-lamoda-browser.service.d
install -m 644 "$directory/systemd/price-checker-lamoda-proxy.conf" \
  /etc/systemd/system/price-checker-lamoda-browser.service.d/proxy.conf
systemctl daemon-reload
# Apply to an already running browser without enabling it or changing schedules.
systemctl try-restart price-checker-lamoda-browser.service
echo 'Lamoda proxy configured; collection schedules preserved.'
