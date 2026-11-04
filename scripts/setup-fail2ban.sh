#!/usr/bin/env bash
# Install SSH-only protection; never reload sshd, UFW, or the application.
set -euo pipefail
[[ $EUID == 0 && $# == 0 ]] || { echo 'Run as root without arguments.' >&2; exit 1; }
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(git -C "$directory" rev-parse --show-toplevel)
[[ $(git -C "$repository" branch --show-current) == develop ]]
[[ $(git -C "$repository" rev-parse --abbrev-ref --symbolic-full-name '@{u}') == origin/develop ]]
[[ -z $(git -C "$repository" status --porcelain) ]]
git -C "$repository" merge-base --is-ancestor HEAD origin/develop
for operation in MERGE_HEAD CHERRY_PICK_HEAD REVERT_HEAD rebase-merge rebase-apply; do
  [[ ! -e $(git -C "$repository" rev-parse --git-path "$operation") ]]
done
source /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 ]] || { echo 'Ubuntu 24.04 required.' >&2; exit 1; }
sshd -t
[[ $(sshd -T | awk '$1 == "port" {print $2}') == 22 ]] || {
  echo 'This policy requires SSH port 22; SSH configuration was not changed.' >&2; exit 1;
}
command -v iptables >/dev/null
command -v ip6tables >/dev/null
exec 9>/run/lock/price-checker-fail2ban-install.lock
flock -n 9 || { echo 'Another Fail2ban installation is running.' >&2; exit 1; }

target=/etc/fail2ban/jail.d/99-price-checker-sshd.local
[[ ! -L $target ]]
enabled=$(systemctl is-enabled fail2ban.service 2>/dev/null || true)
case "$enabled" in masked*) echo 'Existing masked service preserved; installation stopped.' >&2; exit 1;; esac
active=false
if systemctl is-active --quiet fail2ban.service; then active=true; fi
installed=false
if [[ $(dpkg-query -W -f='${Status}' fail2ban 2>/dev/null || true) == 'install ok installed' ]]; then installed=true; fi
install -d -m 700 /var/backups/price-checker-fail2ban
saved=$(mktemp -d /var/backups/price-checker-fail2ban/install-XXXXXXXX)
if [[ -e $target ]]; then cp -p -- "$target" "$saved/jail.previous"; fi
printf 'active=%s\nenabled=%s\ninstalled=%s\n' "$active" "$enabled" "$installed" > "$saved/service-state"
masked=false
changed=false
finish() {
  result=$?
  trap - EXIT
  set +e
  if (( result != 0 )); then
    if $changed; then
      if [[ -e $saved/jail.previous ]]; then
        cp -p -- "$saved/jail.previous" "$target"
      else
        rm -f -- "$target"
      fi
    fi
    if $masked; then systemctl unmask --runtime fail2ban.service; masked=false; fi
    if $active; then
      systemctl restart fail2ban.service || systemctl stop fail2ban.service
    else
      systemctl stop fail2ban.service
    fi
    if [[ $enabled != enabled ]]; then systemctl disable fail2ban.service; fi
    echo "Installation failed; previous jail restored. Saved state: $saved" >&2
  fi
  if $masked; then systemctl unmask --runtime fail2ban.service; fi
  exit "$result"
}
trap finish EXIT

# Debian may auto-start a newly installed package. Validate our policy first.
if ! $installed; then
  systemctl mask --runtime fail2ban.service
  masked=true
fi
export DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=l
apt-get update -qq
apt-get install --yes --no-install-recommends fail2ban python3-systemd
install -d -m 755 /etc/fail2ban/jail.d
changed=true
install -m 644 "$directory/fail2ban/sshd.conf" "$target"
fail2ban-client -t
if $masked; then
  systemctl unmask --runtime fail2ban.service
  masked=false
fi
systemctl enable fail2ban.service
if $active; then
  fail2ban-client reload
else
  systemctl start fail2ban.service
fi
for (( attempt=0; attempt<20; attempt++ )); do
  if fail2ban-client ping >/dev/null 2>&1; then break; fi
  sleep 0.5
done
fail2ban-client status sshd
[[ $(fail2ban-client get sshd maxretry) == 5 ]]
[[ $(fail2ban-client get sshd findtime) == 600 ]]
[[ $(fail2ban-client get sshd bantime) == 3600 ]]
systemctl is-active --quiet fail2ban.service
echo "Fail2ban SSH protection enabled. Previous jail/state: $saved"
