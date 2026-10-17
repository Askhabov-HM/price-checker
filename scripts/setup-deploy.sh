#!/usr/bin/env bash
# Run as root on the existing Ubuntu server; never restarts the application.
set -euo pipefail

if [[ $EUID != 0 || $# != 1 ]]; then
  echo 'Usage: sudo bash scripts/setup-deploy.sh /path/to/deploy-key.pub' >&2
  exit 1
fi
systemctl is-active --quiet price-checker.service
test -d /opt/price-checker/releases
test -L /opt/price-checker/current
test -d /var/lib/price-checker/data
test -f /var/lib/price-checker/secrets/price-checker-auth.json
command -v python3 >/dev/null
test -x /usr/local/bin/npm
ssh-keygen -lf "$1" >/dev/null
public_key=$(cat "$1")
[[ $public_key == ssh-ed25519\ * && $public_key != *$'\n'* ]]

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 755 /usr/local/lib/price-checker
install -m 644 "$script_directory/deploy.py" /usr/local/lib/price-checker/deploy.py
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
entry="restrict,command=\"/usr/bin/python3 /usr/local/lib/price-checker/deploy.py\" $public_key"
if ! grep -qF -- "$public_key" /root/.ssh/authorized_keys; then
  printf '\n%s\n' "$entry" >> /root/.ssh/authorized_keys
fi
echo 'Restricted deployment key installed; existing service and data preserved.'
