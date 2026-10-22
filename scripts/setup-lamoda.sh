#!/usr/bin/env bash
# Install only the Lamoda service. Activation follows the server capacity review.
set -euo pipefail
[[ $EUID == 0 && $# -le 1 && ( ${1:-} == '' || ${1:-} == '--enable-browser' ) ]]
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
test -x /opt/google/chrome/chrome
test -x /usr/local/bin/node
test -x /usr/bin/Xvfb
test -x /usr/bin/x11vnc
test -f /opt/price-checker/current/scripts/lamoda-browser.js
id lamodabrowser >/dev/null 2>&1 || useradd --system --home /var/lib/price-checker-lamoda-browser --shell /usr/sbin/nologin lamodabrowser
install -d -m 700 -o lamodabrowser -g pricechecker /var/lib/price-checker-lamoda-browser
install -d -m 700 -o lamodabrowser -g pricechecker /var/lib/price-checker-lamoda-browser/profile
install -m 644 "$directory/systemd/price-checker-lamoda-browser.service" /etc/systemd/system/
# Return from an explicitly installed diagnostic preview to the deployed release.
rm -f -- /etc/systemd/system/price-checker-lamoda-browser.service.d/diagnostics.conf
systemctl daemon-reload
if [[ ${1:-} == '--enable-browser' ]]; then
  systemctl enable --now price-checker-lamoda-browser.service
fi
echo 'Lamoda service installed; collection schedules are preserved.'
