#!/usr/bin/env bash
# Replace the broad HTTPS rule with TCP-only access; leave SSH and other rules.
set -euo pipefail
export LC_ALL=C
[[ $EUID == 0 && $# == 0 ]] || { echo 'Run as root without arguments.' >&2; exit 1; }
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(git -C "$directory" rev-parse --show-toplevel)
[[ $(git -C "$repository" branch --show-current) == develop ]]
[[ $(git -C "$repository" rev-parse --abbrev-ref --symbolic-full-name '@{u}') == origin/develop ]]
[[ -z $(git -C "$repository" status --porcelain) ]]
git -C "$repository" merge-base --is-ancestor HEAD origin/develop
ufw status | grep -Fxq 'Status: active'
[[ -z $(ss -H -lnup 'sport = :443') ]] || {
  echo 'UDP/443 has a listener; inspect its purpose before closing it.' >&2; exit 1;
}
check_policy() {
  iptables -C ufw-user-input -p tcp --dport 443 -j ACCEPT
  ip6tables -C ufw6-user-input -p tcp --dport 443 -j ACCEPT
  if iptables -C ufw-user-input -p udp --dport 443 -j ACCEPT 2>/dev/null ||
     ip6tables -C ufw6-user-input -p udp --dport 443 -j ACCEPT 2>/dev/null; then
    echo 'Unexpected UDP/443 permission remains.' >&2
    return 1
  fi
}
if ! ufw show added | grep -Fxq 'ufw allow 443'; then
  check_policy
  echo 'HTTPS is already TCP-only; no change needed.'
  exit 0
fi
exec 9>/run/lock/price-checker-firewall.lock
flock -n 9 || { echo 'Another firewall change is running.' >&2; exit 1; }
install -d -m 700 /var/backups/price-checker-firewall
saved=$(mktemp -d /var/backups/price-checker-firewall/https-443-XXXXXXXX)
cp -p /etc/ufw/user.rules /etc/ufw/user6.rules "$saved/"
ufw show added > "$saved/rules-before.txt"
restore_on_error() {
  result=$?
  trap - EXIT
  if (( result != 0 )); then
    ufw allow 443 || true
    echo "Verification failed; restored broad HTTPS access. Saved rules: $saved" >&2
  fi
  exit "$result"
}
trap restore_on_error EXIT
ufw allow 443/tcp
# Check both families before deleting the rule that currently carries HTTPS.
iptables -C ufw-user-input -p tcp --dport 443 -j ACCEPT
ip6tables -C ufw6-user-input -p tcp --dport 443 -j ACCEPT
ufw --force delete allow 443
check_policy
trap - EXIT
echo "UDP/443 permission removed; TCP/443 preserved. Previous rules: $saved"
