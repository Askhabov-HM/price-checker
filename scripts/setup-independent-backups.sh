#!/usr/bin/env bash
# Switch only after all three uploads and isolated recoveries succeed.
set -euo pipefail
if [[ $EUID != 0 || $# != 1 || $1 != '--enable' ]]; then
  echo 'Usage: sudo bash scripts/setup-independent-backups.sh --enable' >&2
  exit 1
fi
directory=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repository=$(git -C "$directory" rev-parse --show-toplevel)
[[ $(git -C "$repository" branch --show-current) == develop ]]
[[ $(git -C "$repository" rev-parse --abbrev-ref '@{upstream}') == origin/develop ]]
[[ -z $(git -C "$repository" status --porcelain) ]]
git -C "$repository" merge-base --is-ancestor HEAD origin/develop
test -f /etc/price-checker-backup.json
command -v restic >/dev/null
command -v rclone >/dev/null
# The units use these fixed data/state roots; reject mismatched installations.
python3 - <<'PY'
import json
from pathlib import Path
c = json.loads(Path('/etc/price-checker-backup.json').read_text())
assert c['data_dir'] == '/var/lib/price-checker/data', 'Unexpected data directory'
assert c['work_dir'] == '/var/lib/price-checker-backup', 'Unexpected backup directory'
assert c.get('coordination_dir', '/var/lib/price-checker-backup-coordination') == '/var/lib/price-checker-backup-coordination', 'Unexpected queue directory'
for relative in ('prices.sqlite3', 'ozon/prices.sqlite3', 'lamoda/prices.sqlite3'):
    assert (Path(c['data_dir']) / relative).is_file(), 'Missing store database'
PY
install -d -m 700 /var/lib/price-checker-backup-coordination
exec 9>/var/lib/price-checker-backup-coordination/install.lock
flock -n 9 || { echo 'Another backup installation is running' >&2; exit 1; }
install -d -m 755 /usr/local/lib/price-checker
for store in randewoo ozon lamoda; do
  install -d -m 700 "/var/lib/price-checker-$store-backup"
done
install -d -m 700 /var/lib/price-checker-backup-maintenance
scripts=(google-drive-backup.py store-backup.py lamoda-backup.py backup-maintenance.py)
units=(price-checker-backup.service price-checker-backup.timer
  price-checker-store-backup@.service price-checker-store-backup@.timer
  price-checker-lamoda-backup.service price-checker-lamoda-backup.timer
  price-checker-backup-maintenance.service price-checker-backup-maintenance.timer)
timers=(price-checker-backup.timer price-checker-store-backup@randewoo.timer
  price-checker-store-backup@ozon.timer price-checker-lamoda-backup.timer
  price-checker-backup-maintenance.timer)
services=(price-checker-backup.service price-checker-store-backup@randewoo.service
  price-checker-store-backup@ozon.service price-checker-lamoda-backup.service
  price-checker-backup-maintenance.service)
saved=$(mktemp -d /var/lib/price-checker-backup-coordination/install-XXXXXXXX)
declare -A enabled active existed
targets=()
for name in "${scripts[@]}"; do targets+=("/usr/local/lib/price-checker/$name"); done
for name in "${units[@]}"; do targets+=("/etc/systemd/system/$name"); done
printf '%s\n' "${targets[@]}" > "$saved/targets.txt"
for i in "${!targets[@]}"; do
  target=${targets[$i]}
  if [[ -e $target ]]; then cp -p -- "$target" "$saved/$i"; existed[$i]=1; fi
done
for timer in "${timers[@]}"; do
  enabled[$timer]=$(systemctl is-enabled "$timer" 2>/dev/null || true)
  active[$timer]=$(systemctl is-active "$timer" 2>/dev/null || true)
  printf '%s\t%s\t%s\n' "$timer" "${enabled[$timer]}" "${active[$timer]}" >> "$saved/timers.tsv"
done
installed=0
rollback() {
  code=$?
  trap - EXIT
  if (( code != 0 )); then
    echo 'Backup migration failed; restoring previous tools and timer states.' >&2
    for timer in "${timers[@]}"; do systemctl stop "$timer" 2>/dev/null || true; done
    for timer in "${timers[@]}"; do
      [[ ${enabled[$timer]} == enabled ]] || systemctl disable "$timer" 2>/dev/null || true
    done
    if (( installed )); then
      # A partially successful enable may already have started a new service.
      for service in "${services[@]}"; do
        while [[ $(systemctl show "$service" -p ActiveState --value) =~ ^(active|activating|deactivating)$ ]]; do sleep 2; done
      done
      flock -w 2400 8
      for i in "${!targets[@]}"; do
        if [[ ${existed[$i]:-0} == 1 ]]; then cp -p -- "$saved/$i" "${targets[$i]}";
        else rm -f -- "${targets[$i]}"; fi
      done
      flock -u 8
    fi
    systemctl daemon-reload
    for timer in "${timers[@]}"; do
      [[ ${enabled[$timer]} != enabled ]] || systemctl enable "$timer"
      [[ ${active[$timer]} != active ]] || systemctl start "$timer"
    done
  fi
  echo "Installer recovery files: $saved"
  exit "$code"
}
trap rollback EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
for timer in "${timers[@]}"; do systemctl stop "$timer" 2>/dev/null || true; done
# Do not interrupt an existing upload or repository maintenance.
deadline=$((SECONDS + 3900))
for service in "${services[@]}"; do
  while [[ $(systemctl show "$service" -p ActiveState --value) =~ ^(active|activating|deactivating)$ ]]; do
    (( SECONDS < deadline )) || { echo 'Timed out waiting for an active backup' >&2; exit 1; }
    sleep 2
  done
done
# Exclude manual operations too. Release before the verified runs acquire it.
exec 8>/var/lib/price-checker-backup-coordination/repository.lock
flock -w 2400 8
installed=1
for name in "${scripts[@]}"; do install -m 644 "$directory/$name" /usr/local/lib/price-checker/; done
for name in "${units[@]}"; do install -m 644 "$directory/systemd/$name" /etc/systemd/system/; done
systemctl daemon-reload
flock -u 8
for store in randewoo ozon; do
  python3 /usr/local/lib/price-checker/store-backup.py --store "$store" run --force --verify
done
python3 /usr/local/lib/price-checker/lamoda-backup.py run --force --verify
python3 /usr/local/lib/price-checker/backup-maintenance.py run
systemctl disable price-checker-backup.timer
systemctl enable --now price-checker-store-backup@randewoo.timer price-checker-store-backup@ozon.timer \
  price-checker-lamoda-backup.timer price-checker-backup-maintenance.timer
echo 'Three independent backups enabled after successful cloud recovery. Legacy snapshots preserved.'
