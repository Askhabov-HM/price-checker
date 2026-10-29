#!/usr/bin/env bash
# Run as root on the existing Ubuntu server; never restarts the application.
set -euo pipefail

if [[ $EUID != 0 || $# != 1 ]]; then
  echo 'Usage: sudo bash scripts/setup-deploy.sh /path/to/deploy-key.pub | --update' >&2
  exit 1
fi
systemctl is-active --quiet price-checker.service
test -d /opt/price-checker/releases
test -L /opt/price-checker/current
test -d /var/lib/price-checker/data
test -f /var/lib/price-checker/secrets/price-checker-auth.json
command -v python3 >/dev/null
test -x /usr/local/bin/npm
if [[ $1 != --update ]]; then
  ssh-keygen -lf "$1" >/dev/null
  public_key=$(cat "$1")
  [[ $public_key == ssh-ed25519\ * && $public_key != *$'\n'* ]]
fi

script_directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
install -d -m 755 /usr/local/lib/price-checker
python3 -c 'import ast,sys; ast.parse(open(sys.argv[1], encoding="utf-8").read())' "$script_directory/deploy.py"
if [[ -f /usr/local/lib/price-checker/deploy.py ]]; then
  cp -p /usr/local/lib/price-checker/deploy.py /usr/local/lib/price-checker/deploy.previous.py
fi
install -d -m 750 -o root -g pricechecker /var/lib/price-checker/data/backup-journal
install -m 644 "$script_directory/backup-journal.py" /usr/local/lib/price-checker/backup-journal.py
python3 /usr/local/lib/price-checker/backup-journal.py /var/lib/price-checker/data
install -m 644 "$script_directory/deploy.py" /usr/local/lib/price-checker/deploy.new.py
mv -T /usr/local/lib/price-checker/deploy.new.py /usr/local/lib/price-checker/deploy.py
if [[ $1 == --update ]]; then
  echo 'Storage-aware deploy entrypoint updated; existing SSH key and running service preserved.'
  exit 0
fi
install -d -m 700 /root/.ssh
touch /root/.ssh/authorized_keys
chmod 600 /root/.ssh/authorized_keys
entry="restrict,command=\"/usr/bin/python3 /usr/local/lib/price-checker/deploy.py\" $public_key"
if ! grep -qF -- "$public_key" /root/.ssh/authorized_keys; then
  printf '\n%s\n' "$entry" >> /root/.ssh/authorized_keys
fi
echo 'Restricted deployment key installed; existing service and data preserved.'
